//! audio/jitter.rs — playback jitter buffer.
//!
//! Receives PCM or WAV frames captured from the relay:
//!   - 48 kHz mono s16le PCM from Ollalink sound-stream (streaming lane)
//!   - 24 kHz WAV from Ollalink sound-stream (batch lane, e.g. Kannada / voice fallback)
//! Resamples to the output device rate and buffers roughly `target_ms` of audio
//! ahead of the cpal callback so transient network jitter doesn't manifest as dropouts.
//!
//! Underruns return silence. Overruns drop oldest.

use crate::audio::resample::Resampler;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};

const ASSUMED_IN_RATE: u32 = 48_000;

pub struct JitterPlayer {
    /// Output device rate (e.g. 48_000, 44_100, 96_000). Atomic for hot-swap (RS-04).
    out_rate: AtomicU32,
    /// Channels the output stream was opened with. Playback duplicates mono. Atomic for hot-swap (RS-04).
    out_channels: AtomicUsize,
    /// Target buffer in milliseconds.
    target_ms: u32,
    /// Buffered samples (already resampled to out_rate, mono).
    ring: Mutex<VecDeque<f32>>,
    /// State flag for playback prebuffering (Atomic to eliminate lock-order inversion deadlock - Bug 24 Fix)
    playing: AtomicBool,
    /// Number of consecutive callbacks that encountered an empty ring buffer
    consecutive_empty: AtomicUsize,
    waiting_callbacks: AtomicUsize,
    /// Last detected or signaled input sample rate
    last_in_rate: Mutex<u32>,
    /// Total underrun count telemetry
    underruns: AtomicU64,
    /// Resamplers keyed by input sample rate (e.g. 48_000, 24_000, 16_000 -> out_rate).
    resamplers: Mutex<HashMap<u32, Resampler>>,
}

impl JitterPlayer {
    pub fn new(out_rate: u32, out_channels: usize, target_ms: u32) -> Self {
        Self {
            out_rate: AtomicU32::new(if out_rate > 0 { out_rate } else { 48_000 }),
            out_channels: AtomicUsize::new(out_channels.max(1)),
            target_ms,
            ring: Mutex::new(VecDeque::new()),
            playing: AtomicBool::new(false),
            consecutive_empty: AtomicUsize::new(0),
            waiting_callbacks: AtomicUsize::new(0),
            last_in_rate: Mutex::new(ASSUMED_IN_RATE),
            underruns: AtomicU64::new(0),
            resamplers: Mutex::new(HashMap::new()),
        }
    }

    /// Read current configured output sample rate.
    #[allow(dead_code)]
    pub fn out_rate(&self) -> u32 {
        self.out_rate.load(Ordering::Relaxed)
    }

    /// Read current configured output channel count.
    #[allow(dead_code)]
    pub fn out_channels(&self) -> usize {
        self.out_channels.load(Ordering::Relaxed)
    }

    /// Hot-swap the output device's sample rate and channel count (RS-04 fix).
    /// Dynamically purges stale resamplers, clears old rate samples, and resets pre-buffering.
    /// Synchronous to avoid holding cpal::Stream across await points (Send safety).
    pub fn update_output_config(&self, new_rate: u32, new_channels: usize) {
        let valid_rate = if new_rate > 0 { new_rate } else { 48_000 };
        let valid_ch = new_channels.max(1);

        let old_rate = self.out_rate.swap(valid_rate, Ordering::SeqCst);
        let old_ch = self.out_channels.swap(valid_ch, Ordering::SeqCst);

        tracing::info!(
            old_rate,
            new_rate = valid_rate,
            old_ch,
            new_ch = valid_ch,
            "RS-04: jitter player output configuration updated"
        );

        // If sample rate changed, cached resamplers are targeted to the old rate.
        // Clear them so fresh resamplers targeted to new_rate are instantiated.
        if old_rate != valid_rate {
            let mut map = self.resamplers.lock();
            map.clear();
        }

        // Reset the playback prebuffering and clear old resampled samples to avoid pitch/speed artifacts
        {
            let mut ring = self.ring.lock();
            ring.clear();
        }
        self.playing.store(false, Ordering::Release);
        self.consecutive_empty.store(0, Ordering::Relaxed);
        self.waiting_callbacks.store(0, Ordering::Relaxed);
    }

    /// Push an audio frame with backwards compatibility.
    pub async fn push_audio(&self, bytes: &[u8]) {
        self.push_audio_with_rate(bytes, 0).await;
    }

    /// Push an audio frame with explicit or auto-detected sample rate.
    /// Accurately resamples 16kHz, 24kHz, and 48kHz audio to prevent 3x speed playback.
    pub async fn push_audio_with_rate(&self, bytes: &[u8], explicit_rate: u32) {
        if bytes.is_empty() { return; }

        let (in_rate, raw_pcm) = if bytes.starts_with(b"RIFF") && bytes.len() >= 44 && &bytes[8..12] == b"WAVE" {
            let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
            let mut offset = 44;
            if let Some(pos) = bytes.windows(4).position(|w| w == b"data") {
                if pos + 8 <= bytes.len() {
                    offset = pos + 8;
                }
            }
            let valid_rate = if rate > 0 { rate } else { 24_000 };
            // WAV rate is local to this container frame; do not overwrite last_in_rate so raw PCM does not inherit 24kHz!
            (valid_rate, &bytes[offset..])
        } else {
            let rate = if explicit_rate > 0 {
                explicit_rate
            } else {
                let current = *self.last_in_rate.lock();
                if current > 0 { current } else { ASSUMED_IN_RATE }
            };
            *self.last_in_rate.lock() = rate;
            (rate, bytes)
        };

        if raw_pcm.is_empty() { return; }

        // Convert s16le bytes to f32
        let mut samples = Vec::with_capacity(raw_pcm.len() / 2);
        for chunk in raw_pcm.chunks_exact(2) {
            let i = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(i as f32 / 32768.0);
        }

        let out_rate = self.out_rate.load(Ordering::Relaxed);

        // Resample dynamically based on native input rate to current output device rate
        let resampled = if in_rate == out_rate {
            samples
        } else {
            let mut map = self.resamplers.lock();
            if !map.contains_key(&in_rate) {
                match Resampler::new(in_rate, out_rate) {
                    Ok(r) => { map.insert(in_rate, r); }
                    Err(e) => {
                        tracing::error!(error=%e, in_rate, out_rate, "jitter resampler init failed");
                        return;
                    }
                }
            }
            let resampler = match map.get_mut(&in_rate) {
                Some(r) => r,
                None => return,
            };
            match resampler.process(&samples) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(error=%e, in_rate, out_rate, "jitter resample failed");
                    return;
                }
            }
        };

        // Retain up to 4 seconds of audio.
        let cap = (out_rate as usize) * 4;
        let mut ring = self.ring.lock();
        for s in resampled {
            if ring.len() >= cap {
                ring.pop_front();
            }
            ring.push_back(s);
        }
    }

    /// Push a 48 kHz mono s16le PCM frame (or WAV file) — preserves backwards compatibility.
    #[allow(dead_code)]
    pub async fn push_pcm48k(&self, bytes: &[u8]) {
        self.push_audio(bytes).await;
    }

    /// Fill an output interleaved buffer from the ring. Underrun -> silence.
    /// Bug 24 Fix: Lock-free atomics for `playing` and `consecutive_empty` eliminate lock-order inversion deadlock.
    pub fn fill_into<T: cpal::Sample + cpal::FromSample<f32>>(&self, out: &mut [T]) {
        let needed = out.len();
        let mut ring = self.ring.lock();
        let out_rate = self.out_rate.load(Ordering::Relaxed);
        let target_len = (out_rate as usize) * (self.target_ms as usize) / 1000;

        // Gating only occurs before playback starts (pre-buffer)
        // Bug S4 Fix: Target pre-buffer threshold with starvation prevention for short utterances (< target_len)
        if !self.playing.load(Ordering::Acquire) {
            let ring_len = ring.len();
            let waited: usize = if ring_len > 0 {
                self.waiting_callbacks.fetch_add(1, Ordering::Relaxed) + 1
            } else {
                self.waiting_callbacks.store(0, Ordering::Relaxed);
                0
            };

            // Start playing if target length reached OR if audio has waited >= 3usize callbacks (~30-50ms)
            if ring_len >= target_len || (ring_len > 0 && waited >= 3) {
                self.playing.store(true, Ordering::Release);
                self.consecutive_empty.store(0, Ordering::Relaxed);
                self.waiting_callbacks.store(0, Ordering::Relaxed);
            } else {
                for s in out.iter_mut() { *s = <T as cpal::FromSample<f32>>::from_sample_(0.0); }
                return;
            }
        }

        let ch = self.out_channels.load(Ordering::Relaxed);
        let mut i = 0;
        while i < needed {
            if let Some(next) = ring.pop_front() {
                self.consecutive_empty.store(0, Ordering::Relaxed);
                // Clamp to prevent DAC clipping/distortion noise (Bug #2 fix)
                let clamped = next.clamp(-1.0, 1.0);
                for c in 0..ch {
                    if i + c < needed {
                        out[i + c] = <T as cpal::FromSample<f32>>::from_sample_(clamped);
                    }
                }
                i += ch;
            } else {
                // Buffer momentarily emptied mid-callback (Bug #1 & Bug #6 fix)
                self.underruns.fetch_add(1, Ordering::Relaxed);
                let count = self.consecutive_empty.fetch_add(1, Ordering::Relaxed) + 1;

                // Only transition back to pre-buffering if the buffer has been empty for
                // at least 15 consecutive callbacks (~150ms), meaning the utterance truly finished.
                if count >= 15 {
                    self.playing.store(false, Ordering::Release);
                }

                while i < needed {
                    out[i] = <T as cpal::FromSample<f32>>::from_sample_(0.0);
                    i += 1;
                }
                break;
            }
        }
    }

    /// Flush active resamplers into the ring buffer when an utterance ends.
    pub async fn flush_resamplers(&self) {
        // Bug 23 Fix: Do NOT clobber last_in_rate on utterance boundary!
        // Preserves the active stream rate (e.g. 48kHz streaming PCM) across sentences.
        let mut map = self.resamplers.lock();
        let mut flushed_all = Vec::new();
        for resampler in map.values_mut() {
            if let Ok(mut samples) = resampler.flush() {
                flushed_all.append(&mut samples);
            }
        }
        if !flushed_all.is_empty() {
            let out_rate = self.out_rate.load(Ordering::Relaxed);
            let cap = (out_rate as usize) * 4;
            let mut ring = self.ring.lock();
            for s in flushed_all {
                if ring.len() >= cap { ring.pop_front(); }
                ring.push_back(s);
            }
        }

        // Bug S4 Fix: Utterance ended (is_last = true). If there are any samples in the ring,
        // force playback immediately so short words or trailing phonemes are never trapped in silence!
        if !self.playing.load(Ordering::Acquire) {
            let ring = self.ring.lock();
            if !ring.is_empty() {
                self.playing.store(true, Ordering::Release);
                self.consecutive_empty.store(0, Ordering::Relaxed);
                self.waiting_callbacks.store(0, Ordering::Relaxed);
            }
        }
    }

    /// Read total underrun count.
    #[allow(dead_code)]
    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }

    #[allow(dead_code)]
    pub fn buffered_ms(&self) -> u32 {
        let len = self.ring.lock().len() as u32;
        let out_rate = self.out_rate.load(Ordering::Relaxed);
        if out_rate == 0 { return 0; }
        len * 1000 / out_rate
    }

    /// Check if the jitter player is actively outputting translated audio to speakers.
    /// Bug 2 & Bug 24 Fix: Lock-free atomic check avoids locking `playing`, preventing deadlock with `fill_into`.
    pub fn is_playing(&self) -> bool {
        if !self.playing.load(Ordering::Acquire) {
            return false;
        }
        !self.ring.lock().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_jitter_player_init_and_config_update() {
        let player = JitterPlayer::new(48_000, 2, 100);
        assert_eq!(player.out_rate(), 48_000);
        assert_eq!(player.out_channels(), 2);

        // Feed some samples
        let pcm = vec![0u8; 960]; // 480 samples @ s16le
        player.push_audio(&pcm).await;
        assert!(player.ring.lock().len() > 0);

        // Hot swap to 44.1 kHz mono DAC/Headphones (RS-04)
        player.update_output_config(44_100, 1);
        assert_eq!(player.out_rate(), 44_100);
        assert_eq!(player.out_channels(), 1);
        // Ring should be cleared on swap to prevent old rate pitch distortion
        assert_eq!(player.ring.lock().len(), 0);
        assert!(!player.playing.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn test_jitter_player_multichannel_fill_into() {
        let player = JitterPlayer::new(48_000, 2, 20); // 20ms prebuffer = 960 samples
        
        // Push 1000 samples of 0.5 amplitude
        let mut pcm = Vec::with_capacity(2000);
        let val_bytes = (16384i16).to_le_bytes(); // 0.5 amplitude
        for _ in 0..1000 {
            pcm.extend_from_slice(&val_bytes);
        }
        player.push_audio(&pcm).await;

        let mut out = [0.0f32; 8]; // 4 stereo frames
        player.fill_into(&mut out);

        // Verify interleaved stereo duplication
        for pair in out.chunks_exact(2) {
            assert!((pair[0] - 0.5).abs() < 1e-4);
            assert!((pair[1] - 0.5).abs() < 1e-4);
        }

        // Hot swap to 5.1 surround (6 channels)
        player.update_output_config(48_000, 6);
        assert_eq!(player.out_channels(), 6);

        // Push new samples
        player.push_audio(&pcm).await;
        let mut out_surround = [0.0f32; 12]; // 2 surround frames (6 ch each)
        player.fill_into(&mut out_surround);

        for ch in 0..6 {
            assert!((out_surround[ch] - 0.5).abs() < 1e-4);
        }
    }

    #[tokio::test]
    async fn test_jitter_player_hot_swap_resample_48k_to_44k() {
        let player = JitterPlayer::new(48_000, 2, 20);
        
        // Push 480 samples @ 48kHz (10ms)
        let pcm48 = vec![0u8; 960];
        player.push_audio_with_rate(&pcm48, 48_000).await;
        // Same rate -> no resampling -> exactly 480 samples
        assert_eq!(player.ring.lock().len(), 480);

        // Hot swap to 44.1kHz (Bluetooth headset)
        player.update_output_config(44_100, 2);
        assert_eq!(player.out_rate(), 44_100);
        assert_eq!(player.ring.lock().len(), 0); // Purged old samples

        // Push another 480 samples @ 48kHz
        player.push_audio_with_rate(&pcm48, 48_000).await;
        // Resampled dynamically from 48kHz to 44.1kHz
        let count = player.ring.lock().len();
        assert!(count > 250 && count <= 441, "Expected resampled samples for 44.1kHz, got {}", count);
    }

    #[tokio::test]
    async fn test_jitter_player_is_playing_state() {
        let player = JitterPlayer::new(48_000, 2, 20); // 20ms prebuffer = 960 samples
        assert!(!player.is_playing(), "initially not playing");

        // Push 1200 samples of audio (exceeding 20ms prebuffer)
        let pcm = vec![0u8; 2400];
        player.push_audio(&pcm).await;
        assert!(!player.is_playing(), "not playing yet until cpal callback drains");

        // First fill_into triggers playing = true
        let mut out = [0.0f32; 8];
        player.fill_into(&mut out);
        assert!(player.is_playing(), "is_playing must be true during active playback");

        // Drain all remaining samples (player has 2 channels so 6000 floats = 3000 frames)
        let mut drain = vec![0.0f32; 6000];
        player.fill_into(&mut drain);
        assert!(!player.is_playing(), "is_playing must return false once ring buffer is empty");
    }

    #[tokio::test]
    async fn test_jitter_player_flush_resamplers_preserves_rate() {
        // Bug 23 Regression Test: flush_resamplers must NOT clobber last_in_rate to 24000
        let player = JitterPlayer::new(48_000, 2, 20);
        // Explicit 48kHz audio push
        let pcm = vec![0u8; 960];
        player.push_audio_with_rate(&pcm, 48_000).await;
        assert_eq!(*player.last_in_rate.lock(), 48_000, "rate should be 48000 after 48k chunk");

        // Utterance boundary: resamplers flushed
        player.flush_resamplers().await;

        // Verify last_in_rate was preserved and NOT reset to 24000
        assert_eq!(
            *player.last_in_rate.lock(),
            48_000,
            "flush_resamplers must NOT clobber last_in_rate to 24000 on utterance end"
        );

        // Subsequent utterance chunk arrives with omitted rate (explicit_rate = 0)
        player.push_audio_with_rate(&pcm, 0).await;
        assert_eq!(
            *player.last_in_rate.lock(),
            48_000,
            "omitted rate chunk in subsequent utterance must retain active 48kHz rate, not 24kHz"
        );
    }

    #[tokio::test]
    async fn test_jitter_player_concurrent_fill_and_is_playing_no_deadlock() {
        use std::sync::Arc;

        let player = Arc::new(JitterPlayer::new(48_000, 2, 20));
        let pcm = vec![0u8; 960];
        player.push_audio(&pcm).await;

        let p1 = Arc::clone(&player);
        let p2 = Arc::clone(&player);

        // Task 1: simulates cpal audio callback running fill_into concurrently
        let h1 = tokio::spawn(async move {
            let mut out = [0.0f32; 128];
            for _ in 0..10_000 {
                p1.fill_into(&mut out);
            }
        });

        // Task 2: simulates tokio task calling is_playing concurrently
        let h2 = tokio::spawn(async move {
            for _ in 0..10_000 {
                let _ = p2.is_playing();
            }
        });

        let (r1, r2) = tokio::join!(h1, h2);
        assert!(r1.is_ok());
        assert!(r2.is_ok());
    }

    #[tokio::test]
    async fn test_jitter_player_starvation_prevention_for_short_utterance() {
        // Target ms is 100ms (4800 samples)
        let player = JitterPlayer::new(48_000, 1, 100);
        // Push only 480 samples (10ms of audio, far below 100ms target)
        let pcm = vec![0u8; 960];
        player.push_audio_with_rate(&pcm, 48_000).await;
        assert_eq!(player.ring.lock().len(), 480);
        assert!(!player.is_playing());

        let mut out = [0.0f32; 48];
        // Callbacks 1 & 2: still waiting
        player.fill_into(&mut out);
        assert!(!player.is_playing());
        player.fill_into(&mut out);
        assert!(!player.is_playing());

        // Callback 3: waited >= 3 triggers starvation prevention, playing starts
        player.fill_into(&mut out);
        assert!(player.is_playing(), "Starvation prevention must trigger playing for short utterance");
    }

    #[tokio::test]
    async fn test_jitter_player_flush_resamplers_triggers_playback_for_short_utterance() {
        // Target ms is 100ms (4800 samples)
        let player = JitterPlayer::new(48_000, 1, 100);
        // Push only 480 samples
        let pcm = vec![0u8; 960];
        player.push_audio_with_rate(&pcm, 48_000).await;
        assert!(!player.is_playing());

        // Utterance ends (is_last = true)
        player.flush_resamplers().await;
        assert!(player.is_playing(), "flush_resamplers on utterance end must trigger playing if ring has samples");
    }
}
