//! Built-in speech source (SWA-38, docs/adr/0002-builtin-speech-source.md):
//! microphone → whisper.cpp → the same `voice::handle` the buzzkey pipe uses.
//!
//! It is just another client of the source-independent layer. It registers
//! an in-process connection with the `indicator` capability, so `begin` pins
//! the pane that owns the keyboard and shows the listening pill, and the
//! insert runs through the renderer's draft rules and the generation-checked
//! write. Nothing here touches pins or `terminals` directly, so the lock
//! order `pins` → `terminals` cannot be broken from this side.
//!
//! Every way a pin ends on the server's initiative (pill Stop, pane death,
//! expiry, Voice switched off) arrives as a `cancelled` push on our
//! connection, exactly as buzzkey would see it; the drain task turns that
//! into "stop recording, discard". One dictation at a time (`active`), held
//! from `begin` until the insert answered — the transcription phase too.

mod capture;
mod engine;
pub mod model;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::protocol::{Request, MAX_TEXT_CHARS};
use super::{close_conn, handle, Conn, Outgoing, VoiceHub};
use capture::{Recorder, WHISPER_RATE};
use engine::Engine;

/// Shorter than this is a slip of the shortcut, not a dictation.
const MIN_SAMPLES: usize = (WHISPER_RATE / 4) as usize;

struct Run {
    conn: Conn,
    pin: String,
    terminal_id: Option<String>,
    recorder: Recorder,
}

#[derive(Default)]
pub struct SpeechHub {
    active: AtomicBool,
    run: Mutex<Option<Run>>,
    engine: Arc<Engine>,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DictationEvent {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: String,
    received: u64,
    total: u64,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    ready: bool,
    downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    models: Vec<ModelStatus>,
    dictation: &'static str,
}

fn emit_state(
    app: &AppHandle,
    state: &'static str,
    terminal_id: Option<String>,
    reason: Option<String>,
) {
    let _ = app.emit(
        "voice:dictation",
        DictationEvent {
            state,
            terminal_id,
            reason,
        },
    );
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| e.to_string())
}

fn selected_model(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let settings = app.state::<VoiceHub>().settings();
    if !settings.enabled {
        return Err("disabled".into());
    }
    if !settings.builtin_enabled {
        return Err("builtin-off".into());
    }
    let model = model::find(&settings.model).ok_or("model-missing")?;
    let dir = models_dir(app)?;
    if !model::is_ready(&dir, model) {
        return Err("model-missing".into());
    }
    Ok((model::path(&dir, model), settings.language))
}

/// Recording or transcribing (begin → insert answer). The announcement
/// voice stays silent meanwhile: half-duplex, and whisper needs the CPU.
pub fn busy(app: &AppHandle) -> bool {
    app.state::<SpeechHub>().active.load(Ordering::SeqCst)
}

fn release(app: &AppHandle, conn: u64) {
    close_conn(app, conn);
    app.state::<SpeechHub>()
        .active
        .store(false, Ordering::SeqCst);
}

/// Shortcut / pane button: start when idle, stop and transcribe when
/// recording, ignored while a transcription is still running.
pub async fn toggle(app: &AppHandle) -> Result<(), String> {
    let hub = app.state::<SpeechHub>();
    let recording = hub.run.lock().unwrap().is_some();
    if recording {
        stop(app).await;
        return Ok(());
    }
    if hub.active.load(Ordering::SeqCst) {
        return Err("busy".into());
    }
    start(app).await
}

async fn start(app: &AppHandle) -> Result<(), String> {
    selected_model(app)?;
    let hub = app.state::<SpeechHub>();
    if hub.active.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let mut conn = Conn::in_process(app.state::<VoiceHub>().register_conn(tx));
    let conn_id = conn.id;
    let resp = handle(
        app,
        Request::Begin {
            request_id: request_id(),
        },
        &mut conn,
    )
    .await;
    let Some(pin) = resp.pin.clone().filter(|_| resp.ok) else {
        release(app, conn_id);
        return Err(resp.reason.unwrap_or_else(|| "no-focus".into()));
    };
    let recorder = match tauri::async_runtime::spawn_blocking(Recorder::start).await {
        Ok(Ok(r)) => r,
        other => {
            let reason = match other {
                Ok(Err(e)) => e,
                _ => "mic-unavailable".into(),
            };
            let cancel = Request::Cancel {
                request_id: None,
                pin,
            };
            handle(app, cancel, &mut conn).await;
            release(app, conn_id);
            eprintln!("voice: {reason}");
            return Err("mic-unavailable".into());
        }
    };
    let terminal_id = pinned_terminal(app, &pin);
    *hub.run.lock().unwrap() = Some(Run {
        conn,
        pin,
        terminal_id: terminal_id.clone(),
        recorder,
    });
    emit_state(app, "recording", terminal_id, None);
    tauri::async_runtime::spawn(drain(app.clone(), conn_id, rx));
    Ok(())
}

/// Server-side ends of our pin. The sender is dropped by `close_conn`, so
/// the loop ends with the dictation.
async fn drain(app: AppHandle, conn_id: u64, mut rx: mpsc::UnboundedReceiver<Outgoing>) {
    while let Some(msg) = rx.recv().await {
        let Outgoing::Line(line) = msg else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("event").and_then(|e| e.as_str()) != Some("cancelled") {
            continue;
        }
        let reason = v
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("cancelled")
            .to_owned();
        abort(&app, Some(conn_id), reason).await;
    }
}

/// Discard a recording. `conn_id = None` means whichever run is active.
async fn abort(app: &AppHandle, conn_id: Option<u64>, reason: String) {
    let hub = app.state::<SpeechHub>();
    let run = {
        let mut slot = hub.run.lock().unwrap();
        match slot.as_ref() {
            Some(r) if conn_id.is_none_or(|c| c == r.conn.id) => slot.take(),
            _ => None,
        }
    };
    let Some(mut run) = run else { return };
    let _ = tauri::async_runtime::spawn_blocking(move || run.recorder.stop()).await;
    let cancel = Request::Cancel {
        request_id: None,
        pin: run.pin,
    };
    handle(app, cancel, &mut run.conn).await;
    release(app, run.conn.id);
    emit_state(app, "idle", run.terminal_id, Some(reason));
}

async fn stop(app: &AppHandle) {
    let hub = app.state::<SpeechHub>();
    let Some(Run {
        mut conn,
        pin,
        terminal_id,
        recorder,
    }) = hub.run.lock().unwrap().take()
    else {
        return;
    };
    emit_state(app, "transcribing", terminal_id.clone(), None);
    let samples = tauri::async_runtime::spawn_blocking(move || recorder.stop())
        .await
        .unwrap_or_default();
    let text = if samples.len() < MIN_SAMPLES {
        Err("too-short".to_string())
    } else {
        match selected_model(app) {
            Ok((path, language)) => {
                let engine = hub.engine.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    engine.transcribe(&path, &samples, &language)
                })
                .await
                .unwrap_or_else(|_| Err("transcribe-failed".into()))
            }
            Err(e) => Err(e),
        }
    };
    let reason = match text {
        Ok(text) if !text.is_empty() => {
            let req = Request::Insert {
                request_id: request_id(),
                pin,
                text: clamp_chars(text, MAX_TEXT_CHARS),
                submit: false,
            };
            let resp = handle(app, req, &mut conn).await;
            (!resp.ok).then(|| resp.reason.unwrap_or_else(|| "rejected".into()))
        }
        other => {
            let reason = match other {
                Err(e) => e,
                Ok(_) => "no-speech".into(),
            };
            let cancel = Request::Cancel {
                request_id: None,
                pin,
            };
            handle(app, cancel, &mut conn).await;
            Some(reason)
        }
    };
    release(app, conn.id);
    emit_state(app, "idle", terminal_id, reason);
}

fn pinned_terminal(app: &AppHandle, pin: &str) -> Option<String> {
    let hub = app.state::<VoiceHub>();
    let pins = hub.pins.lock().unwrap();
    pins.terminal_of(pin)
}

fn request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The pipe enforces `MAX_TEXT_CHARS` while parsing; the in-process source
/// skips parsing, so it applies the same bound itself.
fn clamp_chars(mut text: String, max: usize) -> String {
    if let Some((idx, _)) = text.char_indices().nth(max) {
        text.truncate(idx);
    }
    text
}

/// Settings switched the built-in source off, or the app quits.
pub fn cancel_running(app: &AppHandle, reason: &str) {
    let app = app.clone();
    let reason = reason.to_owned();
    tauri::async_runtime::spawn(async move { abort(&app, None, reason).await });
}

pub fn status(app: &AppHandle) -> Result<SpeechStatus, String> {
    let hub = app.state::<SpeechHub>();
    let dir = models_dir(app)?;
    let downloads = hub.downloads.lock().unwrap();
    let models = model::CATALOG
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            label: m.label,
            bytes: m.bytes,
            ready: model::is_ready(&dir, m),
            downloading: downloads.contains_key(m.id),
        })
        .collect();
    let dictation = if hub.run.lock().unwrap().is_some() {
        "recording"
    } else if hub.active.load(Ordering::SeqCst) {
        "transcribing"
    } else {
        "idle"
    };
    Ok(SpeechStatus { models, dictation })
}

pub fn download(app: &AppHandle, id: &str) -> Result<(), String> {
    let model = model::find(id).ok_or("unknown-model")?;
    let dir = models_dir(app)?;
    if model::is_ready(&dir, model) {
        return Ok(());
    }
    let flag = Arc::new(AtomicBool::new(false));
    {
        let hub = app.state::<SpeechHub>();
        let mut downloads = hub.downloads.lock().unwrap();
        if downloads.contains_key(id) {
            return Ok(());
        }
        downloads.insert(id.to_owned(), flag.clone());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = fetch(&app, model, &dir, &flag).await;
        app.state::<SpeechHub>()
            .downloads
            .lock()
            .unwrap()
            .remove(model.id);
        let _ = app.emit(
            "voice:model-progress",
            ProgressEvent {
                id: model.id.into(),
                received: if result.is_ok() { model.bytes } else { 0 },
                total: model.bytes,
                done: true,
                error: result.err(),
            },
        );
    });
    Ok(())
}

async fn fetch(
    app: &AppHandle,
    model: &'static model::ModelInfo,
    dir: &std::path::Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut resp = reqwest::Client::new()
        .get(model::url(model))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download-failed: {e}"))?;
    let mut part = model::PartFile::create(dir, model)?;
    let mut last_emit = 0u64;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            part.abandon();
            return Err("cancelled".into());
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                part.abandon();
                return Err(format!("download-failed: {e}"));
            }
        };
        let received = match part.write(&chunk) {
            Ok(n) => n,
            Err(e) => {
                part.abandon();
                return Err(e);
            }
        };
        // ~1 % steps; the bar does not need every 16 KiB chunk.
        if received - last_emit >= model.bytes / 100 {
            last_emit = received;
            let _ = app.emit(
                "voice:model-progress",
                ProgressEvent {
                    id: model.id.into(),
                    received,
                    total: model.bytes,
                    done: false,
                    error: None,
                },
            );
        }
    }
    part.finish().map(|_| ())
}

pub fn cancel_download(app: &AppHandle, id: &str) {
    let hub = app.state::<SpeechHub>();
    let downloads = hub.downloads.lock().unwrap();
    if let Some(flag) = downloads.get(id) {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let model = model::find(id).ok_or("unknown-model")?;
    let hub = app.state::<SpeechHub>();
    if hub.active.load(Ordering::SeqCst) {
        return Err("busy".into());
    }
    hub.engine.unload();
    let path = model::path(&models_dir(app)?, model);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete-failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_cuts_on_char_boundaries() {
        assert_eq!(clamp_chars("äöü".into(), 2), "äö");
        assert_eq!(clamp_chars("ab".into(), 5), "ab");
    }
}
