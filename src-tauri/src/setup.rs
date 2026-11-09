//! First-run integration setup (SWA-83): who writes the agent CLIs' config
//! for Swarmterm, when, and what came of it.
//!
//! The writers themselves (`hook::install`, `hook::codex`, `mcp::config`,
//! `statusline::install`) stay where they are; this module decides WHEN they
//! run and keeps their last outcome so the renderer can show it
//! (`setup_status`) instead of the failures vanishing into stderr.
//!
//! Rules:
//! * Nothing is written for a CLI that is not installed. A fresh machine
//!   without Claude Code must not grow a `~/.claude/settings.json`. A profile
//!   that already holds our entries counts as installed even when the CLI is
//!   not on the app's PATH (nvm/volta from a shell profile, installed after
//!   start): its stale exe paths are still repaired on every boot.
//! * `ensure_*` is idempotent and re-runs wherever a CLI may have appeared
//!   since boot: at pane spawn and when the renderer re-probes agents. Once a
//!   CLI's entries are in place the call is a PATH scan and two atomics.
//! * Writes run under `accounts::CONFIG_WRITE`, like enrollment and the MCP
//!   switch, so a repair never interleaves its read-merge-rename with them.
//!   That includes the status line: it shares `settings.json` with the hooks.
//!   Never call these while holding `terminals` or an enroll lock.
//! * Codex is probed (`codex --help`, up to 3 s) on a blocking worker, never
//!   on the setup thread, and never under `CONFIG_WRITE` (every enrollment
//!   and the MCP switch would wait for it). A Codex pane spawned before that
//!   finishes calls `ensure_codex` itself and waits on the same probe, so it
//!   never starts without hooks.
//! * Only names and states leave this module; error texts are the writers'
//!   own (paths at most, never file contents or env values).

use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Outcome of one integration check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Not checked yet this run (e.g. the Codex probe is still running).
    Unknown,
    /// Our entry is in place (or nothing needed changing).
    Ok,
    /// Switched off by the user or by admin policy.
    Off,
    /// The CLI is not installed; nothing was written.
    NotInstalled,
    /// The installed CLI is too old for this feature.
    Outdated,
    /// The user's own entry occupies the slot; left untouched on purpose.
    Foreign,
    /// Left to another Swarmterm (dev build next to the installed app).
    Deferred,
    /// Writing failed; `detail` says why.
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Check {
    pub state: State,
    pub detail: Option<String>,
}

impl Check {
    pub const fn unknown() -> Self {
        Self {
            state: State::Unknown,
            detail: None,
        }
    }
    fn of(state: State) -> Self {
        Self {
            state,
            detail: None,
        }
    }
    fn error(detail: impl Into<String>) -> Self {
        Self {
            state: State::Error,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// `None` until the first check ran.
    pub installed: Option<bool>,
    pub hooks: Check,
    pub mcp: Check,
    pub status_line: Check,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: Option<bool>,
    pub hooks: Check,
    pub mcp: Check,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub claude: ClaudeStatus,
    pub codex: CodexStatus,
}

impl SetupStatus {
    const fn new() -> Self {
        Self {
            claude: ClaudeStatus {
                installed: None,
                hooks: Check::unknown(),
                mcp: Check::unknown(),
                status_line: Check::unknown(),
            },
            codex: CodexStatus {
                installed: None,
                hooks: Check::unknown(),
                mcp: Check::unknown(),
            },
        }
    }
}

/// The last outcome per check. Own lock, never held together with
/// `terminals`, `CONFIG_WRITE` or anything else.
static STATUS: Mutex<SetupStatus> = Mutex::new(SetupStatus::new());

/// Serialize each agent's ensure so two pane spawns do not both write.
static CLAUDE_ENSURE: Mutex<()> = Mutex::new(());
static CODEX_ENSURE: Mutex<()> = Mutex::new(());
/// Set once every entry for the agent is in place; later calls only re-check
/// that the CLI is still there.
static CLAUDE_DONE: AtomicBool = AtomicBool::new(false);
static CODEX_DONE: AtomicBool = AtomicBool::new(false);

/// The renderer's status-line preference, once it has sent one. Applied when
/// Claude Code turns up after boot (the renderer only syncs at start).
static STATUSLINE_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn status() -> SetupStatus {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Apply `f` to the stored status; tell the renderer when anything changed.
fn update(app: Option<&AppHandle>, f: impl FnOnce(&mut SetupStatus)) {
    let changed = {
        let mut s = STATUS.lock().unwrap_or_else(|e| e.into_inner());
        let before = s.clone();
        f(&mut s);
        *s != before
    };
    if changed {
        if let Some(app) = app {
            let _ = app.emit("setup:changed", ());
        }
    }
}

/// `CLAUDE_CONFIG_DIR` set to a folder that does not exist: the MCP writer
/// refuses to fabricate it (a typo must fail), so the hooks must not create
/// it either. Returns the folder when that is the case.
fn missing_config_dir(var: Option<&str>) -> Option<&str> {
    var.map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|dir| !Path::new(dir).is_dir())
}

/// Does the default profile's `settings.json` already carry one of our hook
/// or status-line commands? Read-only; a missing or unreadable file is "no".
fn claude_profile_has_ours(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    let cfg = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let path = crate::statusline::install::resolve_settings_path(&home, cfg.as_deref());
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|text| settings_have_ours(&text))
}

/// Pure half of `claude_profile_has_ours`: any `command` string that is our
/// `--hook` or `--statusline` entry, wherever it sits in the document.
fn settings_have_ours(text: &str) -> bool {
    fn walk(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
                (k == "command"
                    && v.as_str().is_some_and(|c| {
                        crate::hook::install::is_ours_hook(c)
                            || crate::statusline::install::is_ours(c)
                    }))
                    || walk(v)
            }),
            serde_json::Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|v| walk(&v))
}

/// Claude Code counts as installed when the CLI is found or the profile
/// already has our entries (see the module rules).
fn claude_installed(app: &AppHandle) -> bool {
    crate::agents::find_agent_binary("claude").is_some() || claude_profile_has_ours(app)
}

/// What `ensure_claude` should do, given what it found. Pure for tests.
#[derive(Debug, PartialEq, Eq)]
enum ClaudePlan {
    NotInstalled,
    MissingConfigDir(String),
    AlreadyDone,
    Write,
}

fn plan_claude(installed: bool, missing_dir: Option<&str>, done: bool) -> ClaudePlan {
    if !installed {
        ClaudePlan::NotInstalled
    } else if let Some(dir) = missing_dir {
        ClaudePlan::MissingConfigDir(dir.to_owned())
    } else if done {
        ClaudePlan::AlreadyDone
    } else {
        ClaudePlan::Write
    }
}

/// Hooks, user-scope MCP entry and (if the renderer asked for it) the status
/// line for the default Claude Code profile.
pub fn ensure_claude(app: &AppHandle) {
    let _guard = CLAUDE_ENSURE.lock().unwrap_or_else(|e| e.into_inner());
    let installed = claude_installed(app);
    let cfg = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let plan = plan_claude(
        installed,
        missing_config_dir(cfg.as_deref()),
        CLAUDE_DONE.load(Ordering::Acquire),
    );
    match plan {
        ClaudePlan::AlreadyDone => {}
        ClaudePlan::NotInstalled => {
            // Uninstalled since: the entries stay (removing a user's config
            // because PATH changed would be worse), but say so.
            CLAUDE_DONE.store(false, Ordering::Release);
            update(Some(app), |s| {
                s.claude.installed = Some(false);
                for check in [
                    &mut s.claude.hooks,
                    &mut s.claude.mcp,
                    &mut s.claude.status_line,
                ] {
                    if check.state != State::Ok {
                        *check = Check::of(State::NotInstalled);
                    }
                }
            });
        }
        ClaudePlan::MissingConfigDir(dir) => {
            // One cause, one problem row where possible: MCP and the status
            // line report it only when they would have been written.
            let why = format!("CLAUDE_CONFIG_DIR points to a folder that does not exist: {dir}");
            let mcp_on = crate::mcp::toggle::is_enabled("claude-code", None);
            let line_on = STATUSLINE_REQUESTED.load(Ordering::Acquire)
                && crate::accounts::STATUSLINE_ENABLED.load(Ordering::Relaxed);
            update(Some(app), |s| {
                s.claude.installed = Some(true);
                s.claude.hooks = Check::error(why.clone());
                s.claude.mcp = if mcp_on {
                    Check::error(why.clone())
                } else {
                    Check::of(State::Off)
                };
                s.claude.status_line = if line_on {
                    Check::error(why)
                } else {
                    Check::of(State::Off)
                };
            });
        }
        ClaudePlan::Write => {
            let (hooks, mcp, status_line) = {
                let _lock = crate::accounts::CONFIG_WRITE
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let hooks = match crate::hook::install::register(app) {
                    Ok(()) => Check::of(State::Ok),
                    Err(e) => {
                        eprintln!("hook: {e}");
                        Check::error(e)
                    }
                };
                let mcp = match crate::mcp::config::register_user_scope(app) {
                    Ok(true) => Check::of(State::Ok),
                    Ok(false) => Check::of(State::Off),
                    Err(e) => {
                        eprintln!("mcp: {e}");
                        Check::error(e)
                    }
                };
                // Same lock as `set_claude_statusline`'s write, and the value
                // is read under it: whichever runs last applies the latest
                // preference.
                let status_line = STATUSLINE_REQUESTED.load(Ordering::Acquire).then(|| {
                    let enabled = crate::accounts::STATUSLINE_ENABLED.load(Ordering::Relaxed);
                    status_line_check(enabled, crate::statusline::install::apply(app, enabled))
                });
                (hooks, mcp, status_line)
            };
            let ok = hooks.state != State::Error
                && mcp.state != State::Error
                && status_line.as_ref().is_none_or(|c| c.state != State::Error);
            CLAUDE_DONE.store(ok, Ordering::Release);
            update(Some(app), |s| {
                s.claude.installed = Some(true);
                s.claude.hooks = hooks;
                s.claude.mcp = mcp;
                if let Some(c) = status_line {
                    s.claude.status_line = c;
                }
            });
        }
    }
}

fn status_line_check(enabled: bool, result: Result<(), String>) -> Check {
    match result {
        Ok(()) if enabled => Check::of(State::Ok),
        Ok(()) => Check::of(State::Off),
        Err(e) if e == crate::statusline::install::FOREIGN_STATUS_LINE => Check::of(State::Foreign),
        Err(e) => Check::error(e),
    }
}

/// Outcome of `set_claude_statusline` for the default profile. Returns
/// whether the default profile should be written at all (Claude installed).
pub fn status_line_requested(app: &AppHandle) -> bool {
    STATUSLINE_REQUESTED.store(true, Ordering::Release);
    let installed = claude_installed(app);
    if !installed {
        update(Some(app), |s| {
            s.claude.installed = Some(false);
            s.claude.status_line = Check::of(State::NotInstalled);
        });
    }
    installed
}

pub fn record_status_line(app: &AppHandle, enabled: bool, result: &Result<(), String>) {
    let check = status_line_check(enabled, result.clone());
    if check.state == State::Error {
        // Let the next ensure (pane spawn, "Check again") retry it.
        CLAUDE_DONE.store(false, Ordering::Release);
    }
    update(Some(app), |s| s.claude.status_line = check);
}

/// Codex session hooks. Blocks on the `codex --help` probe (≤ 3.5 s) the
/// first time, so call it from a blocking worker or a pane spawn.
pub fn ensure_codex(app: &AppHandle) {
    let _guard = CODEX_ENSURE.lock().unwrap_or_else(|e| e.into_inner());
    let installed = crate::agents::find_agent_binary("codex").is_some();
    if !installed {
        CODEX_DONE.store(false, Ordering::Release);
        update(Some(app), |s| {
            s.codex.installed = Some(false);
            for check in [&mut s.codex.hooks, &mut s.codex.mcp] {
                if check.state != State::Ok {
                    *check = Check::of(State::NotInstalled);
                }
            }
        });
        return;
    }
    if CODEX_DONE.load(Ordering::Acquire) {
        return;
    }
    // Probe BEFORE taking the write lock; `register` then hits the cache.
    let _ = crate::hook::codex::probe_supported();
    let (hooks, mcp) = {
        let _lock = crate::accounts::CONFIG_WRITE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = crate::hook::codex::register(app);
        if let Err(e) = &result {
            eprintln!("Codex session hook registration failed: {e}");
        }
        (codex_hooks_check(result), codex_mcp_locked(app))
    };
    // Unsupported is final for this run (the probe result is cached);
    // Undecided (probe timed out) is retried by the next call.
    CODEX_DONE.store(
        hooks.state == State::Ok && mcp.as_ref().is_none_or(|c| c.state != State::Error),
        Ordering::Release,
    );
    update(Some(app), |s| {
        s.codex.installed = Some(true);
        s.codex.hooks = hooks;
        if let Some(mcp) = mcp {
            s.codex.mcp = mcp;
        }
    });
}

fn codex_hooks_check(result: Result<crate::hook::codex::Registered, String>) -> Check {
    use crate::hook::codex::Registered;
    match result {
        Ok(Registered::Written) => Check::of(State::Ok),
        Ok(Registered::Unsupported) => Check::of(State::Outdated),
        Ok(Registered::Deferred) => Check::of(State::Deferred),
        Ok(Registered::Undecided) => Check {
            state: State::Unknown,
            detail: Some(
                "Codex did not answer in time; checked again at the next pane start".into(),
            ),
        },
        Err(e) => Check::error(e),
    }
}

/// Codex reads MCP servers from `config.toml` at session start and cannot
/// expand env vars in `url`, so the concrete URL is (re)written. Dev builds
/// skip it: two apps sharing one `config.toml` would overwrite each other's
/// port, and pane-started Codex is pinned per process anyway. `None` until
/// the MCP server has a port (`mcp::start` calls `codex_mcp` then). The
/// caller holds `CONFIG_WRITE` (the hooks write the same `config.toml`).
fn codex_mcp_locked(app: &AppHandle) -> Option<Check> {
    use tauri::Manager;
    if cfg!(debug_assertions) {
        return Some(codex_mcp_check(None));
    }
    if !crate::mcp::toggle::is_enabled("codex", None) {
        return Some(codex_mcp_check(Some(Ok(false))));
    }
    let url = app
        .state::<crate::pty::AppState>()
        .mcp_url
        .get()?
        .to_string();
    let result = crate::mcp::config::register_codex(app, &url);
    if let Err(e) = &result {
        eprintln!("mcp: {e}");
    }
    Some(codex_mcp_check(Some(result.map(|()| true))))
}

/// Called by `mcp::start` once the port is known: writes Codex's entry if
/// Codex is installed, records "not installed" otherwise. A Codex installed
/// later gets it from `ensure_codex`.
pub fn codex_mcp(app: &AppHandle) {
    let check = if crate::agents::find_agent_binary("codex").is_none() {
        Some(Check::of(State::NotInstalled))
    } else {
        let _lock = crate::accounts::CONFIG_WRITE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        codex_mcp_locked(app)
    };
    if let Some(check) = check {
        update(Some(app), |s| s.codex.mcp = check);
    }
}

fn codex_mcp_check(result: Option<Result<bool, String>>) -> Check {
    match result {
        // Dev build: not written to the shared `config.toml` on purpose.
        None => Check {
            state: State::Deferred,
            detail: Some("Codex panes started here get the address directly".into()),
        },
        Some(Ok(true)) => Check::of(State::Ok),
        Some(Ok(false)) => Check::of(State::Off),
        Some(Err(e)) => Check::error(e),
    }
}

/// Boot: Claude synchronously (hooks are snapshotted when a session starts,
/// and restored panes spawn right after the renderer mounts), Codex on a
/// blocking worker so its probe never delays the window.
pub fn boot(app: &AppHandle) {
    ensure_claude(app);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_codex(&app));
}

/// Pane spawn: make sure the agent about to start finds its entries.
pub fn ensure_for_agent(app: &AppHandle, agent_id: Option<&str>) {
    match agent_id {
        Some("claude-code") => ensure_claude(app),
        Some("codex") => ensure_codex(app),
        _ => {}
    }
}

/// Renderer re-probe (Welcome mount, Settings → Setup): pick up a CLI that
/// was installed while the app runs, and re-verify entries that were fine
/// before — a settings file the user broke since must show up here. The
/// writers are idempotent, so a healthy setup costs reads, not writes.
pub fn recheck(app: &AppHandle) -> SetupStatus {
    CLAUDE_DONE.store(false, Ordering::Release);
    CODEX_DONE.store(false, Ordering::Release);
    ensure_claude(app);
    ensure_codex(app);
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_written_for_a_missing_cli() {
        assert_eq!(plan_claude(false, None, false), ClaudePlan::NotInstalled);
        // Even when it was done before (uninstalled since).
        assert_eq!(plan_claude(false, None, true), ClaudePlan::NotInstalled);
    }

    #[test]
    fn a_missing_config_dir_is_reported_not_fabricated() {
        assert_eq!(
            plan_claude(true, Some("D:/nope"), false),
            ClaudePlan::MissingConfigDir("D:/nope".into())
        );
    }

    #[test]
    fn done_skips_the_write_until_the_cli_goes_away() {
        assert_eq!(plan_claude(true, None, true), ClaudePlan::AlreadyDone);
        assert_eq!(plan_claude(true, None, false), ClaudePlan::Write);
    }

    #[test]
    fn config_dir_check_ignores_blank_and_existing() {
        assert_eq!(missing_config_dir(None), None);
        assert_eq!(missing_config_dir(Some("  ")), None);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(missing_config_dir(dir.path().to_str()), None);
        let gone = dir.path().join("gone");
        assert_eq!(
            missing_config_dir(gone.to_str()),
            gone.to_str().map(|s| s.trim())
        );
    }

    #[test]
    fn a_foreign_status_line_is_not_an_error() {
        let foreign = Err(crate::statusline::install::FOREIGN_STATUS_LINE.to_owned());
        assert_eq!(status_line_check(true, foreign).state, State::Foreign);
        assert_eq!(status_line_check(true, Ok(())).state, State::Ok);
        assert_eq!(status_line_check(false, Ok(())).state, State::Off);
        let broken = status_line_check(true, Err("parse: x".into()));
        assert_eq!(broken.state, State::Error);
        assert_eq!(broken.detail.as_deref(), Some("parse: x"));
    }

    #[test]
    fn codex_mcp_outcomes() {
        assert_eq!(codex_mcp_check(None).state, State::Deferred);
        assert_eq!(codex_mcp_check(Some(Ok(true))).state, State::Ok);
        assert_eq!(codex_mcp_check(Some(Ok(false))).state, State::Off);
        assert_eq!(codex_mcp_check(Some(Err("e".into()))).state, State::Error);
    }

    #[test]
    fn our_entries_are_found_anywhere_in_settings() {
        let hook = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"C:/Apps/swarmterm.exe\" --hook"}]}]}}"#;
        assert!(settings_have_ours(hook));
        let line = r#"{"statusLine":{"type":"command","command":"\"C:/Apps/swarmterm.exe\" --statusline"}}"#;
        assert!(settings_have_ours(line));
        assert!(!settings_have_ours(
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"~/notify.sh"}]}]}}"#
        ));
        assert!(!settings_have_ours("not json"));
        assert!(!settings_have_ours("{}"));
    }

    #[test]
    fn a_slow_codex_is_not_reported_outdated() {
        use crate::hook::codex::Registered;
        assert_eq!(
            codex_hooks_check(Ok(Registered::Undecided)).state,
            State::Unknown
        );
        assert_eq!(
            codex_hooks_check(Ok(Registered::Unsupported)).state,
            State::Outdated
        );
        assert_eq!(codex_hooks_check(Ok(Registered::Written)).state, State::Ok);
        assert_eq!(codex_hooks_check(Err("x".into())).state, State::Error);
    }

    #[test]
    fn status_serializes_camel_case() {
        let v = serde_json::to_value(SetupStatus::new()).unwrap();
        assert_eq!(v["claude"]["statusLine"]["state"], "unknown");
        assert_eq!(v["codex"]["installed"], serde_json::Value::Null);
        assert_eq!(
            serde_json::to_value(State::NotInstalled).unwrap(),
            "notInstalled"
        );
    }
}
