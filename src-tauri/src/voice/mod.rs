//! Voice dictation endpoint (SWA-12): an external dictation app (buzzkey)
//! sends finished text; Swarmterm types it as a draft into the pane that
//! owned the keyboard when recording began.
//!
//! Layers, so a future in-process speech source can skip the pipe:
//! - `protocol` / `pins`: pure wire format, auth and pin bookkeeping.
//! - this file: the source-independent logic — `begin` asks the renderer
//!   who owns the keyboard and pins `{terminalId, spawn_id}`; `insert`
//!   redeems the pin, hands the text to the renderer (`voice:insert`) and
//!   waits for the ACK of the generation-checked write.
//! - `pipe` (Windows only): named pipe + discovery file, the buzzkey adapter.
//! - `speech` (Windows only, SWA-38): microphone + whisper.cpp, an
//!   in-process client of the same layer (no pipe, no token).
//!
//! Indicator (SWA-40): on a connection that negotiated `indicator`, `begin`
//! issues a pin bound to that connection and turns the pane's "listening"
//! pill on. Every end of such a pin funnels through `finish`, which turns the
//! pill off and pushes the reason to the client if it is still connected.
//!
//! Status feed (SWA-41): a connection that negotiated `turns` may
//! `subscribe`; from then on it only pings and receives `turn` pushes (agent
//! done / needs input), fanned out by `voice_turn_event`. The renderer
//! decides WHICH facts qualify (notification-watch: still current, pane not
//! watched); Rust gates on Settings → Voice and numbers them.
//!
//! Announcements (SWA-66): `tts/` speaks the same facts with the system's
//! voices. `voice_turn_event` builds one event, then runs the local voice
//! and the subscriber feed independently; `ttsHandled` on the push tells a
//! fallback voice in buzzkey whether Swarmterm took it. `begin` holds a
//! `tts::BeginGuard` and silences the voice before any mic opens.
//!
//! Spoken replies (SWA-58, docs/adr/0004): `completion/` keeps the turn
//! ledger fed by Claude's hooks (`hook_turn`). With "Allow excerpts" on it
//! reads the final answer from the pane's transcript and Swarmterm says the
//! agent's `<voice>` line (else quoted prose) instead of "fertig", also for
//! a watched pane. Error and interrupted turns are said in the same tone.
//! None of it leaves this process: the pipe keeps done/needs_input only and
//! `excerpt` stays null.
//!
//! Companion (SWA-42): `companion/` installs and starts buzzkey from
//! Settings → Voice. It reads "connected" and the version from the live
//! hello'd connections here and asks buzzkey to leave with a `quit` push.
//!
//! The renderer owns focus and xterm state (bracketed paste, IME, typing
//! signal), Rust owns the PTY generation. Both checks are needed: the
//! renderer decides WHAT to write, `write_terminal_checked` refuses to write
//! it into a respawned shell.

pub mod companion;
pub mod completion;
pub mod pins;
#[cfg(windows)]
mod pipe;
pub mod protocol;
mod settings;
#[cfg(windows)]
pub mod speech;
pub mod tts;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use crate::pty::AppState;
use pins::{Pin, PinStore, PIN_TTL};
use protocol::{
    CancelReason, Event, Request, Response, TurnEvent, TurnKind, CAP_ADDRESS, CAP_INDICATOR,
    CAP_QUIT, CAP_TTS, CAP_TURNS,
};
pub use settings::VoiceSettings;

/// Renderer round trip for "who owns the keyboard". A late answer belongs to
/// an older begin and is dropped (its sender is gone).
const FOCUS_TIMEOUT: Duration = Duration::from_millis(300);
/// Covers the IME wait (`COMPOSITION_WAIT_MS` in voice-delivery.ts) plus IPC.
const INSERT_TIMEOUT: Duration = Duration::from_secs(8);
/// Remembered insert outcomes, so a repeated requestId never types twice.
const SEEN_REQUESTS: usize = 64;
/// Status subscribers at once. Pipe instances are not capped, but a runaway
/// client reconnecting in a loop must not pile up feeds; one dictation app
/// needs one.
const MAX_SUBSCRIBERS: usize = 4;

/// A same-id respawn keeps the terminalId but gets a fresh spawn_id; text
/// pinned to the old shell must not land in the new one.
pub fn check_generation(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("target-gone".into())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusReply {
    pub terminal_id: Option<String>,
    pub name: Option<String>,
    pub agent_id: Option<String>,
    /// BUZ-5: why an addressed begin found no pane (`no-target`/`ambiguous`).
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertReply {
    pub ok: bool,
    pub reason: Option<String>,
    pub submit_scheduled: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FocusRequestEvent {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InsertEvent {
    request_id: String,
    terminal_id: String,
    expected_spawn_id: String,
    text: String,
    submit: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndicatorEvent {
    terminal_id: String,
    pin: String,
    active: bool,
}

/// What a connection's writer task sends. `Close` ends the connection after
/// everything queued before it went out (used after an `expired` push).
pub enum Outgoing {
    Line(String),
    Close,
}

/// Per-connection state, owned by whoever reads the requests. The default is
/// a proto-1 connection without capabilities (also what an in-process
/// source would use).
#[derive(Default)]
pub struct Conn {
    pub id: u64,
    requests: u64,
    capabilities: Vec<String>,
    /// Set by `subscribe`; the pipe then uses the subscriber idle timeout.
    pub subscribed: bool,
}

impl Conn {
    /// The built-in speech source: a registered connection (for `cancelled`
    /// pushes) that negotiated `indicator` without saying hello.
    #[cfg(windows)]
    fn in_process(id: u64) -> Self {
        Self {
            id,
            requests: 1,
            capabilities: vec![CAP_INDICATOR.to_owned()],
            subscribed: false,
        }
    }

    fn indicator(&self) -> bool {
        self.capabilities.iter().any(|c| c == CAP_INDICATOR)
    }
    fn turns(&self) -> bool {
        self.capabilities.iter().any(|c| c == CAP_TURNS)
    }
    fn tts(&self) -> bool {
        self.capabilities.iter().any(|c| c == CAP_TTS)
    }
    fn address(&self) -> bool {
        self.capabilities.iter().any(|c| c == CAP_ADDRESS)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInput {
    pub terminal_id: String,
    pub kind: TurnKind,
    pub pane_name: String,
    pub agent: String,
    /// SWA-58: the user is looking at this pane. Such a turn is never
    /// pushed and never gets a bare status — only a reply (opt-in).
    #[serde(default)]
    pub watched: bool,
}

/// What a client said in `hello`. The last one is kept after its connection
/// closes (buzzkey opens one per dictation), so the panel still shows the
/// version between dictations.
#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub app: String,
    pub version: String,
    #[allow(dead_code)]
    pub proto: u64,
}

/// The client app name buzzkey sends in `hello`.
const BUZZKEY_APP: &str = "buzzkey";

#[derive(Default)]
pub struct VoiceHub {
    pub(crate) pins: Mutex<PinStore>,
    focus_waiters: Mutex<HashMap<String, oneshot::Sender<FocusReply>>>,
    insert_waiters: Mutex<HashMap<String, oneshot::Sender<InsertReply>>>,
    seen: Mutex<VecDeque<(String, Response)>>,
    settings: Mutex<VoiceSettings>,
    conns: Mutex<HashMap<u64, mpsc::UnboundedSender<Outgoing>>>,
    next_conn: AtomicU64,
    peer: Mutex<Option<PeerInfo>>,
    /// Live hello'd connections: app name and whether it negotiated `quit`.
    hellos: Mutex<HashMap<u64, (String, bool)>>,
    subscribers: Mutex<HashSet<u64>>,
    turn_seq: AtomicU64,
    /// SWA-58. Lock order: never held together with `terminals`, `pins` or
    /// the TTS hub lock — every caller copies out what it needs and drops it.
    pub(crate) ledger: Mutex<completion::Ledger>,
    #[cfg(windows)]
    server: Mutex<Option<pipe::Running>>,
}

impl VoiceHub {
    pub fn settings(&self) -> VoiceSettings {
        self.settings.lock().unwrap().clone()
    }

    /// The last buzzkey that said hello, connected or not.
    pub fn buzzkey_peer(&self) -> Option<PeerInfo> {
        self.peer
            .lock()
            .unwrap()
            .clone()
            .filter(|p| p.app == BUZZKEY_APP)
    }

    pub fn buzzkey_connected(&self) -> bool {
        self.hellos
            .lock()
            .unwrap()
            .values()
            .any(|(app, _)| app == BUZZKEY_APP)
    }

    pub fn buzzkey_can_quit(&self) -> bool {
        self.hellos
            .lock()
            .unwrap()
            .values()
            .any(|(app, quit)| app == BUZZKEY_APP && *quit)
    }

    /// Push `quit` to every live buzzkey connection that negotiated it.
    /// False = nobody to ask; the user quits from the tray instead.
    pub fn request_buzzkey_quit(&self) -> bool {
        let targets: Vec<u64> = self
            .hellos
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (app, quit))| app == BUZZKEY_APP && *quit)
            .map(|(id, _)| *id)
            .collect();
        let conns = self.conns.lock().unwrap();
        let mut sent = false;
        for id in targets {
            if let Some(tx) = conns.get(&id) {
                sent |= tx.send(Outgoing::Line(protocol::quit_line())).is_ok();
            }
        }
        sent
    }

    /// A new pipe connection; pushes for it go through `tx`.
    pub fn register_conn(&self, tx: mpsc::UnboundedSender<Outgoing>) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
        self.conns.lock().unwrap().insert(id, tx);
        id
    }

    pub fn conn_has_pin(&self, conn: u64) -> bool {
        self.pins.lock().unwrap().conn_has_pin(conn)
    }

    pub fn ledger_holds(&self, token: &str) -> bool {
        self.ledger.lock().unwrap().holds(token)
    }

    fn remembered(&self, request_id: &str) -> Option<Response> {
        let seen = self.seen.lock().unwrap();
        seen.iter()
            .find(|(id, _)| id == request_id)
            .map(|(_, r)| r.clone())
    }

    fn remember(&self, request_id: &str, resp: &Response) {
        let mut seen = self.seen.lock().unwrap();
        if seen.len() >= SEEN_REQUESTS {
            seen.pop_front();
        }
        seen.push_back((request_id.to_owned(), resp.clone()));
    }
}

pub(crate) fn spawn_id_of(app: &AppHandle, terminal_id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let terminals = state.terminals.lock().ok()?;
    terminals.get(terminal_id).map(|t| t.spawn_id.clone())
}

fn emit_indicator(app: &AppHandle, pin: &Pin, active: bool) {
    let _ = app.emit(
        "voice:indicator",
        IndicatorEvent {
            terminal_id: pin.terminal_id.clone(),
            pin: pin.id.clone(),
            active,
        },
    );
}

/// The one place an indicator pin ends on the server's initiative: pill off,
/// reason pushed to its connection if that is still open. `Expired` also
/// closes the connection — the client sees why instead of a bare EOF.
fn finish(app: &AppHandle, removed: Vec<(Pin, CancelReason)>) {
    let hub = app.state::<VoiceHub>();
    for (pin, reason) in removed {
        let Some(conn) = pin.conn else { continue };
        emit_indicator(app, &pin, false);
        if let Some(tx) = hub.conns.lock().unwrap().get(&conn) {
            let _ = tx.send(Outgoing::Line(
                Event::cancelled(pin.id.clone(), reason).to_line(),
            ));
            if reason == CancelReason::Expired {
                let _ = tx.send(Outgoing::Close);
            }
        }
    }
}

/// Pill off without a push: the client itself ended the pin (insert,
/// cancel) or is gone.
fn quiet_off(app: &AppHandle, pin: &Pin) {
    if pin.conn.is_some() {
        emit_indicator(app, pin, false);
    }
}

/// The connection closed: forget it, then drop its pins. In that order, so
/// nothing is pushed into a dead pipe.
pub fn close_conn(app: &AppHandle, conn: u64) {
    let hub = app.state::<VoiceHub>();
    hub.conns.lock().unwrap().remove(&conn);
    hub.subscribers.lock().unwrap().remove(&conn);
    hub.hellos.lock().unwrap().remove(&conn);
    let pins = hub.pins.lock().unwrap().remove_conn(conn);
    for pin in &pins {
        quiet_off(app, pin);
    }
}

/// Terminal died or respawned (`kill_terminal` and `read_loop`, like the
/// War Room auto-leave). Idempotent.
pub fn drop_terminal(app: &AppHandle, terminal_id: &str) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    let removed = hub.pins.lock().unwrap().remove_terminal(terminal_id);
    finish(app, removed);
    hub.ledger.lock().unwrap().forget(terminal_id);
    if let Some(tts) = app.try_state::<tts::TtsHub>() {
        tts.drop_terminal(terminal_id);
    }
}

/// SWA-58: replies are spoken only with the voice on AND the transcript
/// opt-in on. Reading without speaking would be reading for nothing.
fn replies_on(s: &VoiceSettings) -> bool {
    s.enabled && s.speak_turns && s.allow_excerpts
}

fn claude_config_dir_of(app: &AppHandle, terminal_id: &str) -> Option<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let terminals = state.terminals.lock().ok()?;
    terminals
        .get(terminal_id)
        .and_then(|t| t.claude_config_dir.clone())
}

/// SWA-58: one Claude turn edge from `POST /hook`, already checked against
/// the pane's live generation and session. The ledger decides; a Stop it
/// accepts may start a transcript read (only with replies on). Returns true
/// for a prompt while replies are on: the hook CLI then asks Claude for the
/// `<voice>` line (`additionalContext`).
pub fn hook_turn(
    app: &AppHandle,
    terminal_id: &str,
    spawn_id: &str,
    session_id: &str,
    turn: &crate::hook::TurnMark,
    config_dir: Option<std::path::PathBuf>,
) -> bool {
    use crate::hook::TurnEdge;
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return false;
    };
    let settings = hub.settings();
    let replies = replies_on(&settings);
    let (job, correction) = {
        let mut ledger = hub.ledger.lock().unwrap();
        match turn.edge {
            TurnEdge::Prompt => {
                ledger.prompt(terminal_id, spawn_id, session_id, &turn.prompt_id);
                return replies;
            }
            TurnEdge::Stop | TurnEdge::StopFailure => {
                let outcome = if turn.edge == TurnEdge::StopFailure {
                    completion::Outcome::Error
                } else {
                    completion::Outcome::Done
                };
                let job = ledger.stop(
                    terminal_id,
                    spawn_id,
                    session_id,
                    &turn.prompt_id,
                    outcome,
                    turn.continued,
                    replies && turn.answer.is_some(),
                );
                let correction = (outcome == completion::Outcome::Error)
                    .then(|| ledger.failed_after_publish(terminal_id))
                    .flatten();
                (job, correction)
            }
        }
    };
    // The status already went out, then the turn turned out to have
    // failed: one correction, never more.
    if let Some(published) = correction {
        speak_status(
            app,
            &settings,
            terminal_id,
            spawn_id,
            &published,
            TurnKind::Error,
        );
        emit_turn_kind(app, terminal_id, TurnKind::Error);
    }
    if let (Some(job), Some(answer)) = (job, turn.answer.clone()) {
        spawn_read(app, job, spawn_id.to_owned(), answer, config_dir);
    }
    false
}

/// A Stop/StopFailure for a prompt that is no longer the open one: the
/// caller drops the whole edge (no `agent:hook` either), so a late Stop of
/// the previous turn cannot end the turn in progress or announce it.
pub fn stale_stop(
    app: &AppHandle,
    terminal_id: &str,
    spawn_id: &str,
    session_id: &str,
    turn: &crate::hook::TurnMark,
) -> bool {
    if turn.edge == crate::hook::TurnEdge::Prompt {
        return false;
    }
    app.try_state::<VoiceHub>().is_some_and(|hub| {
        hub.ledger
            .lock()
            .unwrap()
            .is_stale(terminal_id, spawn_id, session_id, &turn.prompt_id)
    })
}

/// SessionStart/SessionEnd: the conversation in this pane is over.
pub fn forget_turns(app: &AppHandle, terminal_id: &str) {
    if let Some(hub) = app.try_state::<VoiceHub>() {
        hub.ledger.lock().unwrap().forget(terminal_id);
    }
}

/// The local voice for one status. A watched pane gets no bare "fertig" or
/// "wartet" (the user sees it), but error and interrupted while replies are
/// on — that is the conversation. Returns whether the voice took it.
fn speak_status(
    app: &AppHandle,
    settings: &VoiceSettings,
    terminal_id: &str,
    spawn_id: &str,
    p: &completion::Published,
    kind: TurnKind,
) -> bool {
    if !settings.enabled || !settings.speak_turns {
        return false;
    }
    if p.watched && !(replies_on(settings) && !kind.on_pipe()) {
        return false;
    }
    app.state::<tts::TtsHub>().announce(
        terminal_id.to_owned(),
        spawn_id.to_owned(),
        &p.pane_name,
        &p.agent,
        kind,
        &settings.tts_voice,
    )
}

/// A reply if there is one, else the status fallback.
fn speak_done(
    app: &AppHandle,
    settings: &VoiceSettings,
    terminal_id: &str,
    spawn_id: &str,
    token: &str,
    p: &completion::Published,
    reply: Option<completion::Reply>,
) -> bool {
    match reply.filter(|_| replies_on(settings)) {
        Some(reply) => app.state::<tts::TtsHub>().say_reply(
            terminal_id.to_owned(),
            spawn_id.to_owned(),
            token.to_owned(),
            &p.pane_name,
            &p.agent,
            &reply,
            &settings.tts_voice,
        ),
        None => speak_status(app, settings, terminal_id, spawn_id, p, TurnKind::Done),
    }
}

/// Error / interrupted for the bell and the notification center. Ids and
/// the kind only, never text.
fn emit_turn_kind(app: &AppHandle, terminal_id: &str, kind: TurnKind) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct TurnKindEvent<'a> {
        terminal_id: &'a str,
        kind: TurnKind,
    }
    let _ = app.emit("voice:turn-kind", TurnKindEvent { terminal_id, kind });
}

/// Read the transcript off the async runtime, within the reader's budget.
/// The final text lives only inside this closure: reduced to the reply right
/// away and dropped. The opt-in is checked again before the commit, and the
/// ledger commits only to the turn the read was started for. If the status
/// already arrived, this is where the turn is spoken.
fn spawn_read(
    app: &AppHandle,
    job: completion::ReadJob,
    spawn_id: String,
    answer: completion::Fingerprint,
    config_dir: Option<std::path::PathBuf>,
) {
    use completion::{reader, speech_text};
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reply = app.path().home_dir().ok().and_then(|home| {
            let root = reader::claude_config_dir(config_dir.as_deref(), &home);
            let path = reader::locate(&root, &job.session_id)?;
            let text = reader::final_answer_within(
                || reader::read_tail(&root, &path),
                &job.prompt_id,
                &answer,
                reader::BUDGET,
            )?;
            speech_text::reply(&text)
        });
        let hub = app.state::<VoiceHub>();
        let settings = hub.settings();
        let reply = reply.filter(|_| replies_on(&settings));
        let late = hub.ledger.lock().unwrap().commit(&job.token, reply);
        if let Some(late) = late {
            speak_done(
                &app,
                &settings,
                &job.terminal_id,
                &spawn_id,
                &late.token,
                &late.published,
                late.reply,
            );
        }
    });
}

/// `turn` push to every subscribed feed. Done and needs_input only, never
/// for a watched pane — exactly what feeds saw before SWA-58.
fn push_turn(app: &AppHandle, event: &TurnInput, kind: TurnKind, handled: bool) {
    let hub = app.state::<VoiceHub>();
    let settings = hub.settings();
    if !settings.enabled || !settings.announce_turns || event.watched || !kind.on_pipe() {
        return;
    }
    let subs: Vec<u64> = hub.subscribers.lock().unwrap().iter().copied().collect();
    if subs.is_empty() {
        return;
    }
    let seq = hub.turn_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let line = TurnEvent::new(
        event.terminal_id.clone(),
        &event.pane_name,
        event.agent.clone(),
        kind,
        seq,
        handled,
    )
    .to_line();
    let conns = hub.conns.lock().unwrap();
    for id in subs {
        if let Some(tx) = conns.get(&id) {
            let _ = tx.send(Outgoing::Line(line.clone()));
        }
    }
}

/// Source-independent entry point: one parsed request in, one response out.
pub async fn handle(app: &AppHandle, req: Request, conn: &mut Conn) -> Response {
    let hub = app.state::<VoiceHub>();
    if !hub.settings().enabled {
        return Response::err(None, "disabled");
    }
    conn.requests += 1;
    // A status feed stays a status feed: no dictation on it, so a reader
    // that lags behind pushes can never hold up an insert.
    if conn.subscribed
        && !matches!(
            req,
            Request::Ping { .. } | Request::Subscribe { .. } | Request::TtsStop { .. }
        )
    {
        return Response::err(req.request_id(), "bad-request");
    }
    match req {
        Request::Hello {
            request_id,
            proto,
            app: peer_app,
            version,
            capabilities,
        } => {
            // Only as the opener: capabilities change what a pin is, so they
            // cannot switch under a dictation that is already running.
            if conn.requests > 1 {
                return Response::err(Some(request_id), "bad-request");
            }
            conn.capabilities = protocol::negotiate(&capabilities);
            let quit = conn.capabilities.iter().any(|c| c == CAP_QUIT);
            hub.hellos
                .lock()
                .unwrap()
                .insert(conn.id, (peer_app.clone(), quit));
            *hub.peer.lock().unwrap() = Some(PeerInfo {
                app: peer_app,
                version,
                proto,
            });
            Response::hello(request_id, conn.capabilities.clone())
        }
        Request::Begin { request_id, target } => {
            if target.is_some() && !conn.address() {
                return Response::err(Some(request_id), "bad-request");
            }
            begin(app, &hub, request_id, target, conn).await
        }
        Request::Insert {
            request_id,
            pin,
            text,
            submit,
        } => {
            if let Some(prev) = hub.remembered(&request_id) {
                return prev;
            }
            let resp = insert(app, &hub, &request_id, &pin, text, submit).await;
            hub.remember(&request_id, &resp);
            resp
        }
        Request::Subscribe { request_id } => subscribe(app, &hub, request_id, conn),
        Request::Ping { request_id } => Response::ok(Some(request_id)),
        Request::TtsStop { request_id } => {
            if !conn.tts() {
                return Response::err(Some(request_id), "bad-request");
            }
            // Answered on silence, like `begin`: buzzkey sends this right
            // before it opens a mic for a dictation that has no Swarmterm pin.
            if app.state::<tts::TtsHub>().quiesce(QUIESCE_TIMEOUT).await {
                Response::ok(Some(request_id))
            } else {
                Response::err(Some(request_id), "tts-busy")
            }
        }
        Request::Cancel { request_id, pin } => {
            let removed = hub.pins.lock().unwrap().remove(&pin);
            if let Some(pin) = removed {
                quiet_off(app, &pin);
            }
            Response::ok(request_id)
        }
    }
}

/// Who speaks status by default right now — UI information for a client's
/// panel. Decisions go by each event's `ttsHandled`.
fn tts_owner(app: &AppHandle, settings: &VoiceSettings) -> &'static str {
    if settings.speak_turns && app.state::<tts::TtsHub>().ready() {
        "swarmterm"
    } else {
        "none"
    }
}

fn subscribe(app: &AppHandle, hub: &VoiceHub, request_id: String, conn: &mut Conn) -> Response {
    let rid = Some(request_id);
    if !conn.turns() || hub.conn_has_pin(conn.id) {
        return Response::err(rid, "bad-request");
    }
    if !conn.subscribed {
        let mut subs = hub.subscribers.lock().unwrap();
        if subs.len() >= MAX_SUBSCRIBERS {
            return Response::err(rid, "busy");
        }
        subs.insert(conn.id);
        conn.subscribed = true;
    }
    // No replay: the client learns where the feed stands and only sees
    // what happens from now on — an old "done" read aloud is noise.
    Response {
        seq: Some(hub.turn_seq.load(Ordering::Relaxed)),
        tts_owner: Some(tts_owner(app, &hub.settings()).to_owned()),
        ..Response::ok(rid)
    }
}

/// How long `begin` waits for the voice to fall silent. SAPI purges at
/// once; this only trips on a wedged engine, and then the mic stays closed.
const QUIESCE_TIMEOUT: Duration = Duration::from_millis(300);

async fn begin(
    app: &AppHandle,
    hub: &VoiceHub,
    request_id: String,
    target: Option<String>,
    conn: &Conn,
) -> Response {
    let rid = Some(request_id.clone());
    // Before the first await: from here on no announcement may start, and
    // the client opens its mic only after our answer — so it never records
    // our own voice. Released when this returns; a live pin keeps the gate
    // shut from then on.
    let tts = app.state::<tts::TtsHub>();
    let _guard = tts.begin_guard();
    if !tts.quiesce(QUIESCE_TIMEOUT).await {
        return Response::err(rid, "tts-busy");
    }
    let (tx, rx) = oneshot::channel();
    let ask = uuid::Uuid::new_v4().simple().to_string();
    hub.focus_waiters.lock().unwrap().insert(ask.clone(), tx);
    let sent = app.emit(
        "voice:focus-request",
        FocusRequestEvent {
            request_id: ask.clone(),
            target,
        },
    );
    let reply = match sent {
        Ok(()) => tokio::time::timeout(FOCUS_TIMEOUT, rx)
            .await
            .ok()
            .and_then(Result::ok),
        Err(_) => None,
    };
    hub.focus_waiters.lock().unwrap().remove(&ask);
    let Some(reply) = reply else {
        return Response::err(rid, "no-focus");
    };
    let Some(terminal_id) = reply.terminal_id else {
        // Only the two address verdicts pass through; anything else the
        // renderer says is still "no pane for you".
        let reason = match reply.error.as_deref() {
            Some("no-target") => "no-target",
            Some("ambiguous") => "ambiguous",
            _ => "no-focus",
        };
        return Response::err(rid, reason);
    };
    let Some(spawn_id) = spawn_id_of(app, &terminal_id) else {
        return Response::err(rid, "no-focus");
    };
    let holder = conn.indicator().then_some(conn.id);
    let now = Instant::now();
    let (pin, removed) = {
        let mut pins = hub.pins.lock().unwrap();
        // Re-check under the pins lock: a pane that died since the focus
        // answer already ran drop_terminal and would never clear this pin.
        // Any later death runs drop_terminal after we release the lock.
        if spawn_id_of(app, &terminal_id).as_deref() != Some(spawn_id.as_str()) {
            return Response::err(rid, "no-focus");
        }
        let (pin, removed) = pins.issue(terminal_id.clone(), spawn_id.clone(), holder, now);
        if holder.is_some() {
            // `on` under the lock too: a begin that supersedes this pin can
            // only emit its `off` after this, so no late `on` revives a
            // pill for a pin that is already gone.
            emit_indicator(
                app,
                &Pin {
                    id: pin.clone(),
                    terminal_id,
                    spawn_id,
                    created: now,
                    conn: holder,
                },
                true,
            );
        }
        (pin, removed)
    };
    finish(app, removed);
    if holder.is_some() {
        // Expiry is otherwise lazy (swept on the next issue/redeem); an
        // indicator pin needs it on time or its pill outlives the dictation.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PIN_TTL + Duration::from_millis(50)).await;
            let hub = app.state::<VoiceHub>();
            let removed = hub.pins.lock().unwrap().remove_expired(Instant::now());
            finish(&app, removed);
        });
    }
    Response {
        pin: Some(pin),
        name: reply.name,
        agent_id: reply.agent_id,
        ..Response::ok(rid)
    }
}

async fn insert(
    app: &AppHandle,
    hub: &VoiceHub,
    request_id: &str,
    pin: &str,
    text: String,
    submit: bool,
) -> Response {
    let rid = Some(request_id.to_owned());
    let redeemed = hub.pins.lock().unwrap().redeem(pin, Instant::now());
    let pin = match redeemed {
        Ok(pin) => pin,
        Err(stale) => {
            if let Some(stale) = stale {
                quiet_off(app, &stale);
            }
            return Response::err(rid, "pin-invalid");
        }
    };
    // Off before the write: recording is over, the pill must not sit on top
    // of the text it is about to receive.
    quiet_off(app, &pin);
    if spawn_id_of(app, &pin.terminal_id).as_deref() != Some(pin.spawn_id.as_str()) {
        return Response::err(rid, "target-gone");
    }
    let (tx, rx) = oneshot::channel();
    hub.insert_waiters
        .lock()
        .unwrap()
        .insert(request_id.to_owned(), tx);
    let event = InsertEvent {
        request_id: request_id.to_owned(),
        terminal_id: pin.terminal_id,
        expected_spawn_id: pin.spawn_id,
        text,
        submit: submit && hub.settings().allow_auto_enter,
    };
    if app.emit("voice:insert", event).is_err() {
        hub.insert_waiters.lock().unwrap().remove(request_id);
        return Response::err(rid, "renderer-unavailable");
    }
    let reply = tokio::time::timeout(INSERT_TIMEOUT, rx)
        .await
        .ok()
        .and_then(Result::ok);
    hub.insert_waiters.lock().unwrap().remove(request_id);
    match reply {
        Some(r) if r.ok => Response {
            submit_scheduled: r.submit_scheduled,
            ..Response::ok(rid)
        },
        Some(r) => Response::err(rid, r.reason.as_deref().unwrap_or("rejected")),
        // The write may or may not have happened. Say so; the client must
        // not retry blindly (a retry with the same requestId is answered
        // from `seen`, and the pin is already spent).
        None => Response::err(rid, "unknown-outcome"),
    }
}

#[tauri::command]
pub fn voice_focus_response(
    hub: tauri::State<'_, VoiceHub>,
    request_id: String,
    reply: FocusReply,
) {
    if let Some(tx) = hub.focus_waiters.lock().unwrap().remove(&request_id) {
        let _ = tx.send(reply);
    }
}

#[tauri::command]
pub fn voice_insert_result(
    hub: tauri::State<'_, VoiceHub>,
    request_id: String,
    reply: InsertReply,
) {
    if let Some(tx) = hub.insert_waiters.lock().unwrap().remove(&request_id) {
        let _ = tx.send(reply);
    }
}

/// Agent finished / needs input (SWA-41), from the renderer's notification
/// watch. One event, two independent consumers: the local voice
/// (`speakTurns`, works without any pipe client) and the subscriber feed
/// (`announceTurns`). SWA-58: a Claude "done" is first matched against the
/// turn ledger — it may become the agent's reply, an error, or (Esc) an
/// interruption. Watched panes arrive too (`watched`) and get only replies.
/// Dropped while the endpoint is off and for panes that are already gone.
#[tauri::command]
pub fn voice_turn_event(app: AppHandle, event: TurnInput) {
    let hub = app.state::<VoiceHub>();
    let settings = hub.settings();
    if !settings.enabled || !(settings.speak_turns || settings.announce_turns) {
        return;
    }
    if event.watched && !replies_on(&settings) {
        return;
    }
    let Some(spawn_id) = spawn_id_of(&app, &event.terminal_id) else {
        return;
    };
    let published = completion::Published {
        pane_name: event.pane_name.clone(),
        agent: event.agent.clone(),
        watched: event.watched,
    };
    let view = if event.kind == TurnKind::Done {
        hub.ledger
            .lock()
            .unwrap()
            .publish(&event.terminal_id, &spawn_id, published.clone())
    } else {
        completion::View::Plain
    };
    match view {
        completion::View::Pending => {
            // The read commits within its 200 ms budget and speaks then.
            let handled = settings.speak_turns && app.state::<tts::TtsHub>().ready();
            push_turn(&app, &event, TurnKind::Done, handled);
        }
        completion::View::Closed {
            token,
            outcome,
            reply,
        } => match outcome {
            completion::Outcome::Done => {
                let handled = speak_done(
                    &app,
                    &settings,
                    &event.terminal_id,
                    &spawn_id,
                    &token,
                    &published,
                    reply,
                );
                push_turn(&app, &event, TurnKind::Done, handled);
            }
            completion::Outcome::Error | completion::Outcome::Interrupted => {
                let kind = if outcome == completion::Outcome::Error {
                    TurnKind::Error
                } else {
                    TurnKind::Interrupted
                };
                speak_status(
                    &app,
                    &settings,
                    &event.terminal_id,
                    &spawn_id,
                    &published,
                    kind,
                );
                emit_turn_kind(&app, &event.terminal_id, kind);
            }
        },
        completion::View::Plain => {
            let open = (event.kind == TurnKind::Done && replies_on(&settings))
                .then(|| {
                    hub.ledger
                        .lock()
                        .unwrap()
                        .open_turn(&event.terminal_id, &spawn_id)
                })
                .flatten();
            match open {
                // A Claude turn went idle without a Stop: Esc fires no hook,
                // so the transcript decides whether it was interrupted.
                Some((session_id, prompt_id)) => spawn_interrupt_check(
                    app.clone(),
                    event,
                    spawn_id,
                    session_id,
                    prompt_id,
                    published,
                ),
                None => {
                    let handled = speak_status(
                        &app,
                        &settings,
                        &event.terminal_id,
                        &spawn_id,
                        &published,
                        event.kind,
                    );
                    push_turn(&app, &event, event.kind, handled);
                }
            }
        }
    }
}

/// Off the main thread: one tail read for the Esc marker, then either the
/// interruption (spoken, bell, never pushed) or the plain status as before.
fn spawn_interrupt_check(
    app: AppHandle,
    event: TurnInput,
    spawn_id: String,
    session_id: String,
    prompt_id: String,
    published: completion::Published,
) {
    use completion::reader;
    let config_dir = claude_config_dir_of(&app, &event.terminal_id);
    tauri::async_runtime::spawn_blocking(move || {
        let interrupted = app.path().home_dir().ok().is_some_and(|home| {
            let root = reader::claude_config_dir(config_dir.as_deref(), &home);
            reader::locate(&root, &session_id).is_some_and(|path| {
                reader::interrupted_once(|| reader::read_tail(&root, &path), &prompt_id)
            })
        });
        let hub = app.state::<VoiceHub>();
        let settings = hub.settings();
        let closed = interrupted
            && replies_on(&settings)
            && hub
                .ledger
                .lock()
                .unwrap()
                .interrupt(&event.terminal_id, &spawn_id, &prompt_id, published.clone())
                .is_some();
        if closed {
            speak_status(
                &app,
                &settings,
                &event.terminal_id,
                &spawn_id,
                &published,
                TurnKind::Interrupted,
            );
            emit_turn_kind(&app, &event.terminal_id, TurnKind::Interrupted);
        } else {
            let handled = speak_status(
                &app,
                &settings,
                &event.terminal_id,
                &spawn_id,
                &published,
                event.kind,
            );
            push_turn(&app, &event, event.kind, handled);
        }
    });
}

/// Silence announcements: everything (typing, the shortcut) or only one
/// pane's (the user just focused it, so they have seen it).
#[tauri::command]
pub fn voice_tts_stop(app: AppHandle, terminal_id: Option<String>) {
    app.state::<tts::TtsHub>().stop(terminal_id.as_deref());
}

/// Settings → Voice "Test voice".
#[tauri::command]
pub fn voice_tts_test(app: AppHandle) -> Result<(), String> {
    let voice = app.state::<VoiceHub>().settings().tts_voice;
    app.state::<tts::TtsHub>().test(&voice)
}

#[tauri::command]
pub fn voice_tts_status(app: AppHandle) -> tts::TtsStatus {
    app.state::<tts::TtsHub>().status()
}

/// The pill's Stop button. Ends the dictation; the client discards it.
#[tauri::command]
pub fn voice_indicator_stop(app: AppHandle, pin: String) {
    let hub = app.state::<VoiceHub>();
    let removed = {
        let mut pins = hub.pins.lock().unwrap();
        // Only indicator pins have a pill; a legacy pin is not ours to stop.
        if pins.is_indicator(&pin) {
            pins.remove(&pin)
        } else {
            None
        }
    };
    if let Some(pin) = removed {
        finish(&app, vec![(pin, CancelReason::User)]);
    }
}

#[tauri::command]
pub fn voice_get_settings(hub: tauri::State<'_, VoiceHub>) -> VoiceSettings {
    hub.settings()
}

#[tauri::command]
pub fn voice_set_settings(
    app: AppHandle,
    settings: VoiceSettings,
) -> Result<VoiceSettings, String> {
    let hub = app.state::<VoiceHub>();
    let path = settings_path(&app)?;
    settings::save(&path, &settings)?;
    let previous = std::mem::replace(&mut *hub.settings.lock().unwrap(), settings.clone());
    let was_enabled = previous.enabled;
    #[cfg(windows)]
    if previous.builtin_enabled && !settings.builtin_enabled {
        speech::cancel_running(&app, "disabled");
    }
    // Only an on/off switch restarts the endpoint. Auto-Enter is read per
    // insert, so changing it must not kill a dictation that is running.
    if was_enabled != settings.enabled {
        apply(&app);
    }
    if previous.speak_turns && !settings.speak_turns {
        app.state::<tts::TtsHub>().stop(None);
    }
    // Revoking the opt-in drops every reply and stops one being spoken;
    // reads still in flight find it off before they commit.
    if previous.allow_excerpts && !settings.allow_excerpts {
        hub.ledger.lock().unwrap().clear_replies();
        app.state::<tts::TtsHub>().stop_replies();
    }
    Ok(settings)
}

// Built-in speech source (SWA-38). Thin wrappers: the logic is in `speech`.
// Off Windows they answer `unsupported` so the invoke list stays one list.

#[tauri::command]
pub async fn voice_dictation_toggle(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    return speech::toggle(&app).await;
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("unsupported".into())
    }
}

#[tauri::command]
pub fn voice_dictation_cancel(app: AppHandle) {
    #[cfg(windows)]
    speech::cancel_running(&app, "user");
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
#[tauri::command]
pub fn voice_speech_status(app: AppHandle) -> Result<speech::SpeechStatus, String> {
    speech::status(&app)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn voice_speech_status(app: AppHandle) -> Result<(), String> {
    let _ = app;
    Err("unsupported".into())
}

#[tauri::command]
pub fn voice_model_download(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<crate::pty::AppState>()
        .admin_policy
        .check(crate::policy::Lock::ModelDownload)?;
    // Corp: `ModelDownload` is compiled in, so the check above already
    // refused; the download code itself is not in that binary.
    #[cfg(all(windows, not(feature = "corp")))]
    return speech::download(&app, &id);
    #[cfg(any(not(windows), feature = "corp"))]
    {
        let _ = (app, id);
        Err("unsupported".into())
    }
}

#[tauri::command]
pub fn voice_model_cancel(app: AppHandle, id: String) {
    #[cfg(windows)]
    speech::cancel_download(&app, &id);
    #[cfg(not(windows))]
    let _ = (app, id);
}

#[tauri::command]
pub fn voice_model_delete(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(windows)]
    return speech::delete(&app, &id);
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err("unsupported".into())
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("voice-settings.json"))
        .map_err(|e| e.to_string())
}

/// Boot: load settings, then open or keep closed the endpoint.
pub fn init(app: &AppHandle) {
    let hub = app.state::<VoiceHub>();
    if let Ok(path) = settings_path(app) {
        *hub.settings.lock().unwrap() = settings::load(&path);
    }
    tts::start(app);
    apply(app);
}

/// Bring the endpoint in line with the settings. Switching off revokes every
/// open pin and connection and removes the discovery file; switching on
/// again issues a fresh token.
pub fn apply(app: &AppHandle) {
    let hub = app.state::<VoiceHub>();
    // Push `disabled` before the server stops: each writer drains its queue
    // after its reader is gone, so clients still learn why.
    let removed = hub.pins.lock().unwrap().revoke_all();
    finish(app, removed);
    #[cfg(windows)]
    {
        let mut server = hub.server.lock().unwrap();
        if let Some(running) = server.take() {
            running.stop();
        }
        if hub.settings().enabled {
            match pipe::start(app.clone()) {
                Ok(running) => *server = Some(running),
                Err(e) => eprintln!("voice: {e}"),
            }
        }
    }
}

/// Quit: close the endpoint and delete the discovery file.
pub fn shutdown(app: &AppHandle) {
    #[cfg(windows)]
    if let Some(running) = app.state::<VoiceHub>().server.lock().unwrap().take() {
        running.stop();
    }
    #[cfg(windows)]
    speech::cancel_running(app, "disabled");
    app.state::<tts::TtsHub>().stop(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_must_match_exactly() {
        assert!(check_generation("g1", "g1").is_ok());
        assert_eq!(check_generation("g2", "g1"), Err("target-gone".into()));
    }
}
