//! Built-in announcements (SWA-66, docs/adr/0003): Swarmterm says "<pane>:
//! fertig" itself instead of only pushing the fact to buzzkey.
//!
//! - `queue` / `text`: pure rules (what is still worth saying, what to say).
//! - this file: `TtsHub` (queue, stop generation, owner state) and the
//!   worker thread that owns the engine.
//! - `sapi` (Windows): the system's SAPI voices — no model download, no
//!   native dependency, no licence question (espeak-ng/GPL is why the
//!   sherpa-onnx route waits for its 2.0; see the ADR).
//!
//! Ownership (`ttsHandled`): `announce` decides under the hub lock whether
//! Swarmterm takes an event. Taken means Swarmterm says it OR drops it on
//! purpose (stale, recording, pane gone, engine error) — never "spoken yet",
//! and never handed back. buzzkey's fallback voice only speaks events that
//! were not taken, so the two never talk over each other.
//!
//! Half-duplex: the worker never speaks while anything records — a `begin`
//! in flight (`BeginGuard`), a live dictation pin, or the built-in
//! transcription — nor within `queue::TAIL` after; what was queued
//! meanwhile is dropped, not replayed. `begin` itself first silences the
//! voice and waits for it (`quiesce`), so a mic never opens on our speech.

pub mod queue;
#[cfg(windows)]
mod sapi;
pub mod text;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::completion::Reply;
use super::protocol::TurnKind;
use super::VoiceHub;
use queue::{Item, Queue};

/// A "Test voice" utterance; not tied to a pane, so no generation check.
const TEST_ID: &str = "__test__";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    /// "de", "en" or "" — only what the announcement text distinguishes.
    pub lang: String,
}

/// A speech backend. Lives on the worker thread (COM apartments).
pub trait Engine {
    fn voices(&self) -> Vec<VoiceInfo>;
    /// Blocks until the utterance ended or `cancelled` turned true; in the
    /// latter case the engine must be silent when this returns.
    fn speak(
        &mut self,
        text: &str,
        voice: &str,
        volume: u8,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String>;
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    pub ready: bool,
    pub error: Option<String>,
    pub voices: Vec<VoiceInfo>,
    pub speaking: bool,
}

#[derive(Default)]
struct Inner {
    queue: Queue,
    /// terminalId of the utterance playing right now.
    speaking: Option<String>,
    /// That utterance is a reply (SWA-58).
    speaking_reply: bool,
    ready: bool,
    error: Option<String>,
    voices: Vec<VoiceInfo>,
}

#[derive(Default)]
pub struct TtsHub {
    inner: Mutex<Inner>,
    cv: Condvar,
    /// Bumped (under `inner`) by every stop; an utterance started under an
    /// older value ends at its next poll.
    gen: AtomicU64,
    /// `begin`s in flight. Counted, not a flag: overlapping begins from
    /// different clients each hold their own guard.
    begins: AtomicUsize,
}

fn lang_of(voices: &[VoiceInfo], wanted: &str) -> String {
    pick_voice(voices, wanted)
        .map(|v| v.lang.clone())
        .unwrap_or_default()
}

/// The configured voice, else the first German one, else the first at all.
pub fn pick_voice<'a>(voices: &'a [VoiceInfo], wanted: &str) -> Option<&'a VoiceInfo> {
    voices
        .iter()
        .find(|v| !wanted.is_empty() && v.id == wanted)
        .or_else(|| voices.iter().find(|v| v.lang == "de"))
        .or_else(|| voices.first())
}

/// Holds the half-duplex gate shut for one `begin`, from before its first
/// await until it returns — then the pin (or the built-in transcription)
/// takes over. Drop releases exactly this guard, never someone else's.
pub struct BeginGuard<'a>(&'a TtsHub);

impl Drop for BeginGuard<'_> {
    fn drop(&mut self) {
        self.0.begins.fetch_sub(1, Ordering::SeqCst);
    }
}

impl TtsHub {
    pub fn begin_guard(&self) -> BeginGuard<'_> {
        self.begins.fetch_add(1, Ordering::SeqCst);
        BeginGuard(self)
    }

    /// Ready = the engine came up; whether announcing is switched on is the
    /// caller's settings check.
    pub fn ready(&self) -> bool {
        self.inner.lock().unwrap().ready
    }

    pub fn status(&self) -> TtsStatus {
        let inner = self.inner.lock().unwrap();
        TtsStatus {
            ready: inner.ready,
            error: inner.error.clone(),
            voices: inner.voices.clone(),
            speaking: inner.speaking.is_some(),
        }
    }

    /// Take an event (see the module doc for what "taken" promises). False
    /// when the engine is not up, so a fallback voice may step in.
    pub fn announce(
        &self,
        terminal_id: String,
        spawn_id: String,
        pane_name: &str,
        agent: &str,
        kind: TurnKind,
        voice: &str,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.ready {
            return false;
        }
        let lang = lang_of(&inner.voices, voice);
        inner.queue.push(Item {
            text: text::announcement(pane_name, agent, kind, &lang),
            terminal_id,
            spawn_id,
            at: std::time::Instant::now(),
            token: None,
            reply: false,
        });
        self.cv.notify_all();
        true
    }

    /// SWA-58: the agent's reply, queued like any announcement (same TTL,
    /// one per pane, same stop and half-duplex rules). `token` names the
    /// closed turn; the worker re-checks it and the opt-in before speaking.
    #[allow(clippy::too_many_arguments)]
    pub fn say_reply(
        &self,
        terminal_id: String,
        spawn_id: String,
        token: String,
        pane_name: &str,
        agent: &str,
        reply: &Reply,
        voice: &str,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.ready {
            return false;
        }
        let lang = lang_of(&inner.voices, voice);
        inner.queue.push(Item {
            text: text::reply_line(pane_name, agent, reply, &lang),
            terminal_id,
            spawn_id,
            at: std::time::Instant::now(),
            token: Some(token),
            reply: true,
        });
        self.cv.notify_all();
        true
    }

    /// "Allow excerpts" switched off: waiting replies go, a playing one
    /// ends at its next poll; statuses are left alone.
    pub fn stop_replies(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.queue.retain(|i| !i.reply);
        if inner.speaking_reply {
            self.gen.fetch_add(1, Ordering::SeqCst);
        }
        self.cv.notify_all();
    }

    pub fn test(&self, voice: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.ready {
            return Err(inner.error.clone().unwrap_or_else(|| "unavailable".into()));
        }
        let lang = lang_of(&inner.voices, voice);
        let text = if lang == "en" {
            "Swarmterm: this is how announcements sound."
        } else {
            "Swarmterm: So klingen die Ansagen."
        };
        inner.queue.push(Item {
            terminal_id: TEST_ID.into(),
            spawn_id: String::new(),
            text: text.into(),
            at: std::time::Instant::now(),
            token: None,
            reply: false,
        });
        self.cv.notify_all();
        Ok(())
    }

    /// Stop everything, or only what concerns one pane (the user looked at
    /// it). Clears the queue and ends the running utterance at its next poll.
    pub fn stop(&self, terminal_id: Option<&str>) {
        let mut inner = self.inner.lock().unwrap();
        match terminal_id {
            None => {
                inner.queue.clear();
                if inner.speaking.is_some() {
                    self.gen.fetch_add(1, Ordering::SeqCst);
                }
            }
            Some(t) => {
                inner.queue.clear_terminal(t);
                if inner.speaking.as_deref() == Some(t) {
                    self.gen.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        self.cv.notify_all();
    }

    /// Stop and wait until the voice is actually silent. False = it did not
    /// go quiet in time; the caller must not open a microphone then.
    pub async fn quiesce(&self, timeout: Duration) -> bool {
        self.stop(None);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.inner.lock().unwrap().speaking.is_none() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Pane died or respawned: its announcements are void.
    pub fn drop_terminal(&self, terminal_id: &str) {
        self.stop(Some(terminal_id));
    }
}

/// Anything holding the microphone right now.
#[cfg(windows)]
fn recording(app: &AppHandle) -> bool {
    let tts = app.state::<TtsHub>();
    if tts.begins.load(Ordering::SeqCst) > 0 {
        return true;
    }
    if app
        .state::<VoiceHub>()
        .pins
        .lock()
        .unwrap()
        .any_live(Instant::now())
    {
        return true;
    }
    super::speech::busy(app)
}

/// Boot: bring the engine up on its own thread. Failure is a status, not a
/// crash — announcements simply stay unavailable (and buzzkey may fall back).
pub fn start(app: &AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("tts".into())
            .spawn(move || worker(app));
        if let Err(e) = spawned {
            eprintln!("tts: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let hub = app.state::<TtsHub>();
        hub.inner.lock().unwrap().error = Some("unsupported".into());
    }
}

#[cfg(windows)]
fn make_engine() -> Result<Box<dyn Engine>, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SWARMTERM_TTS_FAKE") {
        return Ok(Box::new(fake::Fake::new(path.into())));
    }
    sapi::Sapi::new().map(|e| Box::new(e) as Box<dyn Engine>)
}

#[cfg(windows)]
fn worker(app: AppHandle) {
    let hub = app.state::<TtsHub>();
    let mut engine = match make_engine() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("tts: {e}");
            hub.inner.lock().unwrap().error = Some(e);
            return;
        }
    };
    {
        let mut inner = hub.inner.lock().unwrap();
        inner.voices = engine.voices();
        if inner.voices.is_empty() {
            inner.error = Some("no-voices".into());
            return;
        }
        inner.ready = true;
    }
    let mut quiet = queue::Quiet::default();
    loop {
        // Outside the hub lock: `recording` takes the pins lock.
        let rec = recording(&app);
        let now = Instant::now();
        let mut inner = hub.inner.lock().unwrap();
        let next = if quiet.may_speak(rec, now) {
            inner.queue.pop_fresh(now)
        } else {
            // Dropped, not held back: after a dictation the user is looking
            // at the screen, and an old "done" would talk over their reading.
            inner.queue.clear();
            None
        };
        let Some(item) = next else {
            // Wake on a push or stop; the timeout re-polls `recording` so a
            // tail that runs out with a queue pending is noticed.
            let wait = if inner.queue.is_empty() {
                Duration::from_millis(250)
            } else {
                Duration::from_millis(25)
            };
            drop(hub.cv.wait_timeout(inner, wait).unwrap());
            continue;
        };
        inner.speaking = Some(item.terminal_id.clone());
        inner.speaking_reply = item.reply;
        // Snapshot under the lock: a stop between pop and play bumps it.
        let snap = hub.gen.load(Ordering::SeqCst);
        drop(inner);

        let current = item.terminal_id == TEST_ID
            || super::spawn_id_of(&app, &item.terminal_id).as_deref() == Some(&item.spawn_id);
        // SWA-58: a reply is spoken only while its turn is still the latest
        // and "Allow excerpts" is still on — the ledger re-checked here,
        // after the hub lock is gone (lock order: never both).
        let voice_hub = app.state::<VoiceHub>();
        let allowed = !item.reply
            || item.token.as_deref().is_some_and(|t| {
                let s = voice_hub.settings();
                s.enabled && s.allow_excerpts && voice_hub.ledger_holds(t)
            });
        if current && allowed {
            let settings = app.state::<VoiceHub>().settings();
            let voice = {
                let inner = hub.inner.lock().unwrap();
                pick_voice(&inner.voices, &settings.tts_voice)
                    .map(|v| v.id.clone())
                    .unwrap_or_default()
            };
            let cancelled =
                || hub.gen.load(Ordering::SeqCst) != snap || hub.begins.load(Ordering::SeqCst) > 0;
            let result = engine.speak(&item.text, &voice, settings.tts_volume, &cancelled);
            let mut inner = hub.inner.lock().unwrap();
            // A failure (device unplugged, voice removed) drops this one
            // announcement; the next may work again.
            inner.error = result.err();
            if let Some(e) = &inner.error {
                eprintln!("tts: {e}");
            }
        }
        {
            let mut inner = hub.inner.lock().unwrap();
            inner.speaking = None;
            inner.speaking_reply = false;
        }
        hub.cv.notify_all();
    }
}

/// Debug builds only: `SWARMTERM_TTS_FAKE=<file>` replaces the voice with a
/// JSON-lines log (text, start/end, cancelled) so the testlab can assert
/// what was said and when it stopped, without audio or SAPI voices.
#[cfg(all(windows, debug_assertions))]
mod fake {
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use super::{Engine, VoiceInfo};

    /// Long enough for a test to interrupt it on purpose.
    const UTTERANCE: Duration = Duration::from_millis(1500);

    pub struct Fake {
        path: PathBuf,
    }

    impl Fake {
        pub fn new(path: PathBuf) -> Self {
            Self { path }
        }
    }

    fn ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    impl Engine for Fake {
        fn voices(&self) -> Vec<VoiceInfo> {
            vec![VoiceInfo {
                id: "fake-de".into(),
                name: "Fake (de)".into(),
                lang: "de".into(),
            }]
        }

        fn speak(
            &mut self,
            text: &str,
            voice: &str,
            volume: u8,
            cancelled: &dyn Fn() -> bool,
        ) -> Result<(), String> {
            let started = ms();
            let t0 = Instant::now();
            let mut was_cancelled = false;
            while t0.elapsed() < UTTERANCE {
                if cancelled() {
                    was_cancelled = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let line = serde_json::json!({
                "text": text,
                "voice": voice,
                "volume": volume,
                "startedMs": started as u64,
                "endedMs": ms() as u64,
                "cancelled": was_cancelled,
            });
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .map_err(|e| e.to_string())?;
            writeln!(f, "{line}").map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(id: &str, lang: &str) -> VoiceInfo {
        VoiceInfo {
            id: id.into(),
            name: id.into(),
            lang: lang.into(),
        }
    }

    #[test]
    fn picks_the_configured_voice_then_german_then_any() {
        let voices = [v("zira", "en"), v("hedda", "de")];
        assert_eq!(pick_voice(&voices, "zira").unwrap().id, "zira");
        assert_eq!(pick_voice(&voices, "").unwrap().id, "hedda");
        assert_eq!(pick_voice(&voices, "removed").unwrap().id, "hedda");
        assert_eq!(pick_voice(&voices[..1], "").unwrap().id, "zira");
        assert!(pick_voice(&[], "").is_none());
    }

    fn ready_hub() -> TtsHub {
        let hub = TtsHub::default();
        {
            let mut inner = hub.inner.lock().unwrap();
            inner.ready = true;
            inner.voices = vec![v("hedda", "de")];
        }
        hub
    }

    #[test]
    fn an_engine_that_is_not_up_never_takes_an_event() {
        let hub = TtsHub::default();
        assert!(!hub.announce("t".into(), "g".into(), "A", "codex", TurnKind::Done, ""));
        let hub = ready_hub();
        assert!(hub.announce("t".into(), "g".into(), "A", "codex", TurnKind::Done, ""));
    }

    #[test]
    fn stop_bumps_the_generation_only_for_the_playing_pane() {
        let hub = ready_hub();
        hub.inner.lock().unwrap().speaking = Some("a".into());
        let g0 = hub.gen.load(Ordering::SeqCst);
        hub.stop(Some("b"));
        assert_eq!(hub.gen.load(Ordering::SeqCst), g0);
        hub.stop(Some("a"));
        assert_eq!(hub.gen.load(Ordering::SeqCst), g0 + 1);
        hub.stop(None);
        assert_eq!(hub.gen.load(Ordering::SeqCst), g0 + 2);
    }

    #[test]
    fn stop_drops_queued_announcements() {
        let hub = ready_hub();
        hub.announce("a".into(), "g".into(), "A", "", TurnKind::Done, "");
        hub.announce("b".into(), "g".into(), "B", "", TurnKind::Done, "");
        hub.stop(Some("a"));
        let now = std::time::Instant::now();
        let mut inner = hub.inner.lock().unwrap();
        assert_eq!(inner.queue.pop_fresh(now).unwrap().terminal_id, "b");
        assert!(inner.queue.is_empty());
    }

    #[test]
    fn a_reply_queues_like_a_status_and_opt_out_stops_only_replies() {
        let reply = Reply::Voice("Alles grün.".into());
        let hub = TtsHub::default();
        assert!(!hub.say_reply("a".into(), "g".into(), "c".into(), "A", "", &reply, ""));
        let hub = ready_hub();
        hub.announce("b".into(), "g".into(), "B", "", TurnKind::Done, "");
        hub.inner.lock().unwrap().speaking = Some("b".into());
        let g0 = hub.gen.load(Ordering::SeqCst);
        assert!(hub.say_reply("a".into(), "g".into(), "c1".into(), "A", "", &reply, ""));
        // Never talks over what plays: no generation bump.
        assert_eq!(hub.gen.load(Ordering::SeqCst), g0);
        {
            let mut inner = hub.inner.lock().unwrap();
            let now = std::time::Instant::now();
            assert_eq!(inner.queue.pop_fresh(now).unwrap().terminal_id, "b");
            let item = inner.queue.pop_fresh(now).unwrap();
            assert_eq!(
                (item.text.as_str(), item.reply, item.token.as_deref()),
                ("A: Alles grün.", true, Some("c1"))
            );
        }
        // Opt-out: a waiting reply goes, a waiting status stays; a playing
        // status is not interrupted, a playing reply is.
        hub.say_reply("a".into(), "g".into(), "c2".into(), "A", "", &reply, "");
        hub.announce("b".into(), "g".into(), "B", "", TurnKind::Done, "");
        let g1 = hub.gen.load(Ordering::SeqCst);
        hub.stop_replies();
        assert_eq!(hub.gen.load(Ordering::SeqCst), g1);
        hub.inner.lock().unwrap().speaking_reply = true;
        hub.stop_replies();
        assert_eq!(hub.gen.load(Ordering::SeqCst), g1 + 1);
        let mut inner = hub.inner.lock().unwrap();
        let left = inner.queue.pop_fresh(std::time::Instant::now()).unwrap();
        assert_eq!((left.terminal_id.as_str(), left.reply), ("b", false));
        assert!(inner.queue.is_empty());
    }

    #[test]
    fn begin_guards_are_counted_per_begin() {
        let hub = TtsHub::default();
        let a = hub.begin_guard();
        let b = hub.begin_guard();
        drop(a);
        // The other begin still holds the gate shut.
        assert_eq!(hub.begins.load(Ordering::SeqCst), 1);
        drop(b);
        assert_eq!(hub.begins.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn quiesce_waits_for_silence_and_reports_a_voice_that_will_not_stop() {
        let hub = ready_hub();
        assert!(hub.quiesce(Duration::from_millis(20)).await);
        hub.inner.lock().unwrap().speaking = Some("a".into());
        assert!(!hub.quiesce(Duration::from_millis(20)).await);
    }
}
