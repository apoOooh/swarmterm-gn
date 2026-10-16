//! Registering the status line in Claude Code's user-scope settings.
//!
//! Same policy as `mcp/config.rs`: read → merge → write `.tmp` → rename, so a
//! crash mid-write can never truncate `settings.json` (which holds far more
//! than our one key). Unlike the MCP registration, this file has a key the user
//! may already own, so a foreign `statusLine` is never overwritten — in either
//! direction: we don't clobber it on enable and we don't delete it on disable.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Build the `statusLine.command` string for an executable path.
///
/// `windows` is a parameter rather than a `cfg!` so both branches are testable
/// on every platform. On Windows the path's backslashes become forward slashes:
/// Claude Code executes the command through Git Bash, which consumes unquoted
/// backslashes as escape characters, so `C:\Users\...` never resolves. Quoting
/// covers paths with spaces on both platforms.
pub fn format_command(exe: &str, windows: bool) -> String {
    let path = if windows {
        exe.replace('\\', "/")
    } else {
        exe.to_owned()
    };
    format!("\"{path}\" --statusline")
}

/// Does this `statusLine.command` belong to us? Both halves must match so a
/// third-party script that happens to live next to a `swarmterm` binary, or an
/// unrelated tool that also takes `--statusline`, is left alone.
pub fn is_ours(command: &str) -> bool {
    let c = command.trim().to_ascii_lowercase();
    c.ends_with("--statusline") && c.contains("swarmterm")
}

/// What `merge_settings` decided.
#[derive(Debug)]
pub enum SettingsWrite {
    /// Nothing to do — already current, or nothing of ours to remove.
    Unchanged,
    /// The user owns `statusLine`. Never touched, and never an app-level error.
    Foreign,
    /// New file contents.
    Write(String),
}

/// Compute the new `settings.json` contents. `command: Some(_)` installs,
/// `None` uninstalls.
pub fn merge_settings(
    existing: Option<&str>,
    command: Option<&str>,
) -> Result<SettingsWrite, String> {
    let mut root = parse_root(existing)?;
    let current = status_command(&root).map(str::to_owned);

    if let Some(cmd) = current.as_deref() {
        if !is_ours(cmd) {
            return Ok(SettingsWrite::Foreign);
        }
    }

    let obj = root.as_object_mut().unwrap();
    match command {
        Some(cmd) => {
            if current.as_deref() == Some(cmd) {
                // A rewrite for no change is pure churn on the user's settings
                // file (and a needless race window) — the same skip
                // `mcp/config.rs` makes on `~/.claude.json`.
                return Ok(SettingsWrite::Unchanged);
            }
            obj.insert(
                "statusLine".to_string(),
                json!({ "type": "command", "command": cmd }),
            );
        }
        None => {
            if current.is_none() {
                return Ok(SettingsWrite::Unchanged);
            }
            // shift, not swap: under `preserve_order` `Map::remove` is
            // swap_remove, which would drag the file's last key into this slot.
            obj.shift_remove("statusLine");
        }
    }

    // Render in the file's own indent + trailing-newline style (detected on
    // the RAW text, not the trimmed parse input) so the write is a one-key
    // diff, not a whole-file reformat.
    crate::json_style::JsonStyle::detect(existing)
        .render(&root)
        .map(SettingsWrite::Write)
}

fn parse_root(existing: Option<&str>) -> Result<Value, String> {
    let root: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse: {e}"))?,
    };
    if !root.is_object() {
        return Err("root is not a JSON object".into());
    }
    Ok(root)
}

fn status_command(root: &Value) -> Option<&str> {
    root.get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
}

/// Carry the user's own status line from the default profile into a named
/// account profile. Such a profile runs Claude Code with its own
/// `CLAUDE_CONFIG_DIR`, so without this the user's line silently turns into
/// ours (or nothing) there. The whole `statusLine` object is copied, keeping
/// `refreshInterval`/`padding`. Precedence matches the default profile: a
/// foreign line beats ours, and a foreign line already in the profile is the
/// user's choice for that account, so it is never replaced.
pub fn adopt_default_status_line(
    profile: Option<&str>,
    default: Option<&str>,
) -> Result<SettingsWrite, String> {
    let default = parse_root(default)?;
    let Some(line) = default
        .get("statusLine")
        .filter(|_| status_command(&default).is_some_and(|c| !is_ours(c)))
    else {
        return Ok(SettingsWrite::Unchanged);
    };
    let mut root = parse_root(profile)?;
    if status_command(&root).is_some_and(|c| !is_ours(c)) {
        return Ok(SettingsWrite::Foreign);
    }
    // `insert` on an existing key keeps its slot under `preserve_order`.
    root.as_object_mut()
        .unwrap()
        .insert("statusLine".to_string(), line.clone());
    crate::json_style::JsonStyle::detect(profile)
        .render(&root)
        .map(SettingsWrite::Write)
}

/// File variant of `adopt_default_status_line`. A missing default file means
/// there is nothing to adopt; returns whether the profile file was written.
pub fn adopt_default_status_line_file(profile: &Path, default: &Path) -> Result<bool, String> {
    let Some(default) = read_optional(default)? else {
        return Ok(false);
    };
    let existing = read_optional(profile)?;
    match adopt_default_status_line(existing.as_deref(), Some(&default))? {
        SettingsWrite::Write(s) => write_atomic(profile, s).map(|_| true),
        SettingsWrite::Unchanged | SettingsWrite::Foreign => Ok(false),
    }
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read: {e}")),
    }
}

fn write_atomic(path: &Path, contents: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort tmp cleanup on rename failure so we don't leave litter.
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

/// Resolve Claude Code's user-scope settings file. Honors `CLAUDE_CONFIG_DIR`
/// (which relocates the whole `~/.claude` directory); a blank value is treated
/// as unset so we never resolve to `/settings.json`. Note this is a DIFFERENT
/// file from the `~/.claude.json` that `mcp::config` writes.
pub fn resolve_settings_path(home: &Path, claude_config_dir: Option<&str>) -> PathBuf {
    match claude_config_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Path::new(dir).join("settings.json"),
        None => home.join(".claude").join("settings.json"),
    }
}

/// Error text when the user owns the `statusLine` entry. Callers that only
/// want "ours where we may" match it through `tolerate_foreign`.
pub const FOREIGN_STATUS_LINE: &str =
    "settings.json already has a custom statusLine — left untouched";

/// A foreign status line is the user's choice, not a failure: refusing to
/// overwrite it is the intended outcome. Every other error passes through.
pub fn tolerate_foreign(result: Result<(), String>) -> Result<(), String> {
    match result {
        Err(e) if e == FOREIGN_STATUS_LINE => Ok(()),
        other => other,
    }
}

/// Read → merge → write tmp → rename. The rename is atomic, so a crash
/// mid-write can never leave the user with a truncated settings file.
pub fn write_settings_to_file(path: &Path, command: Option<&str>) -> Result<(), String> {
    let existing = read_optional(path)?;
    // Same dev-build rule as the hooks (`dev_defer`): never swap a live
    // installed app's command for a `target/debug` path that may vanish.
    if crate::dev_defer::defers(existing.as_deref(), is_ours) {
        return Ok(());
    }
    let merged = match merge_settings(existing.as_deref(), command)? {
        SettingsWrite::Unchanged => return Ok(()),
        SettingsWrite::Foreign => return Err(FOREIGN_STATUS_LINE.into()),
        SettingsWrite::Write(s) => s,
    };
    write_atomic(path, merged)
}

/// Install or remove the status line entry for the running app.
///
/// The path is re-derived from `current_exe()` on every call, so moving or
/// updating the app repairs a stale command instead of leaving Claude Code
/// running something that no longer exists.
pub fn apply(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    let cfg_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let path = resolve_settings_path(&home, cfg_dir.as_deref());

    let command = if enabled {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        Some(format_command(&exe.to_string_lossy(), cfg!(windows)))
    } else {
        None
    };
    write_settings_to_file(&path, command.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    const OURS: &str = "\"/Applications/Swarmterm.app/Contents/MacOS/swarmterm\" --statusline";

    #[test]
    fn foreign_status_line_is_tolerated_other_errors_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"statusLine":{"type":"command","command":"node mine.mjs"}}"#,
        )
        .unwrap();
        let refused = write_settings_to_file(&path, Some(OURS));
        assert_eq!(refused, Err(FOREIGN_STATUS_LINE.to_owned()));
        assert_eq!(tolerate_foreign(refused), Ok(()));
        assert!(fs::read_to_string(&path).unwrap().contains("node mine.mjs"));
        assert_eq!(
            tolerate_foreign(Err("read: denied".into())),
            Err("read: denied".into())
        );
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
        // Claude Code runs the command through Git Bash, which consumes
        // unquoted backslashes as escapes, so a native Windows path never
        // resolves. Forward slashes work in both shells.
        assert_eq!(
            format_command(
                "C:\\Users\\me\\AppData\\Local\\Swarmterm\\swarmterm.exe",
                true
            ),
            "\"C:/Users/me/AppData/Local/Swarmterm/swarmterm.exe\" --statusline"
        );
    }

    #[test]
    fn leaves_backslashes_alone_off_windows() {
        // A backslash is a legal character in a POSIX filename; rewriting it
        // there would corrupt the path.
        assert_eq!(
            format_command("/tmp/we\\ird/swarmterm", false),
            "\"/tmp/we\\ird/swarmterm\" --statusline"
        );
    }

    #[test]
    fn recognises_our_own_command() {
        assert!(is_ours(OURS));
        assert!(is_ours("\"C:/x/swarmterm.exe\" --statusline"));
        assert!(is_ours("/usr/local/bin/swarmterm --statusline"));
    }

    #[test]
    fn does_not_claim_a_foreign_command() {
        assert!(!is_ours("~/.claude/statusline.sh"));
        assert!(!is_ours("starship prompt"));
        assert!(!is_ours("swarmterm"));
        assert!(!is_ours("some-other-tool --statusline"));
        assert!(!is_ours(""));
    }

    #[test]
    fn creates_settings_from_nothing() {
        let SettingsWrite::Write(out) = merge_settings(None, Some(OURS)).unwrap() else {
            panic!("expected a write");
        };
        let v = parse(&out);
        assert_eq!(v["statusLine"]["type"], "command");
        assert_eq!(v["statusLine"]["command"], OURS);
    }

    #[test]
    fn creates_settings_from_an_empty_file() {
        assert!(matches!(
            merge_settings(Some("   "), Some(OURS)).unwrap(),
            SettingsWrite::Write(_)
        ));
    }

    #[test]
    fn preserves_unrelated_settings() {
        let existing = r#"{"model":"opus[1m]","theme":"dark","effortLevel":"xhigh"}"#;
        let SettingsWrite::Write(out) = merge_settings(Some(existing), Some(OURS)).unwrap() else {
            panic!("expected a write");
        };
        let v = parse(&out);
        assert_eq!(v["model"], "opus[1m]");
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["effortLevel"], "xhigh");
        assert_eq!(v["statusLine"]["command"], OURS);
    }

    #[test]
    fn skips_the_write_when_our_entry_is_already_current() {
        let existing = format!(
            r#"{{"statusLine":{{"type":"command","command":{}}}}}"#,
            serde_json::to_string(OURS).unwrap()
        );
        assert!(matches!(
            merge_settings(Some(&existing), Some(OURS)).unwrap(),
            SettingsWrite::Unchanged
        ));
    }

    #[test]
    fn rewrites_our_entry_when_the_binary_moved() {
        let existing =
            r#"{"statusLine":{"type":"command","command":"\"/old/path/swarmterm\" --statusline"}}"#;
        let SettingsWrite::Write(out) = merge_settings(Some(existing), Some(OURS)).unwrap() else {
            panic!("expected a write");
        };
        assert_eq!(parse(&out)["statusLine"]["command"], OURS);
    }

    #[test]
    fn refuses_to_clobber_a_foreign_status_line() {
        let existing = r#"{"statusLine":{"type":"command","command":"~/.claude/mine.sh"}}"#;
        assert!(matches!(
            merge_settings(Some(existing), Some(OURS)).unwrap(),
            SettingsWrite::Foreign
        ));
    }

    #[test]
    fn removes_only_our_own_entry_on_disable() {
        let existing = format!(
            r#"{{"theme":"dark","statusLine":{{"type":"command","command":{}}}}}"#,
            serde_json::to_string(OURS).unwrap()
        );
        let SettingsWrite::Write(out) = merge_settings(Some(&existing), None).unwrap() else {
            panic!("expected a write");
        };
        let v = parse(&out);
        assert!(v.get("statusLine").is_none());
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn disable_leaves_a_foreign_entry_alone() {
        let existing = r#"{"statusLine":{"type":"command","command":"~/.claude/mine.sh"}}"#;
        assert!(matches!(
            merge_settings(Some(existing), None).unwrap(),
            SettingsWrite::Foreign
        ));
    }

    #[test]
    fn disable_is_a_no_op_when_there_is_nothing_to_remove() {
        assert!(matches!(
            merge_settings(None, None).unwrap(),
            SettingsWrite::Unchanged
        ));
        assert!(matches!(
            merge_settings(Some(r#"{"theme":"dark"}"#), None).unwrap(),
            SettingsWrite::Unchanged
        ));
    }

    fn pos(text: &str, key: &str) -> usize {
        text.find(&format!("\"{key}\""))
            .unwrap_or_else(|| panic!("{key} missing in {text}"))
    }

    fn written(existing: Option<&str>, command: Option<&str>) -> String {
        match merge_settings(existing, command).unwrap() {
            SettingsWrite::Write(s) => s,
            other => panic!("expected a write, got {other:?}"),
        }
    }

    #[test]
    fn install_keeps_key_order_and_appends_status_line_last() {
        let out = written(Some(r#"{"z":1,"a":2}"#), Some(OURS));
        assert!(
            pos(&out, "z") < pos(&out, "a") && pos(&out, "a") < pos(&out, "statusLine"),
            "{out}"
        );
    }

    #[test]
    fn disable_shifts_the_remaining_keys_instead_of_swapping() {
        // Four keys, ours second: swap_remove would drag `a` into slot 1
        // (z, a, m); the user's order is z, m, a.
        let existing = format!(
            r#"{{"z":1,"statusLine":{{"type":"command","command":{}}},"m":2,"a":3}}"#,
            serde_json::to_string(OURS).unwrap()
        );
        let out = written(Some(&existing), None);
        assert!(!out.contains("statusLine"), "{out}");
        assert!(
            pos(&out, "z") < pos(&out, "m") && pos(&out, "m") < pos(&out, "a"),
            "{out}"
        );
    }

    #[test]
    fn keeps_the_file_indent_and_trailing_newline() {
        let four = written(Some("{\n    \"theme\": \"dark\"\n}\n"), Some(OURS));
        assert!(
            four.contains("\n    \"statusLine\": {\n        \"type\": \"command\""),
            "{four}"
        );
        assert!(four.ends_with("}\n"), "{four}");
        let tab = written(Some("{\n\t\"theme\": \"dark\"\n}"), Some(OURS));
        assert!(
            tab.contains("\n\t\"statusLine\": {\n\t\t\"type\": \"command\""),
            "{tab}"
        );
        assert!(tab.ends_with('}'), "{tab}");
        let fresh = written(None, Some(OURS));
        assert_eq!(fresh, serde_json::to_string_pretty(&parse(&fresh)).unwrap());
    }

    #[test]
    fn errors_on_malformed_json() {
        assert!(merge_settings(Some("{ not json"), Some(OURS)).is_err());
    }

    #[test]
    fn errors_when_root_is_not_an_object() {
        assert!(merge_settings(Some("[1,2,3]"), Some(OURS)).is_err());
    }

    #[test]
    fn settings_path_defaults_under_dot_claude() {
        let p = resolve_settings_path(Path::new("/home/duong"), None);
        assert_eq!(p, Path::new("/home/duong/.claude/settings.json"));
    }

    #[test]
    fn settings_path_honors_claude_config_dir() {
        let p = resolve_settings_path(Path::new("/home/duong"), Some("/custom/cfg"));
        assert_eq!(p, Path::new("/custom/cfg/settings.json"));
    }

    #[test]
    fn settings_path_ignores_a_blank_config_dir() {
        let p = resolve_settings_path(Path::new("/home/duong"), Some("  "));
        assert_eq!(p, Path::new("/home/duong/.claude/settings.json"));
    }

    #[test]
    fn to_file_creates_parent_directories_and_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        write_settings_to_file(&path, Some(OURS)).unwrap();
        let v = parse(&fs::read_to_string(&path).unwrap());
        assert_eq!(v["statusLine"]["command"], OURS);
    }

    #[test]
    fn to_file_round_trips_enable_then_disable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
        write_settings_to_file(&path, Some(OURS)).unwrap();
        write_settings_to_file(&path, None).unwrap();
        let v = parse(&fs::read_to_string(&path).unwrap());
        assert!(v.get("statusLine").is_none());
        assert_eq!(v["theme"], "dark");
    }

    const USER_LINE: &str = r#"{"theme":"dark","statusLine":{"type":"command","command":"node \"C:/u/.claude/statusline.mjs\"","refreshInterval":5}}"#;

    #[test]
    fn adopt_copies_the_users_line_over_ours_with_all_its_keys() {
        let profile = format!(
            r#"{{"hooks":{{}},"statusLine":{{"type":"command","command":{}}},"model":"opus"}}"#,
            serde_json::to_string(OURS).unwrap()
        );
        let SettingsWrite::Write(out) =
            adopt_default_status_line(Some(&profile), Some(USER_LINE)).unwrap()
        else {
            panic!("expected a write");
        };
        let v = parse(&out);
        assert_eq!(v["statusLine"], parse(USER_LINE)["statusLine"]);
        assert!(
            v.get("theme").is_none(),
            "only statusLine is adopted: {out}"
        );
        assert!(
            pos(&out, "hooks") < pos(&out, "statusLine")
                && pos(&out, "statusLine") < pos(&out, "model"),
            "{out}"
        );
    }

    #[test]
    fn adopt_fills_a_profile_without_a_status_line() {
        let SettingsWrite::Write(out) = adopt_default_status_line(None, Some(USER_LINE)).unwrap()
        else {
            panic!("expected a write");
        };
        assert_eq!(parse(&out)["statusLine"]["refreshInterval"], 5);
    }

    #[test]
    fn adopt_never_replaces_a_line_the_profile_owns() {
        let own = r#"{"statusLine":{"type":"command","command":"~/work-line.sh"}}"#;
        assert!(matches!(
            adopt_default_status_line(Some(own), Some(USER_LINE)).unwrap(),
            SettingsWrite::Foreign
        ));
        assert!(matches!(
            adopt_default_status_line(Some(USER_LINE), Some(USER_LINE)).unwrap(),
            SettingsWrite::Foreign
        ));
    }

    #[test]
    fn adopt_ignores_a_default_with_ours_or_no_line() {
        let ours = format!(
            r#"{{"statusLine":{{"type":"command","command":{}}}}}"#,
            serde_json::to_string(OURS).unwrap()
        );
        for default in [
            None,
            Some("{}"),
            Some(r#"{"theme":"dark"}"#),
            Some(ours.as_str()),
        ] {
            assert!(matches!(
                adopt_default_status_line(None, default).unwrap(),
                SettingsWrite::Unchanged
            ));
        }
    }

    #[test]
    fn adopt_file_writes_once_and_tolerates_a_missing_default() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profile").join("settings.json");
        let default = dir.path().join("settings.json");
        assert!(!adopt_default_status_line_file(&profile, &default).unwrap());
        assert!(!profile.exists());
        fs::write(&default, USER_LINE).unwrap();
        write_settings_to_file(&profile, Some(OURS)).unwrap();
        assert!(adopt_default_status_line_file(&profile, &default).unwrap());
        assert!(!adopt_default_status_line_file(&profile, &default).unwrap());
        // Our own writer now sees the user's line and stands down.
        assert!(write_settings_to_file(&profile, Some(OURS)).is_err());
        let v = parse(&fs::read_to_string(&profile).unwrap());
        assert_eq!(v["statusLine"], parse(USER_LINE)["statusLine"]);
    }

    #[test]
    fn to_file_leaves_a_malformed_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(write_settings_to_file(&path, Some(OURS)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
