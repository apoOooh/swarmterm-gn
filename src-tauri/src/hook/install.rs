//! Registering `swarmterm --hook` in Claude Code's user-scope settings.
//!
//! Same read → merge → `.tmp` → rename policy as `statusline/install.rs` and
//! `mcp/config.rs`, so a crash mid-write can never truncate `settings.json`.
//! Unlike the status line, `hooks` is a key the user very plausibly already
//! owns (their own Stop notifier, a lint on PostToolUse…), so the merge is
//! ADDITIVE: groups that are entirely ours are replaced (repairs a stale exe
//! path after an update or move), foreign and mixed groups are never touched,
//! and removal leaves the file as if we had never been there. "Ours" is
//! decided per command string (`is_ours_hook`), never by position.
//!
//! Steady state must be ZERO writes: the decision is `Value` equality, not
//! string equality, so a user's own reformatting never triggers a rewrite —
//! and every real write keeps their key order and indent (`json_style`).
//!
//! Runs at boot, before any pane launches `claude`. Claude Code snapshots
//! hooks at session start, so new sessions see us; already-running sessions
//! do not (documented in S5.3).

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The events Claude Code will run us for. Exactly the `Some` rows of
/// `super::signal_for` — the lockstep test enforces both directions, because a
/// registered event with no signal spawns a process for nothing and a signal
/// with no registration is a state the renderer never hears about.
pub const HOOK_EVENTS: [&str; 8] = [
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "Stop",
    // SWA-58: a turn that ended in an API error is announced as such.
    "StopFailure",
    "SessionStart",
    "SessionEnd",
];

/// Wedge backstop, in SECONDS (Claude Code's unit). The CLI's own POST times
/// out at 300 ms; this only matters if the binary itself hangs, where Claude
/// Code's 600 s default would freeze the session on every event.
const HOOK_TIMEOUT_SECS: u64 = 5;

/// Our hook entry for an executable path, in exec form (SWA-83 1c-ii):
/// with `args`, Claude Code spawns `command` directly instead of handing a
/// command line to a shell. The same entry therefore works under Git Bash
/// and under the PowerShell that Claude Code falls back to without it,
/// where the former `"<path>" --hook` line was a parse error on every
/// event. Forward slashes only to match how the status line records paths;
/// a direct spawn takes either.
pub fn hook_entry(exe: &str, windows: bool) -> Value {
    let path = if windows {
        exe.replace('\\', "/")
    } else {
        exe.to_owned()
    };
    json!({ "type": "command", "command": path, "args": ["--hook"] })
}

/// The shell-form command line (`"<path>" --hook`): runs only under Git
/// Bash. Kept for Claude Code before 2.1.139 (`claude_version`), where the
/// 1c-i gate still applies; `is_ours_hook` recognises it either way, so a
/// Claude Code update migrates it to `hook_entry`.
pub fn format_command(exe: &str, windows: bool) -> String {
    let path = if windows {
        exe.replace('\\', "/")
    } else {
        exe.to_owned()
    };
    format!("\"{path}\" --hook")
}

/// Our entry for the Claude Code on this machine: exec form when it takes
/// one (`claude_version::exec_hooks`), else the shell form.
pub fn claude_hook_entry(exe: &str, windows: bool, exec: bool) -> Value {
    if exec {
        hook_entry(exe, windows)
    } else {
        json!({ "type": "command", "command": format_command(exe, windows) })
    }
}

/// One hook entry as a command line: `command` itself (shell form), or
/// `"command" arg` (exec form). Every "is this ours" and "which binary"
/// rule reads entries through this, so both shapes are recognised. An exec
/// form we could not have written — more or fewer than one argument, a
/// non-string argument, a quote inside `command` — has no line at all, so a
/// stranger's `node ["…/swarmterm/notify.js", "--hook"]` is never flattened
/// into something that looks like ours.
pub fn entry_line(entry: &Value) -> Option<String> {
    let command = entry.get("command")?.as_str()?;
    let Some(args) = entry.get("args") else {
        return Some(command.to_owned());
    };
    match args.as_array()?.as_slice() {
        [arg] if !command.contains('"') => Some(format!("\"{command}\" {}", arg.as_str()?)),
        _ => None,
    }
}

/// The file name of our binary, in every edition and build.
pub fn is_swarmterm_exe(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("");
    name.eq_ignore_ascii_case("swarmterm.exe") || name.eq_ignore_ascii_case("swarmterm")
}

/// The executable of `"<path>" <flag>` or `<path> <flag>`, exactly that
/// shape; `None` for anything else.
pub fn command_with_flag<'a>(line: &'a str, flag: &str) -> Option<&'a str> {
    let line = line.trim();
    let (path, rest) = match line.strip_prefix('"') {
        Some(quoted) => {
            let end = quoted.find('"')?;
            (&quoted[..end], &quoted[end + 1..])
        }
        None => line.split_once(' ')?,
    };
    (!path.is_empty() && rest.trim() == flag).then_some(path)
}

/// Does this hook command line belong to us? Structurally: exactly our
/// binary (`swarmterm.exe`, by file name — a folder called `swarmterm` or a
/// `swarmterm-helper.exe` is not us) followed by exactly `--hook`. Our own
/// `--statusline` entry, a bare `swarmterm` and a stranger's `--hook` are
/// all left alone.
pub fn is_ours_hook(command: &str) -> bool {
    command_with_flag(command, "--hook").is_some_and(is_swarmterm_exe)
}

/// The one group we install per event. No `matcher`: it is ignored on most of
/// these events anyway and the CLI filters `notification_type` itself. No
/// `async`: a synchronous hook guarantees the signal lands before Claude
/// proceeds, and the CLI returns in well under its 300 ms POST budget.
fn our_group(entry: &Value, timeout_secs: u64) -> Value {
    let mut entry = entry.clone();
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("timeout".into(), json!(timeout_secs));
    }
    json!({ "hooks": [entry] })
}

/// A group is ours iff it is an object whose `hooks` is a non-empty array and
/// EVERY entry's command line is ours. Anything mixed belongs to the user —
/// they hand-copied our command into their own group and may edit it as they
/// like.
pub(crate) fn group_is_ours(group: &Value, is_ours: fn(&str) -> bool) -> bool {
    let Some(entries) = group.get("hooks").and_then(Value::as_array) else {
        return false;
    };
    !entries.is_empty()
        && entries
            .iter()
            .all(|h| entry_line(h).is_some_and(|line| is_ours(&line)))
}

/// What `merge_hooks` decided. There is deliberately no `Foreign` variant:
/// additive means foreign groups coexist with ours, never a refusal.
#[derive(Debug)]
pub enum HooksWrite {
    /// Already current (or nothing of ours to remove) — do not touch the file.
    Unchanged,
    /// New file contents.
    Write(String),
}

/// Compute the new `settings.json` contents. `entry: Some(_)` installs,
/// `None` removes.
///
/// Only the eight `HOOK_EVENTS` keys are ever rewritten; every other key under
/// `hooks` (and every other top-level key) passes through untouched. An event
/// array or the `hooks` object that ends up empty is dropped, so removal
/// restores the file to "we were never here". A pre-existing empty
/// `"hooks": {}` gets tidied once by the same rule — a harmless one-time write.
pub fn merge_hooks(existing: Option<&str>, entry: Option<&Value>) -> Result<HooksWrite, String> {
    merge_events(existing, entry, &HOOK_EVENTS, is_ours_hook)
}

pub fn merge_events(
    existing: Option<&str>,
    entry: Option<&Value>,
    events: &[&str],
    is_ours: fn(&str) -> bool,
) -> Result<HooksWrite, String> {
    merge_events_timed(existing, entry, events, is_ours, |_| HOOK_TIMEOUT_SECS)
}

/// `merge_events` with a timeout per event: Codex clamps some events
/// (`Interrupt` to 3 s) and warns on every start if we ask for more.
pub fn merge_events_timed(
    existing: Option<&str>,
    entry: Option<&Value>,
    events: &[&str],
    is_ours: fn(&str) -> bool,
    timeout_secs: fn(&str) -> u64,
) -> Result<HooksWrite, String> {
    let before: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse: {e}"))?,
    };
    if !before.is_object() {
        return Err("root is not a JSON object".into());
    }
    let mut root = before.clone();
    let obj = root.as_object_mut().unwrap();

    // Edit `hooks` and each event array IN PLACE. The old remove-and-reinsert
    // dance is not order-neutral under `preserve_order`: `Map::remove` is
    // swap_remove (drags the last key into the hole) and a re-insert lands at
    // the end — either way the user's file gets shuffled. `entry` on an absent
    // key appends, which is the only order that makes sense for a new key.
    let hooks = match obj.entry("hooks").or_insert_with(|| json!({})) {
        Value::Object(m) => m,
        _ => return Err("`hooks` is not a JSON object".into()),
    };
    for &event in events {
        if !hooks.contains_key(event) {
            if let Some(entry) = entry {
                hooks.insert(
                    event.to_owned(),
                    Value::Array(vec![our_group(entry, timeout_secs(event))]),
                );
            }
            continue;
        }
        let groups = match hooks.get_mut(event) {
            Some(Value::Array(a)) => a,
            _ => return Err(format!("`hooks.{event}` is not a JSON array")),
        };
        // Dropping every all-ours group and re-adding one is what repairs a
        // stale exe path (dev build → release build, or a moved app).
        groups.retain(|g| !group_is_ours(g, is_ours));
        if let Some(entry) = entry {
            groups.push(our_group(entry, timeout_secs(event)));
        }
        if groups.is_empty() {
            hooks.shift_remove(event);
        }
    }
    if hooks.is_empty() {
        // shift, not swap — see above. Also what turns a pre-existing
        // `"hooks": {}` into "we were never here".
        obj.shift_remove("hooks");
    }

    if root == before {
        return Ok(HooksWrite::Unchanged);
    }
    crate::json_style::JsonStyle::detect(existing)
        .render(&root)
        .map(HooksWrite::Write)
}

/// Read → merge → write tmp → rename. The rename is atomic, so a crash
/// mid-write can never leave a truncated settings file. The tmp name differs
/// from the status line's `json.tmp` so the two writers can never collide on
/// the same intermediate file.
pub fn write_hooks_to_file(path: &Path, entry: Option<&Value>) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read: {e}")),
    };
    // A dev build next to the installed app leaves its live entries alone
    // (in both directions), or a deleted worktree breaks every Claude session.
    if crate::dev_defer::defers(existing.as_deref(), is_ours_hook) {
        return Ok(());
    }
    let merged = match merge_hooks(existing.as_deref(), entry)? {
        HooksWrite::Unchanged => return Ok(()),
        HooksWrite::Write(s) => s,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("json.hooks.tmp");
    fs::write(&tmp, merged).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort tmp cleanup on rename failure so we don't leave litter.
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

/// Register the hook command for the running app. One-shot at boot,
/// idempotent, log-only: a failure here costs exact agent-state edges for
/// Claude Code panes (the screen-scraper still works) and must never block
/// boot. The path is re-derived from `current_exe()` every time so an update
/// or move repairs a stale command instead of leaving Claude Code running a
/// binary that no longer exists.
///
/// Not locked against a concurrently running Claude Code writing
/// `settings.json`: the rename is atomic (never corrupts) and steady state is
/// zero writes, so any lost-update window is a single first-boot write.
/// Called through `setup::ensure_claude`, which records the outcome.
///
/// `exec` is the caller's `claude_version` verdict: the probe runs before
/// any write lock is taken.
pub fn register(app: &AppHandle, exec: bool) -> Result<(), String> {
    let path = default_settings_path(app)?;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let entry = claude_hook_entry(&exe.to_string_lossy(), cfg!(windows), exec);
    write_hooks_to_file(&path, Some(&entry)).map_err(|e| {
        format!(
            "failed to register Claude Code hooks at {}: {e}",
            path.display()
        )
    })
}

fn default_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir for Claude Code hooks: {e}"))?;
    let cfg_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    Ok(crate::statusline::install::resolve_settings_path(
        &home,
        cfg_dir.as_deref(),
    ))
}

/// Remove our hook entries from the default profile (Git Bash missing and a
/// Claude Code before exec-form hooks, SWA-83): it would run the shell form
/// through PowerShell, where it fails on every event, also in sessions
/// outside Swarmterm. Foreign hooks
/// stay; a dev build still defers to the installed app's live entries.
pub fn unregister(app: &AppHandle) -> Result<(), String> {
    let path = default_settings_path(app)?;
    write_hooks_to_file(&path, None).map_err(|e| {
        format!(
            "failed to remove Claude Code hooks at {}: {e}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::signal_for;

    const OURS: &str = "\"/Applications/Swarmterm.app/Contents/MacOS/swarmterm\" --hook";
    const STALE: &str = "\"/Users/me/dev/swarmterm/src-tauri/target/debug/swarmterm\" --hook";
    const FOREIGN: &str = "~/.claude/notify.sh";

    /// A shell-form entry, as builds before 1c-ii wrote it.
    fn shell(cmd: &str) -> Value {
        json!({ "type": "command", "command": cmd })
    }

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /// `merge_hooks` that must produce a write; returns the parsed result.
    fn merged(existing: Option<&str>, command: Option<&Value>) -> Value {
        match merge_hooks(existing, command).unwrap() {
            HooksWrite::Write(s) => parse(&s),
            HooksWrite::Unchanged => panic!("expected a write"),
        }
    }

    fn foreign_group(cmd: &str) -> Value {
        json!({ "matcher": "", "hooks": [{ "type": "command", "command": cmd }] })
    }

    fn ours_group(cmd: &str) -> Value {
        json!({ "hooks": [{ "type": "command", "command": cmd, "timeout": 5 }] })
    }

    #[test]
    fn quotes_the_path_and_appends_the_flag() {
        assert_eq!(
            format_command(
                "/Applications/Swarmterm.app/Contents/MacOS/swarmterm",
                false
            ),
            OURS
        );
    }

    #[test]
    fn rewrites_backslashes_on_windows() {
        // Claude Code runs hook commands through Git Bash, which consumes
        // unquoted backslashes as escapes — same trap as the status line.
        assert_eq!(
            format_command(
                "C:\\Users\\me\\AppData\\Local\\Swarmterm\\swarmterm.exe",
                true
            ),
            "\"C:/Users/me/AppData/Local/Swarmterm/swarmterm.exe\" --hook"
        );
    }

    #[test]
    fn leaves_backslashes_alone_off_windows() {
        assert_eq!(
            format_command("/tmp/we\\ird/swarmterm", false),
            "\"/tmp/we\\ird/swarmterm\" --hook"
        );
    }

    #[test]
    fn exec_form_entry_needs_no_shell() {
        let e = hook_entry(r"C:\Program Files\Swarmterm GN\swarmterm.exe", true);
        assert_eq!(
            e,
            json!({
                "type": "command",
                "command": "C:/Program Files/Swarmterm GN/swarmterm.exe",
                "args": ["--hook"]
            })
        );
        assert_eq!(
            entry_line(&e).as_deref(),
            Some("\"C:/Program Files/Swarmterm GN/swarmterm.exe\" --hook")
        );
        assert!(entry_line(&e).is_some_and(|l| is_ours_hook(&l)));
        // Older Claude Code: the shell form as before.
        assert_eq!(
            claude_hook_entry("C:/x/swarmterm.exe", true, false),
            shell("\"C:/x/swarmterm.exe\" --hook")
        );
        assert_eq!(
            claude_hook_entry("C:/x/swarmterm.exe", true, true)["args"],
            json!(["--hook"])
        );
    }

    #[test]
    fn exec_form_lookalikes_stay_foreign() {
        let foreign = [
            json!({"type":"command","command":"node","args":["notify.js","--hook"]}),
            json!({"type":"command","command":"C:/x/swarmterm.exe","args":["--statusline"]}),
            json!({"type":"command","command":"C:/x/swarmterm.exe","args":[1]}),
            // Found in review: a path through a folder named swarmterm, a
            // helper with a similar name, and a flattened multi-arg command.
            json!({"type":"command","command":"C:/work/swarmterm/custom.exe","args":["--hook"]}),
            json!({"type":"command","command":"C:/x/swarmterm-helper.exe","args":["--hook"]}),
            json!({"type":"command","command":"node","args":["C:/work/swarmterm/notify.js","--hook"]}),
            json!({"type":"command","command":"C:/x/swarmterm.exe","args":["--hook","--verbose"]}),
            json!({"type":"command","command":"C:/x/swarmterm.exe","args":[]}),
            json!({"type":"command","command":"C:/x/swarmterm.exe\" --hook \"x","args":["y"]}),
        ];
        for entry in foreign {
            let group = json!({ "hooks": [entry.clone()] });
            assert!(!group_is_ours(&group, is_ours_hook), "{entry}");
        }
    }

    #[test]
    fn an_update_replaces_the_shell_form_and_then_settles() {
        let exec = hook_entry("C:/Apps/swarmterm.exe", true);
        let old = merged(None, Some(&shell("\"C:/Apps/swarmterm.exe\" --hook"))).to_string();
        let v = merged(Some(&old), Some(&exec));
        for event in HOOK_EVENTS {
            let groups = v["hooks"][event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event}");
            assert_eq!(groups[0]["hooks"][0]["args"], json!(["--hook"]));
            assert_eq!(groups[0]["hooks"][0]["timeout"], 5);
        }
        assert!(matches!(
            merge_hooks(Some(&v.to_string()), Some(&exec)).unwrap(),
            HooksWrite::Unchanged
        ));
        // And back, should Claude Code be downgraded below 2.1.139.
        let back = merged(
            Some(&v.to_string()),
            Some(&shell("\"C:/Apps/swarmterm.exe\" --hook")),
        );
        assert!(back["hooks"]["Stop"][0]["hooks"][0].get("args").is_none());
        // Removal finds the exec form too.
        assert!(merged(Some(&v.to_string()), None).get("hooks").is_none());
    }

    #[test]
    fn recognises_our_own_hook_command() {
        assert!(is_ours_hook(OURS));
        assert!(is_ours_hook(STALE));
        assert!(is_ours_hook("\"C:/x/swarmterm.exe\" --hook"));
        assert!(is_ours_hook("/usr/local/bin/swarmterm --hook  "));
    }

    #[test]
    fn does_not_claim_a_foreign_hook_command() {
        // Both halves must match: our own --statusline entry is NOT a hook,
        // a bare binary is not ours, and a stranger's --hook is theirs.
        assert!(!is_ours_hook(
            "\"/Applications/Swarmterm.app/Contents/MacOS/swarmterm\" --statusline"
        ));
        assert!(!is_ours_hook("swarmterm"));
        assert!(!is_ours_hook("some-other-tool --hook"));
        assert!(!is_ours_hook("\"C:/work/swarmterm/custom.exe\" --hook"));
        assert!(!is_ours_hook("C:/x/swarmterm-helper.exe --hook"));
        assert!(!is_ours_hook("\"C:/x/swarmterm.exe\" --hook --verbose"));
        assert!(!is_ours_hook("node C:/work/swarmterm/notify.js --hook"));
        assert!(!is_ours_hook(FOREIGN));
        assert!(!is_ours_hook(""));
    }

    #[test]
    fn hook_events_stay_in_lockstep_with_signal_for() {
        // Every registered event must yield a signal (else the CLI would be
        // spawned for nothing), and every signal-bearing event must be
        // registered (else the renderer never hears it). PreToolUse is the
        // canary: it fires on every tool call and must stay out.
        assert_eq!(HOOK_EVENTS.len(), 8);
        for event in HOOK_EVENTS {
            let nt = (event == "Notification").then_some("permission_prompt");
            assert!(signal_for(event, nt).is_some(), "{event} has no signal");
        }
        for must in [
            "UserPromptSubmit",
            "PermissionRequest",
            "Notification",
            "PostToolUse",
            "Stop",
            "StopFailure",
            "SessionStart",
            "SessionEnd",
        ] {
            assert!(HOOK_EVENTS.contains(&must), "{must} missing");
        }
        assert!(!HOOK_EVENTS.contains(&"PreToolUse"));
        assert_eq!(signal_for("PreToolUse", None), None);
    }

    #[test]
    fn installs_into_an_empty_file() {
        for existing in [None, Some(""), Some("   \n"), Some("{}")] {
            let v = merged(existing, Some(&shell(OURS)));
            for event in HOOK_EVENTS {
                let groups = v["hooks"][event]
                    .as_array()
                    .unwrap_or_else(|| panic!("{event}"));
                assert_eq!(groups.len(), 1, "{event}");
                assert_eq!(groups[0], ours_group(OURS), "{event}");
                assert!(
                    groups[0].get("matcher").is_none(),
                    "{event}: matcher must be omitted"
                );
            }
            assert_eq!(v["hooks"].as_object().unwrap().len(), 8);
        }
    }

    #[test]
    fn appends_after_a_foreign_group() {
        let existing = json!({ "hooks": { "Notification": [foreign_group(FOREIGN)] } }).to_string();
        let v = merged(Some(&existing), Some(&shell(OURS)));
        let n = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(n.len(), 2);
        assert_eq!(n[0], foreign_group(FOREIGN));
        assert_eq!(n[1], ours_group(OURS));
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn replaces_a_stale_ours_group_in_place() {
        // A dev build registered target/debug; the release build must repair
        // the path, not add a second group beside it.
        let existing = merged(None, Some(&shell(STALE))).to_string();
        let v = merged(Some(&existing), Some(&shell(OURS)));
        for event in HOOK_EVENTS {
            let groups = v["hooks"][event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event}");
            assert_eq!(groups[0]["hooks"][0]["command"], OURS, "{event}");
        }
    }

    #[test]
    fn is_unchanged_when_already_current() {
        let pretty = match merge_hooks(None, Some(&shell(OURS))).unwrap() {
            HooksWrite::Write(s) => s,
            HooksWrite::Unchanged => panic!(),
        };
        assert!(matches!(
            merge_hooks(Some(&pretty), Some(&shell(OURS))).unwrap(),
            HooksWrite::Unchanged
        ));
        // Different whitespace and key order are still "current" — Value
        // equality, not byte equality, or every boot would rewrite the file.
        let compact = parse(&pretty).to_string();
        assert!(matches!(
            merge_hooks(Some(&compact), Some(&shell(OURS))).unwrap(),
            HooksWrite::Unchanged
        ));
        let reordered = compact
            .replace(r#"{"type":"command","command":"#, r#"{"command":"#)
            .replace(r#","timeout":5}"#, r#","timeout":5,"type":"command"}"#);
        assert_ne!(
            reordered, compact,
            "the reorder must be real or this proves nothing"
        );
        assert!(matches!(
            merge_hooks(Some(&reordered), Some(&shell(OURS))).unwrap(),
            HooksWrite::Unchanged
        ));
    }

    #[test]
    fn leaves_a_mixed_group_alone_and_still_appends() {
        // A user who hand-copied our command into their own group owns that
        // group; we neither edit nor dedupe it (a duplicate signal is harmless).
        let mixed = json!({ "hooks": [
            { "type": "command", "command": FOREIGN },
            { "type": "command", "command": STALE },
        ] });
        let existing = json!({ "hooks": { "Stop": [mixed.clone()] } }).to_string();
        let v = merged(Some(&existing), Some(&shell(OURS)));
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0], mixed);
        assert_eq!(stop[1], ours_group(OURS));
    }

    #[test]
    fn preserves_unrelated_keys_and_events() {
        let existing = json!({
            "statusLine": { "type": "command", "command": "x --statusline" },
            "model": "opus",
            "hooks": { "PreToolUse": [foreign_group("lint")], "Stop": ["weird"] }
        })
        .to_string();
        let v = merged(Some(&existing), Some(&shell(OURS)));
        assert_eq!(v["statusLine"]["command"], "x --statusline");
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hooks"]["PreToolUse"], json!([foreign_group("lint")]));
        // A non-object group is foreign by definition: kept, ours appended.
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop[0], "weird");
        assert_eq!(stop[1], ours_group(OURS));
    }

    #[test]
    fn remove_drops_only_ours_and_tidies_empty_keys() {
        let existing = json!({
            "theme": "dark",
            "hooks": { "Stop": [foreign_group(FOREIGN), ours_group(OURS)], "Notification": [ours_group(OURS)] }
        }).to_string();
        let v = merged(Some(&existing), None);
        assert_eq!(v["hooks"]["Stop"], json!([foreign_group(FOREIGN)]));
        assert!(v["hooks"].get("Notification").is_none());
        assert_eq!(v["theme"], "dark");

        // Nothing but ours → the whole `hooks` key goes, as if we were never there.
        let only_ours = merged(Some(r#"{"theme":"dark"}"#), Some(&shell(OURS))).to_string();
        let v = merged(Some(&only_ours), None);
        assert_eq!(v, json!({ "theme": "dark" }));
    }

    #[test]
    fn remove_with_nothing_ours_is_unchanged() {
        let foreign_only = json!({ "hooks": { "Stop": [foreign_group(FOREIGN)] } }).to_string();
        assert!(matches!(
            merge_hooks(Some(&foreign_only), None).unwrap(),
            HooksWrite::Unchanged
        ));
        assert!(matches!(
            merge_hooks(Some("{}"), None).unwrap(),
            HooksWrite::Unchanged
        ));
        assert!(matches!(
            merge_hooks(None, None).unwrap(),
            HooksWrite::Unchanged
        ));
    }

    fn pos(text: &str, key: &str) -> usize {
        text.find(&format!("\"{key}\""))
            .unwrap_or_else(|| panic!("{key} missing in {text}"))
    }

    fn written(existing: Option<&str>, command: Option<&Value>) -> String {
        match merge_hooks(existing, command).unwrap() {
            HooksWrite::Write(s) => s,
            HooksWrite::Unchanged => panic!("expected a write"),
        }
    }

    #[test]
    fn install_keeps_top_level_and_event_order() {
        // `hooks` sits between z and a; remove-and-reinsert would push it last.
        let existing = format!(
            r#"{{"z":1,"hooks":{{"PreToolUse":[{}]}},"a":2}}"#,
            foreign_group("lint")
        );
        let out = written(Some(&existing), Some(&shell(OURS)));
        assert!(
            pos(&out, "z") < pos(&out, "hooks") && pos(&out, "hooks") < pos(&out, "a"),
            "{out}"
        );
        // The user's event stays first; ours are appended in HOOK_EVENTS order.
        assert!(
            pos(&out, "PreToolUse") < pos(&out, "UserPromptSubmit"),
            "{out}"
        );
        assert!(
            pos(&out, "UserPromptSubmit") < pos(&out, "SessionEnd"),
            "{out}"
        );
    }

    #[test]
    fn stale_replacement_keeps_the_event_in_its_slot() {
        let existing = format!(
            r#"{{"hooks":{{"PreToolUse":[{}],"Stop":[{}],"Notification":[{}]}}}}"#,
            foreign_group("lint"),
            ours_group(STALE),
            foreign_group(FOREIGN)
        );
        let out = written(Some(&existing), Some(&shell(OURS)));
        assert!(
            pos(&out, "PreToolUse") < pos(&out, "Stop")
                && pos(&out, "Stop") < pos(&out, "Notification"),
            "{out}"
        );
        let v = parse(&out);
        assert_eq!(v["hooks"]["Stop"], json!([ours_group(OURS)]));
    }

    #[test]
    fn remove_shifts_instead_of_swapping_at_both_levels() {
        // Top level: z, hooks, m, a → z, m, a (swap would give z, a, m).
        let existing = format!(
            r#"{{"z":1,"hooks":{{"Stop":[{}]}},"m":2,"a":3}}"#,
            ours_group(OURS)
        );
        let out = written(Some(&existing), None);
        assert!(!out.contains("hooks"), "{out}");
        assert!(
            pos(&out, "z") < pos(&out, "m") && pos(&out, "m") < pos(&out, "a"),
            "{out}"
        );
        // Event level: dropping Stop must not move PostToolUse ahead of Notification.
        let existing = format!(
            r#"{{"hooks":{{"PreToolUse":[{0}],"Stop":[{1}],"Notification":[{0}],"PostToolUse":[{0}]}}}}"#,
            foreign_group("lint"),
            ours_group(OURS)
        );
        let out = written(Some(&existing), None);
        assert!(!out.contains("Stop"), "{out}");
        assert!(
            pos(&out, "PreToolUse") < pos(&out, "Notification")
                && pos(&out, "Notification") < pos(&out, "PostToolUse"),
            "{out}"
        );
    }

    #[test]
    fn keeps_the_file_indent_and_trailing_newline() {
        let four = written(Some("{\n    \"theme\": \"dark\"\n}\n"), Some(&shell(OURS)));
        assert!(
            four.contains("\n    \"hooks\": {\n        \"UserPromptSubmit\": [\n            {"),
            "{four}"
        );
        assert!(four.ends_with("}\n"), "{four}");
        let tab = written(Some("{\n\t\"theme\": \"dark\"\n}"), Some(&shell(OURS)));
        assert!(
            tab.contains("\n\t\"hooks\": {\n\t\t\"UserPromptSubmit\": [\n\t\t\t{"),
            "{tab}"
        );
        assert!(tab.ends_with('}'), "{tab}");
        let fresh = written(None, Some(&shell(OURS)));
        assert_eq!(fresh, serde_json::to_string_pretty(&parse(&fresh)).unwrap());
    }

    #[test]
    fn refuses_shapes_it_does_not_understand() {
        // Never clobber a shape we can't reason about — an Err here is a
        // stderr line at boot, a wrong write is a broken Claude Code config.
        assert!(merge_hooks(Some(r#"{"hooks":[]}"#), Some(&shell(OURS))).is_err());
        assert!(merge_hooks(Some(r#"{"hooks":"nope"}"#), Some(&shell(OURS))).is_err());
        assert!(merge_hooks(Some(r#"{"hooks":{"Stop":{}}}"#), Some(&shell(OURS))).is_err());
        assert!(merge_hooks(Some("{ not json"), Some(&shell(OURS))).is_err());
        assert!(merge_hooks(Some("[]"), Some(&shell(OURS))).is_err());
        assert!(merge_hooks(Some("42"), None).is_err());
    }

    #[test]
    fn to_file_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        write_hooks_to_file(&path, Some(&shell(OURS))).unwrap();
        let v = parse(&fs::read_to_string(&path).unwrap());
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], OURS);
    }

    #[test]
    fn to_file_round_trips_enable_then_disable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
        write_hooks_to_file(&path, Some(&shell(OURS))).unwrap();
        write_hooks_to_file(&path, None).unwrap();
        assert_eq!(
            parse(&fs::read_to_string(&path).unwrap()),
            json!({ "theme": "dark" })
        );
    }

    #[test]
    fn to_file_leaves_a_malformed_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(write_hooks_to_file(&path, Some(&shell(OURS))).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        assert!(!path.with_extension("json.hooks.tmp").exists());
    }

    #[test]
    fn to_file_second_enable_is_a_noop() {
        // Steady state = zero writes: the second boot must not even rewrite
        // identical bytes (that would still bump mtime and race Claude Code).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_hooks_to_file(&path, Some(&shell(OURS))).unwrap();
        let first = fs::read(&path).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        write_hooks_to_file(&path, Some(&shell(OURS))).unwrap();
        assert_eq!(fs::read(&path).unwrap(), first);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        assert!(!path.with_extension("json.hooks.tmp").exists());
    }
}
