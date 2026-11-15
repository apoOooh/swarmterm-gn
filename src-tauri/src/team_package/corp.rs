//! Corp edition: the team package commands stay registered (one
//! `generate_handler!` list for both editions) but refuse with the edition's
//! message; `DisableTeamPackage` is compiled in, and no fetch or run code is.

use super::source::Op;
use super::{gate, RunOutcome, TeamPackageState};
use tauri::AppHandle;

#[tauri::command]
pub async fn team_package_set_source(
    webview: tauri::Webview,
    app: AppHandle,
    source: Option<String>,
) -> Result<TeamPackageState, String> {
    let _ = source;
    gate(&webview, &app)?;
    Err("unsupported".into())
}

#[tauri::command]
pub async fn team_package_preview(
    webview: tauri::Webview,
    app: AppHandle,
    op: Op,
) -> Result<RunOutcome, String> {
    let _ = op;
    gate(&webview, &app)?;
    Err("unsupported".into())
}

#[tauri::command]
pub async fn team_package_run(
    webview: tauri::Webview,
    app: AppHandle,
    op: Op,
    fingerprint: String,
) -> Result<RunOutcome, String> {
    let _ = (op, fingerprint);
    gate(&webview, &app)?;
    Err("unsupported".into())
}
