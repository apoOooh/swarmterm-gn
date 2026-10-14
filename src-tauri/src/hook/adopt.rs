//! Carrying the default profile's hooks and permission guards into a named
//! account profile (SWA-45).
//!
//! A profile runs with its own `CLAUDE_CONFIG_DIR`, so Claude Code never reads
//! the default `settings.json`: the user's hooks (a data-masking guard, a
//! lint, a notifier) and their `permissions.deny`/`ask` rules silently do not
//! apply there. Sessions under a profile would run with fewer safeguards than
//! the user's normal Claude Code — the one direction that must not happen.
//!
//! Deliberately NOT a copy of the whole file. Only `hooks` and the two
//! restricting permission lists travel; `permissions.allow` never does (a
//! profile must not be allowed more than the user granted it), nor does any
//! other key. Our own hook groups are skipped: `install::write_hooks_to_file`
//! writes those with the profile's exe path.
//!
//! The merge is additive and the profile's own entries are never removed.
//! What we added is remembered in a sidecar beside the profile's settings, so
//! an entry the user later changed or dropped in the default (a guard moved
//! from `src/` to `bin/`) is retired instead of piling up next to its
//! successor. An entry identical to one the profile already had is the
//! user's, not ours, and is never recorded — so it is never retired either.
//!
//! Steady state is zero writes (`Value` equality), and a real write keeps the
//! file's key order and indent (`json_style`), like the other writers here.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::install::{group_is_ours, is_ours_hook};

/// The permission lists that only ever restrict. `allow` is absent on purpose.
const GUARD_LISTS: [&str; 2] = ["deny", "ask"];

/// Sidecar file name inside the profile directory. Swarmterm's, not Claude
/// Code's: keeping it out of `settings.json` leaves that file purely the
/// user's schema.
pub const RECORD_FILE: &str = ".swarmterm-adopted.json";

/// What we added to a profile on earlier runs.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Adopted {
    pub hooks: BTreeMap<String, Vec<Value>>,
    pub permissions: BTreeMap<String, Vec<String>>,
}

#[derive(Debug)]
pub struct Merge {
    /// New `settings.json` contents, `None` when already current.
    pub settings: Option<String>,
    pub adopted: Adopted,
}

/// Merge the default profile's hooks and guard lists into a profile's
/// `settings.json`. `previously` is what an earlier run added.
pub fn merge(profile: Option<&str>, default: &str, previously: &Adopted) -> Result<Merge, String> {
    let before = parse(profile)?;
    let source = parse(Some(default))?;
    let mut root = before.clone();
    let obj = root.as_object_mut().unwrap();
    let mut adopted = Adopted::default();

    let wanted = source
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut events: Vec<String> = wanted.keys().cloned().collect();
    events.extend(
        previously
            .hooks
            .keys()
            .filter(|e| !wanted.contains_key(*e))
            .cloned(),
    );
    for event in events {
        let want: Vec<Value> = wanted
            .get(&event)
            .and_then(Value::as_array)
            .map(|groups| {
                groups
                    .iter()
                    .filter(|g| !group_is_ours(g, is_ours_hook))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let had = previously
            .hooks
            .get(&event)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let hooks = child_object(obj, "hooks")?;
        let ours = sync_list(hooks, &event, &want, had, "hooks", is_swarmterm_group)?;
        if hooks.is_empty() {
            obj.shift_remove("hooks");
        }
        if !ours.is_empty() {
            adopted.hooks.insert(event, ours);
        }
    }

    for list in GUARD_LISTS {
        let want: Vec<Value> = source
            .pointer(&format!("/permissions/{list}"))
            .and_then(Value::as_array)
            .map(|rules| rules.iter().filter(|r| r.is_string()).cloned().collect())
            .unwrap_or_default();
        let had: Vec<Value> = previously
            .permissions
            .get(list)
            .map(|rules| rules.iter().map(|r| json!(r)).collect())
            .unwrap_or_default();
        let permissions = child_object(obj, "permissions")?;
        let ours = sync_list(permissions, list, &want, &had, "permissions", |_| false)?;
        if permissions.is_empty() {
            obj.shift_remove("permissions");
        }
        if !ours.is_empty() {
            let rules = ours.iter().filter_map(|r| r.as_str().map(str::to_owned));
            adopted.permissions.insert(list.to_owned(), rules.collect());
        }
    }

    let settings = if root == before {
        None
    } else {
        Some(crate::json_style::JsonStyle::detect(profile).render(&root)?)
    };
    Ok(Merge { settings, adopted })
}

fn parse(text: Option<&str>) -> Result<Value, String> {
    let value = match text.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse: {e}"))?,
    };
    if !value.is_object() {
        return Err("root is not a JSON object".into());
    }
    Ok(value)
}

/// `entry` appends a missing key at the end and leaves an existing one in
/// place, so the user's key order survives.
fn child_object<'a>(
    obj: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    match obj.entry(key).or_insert_with(|| json!({})) {
        Value::Object(m) => Ok(m),
        _ => Err(format!("`{key}` is not a JSON object")),
    }
}

fn is_swarmterm_group(group: &Value) -> bool {
    group_is_ours(group, is_ours_hook)
}

/// Bring `parent[key]` in line with `want`: retire what we added earlier that
/// is no longer wanted, add what is missing. New entries go in front of the
/// first `keep_last` entry: `install::merge_hooks` always moves Swarmterm's
/// own group to the end, so appending after it would make the two writers
/// swap places once on the next pane start. Returns the entries that are
/// ours after this run — the ones added now plus the ones we added before and
/// still want.
fn sync_list(
    parent: &mut Map<String, Value>,
    key: &str,
    want: &[Value],
    had: &[Value],
    path: &str,
    keep_last: fn(&Value) -> bool,
) -> Result<Vec<Value>, String> {
    let mut ours = Vec::new();
    if want.is_empty() && !parent.contains_key(key) {
        return Ok(ours);
    }
    let parent_had_key = parent.contains_key(key);
    let list = match parent.entry(key).or_insert_with(|| json!([])) {
        Value::Array(a) => a,
        _ => return Err(format!("`{path}.{key}` is not a JSON array")),
    };
    let before = list.len();
    list.retain(|item| !had.contains(item) || want.contains(item));
    let retired = list.len() != before;
    for item in want {
        if !list.contains(item) {
            let at = list.iter().position(keep_last).unwrap_or(list.len());
            list.insert(at, item.clone());
            ours.push(item.clone());
        } else if had.contains(item) {
            ours.push(item.clone());
        }
    }
    // Only a list we emptied is dropped; a user's own `[]` stays as written.
    if list.is_empty() && (retired || !parent_had_key) {
        parent.shift_remove(key);
    }
    Ok(ours)
}

/// Read → merge → atomic write of the profile's `settings.json`, then the
/// sidecar. The sidecar is only written after the settings landed, so a
/// failed write never records entries the file does not have. A missing
/// default changes nothing: that is "unknown", not "the user removed it all".
/// A corrupt sidecar counts as empty, which can only add, never retire.
pub fn adopt_file(profile_dir: &Path, default_settings: &Path) -> Result<bool, String> {
    let Some(default) = read_optional(default_settings)? else {
        return Ok(false);
    };
    let settings_path = profile_dir.join("settings.json");
    let record_path = profile_dir.join(RECORD_FILE);
    let previously: Adopted = read_optional(&record_path)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let existing = read_optional(&settings_path)?;
    let merged = merge(existing.as_deref(), &default, &previously)?;
    let wrote = merged.settings.is_some();
    if let Some(contents) = merged.settings {
        write_atomic(&settings_path, contents)?;
    }
    if merged.adopted != previously {
        let record = serde_json::to_string_pretty(&merged.adopted).map_err(|e| e.to_string())?;
        write_atomic(&record_path, record)?;
    }
    Ok(wrote)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read: {e}")),
    }
}

/// Own tmp suffix so this writer never collides with the status line's or
/// the hook installer's intermediate file.
fn write_atomic(path: &Path, contents: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("adopt.tmp");
    fs::write(&tmp, contents).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUARD_OLD: &str =
        r#"{"hooks":[{"type":"command","command":"node data-shield/src/guard/guard.ts"}]}"#;
    const GUARD_NEW: &str =
        r#"{"hooks":[{"type":"command","command":"node data-shield/bin/guard.mjs"}]}"#;
    const OURS: &str = r#"{"hooks":[{"type":"command","command":"\"C:/Swarmterm/swarmterm.exe\" --hook","timeout":5}]}"#;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    fn default_with(groups: &[&str], deny: &[&str]) -> String {
        let groups: Vec<Value> = groups.iter().map(|g| v(g)).collect();
        json!({
            "hooks": { "PreToolUse": groups },
            "permissions": { "deny": deny, "allow": ["Bash(*)"] },
            "cleanupPeriodDays": 99
        })
        .to_string()
    }

    fn run(profile: Option<&str>, default: &str, previously: &Adopted) -> (Value, Merge) {
        let m = merge(profile, default, previously).unwrap();
        let text = m
            .settings
            .clone()
            .or(profile.map(str::to_owned))
            .unwrap_or("{}".into());
        (v(&text), m)
    }

    #[test]
    fn adopts_hooks_and_guard_lists_but_not_allow_or_other_keys() {
        let default = default_with(&[GUARD_OLD], &["Read(**/.env)"]);
        let (s, m) = run(None, &default, &Adopted::default());
        assert_eq!(s["hooks"]["PreToolUse"], json!([v(GUARD_OLD)]));
        assert_eq!(s["permissions"]["deny"], json!(["Read(**/.env)"]));
        assert!(s["permissions"].get("allow").is_none());
        assert!(s.get("cleanupPeriodDays").is_none());
        assert_eq!(m.adopted.hooks["PreToolUse"], vec![v(GUARD_OLD)]);
        assert_eq!(m.adopted.permissions["deny"], vec!["Read(**/.env)"]);
    }

    #[test]
    fn second_run_is_unchanged() {
        let default = default_with(&[GUARD_OLD], &["Read(**/.env)"]);
        let first = merge(None, &default, &Adopted::default()).unwrap();
        let again = merge(first.settings.as_deref(), &default, &first.adopted).unwrap();
        assert!(again.settings.is_none());
        assert_eq!(again.adopted, first.adopted);
    }

    #[test]
    fn keeps_profile_entries_order_and_skips_swarmterm_groups() {
        let own = r#"{"matcher":"Bash","hooks":[{"type":"command","command":"lint"}]}"#;
        let profile = json!({
            "model": "opus",
            "hooks": { "PreToolUse": [v(own), v(OURS)] },
            "permissions": { "deny": ["Write(/etc/**)"], "allow": ["Read"] }
        })
        .to_string();
        let default = default_with(&[OURS, GUARD_OLD], &["Read(**/.env)", "Write(/etc/**)"]);
        let (s, m) = run(Some(&profile), &default, &Adopted::default());
        assert_eq!(
            s["hooks"]["PreToolUse"],
            json!([v(own), v(GUARD_OLD), v(OURS)])
        );
        assert_eq!(
            s["permissions"]["deny"],
            json!(["Write(/etc/**)", "Read(**/.env)"])
        );
        assert_eq!(s["permissions"]["allow"], json!(["Read"]));
        let keys: Vec<&String> = s.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "permissions"]);
        // The rule the profile already had is the user's, not ours.
        assert_eq!(m.adopted.permissions["deny"], vec!["Read(**/.env)"]);
    }

    #[test]
    fn stays_put_alongside_the_hook_installer() {
        use crate::hook::install::{merge_hooks, HooksWrite};
        let cmd = "\"C:/Swarmterm/swarmterm.exe\" --hook";
        let install = |text: &str| match merge_hooks(Some(text), Some(cmd)).unwrap() {
            HooksWrite::Write(s) => (s, true),
            HooksWrite::Unchanged => (text.to_owned(), false),
        };
        let default = default_with(&[GUARD_OLD], &[]);
        let (text, _) = install("{}");
        let first = merge(Some(&text), &default, &Adopted::default()).unwrap();
        let text = first.settings.unwrap();
        let (text, rewrote) = install(&text);
        assert!(!rewrote, "{text}");
        assert!(merge(Some(&text), &default, &first.adopted)
            .unwrap()
            .settings
            .is_none());
    }

    #[test]
    fn changed_default_entry_replaces_what_we_added_only() {
        let default = default_with(&[GUARD_OLD], &["Read(**/.env)"]);
        let first = merge(None, &default, &Adopted::default()).unwrap();
        let moved = default_with(&[GUARD_NEW], &[]);
        let (s, m) = run(first.settings.as_deref(), &moved, &first.adopted);
        assert_eq!(s["hooks"]["PreToolUse"], json!([v(GUARD_NEW)]));
        assert!(s.get("permissions").is_none());
        assert!(m.adopted.permissions.is_empty());

        // The same entry, already in the profile before we ever ran, stays.
        let profile = json!({ "hooks": { "PreToolUse": [v(GUARD_OLD)] } }).to_string();
        let (s, m) = run(Some(&profile), &moved, &Adopted::default());
        assert_eq!(
            s["hooks"]["PreToolUse"],
            json!([v(GUARD_OLD), v(GUARD_NEW)])
        );
        assert_eq!(m.adopted.hooks["PreToolUse"], vec![v(GUARD_NEW)]);
    }

    #[test]
    fn event_dropped_from_default_retires_our_groups() {
        let first = merge(None, &default_with(&[GUARD_OLD], &[]), &Adopted::default()).unwrap();
        let (s, m) = run(first.settings.as_deref(), r#"{}"#, &first.adopted);
        assert!(s.get("hooks").is_none(), "{s}");
        assert!(m.adopted.hooks.is_empty());
    }

    #[test]
    fn malformed_files_are_errors() {
        let default = default_with(&[GUARD_OLD], &[]);
        assert!(merge(Some("[]"), &default, &Adopted::default()).is_err());
        assert!(merge(Some(r#"{"hooks":[]}"#), &default, &Adopted::default()).is_err());
        assert!(merge(None, "not json", &Adopted::default()).is_err());
    }

    #[test]
    fn file_round_trip_skips_missing_default_and_ignores_corrupt_record() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profile");
        let default = dir.path().join("default.json");
        assert!(!adopt_file(&profile, &default).unwrap());
        assert!(!profile.join("settings.json").exists());

        fs::write(&default, default_with(&[GUARD_OLD], &[])).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join(RECORD_FILE), "garbage").unwrap();
        assert!(adopt_file(&profile, &default).unwrap());
        assert!(!adopt_file(&profile, &default).unwrap());
        let record: Adopted =
            serde_json::from_str(&fs::read_to_string(profile.join(RECORD_FILE)).unwrap()).unwrap();
        assert_eq!(record.hooks["PreToolUse"], vec![v(GUARD_OLD)]);
    }
}
