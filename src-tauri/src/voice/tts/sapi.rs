//! The system's SAPI 5 voices (ADR 0003). SAPI plays through the default
//! output device itself, so there is no audio pipeline of ours to stall: a
//! purge (`SPF_PURGEBEFORESPEAK` with no text) silences it at once, which is
//! what the stop budget relies on. COM objects are apartment-bound, so the
//! engine lives and dies on the TTS worker thread.

use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Media::Speech::{
    IEnumSpObjectTokens, ISpObjectToken, ISpObjectTokenCategory, ISpVoice, SpObjectTokenCategory,
    SpVoice, SPCAT_VOICES, SPF_ASYNC, SPF_IS_NOT_XML, SPF_PURGEBEFORESPEAK, SPRS_DONE,
    SPVOICESTATUS,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use super::{Engine, VoiceInfo};

/// How often a running utterance checks for a stop. Well inside the 150 ms
/// stop budget, cheap enough to not matter.
const POLL: Duration = Duration::from_millis(20);

pub struct Sapi {
    voice: ISpVoice,
    voices: Vec<(VoiceInfo, ISpObjectToken)>,
    current: Option<String>,
}

fn take_wide(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAPI hands out CoTaskMem strings; we own them now.
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// SAPI stores the language as a hex LCID list ("407;409"); only the first
/// matters for us, and only the few we name in text.
fn lang_of(lcid: &str) -> String {
    let first = lcid.split(';').next().unwrap_or("");
    match u32::from_str_radix(first.trim(), 16).unwrap_or(0) & 0x3ff {
        0x07 => "de".into(),
        0x09 => "en".into(),
        _ => String::new(),
    }
}

fn enum_voices() -> windows::core::Result<Vec<(VoiceInfo, ISpObjectToken)>> {
    unsafe {
        let cat: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)?;
        cat.SetId(SPCAT_VOICES, false)?;
        let tokens: IEnumSpObjectTokens = cat.EnumTokens(PCWSTR::null(), PCWSTR::null())?;
        let mut count = 0u32;
        tokens.GetCount(&mut count)?;
        let mut out = Vec::new();
        for i in 0..count {
            let Ok(token) = tokens.Item(i) else { continue };
            let id = token.GetId().map(take_wide).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let name = token
                .GetStringValue(PCWSTR::null())
                .map(take_wide)
                .unwrap_or_else(|_| id.clone());
            let lang = token
                .OpenKey(windows::core::w!("Attributes"))
                .and_then(|k| k.GetStringValue(windows::core::w!("Language")))
                .map(take_wide)
                .map(|l| lang_of(&l))
                .unwrap_or_default();
            out.push((VoiceInfo { id, name, lang }, token));
        }
        Ok(out)
    }
}

impl Sapi {
    pub fn new() -> Result<Self, String> {
        unsafe {
            // MTA: SAPI's async speak runs on its own thread and needs no
            // message pump on ours.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let voice: ISpVoice =
                CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(|e| format!("sapi: {e}"))?;
            let voices = enum_voices().map_err(|e| format!("sapi voices: {e}"))?;
            Ok(Self {
                voice,
                voices,
                current: None,
            })
        }
    }

    fn select(&mut self, id: &str) {
        if self.current.as_deref() == Some(id) {
            return;
        }
        if let Some((_, token)) = self.voices.iter().find(|(v, _)| v.id == id) {
            if unsafe { self.voice.SetVoice(token) }.is_ok() {
                self.current = Some(id.to_owned());
            }
        }
    }

    fn purge(&self) {
        let _ = unsafe {
            self.voice
                .Speak(PCWSTR::null(), SPF_PURGEBEFORESPEAK.0 as u32, None)
        };
    }

    fn done(&self) -> bool {
        let mut status = SPVOICESTATUS::default();
        let ok = unsafe { self.voice.GetStatus(&mut status, std::ptr::null_mut()) }.is_ok();
        !ok || status.dwRunningState == SPRS_DONE.0 as u32
    }
}

impl Engine for Sapi {
    fn voices(&self) -> Vec<VoiceInfo> {
        self.voices.iter().map(|(v, _)| v.clone()).collect()
    }

    fn speak(
        &mut self,
        text: &str,
        voice: &str,
        volume: u8,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        self.select(voice);
        let text = wide(text);
        unsafe {
            let _ = self.voice.SetVolume(u16::from(volume.min(100)));
            let flags = SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0 | SPF_IS_NOT_XML.0;
            self.voice
                .Speak(PCWSTR(text.as_ptr()), flags as u32, None)
                .map_err(|e| format!("sapi speak: {e}"))?;
        }
        loop {
            if cancelled() {
                self.purge();
                return Ok(());
            }
            // Not WaitUntilDone: it overshoots its timeout while audio is
            // queued (measured ~140 ms stop latency), a plain sleep plus the
            // running state keeps the stop inside budget.
            std::thread::sleep(POLL);
            if self.done() {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Hardware smoke (speaks out loud): `cargo test sapi -- --ignored
    /// --nocapture`. Prints the voices and how long a stop takes to silence
    /// a running utterance — the budget is 150 ms.
    #[test]
    #[ignore]
    fn sapi_speaks_and_stops_within_budget() {
        let mut sapi = Sapi::new().expect("sapi");
        let voices = sapi.voices();
        println!("voices: {voices:?}");
        let voice = super::super::pick_voice(&voices, "").expect("a voice").id.clone();
        sapi.speak("Backend: fertig.", &voice, 60, &|| false).unwrap();
        let t0 = Instant::now();
        let stop_at = Duration::from_millis(700);
        sapi.speak(
            "Das ist ein langer Satz, der mitten im Sprechen abgebrochen wird, damit wir die Latenz messen.",
            &voice,
            60,
            &|| t0.elapsed() >= stop_at,
        )
        .unwrap();
        let latency = Instant::now().saturating_duration_since(t0 + stop_at);
        println!("stop latency: {latency:?}");
        assert!(sapi.done());
        assert!(latency < Duration::from_millis(150));
    }
}
