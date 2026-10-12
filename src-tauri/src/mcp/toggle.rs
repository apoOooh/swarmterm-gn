//! Per-profile on/off switch for Swarmterm's own MCP entry (Settings → MCP).
//!
//! Enrollment rewrites the entry on every boot / pane start, so "off" cannot
//! just delete it — the next spawn would put it back. The opt-out is a set of
//! profile keys persisted in the app data dir and consulted by every writer
//! (`register_*`, `accounts::enroll`, the Codex `-c` pin). Removal only ever
//! touches an entry that is recognisably ours (placeholder URL or the
//! `SWARMTERM_SESSION` bearer); a user's own `swarmterm` server is preserved.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

static DISABLED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
static STORE: OnceLock<PathBuf> = OnceLock::new();

fn disabled() -> &'static Mutex<BTreeSet<String>> {
    DISABLED.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// `agent:accountId`, or `agent:default` for the CLI's own profile.
pub fn profile_key(agent_id: &str, account_id: Option<&str>) -> String {
    format!("{agent_id}:{}", account_id.unwrap_or("default"))
}

pub fn parse_store(text: &str) -> BTreeSet<String> {
    serde_json::from_str::<Vec<String>>(text)
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Load the opt-out set once at boot, before the first enrollment runs.
/// A missing or unreadable file means "everything on" (the old behaviour).
pub fn load(path: PathBuf) {
    let set = fs::read_to_string(&path)
        .map(|s| parse_store(&s))
        .unwrap_or_default();
    *disabled().lock().unwrap() = set;
    let _ = STORE.set(path);
}

pub fn is_enabled(agent_id: &str, account_id: Option<&str>) -> bool {
    !disabled()
        .lock()
        .unwrap()
        .contains(&profile_key(agent_id, account_id))
}

/// Flip one profile and persist the whole set (tmp + rename).
pub fn set_enabled(agent_id: &str, account_id: Option<&str>, enabled: bool) -> Result<(), String> {
    let text = {
        let mut set = disabled().lock().unwrap();
        let key = profile_key(agent_id, account_id);
        if enabled {
            set.remove(&key);
        } else {
            set.insert(key);
        }
        serde_json::to_string_pretty(&set.iter().collect::<Vec<_>>()).map_err(|e| e.to_string())?
    };
    let path = STORE.get().ok_or("MCP switch store not initialised")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryState {
    Absent,
    Ours,
    /// A `swarmterm` server the user defined themselves — never removed.
    Foreign,
    /// Injected per pane through the environment (OpenCode); no file.
    PerPane,
}

fn json_is_ours(v: &Value) -> bool {
    let url = v
        .get("url")
        .or_else(|| v.get("httpUrl"))
        .and_then(Value::as_str);
    let auth = v
        .get("headers")
        .and_then(|h| h.get("Authorization"))
        .and_then(Value::as_str)
        .unwrap_or("");
    url == Some("${SWARMTERM_MCP_URL}") || auth.contains("SWARMTERM_SESSION")
}

pub fn json_entry_state(text: &str) -> EntryState {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return EntryState::Absent;
    };
    match doc.get("mcpServers").and_then(|m| m.get("swarmterm")) {
        None => EntryState::Absent,
        Some(v) if json_is_ours(v) => EntryState::Ours,
        Some(_) => EntryState::Foreign,
    }
}

/// New file text without our entry, or None when there is nothing of ours to
/// remove. Re-serialised with serde (like the writer), keys stay in order.
pub fn remove_json_entry(text: &str) -> Result<Option<String>, String> {
    if json_entry_state(text) != EntryState::Ours {
        return Ok(None);
    }
    let mut doc: Value = serde_json::from_str(text).map_err(|e| format!("parse: {e}"))?;
    if let Some(m) = doc.get_mut("mcpServers").and_then(Value::as_object_mut) {
        m.remove("swarmterm");
    }
    serde_json::to_string_pretty(&doc)
        .map(Some)
        .map_err(|e| e.to_string())
}

pub fn codex_entry_state(text: &str) -> EntryState {
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return EntryState::Absent;
    };
    match doc.get("mcp_servers").and_then(|m| m.get("swarmterm")) {
        None => EntryState::Absent,
        Some(e)
            if e.get("bearer_token_env_var").and_then(|v| v.as_str())
                == Some("SWARMTERM_SESSION") =>
        {
            EntryState::Ours
        }
        Some(_) => EntryState::Foreign,
    }
}

/// toml_edit keeps the user's comments and formatting around the removal.
pub fn remove_codex_entry(text: &str) -> Result<Option<String>, String> {
    if codex_entry_state(text) != EntryState::Ours {
        return Ok(None);
    }
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("parse: {e}"))?;
    if let Some(t) = doc.get_mut("mcp_servers").and_then(|m| m.as_table_mut()) {
        t.remove("swarmterm");
    }
    Ok(Some(doc.to_string()))
}

pub fn entry_state_of_file(path: &Path, codex: bool) -> EntryState {
    match fs::read_to_string(path) {
        Ok(s) if codex => codex_entry_state(&s),
        Ok(s) => json_entry_state(&s),
        Err(_) => EntryState::Absent,
    }
}

/// Remove our entry from `path` if present. Missing file = nothing to do.
pub fn remove_from_file(path: &Path, codex: bool) -> Result<(), String> {
    let text = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read: {e}")),
    };
    let next = if codex {
        remove_codex_entry(&text)?
    } else {
        remove_json_entry(&text)?
    };
    let Some(next) = next else { return Ok(()) };
    let tmp = path.with_extension("swarmterm.tmp");
    fs::write(&tmp, next).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS_JSON: &str = r#"{"numStartups":3,"mcpServers":{"swarmterm":{"type":"http","url":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}},"other":{"command":"x"}}}"#;

    #[test]
    fn profile_key_defaults() {
        assert_eq!(profile_key("codex", None), "codex:default");
        assert_eq!(profile_key("codex", Some("a1")), "codex:a1");
    }

    #[test]
    fn store_parse_is_fail_open() {
        assert!(parse_store("garbage").is_empty());
        assert!(parse_store(r#"["codex:default"]"#).contains("codex:default"));
    }

    #[test]
    fn json_removal_keeps_foreign_servers() {
        let out = remove_json_entry(OURS_JSON).unwrap().unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"].get("swarmterm").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["numStartups"], 3);
        assert_eq!(json_entry_state(&out), EntryState::Absent);
    }

    #[test]
    fn json_foreign_swarmterm_is_never_removed() {
        let foreign = r#"{"mcpServers":{"swarmterm":{"command":"my-own"}}}"#;
        assert_eq!(json_entry_state(foreign), EntryState::Foreign);
        assert!(remove_json_entry(foreign).unwrap().is_none());
    }

    #[test]
    fn qwen_shape_is_recognised() {
        let q = r#"{"mcpServers":{"swarmterm":{"httpUrl":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}}}}"#;
        assert_eq!(json_entry_state(q), EntryState::Ours);
    }

    #[test]
    fn codex_removal_preserves_comments_and_other_tables() {
        let text = "# mine\nmodel = \"o3\"\n\n[mcp_servers.swarmterm]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n\n[mcp_servers.github]\ncommand = \"gh\"\n";
        assert_eq!(codex_entry_state(text), EntryState::Ours);
        let out = remove_codex_entry(text).unwrap().unwrap();
        assert!(out.contains("# mine"));
        assert!(out.contains("[mcp_servers.github]"));
        assert!(!out.contains("swarmterm"));
    }

    #[test]
    fn codex_foreign_entry_stays() {
        let text = "[mcp_servers.swarmterm]\ncommand = \"own\"\n";
        assert_eq!(codex_entry_state(text), EntryState::Foreign);
        assert!(remove_codex_entry(text).unwrap().is_none());
    }

    #[test]
    fn remove_from_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".claude.json");
        fs::write(&p, OURS_JSON).unwrap();
        remove_from_file(&p, false).unwrap();
        assert_eq!(entry_state_of_file(&p, false), EntryState::Absent);
        // Missing file is fine.
        remove_from_file(&dir.path().join("nope.json"), false).unwrap();
    }
}
