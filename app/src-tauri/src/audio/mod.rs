//! audio/mod.rs — audio pipeline wiring CPAL to the relay socket.
//!
//! Owns two audio streams:
//!   - Input:  cpal input stream -> ring buffer -> Resampler -> Relay (via WS PCM frames)
//!   - Output: Relay (via WS PCM frames) -> JitterPlayer -> cpal output stream
//!
//! Supports seamless hot-swapping of input/output devices mid-call without
//! dropping the session or distorting sample rates.

pub mod jitter;
pub mod resample;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, SampleFormat, Stream, StreamConfig};
use parking_lot::Mutex;
use ringbuf::{traits::*, HeapRb};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::ws::RelaySocket;
use jitter::JitterPlayer;
use resample::Resampler;

/// Ring buffer size in samples. 48kHz * 2 channels * 0.5s = 48000 samples.
const CAPTURE_RING_SAMPLES: usize = 48000;

/// RAII wrapper for a cpal Stream that implements Send.
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
    // task to swap its consumer and update the native sample rate via this channel.
    input_ring_tx: tokio::sync::mpsc::UnboundedSender<(ringbuf::HeapCons<f32>, u32)>,
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
        relay: RelaySocket,
        app: AppHandle,
    ) -> Result<Arc<Self>> {
        let running = Arc::new(AtomicBool::new(true));
        let input_gain = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        let (prod, cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();

        // Open initial input stream
        let (input_stream, in_rate, in_ch) =
            open_input_stream(cfg.input_device.as_deref(), prod, running.clone(), input_gain.clone(), Some(app.clone()))?;
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
            open_output_stream(cfg.output_device.as_deref(), cfg.jitter_buffer_ms, jitter.clone(), Some(app.clone()))?;
        output_stream.play().context("start output stream")?;

        // Sender task: ring -> resample -> relay.
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

        // Playback task: relay -> jitter
        let playback_task = {
            let relay = relay.clone();
            let jitter = jitter.clone();
            let running = running.clone();
            tokio::spawn(async move {
                while running.load(Ordering::Relaxed) {
                    match relay.next_inbound_audio().await {
                        Some(ref audio_bytes) => jitter.push_audio(audio_bytes).await,
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

    /// Gracefully stop.
    pub async fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);

        if let Some(s) = self.input_stream.lock().take() {
            let _ = s.pause();
        }
        let playback_task = self.playback_task.lock().take();
        if let Some(t) = playback_task {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), t).await;
        }
        if let Some(s) = self.output_stream.lock().take() {
            let _ = s.pause();
        }
        let sender_task = self.sender_task.lock().take();
        if let Some(t) = sender_task {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(200), t).await;
        }
    }

    /// Hot-swap the input device mid-call.
    pub async fn swap_input_device(&self, name: Option<String>) -> Result<()> {
        if let Some(s) = self.input_stream.lock().take() {
            let _ = s.pause();
        }
        let (new_prod, new_cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();
        let (new_stream, rate, _ch) = open_input_stream(
            name.as_deref().or(self.cfg.input_device.as_deref()),
            new_prod,
            self.running.clone(),
            self.input_gain.clone(),
            Some(self.app.clone()),
        )?;
        new_stream.play().context("restart input stream")?;

        *self.input_stream.lock() = Some(SendStream(new_stream));
        let _ = self.input_ring_tx.send((new_cons, rate));
        Ok(())
    }

    /// Hot-swap the output device mid-call.
    pub async fn swap_output_device(&self, name: Option<String>) -> Result<()> {
        if let Some(s) = self.output_stream.lock().take() {
            let _ = s.pause();
        }
        let (new_stream, _rate, _ch) = open_output_stream(
            name.as_deref().or(self.cfg.output_device.as_deref()),
            self.cfg.jitter_buffer_ms,
            self.jitter.clone(),
            Some(self.app.clone()),
        )?;
        new_stream.play().context("restart output stream")?;
        *self.output_stream.lock() = Some(SendStream(new_stream));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers for opening streams with CPAL
// ---------------------------------------------------------------------------

fn pick_input_device(host: &Host, name: Option<&str>) -> Result<Device> {
    if let Some(n) = name {
        for d in host.input_devices()? {
            if d.name().map(|nm| nm == n).unwrap_or(false) {
                return Ok(d);
            }
        }
    }
    host.default_input_device().context("no default input device")
}

fn pick_output_device(host: &Host, name: Option<&str>) -> Result<Device> {
    if let Some(n) = name {
        for d in host.output_devices()? {
            if d.name().map(|nm| nm == n).unwrap_or(false) {
                return Ok(d);
            }
        }
    }
    host.default_output_device().context("no default output device")
}

fn open_input_stream(
    name: Option<&str>,
    ring: ringbuf::HeapProd<f32>,
    running: Arc<AtomicBool>,
    gain: Arc<AtomicU32>,
    app: Option<AppHandle>,
) -> Result<(Stream, u32, usize)> {
    let host = cpal::default_host();
    let device = pick_input_device(&host, name)?;
    let cfg = device.default_input_config().context("default input config")?;
    let rate = cfg.sample_rate().0;
    let channels = cfg.channels() as usize;
    let sconfig: StreamConfig = cfg.clone().into();
    let fmt = cfg.sample_format();

    let app_in = app.clone();
    let err_fn = move |e: cpal::StreamError| {
        tracing::error!(error=%e, "input stream error");
        if let Some(ref a) = app_in {
            let _ = a.emit("audio-device-lost", serde_json::json!({
                "kind": "input",
                "error": e.to_string(),
            }));
        }
    };
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
                        // For stereo / array mics (Intel Smart Sound, Realtek Array),
                        // take the primary front capsule (channel 0) to avoid destructive phase cancellation.
                        for chunk in data.chunks_exact(channels) {
                            let s = <f32 as cpal::FromSample<$t>>::from_sample_(chunk[0]);
                            let _ = ring_mut.try_push(s * g);
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
    app: Option<AppHandle>,
) -> Result<(Stream, u32, usize)> {
    let host = cpal::default_host();
    let device = pick_output_device(&host, name)?;
    let cfg = device.default_output_config().context("default output config")?;
    let rate = cfg.sample_rate().0;
    let channels = cfg.channels() as usize;
    let sconfig: StreamConfig = cfg.clone().into();
    let fmt = cfg.sample_format();
    let _ = jitter_ms;

    let jitter_for_cb = jitter.clone();
    let app_out = app.clone();
    let err_fn = move |e: cpal::StreamError| {
        tracing::error!(error=%e, "output stream error");
        if let Some(ref a) = app_out {
            let _ = a.emit("audio-device-lost", serde_json::json!({
                "kind": "output",
                "error": e.to_string(),
            }));
        }
    };
    macro_rules! build {
        ($t:ty) => {
            device.build_output_stream(
                &sconfig,
                move |data: &mut [$t], _| {
                    jitter_for_cb.fill_into(data);
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

async fn run_sender_watch(
    mut ring: ringbuf::HeapCons<f32>,
    mut ring_rx: tokio::sync::mpsc::UnboundedReceiver<(ringbuf::HeapCons<f32>, u32)>,
    mut in_rate: u32,
    _in_channels: usize,
    target_rate: u32,
    frame_ms: u32,
    relay: RelaySocket,
    app: AppHandle,
    running: Arc<AtomicBool>,
) -> Result<()> {
    let frame_samples = (target_rate as usize * frame_ms as usize) / 1000;
    let mut resampler = Resampler::new(in_rate, target_rate)?;
    let mut scratch = Vec::<f32>::with_capacity(frame_samples * 4);
    let mut pcm_out = Vec::<u8>::with_capacity(frame_samples * 2);
    let mut pending: Vec<f32> = Vec::with_capacity(frame_samples * 4);
    let mut dropped_overflow_samples: u64 = 0;
    let mut last_overflow_log = std::time::Instant::now();

    while running.load(Ordering::Relaxed) {
        // Pull latest consumer & sample rate on device hot-swap
        if let Ok((new_cons, new_rate)) = ring_rx.try_recv() {
            ring = new_cons;
            if new_rate != in_rate {
                tracing::info!(old = in_rate, new = new_rate, "updating resampler for swapped device");
                in_rate = new_rate;
                if let Ok(new_resampler) = Resampler::new(new_rate, target_rate) {
                    resampler = new_resampler;
                }
            }
        }

        let available = ring.occupied_len();
        if available == 0 {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
                maybe_new = ring_rx.recv() => {
                    match maybe_new {
                        Some((new_cons, new_rate)) => {
                            ring = new_cons;
                            if new_rate != in_rate {
                                tracing::info!(old = in_rate, new = new_rate, "updating resampler for swapped device");
                                in_rate = new_rate;
                                if let Ok(new_resampler) = Resampler::new(new_rate, target_rate) {
                                    resampler = new_resampler;
                                }
                            }
                        }
                        None => { break; }
                    }
                }
            }
            continue;
        }

        scratch.clear();
        scratch.extend(ring.pop_iter().take(available));

        // Resample clean microphone stream without artificial silence muting
        let resampled = resampler.process(&scratch)?;
        pending.extend_from_slice(&resampled);

        // Pack into regular 16kHz s16le PCM frames
        while pending.len() >= frame_samples {
            let frame: Vec<f32> = pending.drain(..frame_samples).collect();
            
            pcm_out.clear();
            for &s in &frame {
                let s16 = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
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
