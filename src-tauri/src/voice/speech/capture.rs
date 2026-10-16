//! Microphone capture for the built-in speech source (SWA-38).
//!
//! The device delivers whatever it likes (48 kHz stereo i16/f32 is typical);
//! Whisper wants 16 kHz mono f32. The callback only downmixes and appends —
//! it runs on the WASAPI thread and must never block on anything slow — and
//! the resample to 16 kHz happens once, on stop. Downmix and resample are
//! pure and unit-tested; the cpal glue is not.
//!
//! The stream lives on its own thread for its whole life: cpal streams are
//! not `Send` on every host, and dropping the stream is what releases the
//! microphone (and the Windows privacy indicator), so the thread owns that
//! drop instead of whichever task happens to stop the dictation.

use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};

pub const WHISPER_RATE: u32 = 16_000;
/// Matches `PIN_TTL`: a dictation cannot outlive its pin anyway, so there is
/// no point buffering more than that.
pub const MAX_SECONDS: u32 = 120;

/// Average the channels of interleaved frames into mono.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let scale = 1.0 / channels as f32;
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() * scale),
    );
}

/// Linear interpolation. Good enough for speech into Whisper, which is
/// trained on far worse audio; a windowed-sinc resampler would be a new
/// dependency for no audible gain here.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let len = ((input.len() as f64) / ratio).floor() as usize;
    (0..len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos as usize;
            let frac = (pos - idx as f64) as f32;
            let a = input[idx];
            let b = *input.get(idx + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

pub struct Recorder {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<Vec<f32>>,
}

impl Recorder {
    /// Opens the default input device. Fails fast (before the caller shows a
    /// "recording" state) when there is no microphone or access is denied.
    pub fn start() -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("voice-capture".into())
            .spawn(move || run(ready_tx, stop_rx))
            .map_err(|e| format!("mic-unavailable: {e}"))?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop: stop_tx,
                thread,
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = stop_tx.send(());
                Err("mic-unavailable: device did not start".into())
            }
        }
    }

    /// Releases the microphone and returns 16 kHz mono samples.
    pub fn stop(self) -> Vec<f32> {
        let _ = self.stop.send(());
        self.thread.join().unwrap_or_default()
    }
}

fn run(ready: mpsc::Sender<Result<(), String>>, stop: mpsc::Receiver<()>) -> Vec<f32> {
    let opened = open();
    let (stream, buf, rate) = match opened {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return Vec::new();
        }
    };
    let _ = ready.send(Ok(()));
    // Any message or a dropped sender ends the recording.
    let _ = stop.recv();
    drop(stream);
    let mono = std::mem::take(&mut *buf.lock().unwrap());
    resample(&mono, rate, WHISPER_RATE)
}

type Opened = (cpal::Stream, Arc<Mutex<Vec<f32>>>, u32);

fn open() -> Result<Opened, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "mic-unavailable: no input device".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("mic-unavailable: {e}"))?;
    let rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let config = supported.config();
    let buf = Arc::new(Mutex::new(Vec::with_capacity(
        (rate * MAX_SECONDS.min(30)) as usize,
    )));
    let cap = (rate * MAX_SECONDS) as usize;
    use cpal::SampleFormat as F;
    let stream = match supported.sample_format() {
        F::F32 => build::<f32>(&device, config, channels, cap, buf.clone()),
        F::I16 => build::<i16>(&device, config, channels, cap, buf.clone()),
        F::I32 => build::<i32>(&device, config, channels, cap, buf.clone()),
        F::U16 => build::<u16>(&device, config, channels, cap, buf.clone()),
        F::U8 => build::<u8>(&device, config, channels, cap, buf.clone()),
        other => Err(format!("mic-unavailable: sample format {other:?}")),
    }?;
    stream.play().map_err(|e| format!("mic-unavailable: {e}"))?;
    Ok((stream, buf, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    cap: usize,
    buf: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                scratch.clear();
                scratch.extend(data.iter().map(|s| f32::from_sample(*s)));
                let mut out = buf.lock().unwrap();
                if out.len() < cap {
                    downmix(&scratch, channels, &mut out);
                    out.truncate(cap);
                }
            },
            |e| eprintln!("voice: capture error: {e}"),
            None,
        )
        .map_err(|e| format!("mic-unavailable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_frames_and_passes_mono_through() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
        downmix(&[0.25], 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.25]);
    }

    #[test]
    fn downmix_drops_a_partial_trailing_frame() {
        let mut out = Vec::new();
        downmix(&[1.0, 1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn resample_keeps_duration_and_interpolates() {
        let one_second: Vec<f32> = (0..48_000).map(|i| i as f32).collect();
        let out = resample(&one_second, 48_000, WHISPER_RATE);
        assert_eq!(out.len(), 16_000);
        assert_eq!(out[1], 3.0);
        assert_eq!(
            resample(&[0.0, 1.0], 16_000, 32_000),
            vec![0.0, 0.5, 1.0, 1.0]
        );
        assert_eq!(resample(&[0.3], 16_000, 16_000), vec![0.3]);
        assert!(resample(&[], 44_100, 16_000).is_empty());
    }
}
