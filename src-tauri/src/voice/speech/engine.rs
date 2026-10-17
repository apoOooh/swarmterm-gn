//! whisper.cpp on the CPU (SWA-38, ADR 0002). The context (model weights) is
//! loaded on first use and kept until the user picks another model — loading
//! `base` takes about as long as transcribing a sentence, so reloading per
//! dictation would double the wait. A fresh `WhisperState` per run keeps one
//! dictation from conditioning the next.

use std::path::Path;
use std::sync::Mutex;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<(String, WhisperContext)>>,
}

impl Engine {
    /// Blocking: call from `spawn_blocking`.
    pub fn transcribe(
        &self,
        model_path: &Path,
        samples: &[f32],
        language: &str,
    ) -> Result<String, String> {
        let key = model_path.to_string_lossy().into_owned();
        let mut loaded = self.loaded.lock().unwrap();
        if loaded.as_ref().map(|(k, _)| k != &key).unwrap_or(true) {
            // Drop the old weights before loading the new ones: two large
            // models side by side are over a gigabyte of RAM.
            *loaded = None;
            whisper_rs::install_logging_hooks();
            let ctx =
                WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                    .map_err(|e| format!("model-load-failed: {e}"))?;
            *loaded = Some((key, ctx));
        }
        let (_, ctx) = loaded.as_ref().expect("loaded above");
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("transcribe-failed: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_n_threads(threads());
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state
            .full(params, samples)
            .map_err(|e| format!("transcribe-failed: {e}"))?;
        let mut parts = Vec::new();
        for segment in state.as_iter() {
            if let Ok(text) = segment.to_str_lossy() {
                parts.push(text.into_owned());
            }
        }
        Ok(clean_transcript(&parts))
    }

    /// The model file is about to be deleted or replaced.
    pub fn unload(&self) {
        *self.loaded.lock().unwrap() = None;
    }
}

/// Leave a core for the UI and the PTY threads.
fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(1, 8) as i32)
        .unwrap_or(4)
}

/// Joins segments and drops Whisper's non-speech annotations
/// (`[BLANK_AUDIO]`, `(Musik)`, `[music]` …): silence must cancel the
/// dictation, not type a bracketed word into a shell.
pub fn clean_transcript(segments: &[String]) -> String {
    let mut out = String::new();
    for seg in segments {
        let t = seg.trim();
        let annotation = (t.starts_with('[') && t.ends_with(']'))
            || (t.starts_with('(') && t.ends_with(')'))
            || (t.starts_with('*') && t.ends_with('*') && t.len() > 1);
        if t.is_empty() || annotation {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn joins_trimmed_segments() {
        assert_eq!(
            clean_transcript(&s(&[" Hallo Welt.", " Wie geht's? "])),
            "Hallo Welt. Wie geht's?"
        );
    }

    #[test]
    fn silence_annotations_become_nothing() {
        assert_eq!(clean_transcript(&s(&[" [BLANK_AUDIO]"])), "");
        assert_eq!(clean_transcript(&s(&["(Musik)", " *Husten*", "  "])), "");
        assert_eq!(
            clean_transcript(&s(&["[music]", " Los geht's"])),
            "Los geht's"
        );
    }

    #[test]
    fn brackets_inside_speech_stay() {
        assert_eq!(
            clean_transcript(&s(&["Array [0] lesen"])),
            "Array [0] lesen"
        );
    }

    /// Latency probe for the ADR, not part of the suite:
    /// `SWA38_MODEL=<ggml-*.bin> SWA38_WAV=<16 kHz mono s16 wav>
    ///  cargo test --release engine::tests::probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe() {
        let model = std::env::var("SWA38_MODEL").expect("SWA38_MODEL");
        let wav = std::fs::read(std::env::var("SWA38_WAV").expect("SWA38_WAV")).unwrap();
        let samples = super::super::capture::pcm16(&wav[44..]);
        let engine = Engine::default();
        for run in 0..2 {
            let t = std::time::Instant::now();
            let text = engine
                .transcribe(Path::new(&model), &samples, "auto")
                .unwrap();
            println!(
                "run {run}: {:.1} s audio -> {:?} in {} ms",
                samples.len() as f32 / 16_000.0,
                text,
                t.elapsed().as_millis()
            );
        }
    }
}
