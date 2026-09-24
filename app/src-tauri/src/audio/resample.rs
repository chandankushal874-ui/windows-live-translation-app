//! audio/resample.rs â€” high-quality offline-online hybrid resampler.
//!
//! Uses `rubato`'s SincFixedIn for streaming resample from the device's native
//! rate (any of 44.1/48/96 kHz) down to 16 kHz mono for upstream, and back
//! up for playback. Chunked, allocation-friendly.

use anyhow::{Context, Result};
use rubato::{FftFixedIn, Resampler as RubatoResampler};

/// Streaming audio resampler. Construct once per direction per session.
pub struct Resampler {
    inner: FftFixedIn<f32>,
    #[allow(dead_code)]
    in_rate: u32,
    #[allow(dead_code)]
    out_rate: u32,
}

impl Resampler {
    /// `in_rate`/`out_rate` in Hz. Chunk size tuned to ~10 ms at the input rate.
    pub fn new(#[allow(dead_code)]
    in_rate: u32, out_rate: u32) -> Result<Self> {
        let chunk_size = (in_rate as usize) / 100;
        let inner = FftFixedIn::<f32>::new(
            in_rate as usize,
            out_rate as usize,
            chunk_size,
            2, // sub-chunks
            1, // mono
        ).context("create rubato resampler")?;
        Ok(Self { inner, in_rate, out_rate })
    }

    /// Process a slice of mono f32 samples. Returns an owned Vec of resampled
    /// samples (at `out_rate`). Latency is roughly the FFT size.
    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.is_empty() {
            return Ok(Vec::new());
        }
        let block = self.inner.input_frames_next();
        let needed = block.saturating_sub(input.len());
        let mut buf = Vec::with_capacity(input.len() + needed);
        buf.extend_from_slice(input);
        if needed > 0 {
            buf.extend(std::iter::repeat(0.0).take(needed));
        }
        let out = self.inner.process(&[buf], None).context("resample process")?;
        Ok(out.into_iter().next().unwrap_or_default())
    }

    #[allow(dead_code)]
    pub fn in_rate(&self) -> u32 { self.in_rate }
    #[allow(dead_code)]
    pub fn out_rate(&self) -> u32 { self.out_rate }
}
