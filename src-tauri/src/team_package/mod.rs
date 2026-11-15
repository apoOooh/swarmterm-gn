//! Team package (SWA-98): fetch a package of rules, skills and command guards
//! for agent harnesses from a source the user configures, and run ONLY its
//! `install.mjs` (install / update / uninstall / check). What the script
//! writes is the package's business; Swarmterm ships no rules and no source.
//!
//! Trust: the user picks the source and confirms every writing run after a
//! `--dry-run` preview. The run must use exactly the files the preview ran:
//! the preview returns a fingerprint over the whole package tree and the run
//! refuses on any change (a pushed commit, an edited local folder). Nothing
//! runs on its own: no start-up run, no update check, no MCP or War Room
//! path; the commands answer the main webview only. Corp (user decision
//! 2026-11-15) locks the feature and compiles the fetch/run code out: `run`
//! is then `corp.rs`, same command names, every one refusing.

pub mod source;

#[cfg(not(feature = "corp"))]
pub mod run;
#[cfg(feature = "corp")]
#[path = "corp.rs"]
pub mod run;

use serde::{Deserialize, Serialize};
use source::Op;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "team-package.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    source: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPackageState {
    pub source: Option<String>,
    /// Refusal text when the edition or an administrator locks the feature.
    pub locked: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub op: Op,
    pub dry_run: bool,
    /// Short commit of a Git source, `None` for a local folder.
    pub commit: Option<String>,
    /// SHA-256 over the package tree the script ran from (`run::fingerprint`).
    pub fingerprint: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(SETTINGS_FILE))
        .map_err(|e| e.to_string())
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn state(app: &AppHandle) -> TeamPackageState {
    TeamPackageState {
        source: load_settings(app).source,
        locked: app
            .state::<crate::pty::AppState>()
            .admin_policy
            .check(crate::policy::Lock::TeamPackage)
            .err(),
    }
}

/// Main webview only (a preview page must never reach it), then the lock.
fn gate(webview: &tauri::Webview, app: &AppHandle) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("The team package is available only in the main application".into());
    }
    app.state::<crate::pty::AppState>()
        .admin_policy
        .check(crate::policy::Lock::TeamPackage)
}

#[tauri::command]
pub async fn team_package_get(app: AppHandle) -> Result<TeamPackageState, String> {
    tauri::async_runtime::spawn_blocking(move || state(&app))
        .await
        .map_err(|e| e.to_string())
}
