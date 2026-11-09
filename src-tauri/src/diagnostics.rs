//! Settings → Diagnostics (SWA-85): the opt-in for local UI-hang dumps.
//! Stored in `<app data>\diagnostics.json`; the stall log line needs no
//! setting (it holds only time and duration). The admin policy
//! `DisableHangDumps` (and the Corp edition) wins over the saved value.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnosticsSettings {
    /// Write a minidump when the window hangs (off by default).
    pub hang_dumps: bool,
}

/// What the renderer shows: the saved choice, whether it is in effect, and
/// where the files go (for "Open folder").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsView {
    pub hang_dumps: bool,
    pub locked: bool,
    pub folder: Option<String>,
}

pub fn load(path: &Path) -> DiagnosticsSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, s: &DiagnosticsSettings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Effective value: a lock forces dumps off whatever was saved.
pub fn effective(saved: &DiagnosticsSettings, locked: bool) -> bool {
    saved.hang_dumps && !locked
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("diagnostics.json"))
}

fn locked(app: &AppHandle) -> bool {
    app.state::<crate::pty::AppState>()
        .admin_policy
        .check(crate::policy::Lock::HangDumps)
        .is_err()
}

fn view(app: &AppHandle, saved: &DiagnosticsSettings) -> DiagnosticsView {
    let locked = locked(app);
    DiagnosticsView {
        hang_dumps: effective(saved, locked),
        locked,
        folder: app
            .path()
            .app_local_data_dir()
            .ok()
            .map(|d| d.join("diagnostics").to_string_lossy().into_owned()),
    }
}

/// Called once in `setup`, before the watchdog starts.
pub fn init(app: &AppHandle) {
    let saved = settings_path(app).map(|p| load(&p)).unwrap_or_default();
    crate::ui_watchdog::set_dumps_enabled(effective(&saved, locked(app)));
    crate::ui_watchdog::start(app);
}

#[tauri::command]
pub async fn diagnostics_get(app: AppHandle) -> Result<DiagnosticsView, String> {
    let path = settings_path(&app)?;
    let saved = tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(view(&app, &saved))
}

#[tauri::command]
pub async fn diagnostics_set(app: AppHandle, hang_dumps: bool) -> Result<DiagnosticsView, String> {
    if hang_dumps {
        app.state::<crate::pty::AppState>()
            .admin_policy
            .check(crate::policy::Lock::HangDumps)?;
    }
    let path = settings_path(&app)?;
    let saved = DiagnosticsSettings { hang_dumps };
    let to_save = saved.clone();
    tauri::async_runtime::spawn_blocking(move || save(&path, &to_save))
        .await
        .map_err(|e| e.to_string())??;
    crate::ui_watchdog::set_dumps_enabled(effective(&saved, locked(&app)));
    Ok(view(&app, &saved))
}

/// Testlab only (debug builds): blocks the UI thread for `ms` so the
/// watchdog's log line and dump can be checked end to end. Synchronous on
/// purpose; release builds refuse it without sleeping.
#[tauri::command]
pub fn debug_ui_stall(ms: u64) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug builds only".into());
    }
    std::thread::sleep(std::time::Duration::from_millis(ms.min(15_000)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_means_off() {
        let dir = std::env::temp_dir().join(format!("swa85-diag-{}", std::process::id()));
        let path = dir.join("diagnostics.json");
        assert_eq!(load(&path), DiagnosticsSettings::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(!load(&path).hang_dumps);
        save(&path, &DiagnosticsSettings { hang_dumps: true }).unwrap();
        assert!(load(&path).hang_dumps);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_forces_dumps_off() {
        let on = DiagnosticsSettings { hang_dumps: true };
        assert!(effective(&on, false));
        assert!(!effective(&on, true));
        assert!(!effective(&DiagnosticsSettings::default(), false));
    }
}
