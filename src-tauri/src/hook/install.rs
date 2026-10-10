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
pub const HOOK_EVENTS: [&str; 7] = [
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "Stop",
    "SessionStart",
    "SessionEnd",
];

/// Wedge backstop, in SECONDS (Claude Code's unit). The CLI's own POST times
/// out at 300 ms; this only matters if the binary itself hangs, where Claude
/// Code's 600 s default would freeze the session on every event.
const HOOK_TIMEOUT_SECS: u64 = 5;

/// Build the hook `command` string for an executable path. Own copy of the
/// `statusline::install::format_command` rule (quote + Git Bash forward
/// slashes) rather than a shared parameterised helper: S5 must stay revertable
/// on its own, so it does not widen the status line's signature.
pub fn format_command(exe: &str, windows: bool) -> String {
    let path = if windows {
        exe.replace('\\', "/")
    } else {
        exe.to_owned()
    };
    format!("\"{path}\" --hook")
}

/// Does this hook `command` belong to us? Both halves must match, so our own
/// `--statusline` entry, a bare `swarmterm`, and a stranger's `--hook` are all
/// left alone.
pub fn is_ours_hook(command: &str) -> bool {
    let c = command.trim().to_ascii_lowercase();
    c.ends_with("--hook") && c.contains("swarmterm")
}

/// The one group we install per event. No `matcher`: it is ignored on most of
/// these events anyway and the CLI filters `notification_type` itself. No
/// `async`: a synchronous hook guarantees the signal lands before Claude
/// proceeds, and the CLI returns in well under its 300 ms POST budget.
fn our_group(command: &str) -> Value {
    json!({
        "hooks": [{ "type": "command", "command": command, "timeout": HOOK_TIMEOUT_SECS }]
    })
}

/// A group is ours iff it is an object whose `hooks` is a non-empty array and
/// EVERY entry's command is ours. Anything mixed belongs to the user — they
/// hand-copied our command into their own group and may edit it as they like.
fn group_is_ours(group: &Value, is_ours: fn(&str) -> bool) -> bool {
    let Some(entries) = group.get("hooks").and_then(Value::as_array) else {
        return false;
    };
    !entries.is_empty()
        && entries.iter().all(|h| {
            h.get("command")
                .and_then(Value::as_str)
                .is_some_and(is_ours)
        })
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

/// Compute the new `settings.json` contents. `command: Some(_)` installs,
/// `None` removes (reachable from tests only today — there is no UI toggle).
///
/// Only the seven `HOOK_EVENTS` keys are ever rewritten; every other key under
/// `hooks` (and every other top-level key) passes through untouched. An event
/// array or the `hooks` object that ends up empty is dropped, so removal
/// restores the file to "we were never here". A pre-existing empty
/// `"hooks": {}` gets tidied once by the same rule — a harmless one-time write.
pub fn merge_hooks(existing: Option<&str>, command: Option<&str>) -> Result<HooksWrite, String> {
    merge_events(existing, command, &HOOK_EVENTS, is_ours_hook)
}

pub fn merge_events(
    existing: Option<&str>,
    command: Option<&str>,
    events: &[&str],
    is_ours: fn(&str) -> bool,
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
            if let Some(cmd) = command {
                hooks.insert(event.to_owned(), Value::Array(vec![our_group(cmd)]));
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
        if let Some(cmd) = command {
            groups.push(our_group(cmd));
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
pub fn write_hooks_to_file(path: &Path, command: Option<&str>) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read: {e}")),
    };
    let merged = match merge_hooks(existing.as_deref(), command)? {
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
pub fn register(app: &AppHandle) {
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("hook: cannot resolve home dir for Claude Code hooks: {e}");
            return;
        }
    };
    let cfg_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let path = crate::statusline::install::resolve_settings_path(&home, cfg_dir.as_deref());
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("hook: current_exe: {e}");
            return;
        }
    };
    let command = format_command(&exe.to_string_lossy(), cfg!(windows));
    if let Err(e) = write_hooks_to_file(&path, Some(&command)) {
        eprintln!(
            "hook: failed to register Claude Code hooks at {}: {e}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::signal_for;

    const OURS: &str = "\"/Applications/Swarmterm.app/Contents/MacOS/swarmterm\" --hook";
    const STALE: &str = "\"/Users/me/dev/swarmterm/src-tauri/target/debug/swarmterm\" --hook";
    const FOREIGN: &str = "~/.claude/notify.sh";

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /// `merge_hooks` that must produce a write; returns the parsed result.
    fn merged(existing: Option<&str>, command: Option<&str>) -> Value {
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
        assert!(!is_ours_hook(FOREIGN));
        assert!(!is_ours_hook(""));
    }

    #[test]
    fn hook_events_stay_in_lockstep_with_signal_for() {
        // Every registered event must yield a signal (else the CLI would be
        // spawned for nothing), and every signal-bearing event must be
        // registered (else the renderer never hears it). PreToolUse is the
        // canary: it fires on every tool call and must stay out.
        assert_eq!(HOOK_EVENTS.len(), 7);
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
            let v = merged(existing, Some(OURS));
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
            assert_eq!(v["hooks"].as_object().unwrap().len(), 7);
        }
    }

    #[test]
    fn appends_after_a_foreign_group() {
        let existing = json!({ "hooks": { "Notification": [foreign_group(FOREIGN)] } }).to_string();
        let v = merged(Some(&existing), Some(OURS));
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
        let existing = merged(None, Some(STALE)).to_string();
        let v = merged(Some(&existing), Some(OURS));
        for event in HOOK_EVENTS {
            let groups = v["hooks"][event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event}");
            assert_eq!(groups[0]["hooks"][0]["command"], OURS, "{event}");
        }
    }

    #[test]
    fn is_unchanged_when_already_current() {
        let pretty = match merge_hooks(None, Some(OURS)).unwrap() {
            HooksWrite::Write(s) => s,
            HooksWrite::Unchanged => panic!(),
        };
        assert!(matches!(
            merge_hooks(Some(&pretty), Some(OURS)).unwrap(),
            HooksWrite::Unchanged
        ));
        // Different whitespace and key order are still "current" — Value
        // equality, not byte equality, or every boot would rewrite the file.
        let compact = parse(&pretty).to_string();
        assert!(matches!(
            merge_hooks(Some(&compact), Some(OURS)).unwrap(),
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
            merge_hooks(Some(&reordered), Some(OURS)).unwrap(),
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
        let v = merged(Some(&existing), Some(OURS));
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
        let v = merged(Some(&existing), Some(OURS));
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
        let only_ours = merged(Some(r#"{"theme":"dark"}"#), Some(OURS)).to_string();
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

    fn written(existing: Option<&str>, command: Option<&str>) -> String {
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
        let out = written(Some(&existing), Some(OURS));
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
        let out = written(Some(&existing), Some(OURS));
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
        let four = written(Some("{\n    \"theme\": \"dark\"\n}\n"), Some(OURS));
        assert!(
            four.contains("\n    \"hooks\": {\n        \"UserPromptSubmit\": [\n            {"),
            "{four}"
        );
        assert!(four.ends_with("}\n"), "{four}");
        let tab = written(Some("{\n\t\"theme\": \"dark\"\n}"), Some(OURS));
        assert!(
            tab.contains("\n\t\"hooks\": {\n\t\t\"UserPromptSubmit\": [\n\t\t\t{"),
            "{tab}"
        );
        assert!(tab.ends_with('}'), "{tab}");
        let fresh = written(None, Some(OURS));
        assert_eq!(fresh, serde_json::to_string_pretty(&parse(&fresh)).unwrap());
    }

    #[test]
    fn refuses_shapes_it_does_not_understand() {
        // Never clobber a shape we can't reason about — an Err here is a
        // stderr line at boot, a wrong write is a broken Claude Code config.
        assert!(merge_hooks(Some(r#"{"hooks":[]}"#), Some(OURS)).is_err());
        assert!(merge_hooks(Some(r#"{"hooks":"nope"}"#), Some(OURS)).is_err());
        assert!(merge_hooks(Some(r#"{"hooks":{"Stop":{}}}"#), Some(OURS)).is_err());
        assert!(merge_hooks(Some("{ not json"), Some(OURS)).is_err());
        assert!(merge_hooks(Some("[]"), Some(OURS)).is_err());
        assert!(merge_hooks(Some("42"), None).is_err());
    }

    #[test]
    fn to_file_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        write_hooks_to_file(&path, Some(OURS)).unwrap();
        let v = parse(&fs::read_to_string(&path).unwrap());
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], OURS);
    }

    #[test]
    fn to_file_round_trips_enable_then_disable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
        write_hooks_to_file(&path, Some(OURS)).unwrap();
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
        assert!(write_hooks_to_file(&path, Some(OURS)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        assert!(!path.with_extension("json.hooks.tmp").exists());
    }

    #[test]
    fn to_file_second_enable_is_a_noop() {
        // Steady state = zero writes: the second boot must not even rewrite
        // identical bytes (that would still bump mtime and race Claude Code).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_hooks_to_file(&path, Some(OURS)).unwrap();
        let first = fs::read(&path).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        write_hooks_to_file(&path, Some(OURS)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), first);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        assert!(!path.with_extension("json.hooks.tmp").exists());
    }
}
