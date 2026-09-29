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

/// Ring buffer size in samples. 48kHz * 1 channel * 2.0s = 96000 samples.
const CAPTURE_RING_SAMPLES: usize = 96000;

/// RAII wrapper for a cpal Stream that implements Send.
pub struct SendStream(pub Stream);
unsafe impl Send for SendStream {}
impl std::ops::Deref for SendStream {
    type Target = Stream;
    fn deref(&self) -> &Self::Target { &self.0 }
}
impl std::ops::DerefMut for SendStream {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.0 }
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
    input_stream: Mutex<Option<SendStream>>,
    output_stream: Mutex<Option<SendStream>>,
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
    mic_muted: Arc<AtomicBool>,
}

impl AudioPipeline {
    pub fn start(
        cfg: AudioPipelineConfig,
        relay: RelaySocket,
        app: AppHandle,
    ) -> Result<Arc<Self>> {
        let running = Arc::new(AtomicBool::new(true));
        let input_gain = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        let mic_muted = Arc::new(AtomicBool::new(false));
        let (prod, cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();

        let (input_stream, in_rate, in_ch) =
            open_input_stream(cfg.input_device.as_deref(), prod, running.clone(), input_gain.clone(), mic_muted.clone(), Some(app.clone()))?;
        input_stream.play().context("start input stream")?;

        let (out_rate, out_ch) = {
            let host = cpal::default_host();
            let dev = pick_output_device(&host, cfg.output_device.as_deref())?;
            let dcfg = dev.default_output_config().context("default output config")?;
            (dcfg.sample_rate().0, dcfg.channels() as usize)
        };

        let jitter = Arc::new(JitterPlayer::new(out_rate, out_ch, cfg.jitter_buffer_ms));

        let (output_stream, out_rate_actual, out_ch_actual) =
            open_output_stream(cfg.output_device.as_deref(), cfg.jitter_buffer_ms, jitter.clone(), Some(app.clone()))?;
        if out_rate_actual != out_rate || out_ch_actual != out_ch {
            jitter.update_output_config(out_rate_actual, out_ch_actual);
        }
        output_stream.play().context("start output stream")?;

        let (ring_tx, ring_rx) = tokio::sync::mpsc::unbounded_channel();
        let sender_task = {
            let relay = relay.clone();
            let app = app.clone();
            let running = running.clone();
            let target_rate = cfg.sample_rate;
            let chunk_ms = 500; // 0.5s chunks per Ollalink docs
            let jitter = jitter.clone();
            let mic_muted = mic_muted.clone();
            tokio::spawn(async move {
                if let Err(e) = run_sender_watch(cons, ring_rx, in_rate, in_ch, target_rate, chunk_ms, relay, app.clone(), running, jitter, mic_muted).await {
                    tracing::error!(error=%e, "sender task failed");
                    let _ = app.emit("audio-error", e.to_string());
                }
            })
        };

        let playback_task = {
            let relay = relay.clone();
            let jitter = jitter.clone();
            let running = running.clone();
            tokio::spawn(async move {
                while running.load(Ordering::Relaxed) {
                    match relay.next_inbound_audio().await {
                        Some((ref audio_bytes, sr, is_last)) => {
                            if !audio_bytes.is_empty() {
                                jitter.push_audio_with_rate(audio_bytes, sr).await;
                            }
                            if is_last {
                                jitter.flush_resamplers().await;
                            }
                        }
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
            mic_muted: mic_muted.clone(),
        }))
    }

    pub fn set_input_gain(&self, v: f32) {
        self.input_gain.store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::Relaxed);
    }

    pub async fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(s) = self.input_stream.lock().take() { let _ = s.pause(); }
        let playback_task = self.playback_task.lock().take();
        if let Some(t) = playback_task { let _ = tokio::time::timeout(std::time::Duration::from_millis(500), t).await; }
        if let Some(s) = self.output_stream.lock().take() { let _ = s.pause(); }
        let sender_task = self.sender_task.lock().take();
        if let Some(t) = sender_task { let _ = tokio::time::timeout(std::time::Duration::from_millis(200), t).await; }
    }

    pub async fn swap_input_device(&self, name: Option<String>) -> Result<()> {
        if let Some(s) = self.input_stream.lock().take() { let _ = s.pause(); }
        let (new_prod, new_cons) = HeapRb::<f32>::new(CAPTURE_RING_SAMPLES).split();
        let (new_stream, rate, _ch) = open_input_stream(
            name.as_deref().or(self.cfg.input_device.as_deref()),
            new_prod, self.running.clone(), self.input_gain.clone(), Arc::new(AtomicBool::new(false)),
            Some(self.app.clone()),
        )?;
        new_stream.play().context("restart input stream")?;
        *self.input_stream.lock() = Some(SendStream(new_stream));
        let _ = self.input_ring_tx.send((new_cons, rate));
        Ok(())
    }

    pub async fn swap_output_device(&self, name: Option<String>) -> Result<()> {
        if let Some(s) = self.output_stream.lock().take() { let _ = s.pause(); }
        let (new_stream, rate, ch) = open_output_stream(
            name.as_deref().or(self.cfg.output_device.as_deref()),
            self.cfg.jitter_buffer_ms, self.jitter.clone(), Some(self.app.clone()),
        )?;
        self.jitter.update_output_config(rate, ch);
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
            if d.name().map(|nm| nm == n).unwrap_or(false) { return Ok(d); }
        }
    }
    host.default_input_device().context("no default input device")
}

fn pick_output_device(host: &Host, name: Option<&str>) -> Result<Device> {
    if let Some(n) = name {
        for d in host.output_devices()? {
            if d.name().map(|nm| nm == n).unwrap_or(false) { return Ok(d); }
        }
    }
    host.default_output_device().context("no default output device")
}

fn open_input_stream(
    name: Option<&str>, ring: ringbuf::HeapProd<f32>, running: Arc<AtomicBool>,
    gain: Arc<AtomicU32>, mic_muted: Arc<AtomicBool>, app: Option<AppHandle>,
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
            let _ = a.emit("audio-device-lost", serde_json::json!({ "kind": "input", "error": e.to_string() }));
        }
    };
    let mut ring_mut = ring;

    macro_rules! build {
        ($t:ty) => {
            device.build_input_stream(
                &sconfig,
                move |data: &[$t], _| {
                    if !running.load(Ordering::Relaxed) { return; }
                    if mic_muted.load(Ordering::Relaxed) { return; }
                    let g = f32::from_bits(gain.load(Ordering::Relaxed));
                    if channels == 1 {
                        for &s in data {
                            let _ = ring_mut.try_push(<f32 as cpal::FromSample<$t>>::from_sample_(s) * g);
                        }
                    } else {
                        for chunk in data.chunks_exact(channels) {
                            let s = <f32 as cpal::FromSample<$t>>::from_sample_(chunk[0]);
                            let _ = ring_mut.try_push(s * g);
                        }
                    }
                },
                err_fn, None,
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
    name: Option<&str>, jitter_ms: u32, jitter: Arc<JitterPlayer>, app: Option<AppHandle>,
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
            let _ = a.emit("audio-device-lost", serde_json::json!({ "kind": "output", "error": e.to_string() }));
        }
    };
    macro_rules! build {
        ($t:ty) => {
            device.build_output_stream(
                &sconfig,
                move |data: &mut [$t], _| { jitter_for_cb.fill_into(data); },
                err_fn, None,
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
// Sender task — dumb pipe per Ollalink docs
// ---------------------------------------------------------------------------

async fn run_sender_watch(
    mut ring: ringbuf::HeapCons<f32>,
    mut ring_rx: tokio::sync::mpsc::UnboundedReceiver<(ringbuf::HeapCons<f32>, u32)>,
    mut in_rate: u32,
    _in_channels: usize,
    target_rate: u32,
    chunk_ms: u32,
    relay: RelaySocket,
    app: AppHandle,
    running: Arc<AtomicBool>,
    _jitter: Arc<JitterPlayer>,
    mic_muted: Arc<AtomicBool>,
) -> Result<()> {
    // Dumb-pipe sender per Ollalink docs:
    // "stream 16kHz mono s16le PCM binary frames (~0.5s each), paced at real time"
    // No client-side VAD, no pre-roll, no audio.commit — Ollalink's endpointing.silence_ms handles all segmentation.
    let chunk_samples = (target_rate as usize * chunk_ms as usize) / 1000;
    let chunk_duration = std::time::Duration::from_millis(chunk_ms as u64);
    let mut resampler = Resampler::new(in_rate, target_rate)?;
    let mut pending: Vec<f32> = Vec::with_capacity(chunk_samples * 2);

    while running.load(Ordering::Relaxed) {
        if mic_muted.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        }

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
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
                maybe_new = ring_rx.recv() => {
                    match maybe_new {
                        Some((new_cons, new_rate)) => {
                            ring = new_cons;
                            if new_rate != in_rate {
                                in_rate = new_rate;
                                if let Ok(new_resampler) = Resampler::new(new_rate, target_rate) {
                                    resampler = new_resampler;
                                }
                            }
                        }
                        None => break,
                    }
                }
            }
            continue;
        }

        let raw: Vec<f32> = ring.pop_iter().take(available).collect();
        let resampled = resampler.process(&raw)?;
        pending.extend_from_slice(&resampled);

        let peak = raw.iter().fold(0.0f32, |acc, &x| acc.max(x.abs()));
        let _ = app.emit("vu-meter", peak);

        // Send complete 0.5s chunks at real time. Discard partial remainder (next iteration fills it).
        while pending.len() >= chunk_samples {
            let frame: Vec<f32> = pending.drain(..chunk_samples).collect();
            let mut pcm_out = Vec::with_capacity(chunk_samples * 2);
            for &s in &frame {
                let s16 = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                pcm_out.extend_from_slice(&s16.to_le_bytes());
            }
            if let Err(e) = relay.send_pcm(&pcm_out).await {
                tracing::warn!(error = %e, "relay send_pcm failed");
                break;
            }
            tokio::time::sleep(chunk_duration).await;
        }
    }
    Ok(())
}

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