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
//! The renderer owns focus and xterm state (bracketed paste, IME, typing
//! signal), Rust owns the PTY generation. Both checks are needed: the
//! renderer decides WHAT to write, `write_terminal_checked` refuses to write
//! it into a respawned shell.

pub mod pins;
#[cfg(windows)]
mod pipe;
pub mod protocol;
mod settings;
#[cfg(windows)]
pub mod speech;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use crate::pty::AppState;
use pins::{Pin, PinStore, PIN_TTL};
use protocol::{CancelReason, Event, Request, Response, CAP_INDICATOR};
pub use settings::VoiceSettings;

/// Renderer round trip for "who owns the keyboard". A late answer belongs to
/// an older begin and is dropped (its sender is gone).
const FOCUS_TIMEOUT: Duration = Duration::from_millis(300);
/// Covers the IME wait (`COMPOSITION_WAIT_MS` in voice-delivery.ts) plus IPC.
const INSERT_TIMEOUT: Duration = Duration::from_secs(8);
/// Remembered insert outcomes, so a repeated requestId never types twice.
const SEEN_REQUESTS: usize = 64;

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
        }
    }

    fn indicator(&self) -> bool {
        self.capabilities.iter().any(|c| c == CAP_INDICATOR)
    }
}

/// The client that last said hello. Kept for the companion UI (SWA-42).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PeerInfo {
    pub app: String,
    pub version: String,
    pub proto: u64,
}

#[derive(Default)]
pub struct VoiceHub {
    pins: Mutex<PinStore>,
    focus_waiters: Mutex<HashMap<String, oneshot::Sender<FocusReply>>>,
    insert_waiters: Mutex<HashMap<String, oneshot::Sender<InsertReply>>>,
    seen: Mutex<VecDeque<(String, Response)>>,
    settings: Mutex<VoiceSettings>,
    conns: Mutex<HashMap<u64, mpsc::UnboundedSender<Outgoing>>>,
    next_conn: AtomicU64,
    peer: Mutex<Option<PeerInfo>>,
    #[cfg(windows)]
    server: Mutex<Option<pipe::Running>>,
}

impl VoiceHub {
    pub fn settings(&self) -> VoiceSettings {
        self.settings.lock().unwrap().clone()
    }

    #[allow(dead_code)]
    pub fn peer(&self) -> Option<PeerInfo> {
        self.peer.lock().unwrap().clone()
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

fn spawn_id_of(app: &AppHandle, terminal_id: &str) -> Option<String> {
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
}

/// Source-independent entry point: one parsed request in, one response out.
pub async fn handle(app: &AppHandle, req: Request, conn: &mut Conn) -> Response {
    let hub = app.state::<VoiceHub>();
    if !hub.settings().enabled {
        return Response::err(None, "disabled");
    }
    conn.requests += 1;
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
            *hub.peer.lock().unwrap() = Some(PeerInfo {
                app: peer_app,
                version,
                proto,
            });
            Response::hello(request_id, conn.capabilities.clone())
        }
        Request::Begin { request_id } => begin(app, &hub, request_id, conn).await,
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
        Request::Cancel { request_id, pin } => {
            let removed = hub.pins.lock().unwrap().remove(&pin);
            if let Some(pin) = removed {
                quiet_off(app, &pin);
            }
            Response::ok(request_id)
        }
    }
}

async fn begin(app: &AppHandle, hub: &VoiceHub, request_id: String, conn: &Conn) -> Response {
    let rid = Some(request_id.clone());
    let (tx, rx) = oneshot::channel();
    let ask = uuid::Uuid::new_v4().simple().to_string();
    hub.focus_waiters.lock().unwrap().insert(ask.clone(), tx);
    let sent = app.emit(
        "voice:focus-request",
        FocusRequestEvent {
            request_id: ask.clone(),
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
        return Response::err(rid, "no-focus");
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
    #[cfg(windows)]
    return speech::download(&app, &id);
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
    let _ = app;
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
