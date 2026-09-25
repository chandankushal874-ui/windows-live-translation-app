//! audio/resample.rs - high-quality streaming resampler.
//!
//! Uses rubato's FftFixedIn for streaming resample from the device's native
//! rate (44.1/48/96 kHz) down to 16 kHz mono for upstream, and back
//! up for playback. Buffer-backed to guarantee exact frame sizes.

use anyhow::{Context, Result};
use rubato::{FftFixedIn, Resampler as RubatoResampler};

/// Streaming audio resampler. Construct once per direction per session.
pub struct Resampler {
    inner: FftFixedIn<f32>,
    in_buffer: Vec<f32>,
    in_rate: u32,
    out_rate: u32,
}

impl Resampler {
    /// in_rate/out_rate in Hz. Chunk size tuned to ~10 ms at the input rate.
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self> {
        let chunk_size = (in_rate as usize) / 100;
        let inner = FftFixedIn::<f32>::new(
            in_rate as usize,
            out_rate as usize,
            chunk_size,
            2, // sub-chunks
            1, // mono
        ).context("create rubato resampler")?;
        Ok(Self {
            inner,
            in_buffer: Vec::with_capacity(chunk_size * 4),
            in_rate,
            out_rate,
        })
    }

    /// Process a slice of mono f32 samples. Buffers arbitrary-length chunks and
    /// feeds rubato exact block sizes (input_frames_next). Never errors on frame size.
    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.is_empty() && self.in_buffer.is_empty() {
            return Ok(Vec::new());
        }
        self.in_buffer.extend_from_slice(input);

        let mut output = Vec::new();
        loop {
            let needed = self.inner.input_frames_next();
            if self.in_buffer.len() < needed {
                break;
            }
            let chunk: Vec<f32> = self.in_buffer.drain(..needed).collect();
            let resampled = self.inner.process(&[chunk], None).context("resample process")?;
            if let Some(mut ch0) = resampled.into_iter().next() {
                output.append(&mut ch0);
            }
        }
        Ok(output)
    }

    #[allow(dead_code)]
    pub fn in_rate(&self) -> u32 { self.in_rate }
    #[allow(dead_code)]
    pub fn out_rate(&self) -> u32 { self.out_rate }
}
