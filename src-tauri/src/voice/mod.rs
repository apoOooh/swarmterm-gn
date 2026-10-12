//! Voice dictation endpoint (SWA-12): an external dictation app (Buzzkey)
//! sends finished text; Swarmterm types it as a draft into the pane that
//! owned the keyboard when recording began.
//!
//! Layers, so a future in-process speech source can skip the pipe:
//! - `protocol` / `pins`: pure wire format, auth and pin bookkeeping.
//! - this file: the source-independent logic — `begin` asks the renderer
//!   who owns the keyboard and pins `{terminalId, spawn_id}`; `insert`
//!   redeems the pin, hands the text to the renderer (`voice:insert`) and
//!   waits for the ACK of the generation-checked write.
//! - `pipe` (Windows only): named pipe + discovery file, the Buzzkey adapter.
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

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::pty::AppState;
use pins::PinStore;
use protocol::{Request, Response};
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

#[derive(Default)]
pub struct VoiceHub {
    pins: Mutex<PinStore>,
    focus_waiters: Mutex<HashMap<String, oneshot::Sender<FocusReply>>>,
    insert_waiters: Mutex<HashMap<String, oneshot::Sender<InsertReply>>>,
    seen: Mutex<VecDeque<(String, Response)>>,
    settings: Mutex<VoiceSettings>,
    #[cfg(windows)]
    server: Mutex<Option<pipe::Running>>,
}

impl VoiceHub {
    pub fn settings(&self) -> VoiceSettings {
        self.settings.lock().unwrap().clone()
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

/// Source-independent entry point: one parsed request in, one response out.
pub async fn handle(app: &AppHandle, req: Request) -> Response {
    let hub = app.state::<VoiceHub>();
    if !hub.settings().enabled {
        return Response::err(None, "disabled");
    }
    match req {
        Request::Begin { request_id } => begin(app, &hub, request_id).await,
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
        Request::Cancel { pin } => {
            hub.pins.lock().unwrap().cancel(&pin);
            Response::ok(None)
        }
    }
}

async fn begin(app: &AppHandle, hub: &VoiceHub, request_id: String) -> Response {
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
    let pin = hub
        .pins
        .lock()
        .unwrap()
        .issue(terminal_id, spawn_id, Instant::now());
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
    let Some(pin) = hub.pins.lock().unwrap().redeem(pin, Instant::now()) else {
        return Response::err(rid, "pin-invalid");
    };
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
    *hub.settings.lock().unwrap() = settings.clone();
    apply(&app);
    Ok(settings)
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
    hub.pins.lock().unwrap().revoke_all();
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
