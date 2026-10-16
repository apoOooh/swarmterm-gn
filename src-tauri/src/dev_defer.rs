//! Dev builds must not take over the user's Claude Code config.
//!
//! Every boot (and every Claude pane start in a named account profile) writes
//! `"<current_exe>" --hook` / `--statusline` into a `settings.json` the
//! installed app shares. A `tauri dev` build in a worktree would therefore
//! point every Claude Code session on the machine at
//! `<worktree>/src-tauri/target/debug/swarmterm.exe` — and once that worktree
//! is cleaned up, each hook event fails with "No such file or directory".
//!
//! Rule (same spirit as the Codex one in `hook/codex.rs::register`): a debug
//! build leaves the file alone, in BOTH directions, while it holds a command
//! of ours that runs a different binary which still exists. The hook and the
//! status line only read the pane's env, so the installed app's entries serve
//! dev panes too. If the entry points at a binary that is gone (exactly the
//! broken state above) or there is none, the dev build writes its own path as
//! before — a working dev entry beats a dead one, and the installed app
//! repairs it on its next boot anyway.

use std::path::Path;

use serde_json::Value;

/// The executable inside one of our `"<path>" --flag` commands (the shape both
/// `format_command`s produce). Anything else is not ours to interpret.
pub fn command_exe(command: &str) -> Option<&str> {
    let rest = command.trim().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end]).filter(|p| !p.is_empty())
}

/// Same executable? Windows paths are case-insensitive and may be recorded
/// with either slash direction, so compare normalised forms.
fn same_exe(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.replace('\\', "/");
        if cfg!(windows) {
            s.to_ascii_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/// Every hook and status line command in a Claude Code `settings.json` value.
fn commands(root: &Value) -> Vec<&str> {
    let mut out = Vec::new();
    if let Some(events) = root.get("hooks").and_then(Value::as_object) {
        for groups in events.values().filter_map(Value::as_array) {
            for group in groups {
                let entries = group.get("hooks").and_then(Value::as_array);
                for entry in entries.into_iter().flatten() {
                    out.extend(entry.get("command").and_then(Value::as_str));
                }
            }
        }
    }
    out.extend(
        root.get("statusLine")
            .and_then(|s| s.get("command"))
            .and_then(Value::as_str),
    );
    out
}

/// Does another, still existing Swarmterm binary own commands in this file?
/// Pure (the filesystem check is injected) so every branch is unit-tested.
/// Unparseable text answers `false`: the writers report the parse error
/// themselves and never write such a file.
pub fn owned_by_other_live_exe(
    existing: Option<&str>,
    own_exe: &str,
    is_ours: fn(&str) -> bool,
    exists: impl Fn(&str) -> bool,
) -> bool {
    let Some(root) = existing
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
    else {
        return false;
    };
    commands(&root)
        .into_iter()
        .filter(|c| is_ours(c))
        .filter_map(command_exe)
        .any(|exe| !same_exe(exe, own_exe) && exists(exe))
}

/// Should this process leave `existing` untouched? Only ever true for a debug
/// build (and never under `cargo test`, whose fixtures exercise the real
/// write paths). Release builds always (re)claim their entries — that is what
/// repairs a stale path after an update or a move.
pub fn defers(existing: Option<&str>, is_ours: fn(&str) -> bool) -> bool {
    if !cfg!(debug_assertions) || cfg!(test) {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    owned_by_other_live_exe(existing, &exe.to_string_lossy(), is_ours, |p| {
        Path::new(p).is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::install::is_ours_hook;
    use crate::statusline::install::is_ours as is_ours_statusline;

    const INSTALLED: &str = "C:/Users/me/AppData/Local/Swarmterm GN/swarmterm.exe";
    const DEV: &str = "C:/Users/me/ai/swarmterm-gn/worktree/x/src-tauri/target/debug/swarmterm.exe";

    fn hooks_file(exe: &str) -> String {
        format!(
            r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"\"{exe}\" --hook"}}]}}]}}}}"#
        )
    }

    fn status_file(exe: &str) -> String {
        format!(r#"{{"statusLine":{{"type":"command","command":"\"{exe}\" --statusline"}}}}"#)
    }

    fn live(exe: &'static str) -> impl Fn(&str) -> bool {
        move |p| p == exe
    }

    #[test]
    fn extracts_the_quoted_executable() {
        assert_eq!(
            command_exe(&format!("\"{INSTALLED}\" --hook")),
            Some(INSTALLED)
        );
        assert_eq!(
            command_exe("  \"/a b/swarmterm\" --statusline "),
            Some("/a b/swarmterm")
        );
        assert_eq!(command_exe("swarmterm --hook"), None);
        assert_eq!(command_exe("\"\" --hook"), None);
        assert_eq!(command_exe("\"unterminated --hook"), None);
    }

    #[test]
    fn defers_to_a_live_installed_hook() {
        let f = hooks_file(INSTALLED);
        assert!(owned_by_other_live_exe(
            Some(&f),
            DEV,
            is_ours_hook,
            live(INSTALLED)
        ));
    }

    #[test]
    fn defers_to_a_live_installed_status_line() {
        let f = status_file(INSTALLED);
        assert!(owned_by_other_live_exe(
            Some(&f),
            DEV,
            is_ours_statusline,
            live(INSTALLED)
        ));
    }

    #[test]
    fn repairs_an_entry_whose_binary_is_gone() {
        // The bug: a deleted worktree's debug exe. Nothing exists → write.
        let f = hooks_file(DEV);
        assert!(!owned_by_other_live_exe(
            Some(&f),
            INSTALLED,
            is_ours_hook,
            |_| false
        ));
    }

    #[test]
    fn its_own_entry_is_not_another_owner() {
        let f = hooks_file(DEV);
        assert!(!owned_by_other_live_exe(
            Some(&f),
            DEV,
            is_ours_hook,
            live(DEV)
        ));
    }

    #[test]
    fn own_exe_matches_across_slash_direction() {
        let f = hooks_file(DEV);
        let backslashed = DEV.replace('/', "\\");
        assert!(!owned_by_other_live_exe(
            Some(&f),
            &backslashed,
            is_ours_hook,
            |_| true
        ));
    }

    #[test]
    fn ignores_foreign_commands_and_the_other_kind() {
        // A foreign hook and our status line do not make the hooks "owned".
        let f = format!(
            r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"\"{INSTALLED}\" --notify"}}]}}]}},
                "statusLine":{{"type":"command","command":"\"{INSTALLED}\" --statusline"}}}}"#
        );
        assert!(!owned_by_other_live_exe(
            Some(&f),
            DEV,
            is_ours_hook,
            |_| true
        ));
    }

    #[test]
    fn nothing_to_defer_to_in_missing_empty_or_malformed_files() {
        for text in [None, Some(""), Some("  "), Some("{not json"), Some("[]")] {
            assert!(!owned_by_other_live_exe(text, DEV, is_ours_hook, |_| true));
        }
    }

    #[test]
    fn never_defers_under_test() {
        assert!(!defers(Some(&hooks_file(INSTALLED)), is_ours_hook));
    }
}
