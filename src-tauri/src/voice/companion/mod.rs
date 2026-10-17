//! Voice companion (SWA-42): install, start, stop and update buzzkey from
//! Settings → Voice. Both products stay independent — buzzkey keeps its own
//! releases and works without Swarmterm — so this is a convenience layer,
//! and every action runs only on a click: no background download, no
//! silent update, no kill.
//!
//! Install: newest signed release (`release::select`) → signature over
//! `SHA256SUMS.txt` → per-file hash and size → staged swap with rollback
//! (`install`). A running buzzkey is asked to quit over the pipe first
//! (capability `quit`); without that capability the user quits it from its
//! tray. "Connected" and the version come from `hello` (`VoiceHub`).

mod install;
pub mod release;
mod system;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::VoiceHub;
use release::{GhRelease, Release};
pub use system::HardwareProbe;

const USER_AGENT: &str = concat!("swarmterm-gn/", env!("CARGO_PKG_VERSION"));
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a polite quit may take before the install gives up.
const QUIT_WAIT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Companion {
    busy: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub supported: bool,
    pub installed: bool,
    pub dir: Option<String>,
    pub running: bool,
    pub connected: bool,
    pub version: Option<String>,
    pub can_quit: bool,
    pub autostart: bool,
    pub whisper_key_running: bool,
    pub busy: bool,
    pub signing_key_is_test: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub latest_tag: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    phase: &'a str,
    file: Option<&'a str>,
    received: u64,
    total: u64,
}

fn emit_progress(app: &AppHandle, phase: &str, file: Option<&str>, received: u64, total: u64) {
    let _ = app.emit(
        "voice:companion-progress",
        Progress {
            phase,
            file,
            received,
            total,
        },
    );
}

/// Debug builds may read releases from the testlab's loopback server.
fn releases_url() -> (String, bool) {
    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var("SWARMTERM_BUZZKEY_RELEASES_URL") {
            if !url.is_empty() {
                return (url, true);
            }
        }
    }
    (release::RELEASES_URL.to_owned(), false)
}

fn client(allow_loopback: bool, timeout: Duration) -> Result<reqwest::Client, String> {
    // Every hop of a redirect chain is held to the same allowlist, so a
    // GitHub redirect cannot hand the download to another host.
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > 5 {
            attempt.error("too-many-redirects")
        } else if release::url_allowed(attempt.url(), allow_loopback) {
            attempt.follow()
        } else {
            attempt.error("host-not-allowed")
        }
    });
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(policy)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http: {e}"))
}

/// GET with a byte cap enforced while reading, not after.
async fn fetch(
    http: &reqwest::Client,
    url: &str,
    allow_loopback: bool,
    limit: u64,
    mut on_chunk: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(url).map_err(|_| "url-invalid".to_string())?;
    if !release::url_allowed(&parsed, allow_loopback) {
        return Err("host-not-allowed".into());
    }
    let mut resp = http
        .get(parsed)
        .header("Accept", "application/octet-stream, application/json")
        .send()
        .await
        .map_err(|e| {
            // Our redirect policy is the only thing that fails a redirect.
            if e.is_redirect() {
                "host-not-allowed".to_string()
            } else {
                format!("download: {e}")
            }
        })?;
    if !resp.status().is_success() {
        return Err(format!("download: HTTP {}", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > limit) {
        return Err("too-large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download: {e}"))? {
        if body.len() as u64 + chunk.len() as u64 > limit {
            return Err("too-large".into());
        }
        body.extend_from_slice(&chunk);
        on_chunk(body.len() as u64);
    }
    Ok(body)
}

async fn latest_release() -> Result<Option<Release>, String> {
    let (url, loopback) = releases_url();
    let http = client(loopback, LIST_TIMEOUT)?;
    let body = fetch(&http, &url, loopback, release::MAX_LIST_BYTES, |_| {}).await?;
    let list: Vec<GhRelease> =
        serde_json::from_slice(&body).map_err(|_| "releases-invalid".to_string())?;
    Ok(release::select(&list))
}

fn status(app: &AppHandle) -> CompanionStatus {
    let hub = app.state::<VoiceHub>();
    let dir = system::install_dir();
    let installed = dir
        .as_ref()
        .is_some_and(|d| d.join(release::EXE).is_file());
    let peer = hub.buzzkey_peer();
    let autostart = match (&dir, system::read_run_value()) {
        (Some(d), Some(v)) => system::run_value_is_ours(&v, d),
        _ => false,
    };
    CompanionStatus {
        supported: cfg!(windows),
        installed,
        dir: dir.map(|d| d.display().to_string()),
        running: system::buzzkey_running(),
        connected: hub.buzzkey_connected(),
        version: peer.map(|p| p.version),
        can_quit: hub.buzzkey_can_quit(),
        autostart,
        whisper_key_running: system::whisper_key_running(),
        busy: app.state::<Companion>().busy.load(Ordering::Relaxed),
        // Debug builds also trust the testlab key; the panel says so.
        signing_key_is_test: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn voice_companion_status(app: AppHandle) -> CompanionStatus {
    status(&app)
}

/// "Check for update" — only on click. Compares against the version the
/// running buzzkey reported in `hello`; without one, any signed release
/// counts as available (fresh install).
#[tauri::command]
pub async fn voice_companion_check(app: AppHandle) -> Result<UpdateCheck, String> {
    let latest = latest_release().await?;
    let current = app
        .state::<VoiceHub>()
        .buzzkey_peer()
        .and_then(|p| release::parse_reported(&p.version));
    let update_available = match (&latest, &current) {
        (Some(l), Some(c)) => release::newer(&l.version, c),
        (Some(_), None) => true,
        (None, _) => false,
    };
    Ok(UpdateCheck {
        latest_tag: latest.as_ref().map(|r| r.tag.clone()),
        latest_version: latest.as_ref().map(|r| r.version.to_string()),
        update_available,
    })
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Install or update. Restarts buzzkey afterwards if it was running.
#[tauri::command]
pub async fn voice_companion_install(app: AppHandle) -> Result<CompanionStatus, String> {
    let companion = app.state::<Companion>();
    if companion.busy.swap(true, Ordering::Relaxed) {
        return Err("busy".into());
    }
    let _guard = BusyGuard(&companion.busy);
    let result = install_inner(&app).await;
    emit_progress(&app, if result.is_ok() { "done" } else { "failed" }, None, 0, 0);
    result.map(|()| status(&app))
}

async fn install_inner(app: &AppHandle) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("unsupported".into());
    }
    if system::whisper_key_running() {
        return Err("whisper-key-running".into());
    }
    let dir = system::install_dir().ok_or("no-install-dir")?;
    emit_progress(app, "check", None, 0, 0);
    let rel = latest_release().await?.ok_or("no-signed-release")?;
    let (_, loopback) = releases_url();
    let http = client(loopback, DOWNLOAD_TIMEOUT)?;

    // Trust first: nothing is downloaded into the folder before the sums
    // are proven to come from the signing key.
    let sums = fetch(&http, &rel.sums.url, loopback, release::MAX_SUMS_BYTES, |_| {}).await?;
    let sig = fetch(&http, &rel.sig.url, loopback, release::MAX_SIG_BYTES, |_| {}).await?;
    emit_progress(app, "verify", Some(release::SUMS), 0, 0);
    let sig = String::from_utf8(sig).map_err(|_| "signature-invalid".to_string())?;
    release::verify_trusted(&sums, &sig)?;
    let sums = String::from_utf8(sums).map_err(|_| "sums-invalid".to_string())?;

    let mut files = Vec::new();
    for name in release::INSTALLED {
        let asset = rel.asset(name).ok_or("asset-missing")?;
        let expected = release::expected_hash(&sums, name)?;
        let total = asset.size;
        let bytes = fetch(&http, &asset.url, loopback, release::MAX_EXE_BYTES, |n| {
            emit_progress(app, "download", Some(name), n, total)
        })
        .await?;
        if bytes.len() as u64 != asset.size || release::sha256(&bytes) != expected {
            return Err(format!("hash-mismatch:{name}"));
        }
        files.push((*name, bytes));
    }

    let was_running = system::buzzkey_running();
    if was_running {
        quit_and_wait(app).await?;
    }
    emit_progress(app, "install", None, 0, 0);
    let staging = install::staging_dir(&dir)?;
    for (name, bytes) in &files {
        std::fs::write(staging.join(name), bytes).map_err(|e| format!("write:{name}: {e}"))?;
    }
    install::commit(&dir, release::INSTALLED)?;
    if was_running {
        system::start(&dir)?;
    }
    Ok(())
}

async fn quit_and_wait(app: &AppHandle) -> Result<(), String> {
    if !app.state::<VoiceHub>().request_buzzkey_quit() {
        return Err("running-quit-in-tray".into());
    }
    let deadline = tokio::time::Instant::now() + QUIT_WAIT;
    while system::buzzkey_running() {
        if tokio::time::Instant::now() >= deadline {
            return Err("quit-timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

#[tauri::command]
pub fn voice_companion_start(app: AppHandle) -> Result<CompanionStatus, String> {
    if system::whisper_key_running() {
        return Err("whisper-key-running".into());
    }
    if !system::buzzkey_running() {
        system::start(&system::install_dir().ok_or("no-install-dir")?)?;
    }
    Ok(status(&app))
}

/// Polite quit over the pipe. Without the capability the panel tells the
/// user to quit from the tray instead — never a kill.
#[tauri::command]
pub fn voice_companion_quit(app: AppHandle) -> Result<(), String> {
    if app.state::<VoiceHub>().request_buzzkey_quit() {
        Ok(())
    } else {
        Err("quit-unsupported".into())
    }
}

#[tauri::command]
pub fn voice_companion_set_autostart(app: AppHandle, on: bool) -> Result<CompanionStatus, String> {
    let dir = system::install_dir().ok_or("no-install-dir")?;
    if on && !dir.join(release::EXE).is_file() {
        return Err("not-installed".into());
    }
    system::set_autostart(&dir, on)?;
    Ok(status(&app))
}

#[tauri::command]
pub async fn voice_companion_probe() -> Option<HardwareProbe> {
    system::probe(&system::install_dir()?).await
}
