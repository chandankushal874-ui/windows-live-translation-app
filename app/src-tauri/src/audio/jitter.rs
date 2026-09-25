//! audio/jitter.rs â€” playback jitter buffer.
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
use tokio::sync::Mutex as AsyncMutex;

const ASSUMED_IN_RATE: u32 = 48_000;

pub struct JitterPlayer {
    /// Output device rate (e.g. 48_000)
    out_rate: u32,
    /// Channels the output stream was opened with. Playback duplicates mono.
    out_channels: usize,
    /// Target buffer in milliseconds.
    target_ms: u32,
    /// Buffered samples (already resampled to out_rate, mono).
    ring: Mutex<VecDeque<f32>>,
    /// State flag for playback prebuffering
    playing: Mutex<bool>,
    /// Resamplers keyed by input sample rate (e.g. 48_000, 24_000 -> out_rate).
    resamplers: AsyncMutex<HashMap<u32, Resampler>>,
}

impl JitterPlayer {
    pub fn new(out_rate: u32, out_channels: usize, target_ms: u32) -> Self {
        Self {
            out_rate,
            out_channels: out_channels.max(1),
            target_ms,
            ring: Mutex::new(VecDeque::new()),
            playing: Mutex::new(false),
            resamplers: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Push an audio frame (either raw 48 kHz PCM s16le or 24 kHz WAV).
    /// Automatically detects RIFF/WAVE header, extracts sample rate, skips the
    /// header, and resamples dynamically to the output device rate.
    pub async fn push_audio(&self, bytes: &[u8]) {
        if bytes.is_empty() { return; }

        let (in_rate, raw_pcm) = if bytes.starts_with(b"RIFF") && bytes.len() >= 44 && &bytes[8..12] == b"WAVE" {
            let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
            let mut offset = 44;
            if let Some(pos) = bytes.windows(4).position(|w| w == b"data") {
                if pos + 8 <= bytes.len() {
                    offset = pos + 8;
                }
            }
            (if rate > 0 { rate } else { 24_000 }, &bytes[offset..])
        } else {
            (ASSUMED_IN_RATE, bytes)
        };

        if raw_pcm.is_empty() { return; }

        // Convert s16le bytes to f32
        let mut samples = Vec::with_capacity(raw_pcm.len() / 2);
        for chunk in raw_pcm.chunks_exact(2) {
            let i = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(i as f32 / 32768.0);
        }

        // Resample dynamically based on native input rate
        let resampled = if in_rate == self.out_rate {
            samples
        } else {
            let mut map = self.resamplers.lock().await;
            if !map.contains_key(&in_rate) {
                match Resampler::new(in_rate, self.out_rate) {
                    Ok(r) => { map.insert(in_rate, r); }
                    Err(e) => {
                        tracing::error!(error=%e, in_rate, "jitter resampler init failed");
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
                    tracing::error!(error=%e, in_rate, "jitter resample failed");
                    return;
                }
            }
        };

        // Append to ring, capping at 8x target.
        let cap = (self.out_rate as usize) * (self.target_ms as usize) * 8 / 1000;
        let mut ring = self.ring.lock();
        for s in resampled {
            if ring.len() >= cap {
                ring.pop_front();
            }
            ring.push_back(s);
        }
    }

    /// Push a 48 kHz mono s16le PCM frame (or WAV file) â€” preserves backwards compatibility.
    #[allow(dead_code)]
    pub async fn push_pcm48k(&self, bytes: &[u8]) {
        self.push_audio(bytes).await;
    }

    /// Fill an output interleaved buffer from the ring. Underrun -> silence.
    pub fn fill_into<T: cpal::Sample + cpal::FromSample<f32>>(&self, out: &mut [T]) {
        let needed = out.len();
        let mut ring = self.ring.lock();
        let target_len = (self.out_rate as usize) * (self.target_ms as usize) / 1000;

        let mut playing = self.playing.lock();

        // Gating only occurs before playback starts (pre-buffer)
        if !*playing {
            if ring.len() >= target_len {
                *playing = true;
            } else {
                for s in out.iter_mut() { *s = <T as cpal::FromSample<f32>>::from_sample_(0.0); }
                return;
            }
        }

        let ch = self.out_channels;
        let mut i = 0;
        while i < needed {
            if let Some(next) = ring.pop_front() {
                for c in 0..ch {
                    if i + c < needed {
                        out[i + c] = <T as cpal::FromSample<f32>>::from_sample_(next);
                    }
                }
                i += ch;
            } else {
                *playing = false;
                while i < needed {
                    out[i] = <T as cpal::FromSample<f32>>::from_sample_(0.0);
                    i += 1;
                }
                break;
            }
        }
    }

    #[allow(dead_code)]
    pub fn buffered_ms(&self) -> u32 {
        let len = self.ring.lock().len() as u32;
        len * 1000 / self.out_rate
    }
}
