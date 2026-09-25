//! audio/mod.rs Ã¢â‚¬â€ capture + playback pipeline.
//!
//! Goals:
//!   * Hot-path allocation-free: all PCM moves through a pre-allocated ring buffer.
//!   * Never block the audio callback on network.
//!   * Resample the mic input (typically 48 kHz) to 16 kHz mono s16le before send.
//!   * Resample inbound 48 kHz audio (from Ollalink) to the output device rate.
//!   * Support mid-call device hot-swap (drop and reopen the stream).
//!
//! Threading model:
//!   * cpal pushes frames into a lock-free SPSC ring.
//!   * A dedicated tokio task drains the ring, resamples, frames into ~20ms chunks,
//!     and forwards to the RelaySocket.
//!   * Inbound frames go to a playback jitter buffer; cpal output callback pops.

pub mod jitter;
pub mod resample;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use ringbuf::traits::Observer;

pub struct SendStream(pub Stream);
unsafe impl Send for SendStream {}
impl std::ops::Deref for SendStream {
    type Target = Stream;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for SendStream {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

use crate::ws::RelaySocket;

pub use jitter::JitterPlayer;
pub use resample::Resampler;

const CAPTURE_RING_SAMPLES: usize = 192_000;

#[derive(Debug, Clone)]
pub struct AudioPipelineConfig {
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub sample_rate: u32,
    pub frame_ms: u32,
    pub jitter_buffer_ms: u32,
}

pub struct AudioPipeline {
    // Mutable stream handles. Swapped atomically on hot-swap.
    input_stream: Mutex<Option<SendStream>>,
    output_stream: Mutex<Option<SendStream>>,

    // The input ring is a split SPSC pair; swap_input_device signals the sender
    // task to swap its consumer via a watch channel rather than orphaning it.
    input_ring_tx: tokio::sync::mpsc::UnboundedSender<ringbuf::HeapCons<f32>>,
    // Parked producer for the CURRENT input stream (used by swap to construct a fresh pair).
    #[allow(dead_code)]
    ring_prod_parked: Mutex<Option<ringbuf::HeapProd<f32>>>,

    #[allow(dead_code)]
    relay: RelaySocket,
    app: AppHandle,

    running: Arc<AtomicBool>,
    input_gain: Arc<AtomicU32>,
    sender_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    playback_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    jitter: Arc<JitterPlayer>,
    cfg: AudioPipelineConfig,
}

impl AudioPipeline {
    pub fn start(
        cfg: AudioPipelineConfig,
        #[allow(dead_code)]
    relay: RelaySocket,
        app: AppHandle,
    ) -> Result<Arc<Self>> {
        let running = Arc::new(AtomicBool::new(true));
        let input_gain = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        let (prod, cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();

        // Open initial input stream
        let (input_stream, in_rate, in_ch) =
            open_input_stream(cfg.input_device.as_deref(), prod, running.clone(), input_gain.clone())?;
        input_stream.play().context("start input stream")?;

        // Discover output device's native rate/channels before constructing the player
        let (out_rate, out_ch) = {
            let host = cpal::default_host();
            let dev = pick_output_device(&host, cfg.output_device.as_deref())?;
            let dcfg = dev.default_output_config().context("default output config")?;
            (dcfg.sample_rate().0, dcfg.channels() as usize)
        };

        // Shared jitter player: playback task pushes, output callback pulls.
        let jitter = Arc::new(JitterPlayer::new(out_rate, out_ch, cfg.jitter_buffer_ms));

        let (output_stream, _rate2, _ch2) =
            open_output_stream(cfg.output_device.as_deref(), cfg.jitter_buffer_ms, jitter.clone())?;
        output_stream.play().context("start output stream")?;

        // Sender task: ring Ã¢â€ â€™ resample Ã¢â€ â€™ relay.
        // Subscribes to a watch channel so swap_input_device can hand it a fresh
        // consumer without restarting the task.
        let (ring_tx, ring_rx) = tokio::sync::mpsc::unbounded_channel();
        let sender_task = {
            let relay = relay.clone();
            let app = app.clone();
            let running = running.clone();
            let target_rate = cfg.sample_rate;
            let frame_ms = cfg.frame_ms;
            tokio::spawn(async move {
                if let Err(e) = run_sender_watch(cons, ring_rx, in_rate, in_ch, target_rate, frame_ms, relay, app.clone(), running).await {
                    tracing::error!(error=%e, "sender task failed");
                    let _ = app.emit("audio-error", e.to_string());
                }
            })
        };

        // Playback task: relay Ã¢â€ â€™ jitter
        let playback_task = {
            let relay = relay.clone();
            let jitter = jitter.clone();
            let running = running.clone();
            tokio::spawn(async move {
                while running.load(Ordering::Relaxed) {
                    match relay.next_inbound_audio().await {
                        Some(audio_bytes) => jitter.push_audio(&audio_bytes).await,
                        None => break,
                    }
                }
            })
        };

        Ok(Arc::new(Self {
            input_stream: Mutex::new(Some(SendStream(input_stream))),
            output_stream: Mutex::new(Some(SendStream(output_stream))),
            input_ring_tx: ring_tx,
            ring_prod_parked: Mutex::new(None),
            relay,
            app,
            running,
            input_gain,
            sender_task: Mutex::new(Some(sender_task)),
            playback_task: Mutex::new(Some(playback_task)),
            jitter,
            cfg,
        }))
    }

    pub fn set_input_gain(&self, v: f32) {
        self.input_gain.store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    /// Gracefully stop. Blocks until playback finishes draining (max 500 ms).
    pub async fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);

        // Pause capture immediately.
        if let Some(s) = self.input_stream.lock().take() {
            let _ = s.pause();
        }
        // Signal playback to drain: close the relay audio channel by dropping
        // the sender. The playback task will see None and exit; existing
        // buffered audio will play out.
        //
        // JitterPlayer continues to serve from its internal ring Ã¢â‚¬â€ the cpal
        // output callback will pull silence once drained.
        let playback_task = self.playback_task.lock().take();
        if let Some(t) = playback_task {
            // Give it up to 500 ms to drain naturally; otherwise hard-abort.
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), t).await;
        }
        // Then stop the speaker.
        if let Some(s) = self.output_stream.lock().take() {
            let _ = s.pause();
        }
        // Finally the sender task (no more mic data anyway).
        let sender_task = self.sender_task.lock().take();
        if let Some(t) = sender_task {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(200), t).await;
        }
    }

    /// Hot-swap the input device mid-call. Drops the old stream, opens a new one
    /// with a fresh ring, and signals the sender task to swap its consumer via
    /// the watch channel. No audio loss beyond the brief device open.
    pub async fn swap_input_device(&self, name: Option<String>) -> Result<()> {
        // 1. Pause current stream
        if let Some(s) = self.input_stream.lock().take() {
            let _ = s.pause();
        }
        // 2. Build a fresh SPSC pair. The producer goes into the new cpal callback;
        //    the consumer will be handed to the sender task.
        let (new_prod, new_cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();
        let (new_stream, _rate, _ch) = open_input_stream(
            name.as_deref().or(self.cfg.input_device.as_deref()),
            new_prod,
            self.running.clone(),
            self.input_gain.clone(),
        )?;
        new_stream.play().context("restart input stream")?;

        // 3. Hand the new consumer to the sender task.
        if let Err(e) = self.input_ring_tx.send(new_cons) {
            return Err(anyhow!("sender task gone: {e}"));
        }
        *self.input_stream.lock() = Some(SendStream(new_stream));
        let _ = self.app.emit("device-swapped", serde_json::json!({ "kind": "input", "name": name }));
        Ok(())
    }

    /// Hot-swap the output device mid-call. Rebuilds the stream; playback task keeps
    /// pushing into the same shared JitterPlayer.
    pub async fn swap_output_device(&self, name: Option<String>) -> Result<()> {
        if let Some(s) = self.output_stream.lock().take() {
            let _ = s.pause();
        }
        let (new_stream, _rate, _ch) = open_output_stream(
            name.as_deref().or(self.cfg.output_device.as_deref()),
            self.cfg.jitter_buffer_ms,
            self.jitter.clone(),
        )?;
        new_stream.play().context("restart output stream")?;
        *self.output_stream.lock() = Some(SendStream(new_stream));
        let _ = self.app.emit("device-swapped", serde_json::json!({ "kind": "output", "name": name }));
        Ok(())
    }

    #[allow(dead_code)]
    pub fn buffered_ms(&self) -> u32 {
        self.jitter.buffered_ms()
    }
}

impl Drop for AudioPipeline {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------------

fn pick_input_device(host: &cpal::Host, name: Option<&str>) -> Result<Device> {
    if let Some(want) = name {
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                if d.name().ok().as_deref() == Some(want) { return Ok(d); }
            }
        }
        tracing::warn!("Requested input device '{want}' not found, falling back to default");
    }
    host.default_input_device().context("no default input device")
}

fn pick_output_device(host: &cpal::Host, name: Option<&str>) -> Result<Device> {
    if let Some(want) = name {
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                if d.name().ok().as_deref() == Some(want) { return Ok(d); }
            }
        }
        tracing::warn!("Requested output device '{want}' not found, falling back to default");
    }
    host.default_output_device().context("no default output device")
}

fn open_input_stream(
    name: Option<&str>,
    ring: ringbuf::HeapProd<f32>,
    running: Arc<AtomicBool>,
    gain: Arc<AtomicU32>,
) -> Result<(Stream, u32, usize)> {
    let host = cpal::default_host();
    let device = pick_input_device(&host, name)?;
    let cfg = device.default_input_config().context("default input config")?;
    let rate = cfg.sample_rate().0;
    let channels = cfg.channels() as usize;
    let sconfig: StreamConfig = cfg.clone().into();
    let fmt = cfg.sample_format();

    let err_fn = |e| tracing::error!(error=%e, "input stream error");
    let mut ring_mut = ring;

    macro_rules! build {
        ($t:ty) => {
            device.build_input_stream(
                &sconfig,
                move |data: &[$t], _| {
                    if !running.load(Ordering::Relaxed) { return; }
                    let g = f32::from_bits(gain.load(Ordering::Relaxed));
                    if channels == 1 {
                        for &s in data {
                            let _ = ring_mut.try_push(<f32 as cpal::FromSample<$t>>::from_sample_(s) * g);
                        }
                    } else {
                        for chunk in data.chunks_exact(channels) {
                            let sum: f32 = chunk.iter()
                                .map(|&s| <f32 as cpal::FromSample<$t>>::from_sample_(s))
                                .sum();
                            let _ = ring_mut.try_push((sum / channels as f32) * g);
                        }
                    }
                },
                err_fn,
                None,
            )
        };
    }

    let stream = match fmt {
        SampleFormat::F32 => build!(f32)?,
        SampleFormat::I16 => build!(i16)?,
        SampleFormat::U16 => build!(u16)?,
        f => return Err(anyhow!("unsupported input sample format: {f:?}")),
    };
    Ok((stream, rate, channels))
}

fn open_output_stream(
    name: Option<&str>,
    jitter_ms: u32,
    jitter: Arc<JitterPlayer>,
) -> Result<(Stream, u32, usize)> {
    let host = cpal::default_host();
    let device = pick_output_device(&host, name)?;
    let cfg = device.default_output_config().context("default output config")?;
    let rate = cfg.sample_rate().0;
    let channels = cfg.channels() as usize;
    let sconfig: StreamConfig = cfg.clone().into();
    let fmt = cfg.sample_format();

    let _ = jitter_ms; // target buffer length is configured on the shared JitterPlayer

    let jitter_for_cb = jitter.clone();
    let err_fn = |e| tracing::error!(error=%e, "output stream error");
    macro_rules! build {
        ($t:ty) => {
            device.build_output_stream(
                &sconfig,
                move |out: &mut [$t], _| {
                    jitter_for_cb.fill_into(out);
                },
                err_fn,
                None,
            )
        };
    }

    let stream = match fmt {
        SampleFormat::F32 => build!(f32)?,
        SampleFormat::I16 => build!(i16)?,
        SampleFormat::U16 => build!(u16)?,
        f => return Err(anyhow!("unsupported output sample format: {f:?}")),
    };
    Ok((stream, rate, channels))
}

// ---------------------------------------------------------------------------
// Sender task
// ---------------------------------------------------------------------------

/// Like run_sender, but takes the consumer through a watch channel so the
/// pipeline can swap to a different ring on device hot-swap.
async fn run_sender_watch(
    mut ring: ringbuf::HeapCons<f32>,
    mut ring_rx: tokio::sync::mpsc::UnboundedReceiver<ringbuf::HeapCons<f32>>,
    in_rate: u32,
    _in_channels: usize,
    target_rate: u32,
    frame_ms: u32,
    #[allow(dead_code)]
    relay: RelaySocket,
    app: AppHandle,
    running: Arc<AtomicBool>,
) -> Result<()> {
    let frame_samples = (target_rate as usize * frame_ms as usize) / 1000;
    let mut resampler = Resampler::new(in_rate, target_rate)?;
    let mut scratch = Vec::<f32>::with_capacity(frame_samples * 4);
    let mut pcm_out = Vec::<u8>::with_capacity(frame_samples * 2);
    let mut pending: Vec<f32> = Vec::with_capacity(frame_samples);
    let mut dropped_overflow_samples: u64 = 0;
    let mut last_overflow_log = std::time::Instant::now();
    let mut is_speaking = false;
    let mut last_speech_time = std::time::Instant::now();

    while running.load(Ordering::Relaxed) {
        // Pull the latest consumer (cheap; only re-borrowed on change).
        if let Ok(new_cons) = ring_rx.try_recv() {
            ring = new_cons;
        }

        let available = ring.occupied_len();
        if available == 0 {
            // Fast path: still sleep, but yield quickly if the ring was swapped.
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
                maybe_new = ring_rx.recv() => {
                    match maybe_new {
                        Some(new_cons) => { ring = new_cons; }
                        None => { break; }
                    }
                }
            }
            continue;
        }
        scratch.clear();
        scratch.extend(ring.pop_iter().take(available));

        let resampled = resampler.process(&scratch)?;
        pending.extend_from_slice(&resampled);

        while pending.len() >= frame_samples {
            let frame: Vec<f32> = pending.drain(..frame_samples).collect();
            
            // Calculate RMS energy for Noise Gate and Client-Side VAD
            let sum_sq: f32 = frame.iter().map(|&x| x * x).sum();
            let rms = (sum_sq / frame.len() as f32).sqrt();
            let is_quiet = rms < 0.012f32;

            if rms >= 0.018f32 {
                is_speaking = true;
                last_speech_time = std::time::Instant::now();
            } else if is_quiet && is_speaking && last_speech_time.elapsed() >= std::time::Duration::from_millis(350) {
                // Pause detected: commit partial speech instantly to eliminate 1-minute buffer latency
                is_speaking = false;
                let _ = relay.send_json(serde_json::json!({ "type": "audio.commit" })).await;
            }

            pcm_out.clear();
            for &s in &frame {
                let val = if is_quiet { 0.0f32 } else { s };
                let s16 = (val.clamp(-1.0, 1.0) * 32767.0) as i16;
                pcm_out.extend_from_slice(&s16.to_le_bytes());
            }
            if let Err(e) = relay.send_pcm(&pcm_out).await {
                tracing::warn!(error = %e, "relay send_pcm failed");
                break;
            }
            if pending.len() >= frame_samples {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }

        let peak = scratch.iter().fold(0.0f32, |acc, &x| acc.max(x.abs()));
        let _ = app.emit("vu-meter", peak);
        if last_overflow_log.elapsed().as_secs() >= 5 {
            if dropped_overflow_samples > 0 {
                tracing::warn!(dropped = dropped_overflow_samples, "capture overflow dropped samples");
                dropped_overflow_samples = 0;
            }
            last_overflow_log = std::time::Instant::now();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

pub fn list_devices() -> Result<crate::commands::AudioDeviceList> {
    let host = cpal::default_host();
    let inputs = host.input_devices()?.filter_map(|d| d.name().ok()).collect();
    let outputs = host.output_devices()?.filter_map(|d| d.name().ok()).collect();
    let default_input = host.default_input_device().and_then(|d| d.name().ok());
    let default_output = host.default_output_device().and_then(|d| d.name().ok());
    Ok(crate::commands::AudioDeviceList {
        inputs, outputs, default_input, default_output,
    })
}

