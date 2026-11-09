//! First start and the setup assistant (SWA-83 phase 2).
//!
//! Whether this is a new installation is decided ONCE, at the start of
//! `setup`, from named markers in the app data dir — never from "the folder
//! is empty": plugins, host copies and WebView2 put files there early, and
//! misreading an existing user as new would switch their voice off (D3).
//! The verdict is written to `setup-state.json` (flags only) right away:
//! the renderer's boot pushes write `env-policy.json`, so a user who quits
//! in the middle of the assistant would otherwise come back as "existing"
//! and never see it again.
//!
//! States: `pending` (new install, assistant not finished), `done`,
//! `skipped`, `existing` (an install from before the assistant, or a
//! renderer that still holds recents/workspaces in localStorage). Only
//! `pending` shows the assistant; Settings → Setup can open it again at any
//! time without changing the state.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const STATE_FILE: &str = "setup-state.json";

/// Files only an install that has run before can have: written by a user
/// action (`local-history` on the first file saved in the editor) or a
/// boot push of a previous run — never before `classify` in this one. A
/// marker written later in a first run is harmless, because the verdict is
/// stored at once.
pub const MARKERS: &[&str] = &[
    "agent-accounts.json",
    "env-policy.json",
    "voice-settings.json",
    "swarmterm-mcp-disabled.json",
    "terminal-host.json",
    "diagnostics.json",
    "local-history",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Wizard {
    Pending,
    Done,
    Skipped,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    version: u32,
    wizard: Wizard,
}

fn read_state(dir: &Path) -> Option<Wizard> {
    let text = fs::read_to_string(dir.join(STATE_FILE)).ok()?;
    serde_json::from_str::<StateFile>(&text)
        .ok()
        .map(|s| s.wizard)
}

fn write_state(dir: &Path, wizard: Wizard) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    let text = serde_json::to_string_pretty(&StateFile { version: 1, wizard })
        .map_err(|e| e.to_string())?;
    let path = dir.join(STATE_FILE);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

/// The pure decision: a stored state wins; otherwise any marker means an
/// install from before the assistant. An unreadable state file counts as
/// missing, so the markers decide again rather than defaulting to "new".
pub fn decide(stored: Option<Wizard>, has_marker: bool) -> Wizard {
    match stored {
        Some(w) => w,
        None if has_marker => Wizard::Existing,
        None => Wizard::Pending,
    }
}

/// Read or settle the state for `dir`, writing it when it was missing.
pub fn classify(dir: &Path) -> Wizard {
    let stored = read_state(dir);
    let has_marker = MARKERS.iter().any(|m| dir.join(m).exists());
    let wizard = decide(stored, has_marker);
    if stored.is_none() {
        if let Err(e) = write_state(dir, wizard) {
            eprintln!("setup state: {e}");
        }
    }
    wizard
}

/// Which outcome the renderer may report from which state. `existing` is
/// only a correction of `pending` (localStorage shows an older install);
/// `done`/`skipped` may also come from a re-run opened in Settings.
pub fn next(current: Wizard, outcome: Wizard) -> Result<Wizard, String> {
    match (current, outcome) {
        (_, Wizard::Pending) => Err("pending is not an outcome".into()),
        (Wizard::Pending, w) => Ok(w),
        (_, Wizard::Existing) => Ok(current),
        (_, w) => Ok(w),
    }
}

pub struct FirstRun {
    dir: Option<PathBuf>,
    wizard: Mutex<Wizard>,
}

impl FirstRun {
    pub fn wizard(&self) -> Wizard {
        *self.wizard.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Debug builds only: `SWARMTERM_SETUP_WIZARD=off` treats a fresh profile as
/// existing without writing anything, so testlab scenarios that start from
/// an empty app data dir are not covered by the assistant.
fn wizard_disabled_for_tests() -> bool {
    cfg!(debug_assertions)
        && std::env::var("SWARMTERM_SETUP_WIZARD").is_ok_and(|v| v.eq_ignore_ascii_case("off"))
}

/// Boot, first thing in `setup`: before voice settings are loaded and before
/// any writer of a marker file runs.
pub fn init(app: &AppHandle) {
    let dir = app.path().app_data_dir().ok();
    let wizard = if wizard_disabled_for_tests() {
        Wizard::Existing
    } else {
        match &dir {
            Some(d) => classify(d),
            None => Wizard::Existing,
        }
    };
    app.manage(FirstRun {
        dir,
        wizard: Mutex::new(wizard),
    });
}

/// The verdict of this boot; `Existing` when `init` did not run.
pub fn wizard(app: &AppHandle) -> Wizard {
    app.try_state::<FirstRun>()
        .map_or(Wizard::Existing, |f| f.wizard())
}

#[tauri::command]
pub async fn setup_wizard_state(app: AppHandle) -> Wizard {
    app.state::<FirstRun>().wizard()
}

/// The renderer reports how the assistant ended (or that localStorage shows
/// an older install). Settles voice in the same step: a new install that
/// never chose keeps voice off on disk, an older one gets it on once.
#[tauri::command]
pub async fn setup_wizard_finish(app: AppHandle, outcome: Wizard) -> Result<Wizard, String> {
    let first = app.state::<FirstRun>();
    let next = next(first.wizard(), outcome)?;
    // Voice first, the outcome second: a crash or a failed voice save in
    // between leaves the assistant pending (voice off, shown again), never
    // a finished install without its voice answer on disk (D3).
    crate::voice::settle_first_run(&app, next == Wizard::Existing)?;
    let mut wizard = first.wizard.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = &first.dir {
        if !wizard_disabled_for_tests() {
            write_state(dir, next)?;
        }
    }
    *wizard = next;
    Ok(next)
}

/// API key variables the agent CLIs read. The environment filter holds
/// them back by default (they match its secret rules), so a user who signs
/// in by key instead of the CLI's own login must pass them on.
pub const API_KEY_VARS: &[&str] = &["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/// Which of `API_KEY_VARS` are set (non-empty) — the names only.
pub fn api_key_vars_set(lookup: impl Fn(&str) -> Option<String>) -> Vec<String> {
    API_KEY_VARS
        .iter()
        .filter(|name| lookup(name).is_some_and(|v| !v.trim().is_empty()))
        .map(|name| (*name).to_owned())
        .collect()
}

/// Names of API key variables set in Swarmterm's environment. Never values.
#[tauri::command]
pub async fn setup_api_key_vars() -> Vec<String> {
    api_key_vars_set(|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_state_wins_and_markers_mean_an_older_install() {
        assert_eq!(decide(None, false), Wizard::Pending);
        assert_eq!(decide(None, true), Wizard::Existing);
        assert_eq!(decide(Some(Wizard::Pending), true), Wizard::Pending);
        assert_eq!(decide(Some(Wizard::Done), false), Wizard::Done);
    }

    #[test]
    fn classify_writes_the_verdict_once() {
        let dir = tempfile::tempdir().unwrap();
        // Unrelated files (WebView2, host copies) do not make an install old.
        fs::create_dir_all(dir.path().join("EBWebView")).unwrap();
        fs::write(dir.path().join("window-state.json"), "{}").unwrap();
        assert_eq!(classify(dir.path()), Wizard::Pending);
        // A boot push of the first run writes a marker; the stored verdict
        // still says pending, so quitting mid-assistant shows it again.
        fs::write(dir.path().join("env-policy.json"), "{}").unwrap();
        assert_eq!(classify(dir.path()), Wizard::Pending);
    }

    #[test]
    fn an_install_from_before_the_assistant_is_existing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("voice-settings.json"), "{}").unwrap();
        assert_eq!(classify(dir.path()), Wizard::Existing);
        assert_eq!(read_state(dir.path()), Some(Wizard::Existing));
    }

    #[test]
    fn local_history_from_an_older_boot_counts() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("local-history")).unwrap();
        assert_eq!(classify(dir.path()), Wizard::Existing);
    }

    #[test]
    fn a_broken_state_file_is_decided_again() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STATE_FILE), "garbage").unwrap();
        fs::write(dir.path().join("agent-accounts.json"), "[]").unwrap();
        assert_eq!(classify(dir.path()), Wizard::Existing);
    }

    #[test]
    fn a_finish_interrupted_after_the_outcome_boots_with_voice_off() {
        use crate::voice::settings::{load_for_boot, save};
        let dir = tempfile::tempdir().unwrap();
        for ended in [Wizard::Done, Wizard::Skipped] {
            // Outcome on disk, voice file missing (crash or a failed save
            // under an older order): the next boot must not turn voice on.
            let voice = dir.path().join("voice-settings.json");
            let _ = fs::remove_file(&voice);
            write_state(dir.path(), ended).unwrap();
            let wizard = classify(dir.path());
            assert_eq!(wizard, ended);
            let (settings, write) = load_for_boot(&voice, wizard);
            assert!(!settings.enabled && write, "{ended:?}");
            save(&voice, &settings).unwrap();
            assert!(!load_for_boot(&voice, classify(dir.path())).0.enabled);
        }
    }

    #[test]
    fn the_state_file_holds_flags_only() {
        let dir = tempfile::tempdir().unwrap();
        write_state(dir.path(), Wizard::Skipped).unwrap();
        let text = fs::read_to_string(dir.path().join(STATE_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v, serde_json::json!({ "version": 1, "wizard": "skipped" }));
    }

    #[test]
    fn reports_names_of_set_key_variables_only() {
        let env = |name: &str| match name {
            "ANTHROPIC_API_KEY" => Some("sk-test".to_owned()),
            "OPENAI_API_KEY" => Some("  ".to_owned()),
            _ => None,
        };
        assert_eq!(api_key_vars_set(env), vec!["ANTHROPIC_API_KEY".to_owned()]);
        assert!(api_key_vars_set(|_| None).is_empty());
    }

    #[test]
    fn outcomes() {
        use Wizard::*;
        assert_eq!(next(Pending, Done), Ok(Done));
        assert_eq!(next(Pending, Skipped), Ok(Skipped));
        assert_eq!(next(Pending, Existing), Ok(Existing));
        assert!(next(Pending, Pending).is_err());
        // A re-run from Settings finishes as done or skipped again.
        assert_eq!(next(Existing, Done), Ok(Done));
        assert_eq!(next(Done, Skipped), Ok(Skipped));
        // "existing" never overrides a finished assistant.
        assert_eq!(next(Done, Existing), Ok(Done));
    }
}
