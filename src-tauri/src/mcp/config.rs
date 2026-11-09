use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::mcp::entry;

/// Claude Code's entry: our stdio proxy (SWA-83 1b). It reads the pane's
/// `SWARMTERM_MCP_URL`/`SWARMTERM_SESSION` itself and serves no tools
/// outside a pane, so a Claude session started anywhere else no longer
/// reports a broken server. Claude Code passes stdio servers its whole
/// environment, so no `env` block is needed.
pub fn swarmterm_entry(exe: &str) -> Value {
    json!({
        "type": "stdio",
        "command": exe,
        "args": [entry::STDIO_ARG],
    })
}

/// Inline OpenCode config for one pane. Concrete URL and bearer: the value
/// lives only in this pane's environment, like `SWARMTERM_SESSION` itself.
pub fn opencode_config_content(url: &str, session: &str) -> String {
    json!({
        "mcp": {
            "swarmterm": {
                "type": "remote",
                "url": url,
                "headers": { "Authorization": format!("Bearer {session}") },
                "enabled": true
            }
        }
    })
    .to_string()
}

/// The MCP entry Swarmterm writes into qwen's `settings.json`. Qwen Code
/// resolves `$VAR`/`${VAR}` in settings strings from the process environment
/// (packages/core envVarResolver), so — like Claude Code and unlike Codex —
/// a placeholder entry written once serves every pane. HTTP transport uses
/// the `httpUrl` key (qwen's `url` means SSE).
pub fn swarmterm_qwen_entry() -> Value {
    json!({
        "httpUrl": "${SWARMTERM_MCP_URL}",
        "headers": { "Authorization": "Bearer ${SWARMTERM_SESSION}" }
    })
}

/// Produce new contents for a JSON config with a `mcpServers` object:
/// * If `existing` is `None` or blank, return a file with only Swarmterm.
/// * If `existing` parses as JSON with a `mcpServers` object, merge the
///   `swarmterm` entry KEY BY KEY — Swarmterm-owned keys are overwritten so
///   the current shape always wins, but keys the user added under `swarmterm`
///   (qwen's `trust`/`timeout`, say) survive. Other server entries are
///   untouched.
/// * If `existing` is malformed JSON, return `Err` — the caller logs it and
///   leaves the file untouched.
fn merge_mcp_servers_json(
    existing: Option<&str>,
    entry: Value,
    drop: &[&str],
) -> Result<String, String> {
    let mut root: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({ "mcpServers": {} }),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse: {e}"))?,
    };
    if !root.is_object() {
        return Err("root is not a JSON object".into());
    }
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err("mcpServers is not an object".into());
    }
    let servers = servers.as_object_mut().unwrap();
    match servers.get_mut("swarmterm") {
        // Existing object entry: overwrite only the keys we own.
        Some(Value::Object(slot)) => {
            for key in drop {
                slot.remove(*key);
            }
            for (k, v) in entry.as_object().expect("entry is an object") {
                slot.insert(k.clone(), v.clone());
            }
        }
        // Absent, or a non-object left by something else: replace wholesale.
        _ => {
            servers.insert("swarmterm".to_string(), entry);
        }
    }
    // Style is detected on the RAW `existing` text, not the trimmed copy fed
    // to the parser: the trailing-newline verdict lives in exactly the bytes
    // `trim()` would throw away.
    crate::json_style::JsonStyle::detect(existing).render(&root)
}

/// Whether `config` (a parsed root object) already carries every key of
/// `entry` under `mcpServers.swarmterm` with our exact values. User-added
/// extra keys are fine — the merge preserves them, so they must not force a
/// rewrite on every boot.
fn entry_is_current(config: &Value, entry: &Value) -> bool {
    match config.get("mcpServers").and_then(|m| m.get("swarmterm")) {
        Some(cur) => entry
            .as_object()
            .expect("entry is an object")
            .iter()
            .all(|(k, v)| cur.get(k) == Some(v)),
        None => false,
    }
}

/// Strip `//` line and `/* */` block comments outside strings — the same
/// tolerance qwen's settings loader applies (strip-json-comments). Used for
/// READING only: rewriting a commented file would serialize the comments
/// away, so such a file is never rewritten (see the writer below).
fn strip_json_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    while let Some(&n) = chars.peek() {
                        if n == '\n' {
                            break;
                        }
                        chars.next();
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut prev = '\0';
                    for n in chars.by_ref() {
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    out
}

/// Merge-write a `swarmterm` MCP entry into a JSON config at `path` (read →
/// `merge_mcp_servers_json` → write tmp → rename). The tmp+rename means a
/// crash mid-write can never truncate the target — important for
/// `~/.claude.json` and qwen's `settings.json`, which hold far more than MCP
/// config. A missing file is created; a malformed existing file returns `Err`
/// and is left untouched.
fn write_mcp_servers_json_to_file(
    path: &Path,
    entry: Value,
    tolerate_comments: bool,
) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read: {e}")),
    };
    // Skip rewriting when the user's config already carries our entry (our
    // keys with our values; user-added extras allowed). This is the user's
    // PRIMARY config for that CLI: even though a rewrite now keeps key order
    // and indent (`json_style`), it would still widen the (already tiny)
    // read-merge-rename race against a concurrently running CLI, and a
    // steady-state write per boot is noise. So we only ever write on the
    // first run (or if the entry drifts).
    if let Some(s) = existing.as_deref() {
        let strict = serde_json::from_str::<Value>(s).ok();
        // Qwen parses settings via strip-json-comments; recognise an entry
        // inside a commented file so we don't log a bogus error every boot.
        let lenient = if strict.is_none() && tolerate_comments {
            serde_json::from_str::<Value>(&strip_json_comments(s)).ok()
        } else {
            None
        };
        if let Some(v) = strict.as_ref().or(lenient.as_ref()) {
            if entry_is_current(v, &entry) {
                return Ok(());
            }
        }
        // A commented file that still needs the entry is left untouched:
        // serde would strip the user's comments on rewrite.
        if strict.is_none() && lenient.is_some() {
            return Err(
                "file contains comments (the CLI tolerates them; rewriting would strip them) — \
                 add the swarmterm entry manually"
                    .into(),
            );
        }
    }
    let merged = merge_mcp_servers_json(existing.as_deref(), entry, &[])?;
    write_json_atomic(path, merged)
}

/// tmp + rename. `.claude.json` → `.claude.json.tmp` (same for
/// `settings.json`): with_extension replaces the trailing `json` segment,
/// preserving the leading dot-name.
fn write_json_atomic(path: &Path, text: String) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort tmp cleanup on rename failure so we don't leave litter.
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read: {e}")),
    }
}

fn own_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("current_exe: {e}"))
}

/// Claude Code variant (`~/.claude.json`). The parent dir is home — never
/// created here (a missing/typo'd CLAUDE_CONFIG_DIR must fail, not be
/// fabricated).
pub fn write_mcp_config_to_file(path: &Path) -> Result<(), String> {
    write_claude_entry(path, &own_exe()?, entry::is_dev_build(), |p| {
        Path::new(p).is_file()
    })
}

/// Does `slot` hold exactly the stdio entry for `exe` (user extras allowed,
/// legacy keys not)?
fn claude_entry_is_current(slot: Option<&Value>, exe: &str) -> bool {
    let Some(slot) = slot else { return false };
    slot.get("type").and_then(Value::as_str) == Some("stdio")
        && slot
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| crate::dev_defer::same_exe(c, exe))
        && slot.get("args") == Some(&json!([entry::STDIO_ARG]))
        && entry::LEGACY_JSON_KEYS
            .iter()
            .all(|k| slot.get(*k).is_none())
}

/// Write (or migrate to) the stdio entry unless `entry::should_write` says
/// the file belongs to the user or to another live Swarmterm.
fn write_claude_entry(
    path: &Path,
    exe: &str,
    debug: bool,
    exists: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let existing = read_optional(path)?;
    if let Some(text) = existing.as_deref().filter(|s| !s.trim().is_empty()) {
        let root: Value = serde_json::from_str(text).map_err(|e| format!("parse: {e}"))?;
        let slot = root.get("mcpServers").and_then(|m| m.get("swarmterm"));
        let kind = entry::classify_json(slot);
        if !entry::should_write(
            &kind,
            claude_entry_is_current(slot, exe),
            exe,
            debug,
            exists,
        ) {
            return Ok(());
        }
    }
    let merged = merge_mcp_servers_json(
        existing.as_deref(),
        swarmterm_entry(exe),
        &entry::LEGACY_JSON_KEYS,
    )?;
    write_json_atomic(path, merged)
}

/// Add the default profile's user-scope MCP servers to a named account
/// profile, which has its own `.claude.json` and would otherwise see only
/// ours. Additive only: a server the profile already has is never
/// overwritten and nothing is deleted. `swarmterm` is skipped because
/// `write_mcp_config_to_file` owns it, gated by the profile's MCP switch.
/// A server removed from the profile alone comes back on the next pane start;
/// mirroring the default is what a profile is for. `None` = nothing to add.
pub fn merge_default_user_servers(
    profile: Option<&str>,
    default: &str,
) -> Result<Option<String>, String> {
    let default: Value = serde_json::from_str(default).map_err(|e| format!("parse: {e}"))?;
    let Some(source) = default.get("mcpServers").and_then(Value::as_object) else {
        return Ok(None);
    };
    let mut root: Value = match profile.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse: {e}"))?,
    };
    let Some(obj) = root.as_object_mut() else {
        return Err("root is not a JSON object".into());
    };
    let Some(servers) = obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
    else {
        return Err("mcpServers is not an object".into());
    };
    let mut added = false;
    for (name, entry) in source {
        if name != "swarmterm" && !servers.contains_key(name) {
            servers.insert(name.clone(), entry.clone());
            added = true;
        }
    }
    if !added {
        return Ok(None);
    }
    crate::json_style::JsonStyle::detect(profile)
        .render(&root)
        .map(Some)
}

/// File variant of `merge_default_user_servers`; returns whether the profile
/// file was written. A missing default file means there is nothing to add.
pub fn copy_default_user_servers(profile: &Path, default: &Path) -> Result<bool, String> {
    let default = match fs::read_to_string(default) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read: {e}")),
    };
    let existing = match fs::read_to_string(profile) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read: {e}")),
    };
    let Some(merged) = merge_default_user_servers(existing.as_deref(), &default)? else {
        return Ok(false);
    };
    let tmp = profile.with_extension("json.tmp");
    fs::write(&tmp, merged).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, profile).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })?;
    Ok(true)
}

/// Qwen Code variant (`settings.json` under `$QWEN_HOME` or `~/.qwen`). An
/// installed-but-never-run qwen has no `~/.qwen` yet, so the parent dir is
/// created — the caller has already probed that the CLI exists.
pub fn write_qwen_settings_to_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    write_mcp_servers_json_to_file(path, swarmterm_qwen_entry(), true)
}

/// Register Swarmterm's MCP server once in Claude Code's user-scope config
/// (`~/.claude.json`) so every terminal Swarmterm spawns — in any folder or
/// worktree — discovers it without a per-project `.mcp.json`. Idempotent: the
/// entry is placeholder-only, so re-running on an already-registered config
/// writes identical bytes. Log-only: a failure here must never block boot, and
/// leaves Swarmterm fully usable minus the agent-facing MCP tools.
///
/// `Ok(false)` = switched off (Settings → MCP or DisableMcp); the outcome is
/// recorded by `setup::ensure_claude`.
pub fn register_user_scope(app: &AppHandle) -> Result<bool, String> {
    if !crate::mcp::toggle::is_enabled("claude-code", None) {
        return Ok(false);
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir for global MCP config: {e}"))?;
    let cfg_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let path = resolve_global_config_path(&home, cfg_dir.as_deref());
    // Note: read-merge-rename is not locked against a concurrently running
    // Claude Code writing ~/.claude.json; the rename is atomic (never corrupts),
    // and the skip-if-present check keeps this to at most a first-run write, so
    // any lost-update window is a single boot-time write, not steady-state.
    write_mcp_config_to_file(&path).map(|()| true).map_err(|e| {
        format!(
            "failed to register global MCP config at {}: {e}",
            path.display()
        )
    })
}

/// Resolve Claude Code's user-scope config file (`.claude.json`). Honors
/// `CLAUDE_CONFIG_DIR` (Claude Code lets users relocate its config there);
/// a blank value is treated as unset so we never resolve to `/.claude.json`.
pub fn resolve_global_config_path(home: &Path, claude_config_dir: Option<&str>) -> PathBuf {
    match claude_config_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Path::new(dir).join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

/// `$QWEN_HOME/settings.json` when set (qwen's own relocation mechanism),
/// else `~/.qwen/settings.json`. Blank env treated as unset.
pub fn resolve_qwen_settings_path(home: &Path, qwen_home: Option<&str>) -> PathBuf {
    match qwen_home.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Path::new(dir).join("settings.json"),
        None => home.join(".qwen").join("settings.json"),
    }
}

/// Register Swarmterm's MCP server once in qwen's user-scope settings. The
/// entry is placeholder-only (qwen expands env vars in settings), so this is
/// idempotent and needs no bound URL. Log-only, like `register_user_scope`.
pub fn register_qwen(app: &AppHandle) {
    // Never plant ~/.qwen on machines that don't have the CLI — enrollment is
    // only meaningful (and its dir-creation only justified) when qwen exists.
    if crate::agents::find_agent_binary("qwen").is_none() {
        return;
    }
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("mcp: cannot resolve home dir for qwen settings: {e}");
            return;
        }
    };
    let qwen_home = std::env::var("QWEN_HOME").ok();
    let path = resolve_qwen_settings_path(&home, qwen_home.as_deref());
    if let Err(e) = write_qwen_settings_to_file(&path) {
        eprintln!(
            "mcp: failed to register qwen MCP config at {}: {e}",
            path.display()
        );
    }
}

/// Codex's entry: the same stdio proxy as Claude's (SWA-83 1b). Codex hands
/// a stdio server only a short default environment, so the pane's two
/// variables are named in `env_vars`. Nothing in it depends on the port, so
/// it is no longer rewritten on every boot. Keys the user added under our
/// table survive; the legacy HTTP keys go. toml_edit (not toml) because
/// config.toml is the user's hand-edited file — formatting and comments must
/// survive the merge.
pub fn merge_codex_config(existing: Option<&str>, exe: &str) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = existing
        .unwrap_or("")
        .parse()
        .map_err(|e| format!("parse: {e}"))?;
    let servers = doc
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table({
            // Implicit so an empty parent never renders a bare [mcp_servers]
            // header above the real [mcp_servers.swarmterm] one.
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            t
        }))
        // Table-like, not just `[table]`: `mcp_servers = { … }` and
        // `swarmterm = { … }` inline tables are edited in place, so the
        // user's keys (`enabled = false`, timeouts) survive the migration.
        .as_table_like_mut()
        .ok_or("mcp_servers is not a table")?;
    if !servers
        .get("swarmterm")
        .is_some_and(|item| item.is_table_like())
    {
        servers.insert("swarmterm", toml_edit::Item::Table(toml_edit::Table::new()));
    }
    let table = servers
        .get_mut("swarmterm")
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or("mcp_servers.swarmterm is not a table")?;
    for key in entry::LEGACY_TOML_KEYS {
        table.remove(key);
    }
    table.insert("command", toml_edit::value(exe));
    table.insert(
        "args",
        toml_edit::value(toml_edit::Array::from_iter([entry::STDIO_ARG])),
    );
    table.insert(
        "env_vars",
        toml_edit::value(toml_edit::Array::from_iter(entry::ENV_VARS)),
    );
    Ok(doc.to_string())
}

fn codex_entry_is_current(table: Option<&toml_edit::Item>, exe: &str) -> bool {
    let Some(t) = table else { return false };
    let strings = |key: &str| -> Option<Vec<String>> {
        t.get(key)?.as_array().map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
    };
    t.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| crate::dev_defer::same_exe(c, exe))
        && strings("args") == Some(vec![entry::STDIO_ARG.to_string()])
        && strings("env_vars") == Some(entry::ENV_VARS.map(str::to_string).to_vec())
        && entry::LEGACY_TOML_KEYS.iter().all(|k| t.get(k).is_none())
}

/// Write (or migrate to) the stdio entry in a Codex `config.toml`; same
/// ownership and dev-build rules as Claude's (`entry::should_write`).
pub fn write_codex_config_to_file(path: &Path) -> Result<(), String> {
    write_codex_entry(path, &own_exe()?, entry::is_dev_build(), |p| {
        Path::new(p).is_file()
    })
}

fn write_codex_entry(
    path: &Path,
    exe: &str,
    debug: bool,
    exists: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let existing = read_optional(path)?;
    if let Some(s) = existing.as_deref() {
        let doc: toml_edit::DocumentMut = s.parse().map_err(|e| format!("parse: {e}"))?;
        let table = doc.get("mcp_servers").and_then(|m| m.get("swarmterm"));
        let kind = entry::classify_toml(table);
        if !entry::should_write(
            &kind,
            codex_entry_is_current(table, exe),
            exe,
            debug,
            exists,
        ) {
            return Ok(());
        }
    }
    let merged = merge_codex_config(existing.as_deref(), exe)?;
    let tmp = path.with_extension("toml.tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::write(&tmp, merged).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

/// Does a Codex started with this `config.toml` need the per-process URL
/// pin (`hook::codex::with_mcp_url`)? Only while the file holds no stdio
/// entry: on top of one, `-c mcp_servers.swarmterm.url=` makes Codex refuse
/// the server ("url is not supported for stdio"), and the proxy reads the
/// pane's own address anyway. A user's own `swarmterm` entry is not
/// overridden either. An unreadable or malformed file pins, as before 1b.
pub fn codex_needs_url_pin(path: &Path) -> bool {
    let Ok(Some(text)) = read_optional(path) else {
        return true;
    };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return true;
    };
    let table = doc.get("mcp_servers").and_then(|m| m.get("swarmterm"));
    matches!(
        entry::classify_toml(table),
        entry::Kind::Absent | entry::Kind::Legacy
    )
}

/// `$CODEX_HOME/config.toml` when set (Codex's own relocation mechanism),
/// else `~/.codex/config.toml`. Blank env treated as unset.
pub fn resolve_codex_config_path(home: &Path, codex_home: Option<&str>) -> PathBuf {
    match codex_home.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Path::new(dir).join("config.toml"),
        None => home.join(".codex").join("config.toml"),
    }
}

/// Register Codex's entry in its default profile. The caller (`setup`)
/// records the outcome.
pub fn register_codex(app: &AppHandle) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir for codex config: {e}"))?;
    let codex_home = std::env::var("CODEX_HOME").ok();
    let path = resolve_codex_config_path(&home, codex_home.as_deref());
    write_codex_config_to_file(&path).map_err(|e| {
        format!(
            "failed to register codex MCP config at {}: {e}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_inline_config_targets_this_pane() {
        let v: Value =
            serde_json::from_str(&opencode_config_content("http://127.0.0.1:5/mcp", "t-1"))
                .unwrap();
        let e = &v["mcp"]["swarmterm"];
        assert_eq!(e["type"], "remote");
        assert_eq!(e["url"], "http://127.0.0.1:5/mcp");
        assert_eq!(e["headers"]["Authorization"], "Bearer t-1");
    }

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /// The pre-1b HTTP entry: the generic merge tests below exercise
    /// `merge_mcp_servers_json` with it, the writer tests migrate from it.
    fn legacy_entry() -> Value {
        json!({
            "type": "http",
            "url": "${SWARMTERM_MCP_URL}",
            "headers": { "Authorization": "Bearer ${SWARMTERM_SESSION}" }
        })
    }

    fn merge_claude(existing: Option<&str>) -> Result<String, String> {
        merge_mcp_servers_json(existing, legacy_entry(), &[])
    }

    fn merge_qwen(existing: Option<&str>) -> Result<String, String> {
        merge_mcp_servers_json(existing, swarmterm_qwen_entry(), &[])
    }

    #[test]
    fn merge_preserves_user_added_keys_under_swarmterm() {
        // qwen users add e.g. "trust": true under our entry to silence
        // per-tool confirmations — a boot must never clobber that.
        let existing = r#"{"mcpServers":{"swarmterm":{"httpUrl":"stale","trust":true}}}"#;
        let out = merge_qwen(Some(existing)).unwrap();
        let v = parse(&out);
        assert_eq!(v["mcpServers"]["swarmterm"]["trust"], true);
        assert_eq!(
            v["mcpServers"]["swarmterm"]["httpUrl"],
            "${SWARMTERM_MCP_URL}"
        );
    }

    #[test]
    fn write_skips_when_current_even_with_user_extras() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let content = r#"{"mcpServers":{"swarmterm":{"httpUrl":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"},"trust":true}}}"#;
        std::fs::write(&path, content).unwrap();
        write_qwen_settings_to_file(&path).unwrap();
        // Byte-identical: our keys were current, so the user extras never
        // forced a reformat.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }

    #[test]
    fn qwen_commented_file_with_current_entry_is_recognized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let content = "// my settings\n{\"mcpServers\":{\"swarmterm\":{\"httpUrl\":\"${SWARMTERM_MCP_URL}\",\"headers\":{\"Authorization\":\"Bearer ${SWARMTERM_SESSION}\"}}}}";
        std::fs::write(&path, content).unwrap();
        write_qwen_settings_to_file(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }

    #[test]
    fn qwen_commented_file_without_entry_errs_and_is_untouched() {
        // Rewriting would strip the user's comments — refuse instead.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let content = "{\n  // trusted folders\n  \"ui\": {}\n}";
        std::fs::write(&path, content).unwrap();
        assert!(write_qwen_settings_to_file(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }

    #[test]
    fn strip_json_comments_leaves_strings_alone() {
        let s = r#"{"a":"http://x/*not a comment*/","b":1}// tail"#;
        let stripped = strip_json_comments(s);
        let v: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(v["a"], "http://x/*not a comment*/");
        assert_eq!(v["b"], 1);
    }

    #[test]
    fn creates_from_nothing() {
        let out = merge_claude(None).unwrap();
        let v = parse(&out);
        assert_eq!(v["mcpServers"]["swarmterm"]["type"], "http");
        assert_eq!(v["mcpServers"]["swarmterm"]["url"], "${SWARMTERM_MCP_URL}");
    }

    #[test]
    fn creates_from_empty_string() {
        let out = merge_claude(Some("   ")).unwrap();
        assert_eq!(parse(&out)["mcpServers"]["swarmterm"]["type"], "http");
    }

    #[test]
    fn preserves_other_servers() {
        let existing = r#"{"mcpServers": {"other": {"type": "stdio", "command": "x"}}}"#;
        let out = merge_claude(Some(existing)).unwrap();
        let v = parse(&out);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["swarmterm"]["type"], "http");
    }

    #[test]
    fn replaces_existing_swarmterm_block() {
        // If the user (or an old Swarmterm build) already had a swarmterm entry
        // with stale headers, overwrite it so the current shape wins.
        let existing = r#"{"mcpServers": {"swarmterm": {"type": "stdio"}}}"#;
        let out = merge_claude(Some(existing)).unwrap();
        assert_eq!(parse(&out)["mcpServers"]["swarmterm"]["type"], "http");
    }

    #[test]
    fn preserves_unrelated_top_level_keys() {
        let existing = r#"{"projects": {"foo": 1}, "mcpServers": {}}"#;
        let out = merge_claude(Some(existing)).unwrap();
        let v = parse(&out);
        assert_eq!(v["projects"]["foo"], 1);
        assert_eq!(v["mcpServers"]["swarmterm"]["type"], "http");
    }

    /// Byte offset of `"key"` in the rendered text — order is a TEXT property,
    /// `Value` equality is order-free.
    fn pos(text: &str, key: &str) -> usize {
        text.find(&format!("\"{key}\""))
            .unwrap_or_else(|| panic!("{key} missing in {text}"))
    }

    #[test]
    fn merge_keeps_user_key_order_and_appends_mcp_servers_last() {
        let out = merge_claude(Some(r#"{"z":1,"a":2}"#)).unwrap();
        assert!(pos(&out, "z") < pos(&out, "a"), "{out}");
        assert!(pos(&out, "a") < pos(&out, "mcpServers"), "{out}");
    }

    #[test]
    fn merge_keeps_four_space_indent_and_trailing_newline() {
        let out = merge_claude(Some("{\n    \"z\": 1\n}\n")).unwrap();
        assert!(out.starts_with("{\n    \"z\": 1,\n    \"mcpServers\": {\n        \"swarmterm\": {\n            \"type\": \"http\""), "{out}");
        assert!(out.ends_with("}\n") && !out.ends_with("\n\n"), "{out}");
    }

    #[test]
    fn merge_keeps_tab_indent_and_no_trailing_newline() {
        let out = merge_claude(Some("{\n\t\"z\": 1\n}")).unwrap();
        assert!(
            out.contains("\n\t\"mcpServers\": {\n\t\t\"swarmterm\": {\n\t\t\t\"type\""),
            "{out}"
        );
        assert!(out.ends_with('}'), "{out}");
    }

    #[test]
    fn merge_of_compact_or_new_file_is_byte_identical_to_pretty() {
        let compact = merge_claude(Some(r#"{"z":1}"#)).unwrap();
        assert!(
            compact.starts_with("{\n  \"z\": 1,\n  \"mcpServers\""),
            "{compact}"
        );
        assert!(compact.ends_with('}'), "{compact}");
        let fresh = merge_claude(None).unwrap();
        assert_eq!(fresh, serde_json::to_string_pretty(&parse(&fresh)).unwrap());
    }

    #[test]
    fn errors_on_malformed_json() {
        assert!(merge_claude(Some("{not json")).is_err());
    }

    #[test]
    fn errors_when_root_not_object() {
        assert!(merge_claude(Some("[1,2,3]")).is_err());
    }

    #[test]
    fn errors_when_mcp_servers_not_object() {
        assert!(merge_claude(Some(r#"{"mcpServers":"nope"}"#)).is_err());
    }

    #[test]
    fn global_path_defaults_to_home() {
        let p = resolve_global_config_path(Path::new("/home/duong"), None);
        assert_eq!(p, Path::new("/home/duong/.claude.json"));
    }

    #[test]
    fn global_path_honors_claude_config_dir() {
        let p = resolve_global_config_path(Path::new("/home/duong"), Some("/custom/cfg"));
        assert_eq!(p, Path::new("/custom/cfg/.claude.json"));
    }

    #[test]
    fn global_path_ignores_blank_config_dir() {
        // Blank/whitespace CLAUDE_CONFIG_DIR must fall back to home, not
        // resolve to "/.claude.json".
        let p = resolve_global_config_path(Path::new("/home/duong"), Some("   "));
        assert_eq!(p, Path::new("/home/duong/.claude.json"));
    }

    #[test]
    fn to_file_creates_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        write_mcp_config_to_file(&path).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("\"swarmterm\""));
        assert!(contents.contains("--mcp-stdio"));
        assert!(!contents.contains("SWARMTERM_MCP_URL"));
    }

    const DEFAULT_USER: &str = r#"{"projects":{"/p":{}},"mcpServers":{
        "board":{"type":"stdio","command":"py","env":{"USER":"x"}},
        "shared":{"type":"http","url":"https://default"},
        "swarmterm":{"type":"http","url":"stale"}}}"#;

    #[test]
    fn default_servers_are_added_without_touching_the_profiles_own() {
        let profile = r#"{"oauthAccount":{},"mcpServers":{"shared":{"type":"http","url":"https://profile"}}}"#;
        let out = merge_default_user_servers(Some(profile), DEFAULT_USER)
            .unwrap()
            .expect("board is missing");
        let v = parse(&out);
        assert_eq!(
            v["mcpServers"]["board"],
            parse(DEFAULT_USER)["mcpServers"]["board"]
        );
        assert_eq!(v["mcpServers"]["shared"]["url"], "https://profile");
        assert!(v["mcpServers"].get("swarmterm").is_none());
        assert!(
            v.get("projects").is_none(),
            "only servers are copied: {out}"
        );
        assert!(v.get("oauthAccount").is_some());
    }

    #[test]
    fn default_servers_create_a_missing_profile_and_settle() {
        let out = merge_default_user_servers(None, DEFAULT_USER)
            .unwrap()
            .unwrap();
        assert!(merge_default_user_servers(Some(&out), DEFAULT_USER)
            .unwrap()
            .is_none());
        assert!(merge_default_user_servers(None, r#"{"theme":"dark"}"#)
            .unwrap()
            .is_none());
    }

    #[test]
    fn default_servers_reject_a_malformed_profile() {
        assert!(merge_default_user_servers(Some("{ nope"), DEFAULT_USER).is_err());
        assert!(merge_default_user_servers(Some(r#"{"mcpServers":[]}"#), DEFAULT_USER).is_err());
    }

    #[test]
    fn copy_default_servers_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profile.claude.json");
        let default = dir.path().join(".claude.json");
        assert!(!copy_default_user_servers(&profile, &default).unwrap());
        std::fs::write(&default, DEFAULT_USER).unwrap();
        write_mcp_config_to_file(&profile).unwrap();
        assert!(copy_default_user_servers(&profile, &default).unwrap());
        assert!(!copy_default_user_servers(&profile, &default).unwrap());
        let v = parse(&std::fs::read_to_string(&profile).unwrap());
        assert!(v["mcpServers"]["board"].is_object());
        assert_eq!(
            v["mcpServers"]["swarmterm"],
            swarmterm_entry(&own_exe().unwrap())
        );
    }

    #[test]
    fn to_file_merges_and_preserves_other_config() {
        // Simulate a realistic ~/.claude.json: a top-level key plus an
        // unrelated MCP server that must survive the merge.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(
            &path,
            r#"{"numStartups":42,"mcpServers":{"1devtool":{"command":"x"}}}"#,
        )
        .unwrap();
        write_mcp_config_to_file(&path).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["numStartups"], 42);
        assert_eq!(v["mcpServers"]["1devtool"]["command"], "x");
        assert_eq!(v["mcpServers"]["swarmterm"]["type"], "stdio");
    }

    #[test]
    fn to_file_leaves_malformed_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(write_mcp_config_to_file(&path).is_err());
        // Original bytes preserved — the tmp+rename never clobbered them.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn to_file_is_idempotent() {
        // Writing twice must leave byte-identical content: the second call sees
        // the swarmterm entry already present and must not rewrite (no reformat).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        write_mcp_config_to_file(&path).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        write_mcp_config_to_file(&path).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn to_file_skips_rewrite_when_entry_already_present() {
        // A file that already contains the exact swarmterm entry but in a
        // different (compact) formatting must be left byte-for-byte untouched —
        // we must not reformat/reorder the user's ~/.claude.json on repeat boots.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        let compact = r#"{"numStartups":7,"mcpServers":{"swarmterm":{"type":"stdio","command":"C:/Apps/Swarmterm GN/swarmterm.exe","args":["--mcp-stdio"],"timeout":9}}}"#;
        std::fs::write(&path, compact).unwrap();
        write_claude_entry(&path, EXE, false, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), compact);
    }

    const EXE: &str = r"C:\Apps\Swarmterm GN\swarmterm.exe";
    const DEV_EXE: &str = r"D:\wt\src-tauri\target\debug\swarmterm.exe";

    fn claude_slot(path: &Path) -> Value {
        parse(&std::fs::read_to_string(path).unwrap())["mcpServers"]["swarmterm"].clone()
    }

    #[test]
    fn claude_writer_migrates_the_legacy_entry_and_keeps_user_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        let mut legacy = legacy_entry();
        legacy["timeout"] = json!(9);
        std::fs::write(
            &path,
            json!({"mcpServers":{"swarmterm":legacy}}).to_string(),
        )
        .unwrap();
        write_claude_entry(&path, EXE, false, |_| true).unwrap();
        let slot = claude_slot(&path);
        assert_eq!(slot["type"], "stdio");
        assert_eq!(slot["command"], EXE);
        assert_eq!(slot["args"], json!(["--mcp-stdio"]));
        assert_eq!(slot["timeout"], 9);
        assert!(slot.get("url").is_none() && slot.get("headers").is_none());
    }

    #[test]
    fn claude_writer_leaves_a_foreign_entry_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        let text = r#"{"mcpServers":{"swarmterm":{"command":"my-own"}}}"#;
        std::fs::write(&path, text).unwrap();
        write_claude_entry(&path, EXE, false, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn claude_writer_in_a_dev_build_defers_to_the_installed_app() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        // Legacy entry: the installed (older) app migrates it, not us.
        let legacy = json!({"mcpServers":{"swarmterm":legacy_entry()}}).to_string();
        std::fs::write(&path, &legacy).unwrap();
        write_claude_entry(&path, DEV_EXE, true, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        // A live installed exe keeps its entry ...
        write_claude_entry(&path, EXE, false, |_| true).unwrap();
        let installed = std::fs::read_to_string(&path).unwrap();
        write_claude_entry(&path, DEV_EXE, true, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), installed);
        // ... a dead one is repaired.
        write_claude_entry(&path, DEV_EXE, true, |_| false).unwrap();
        assert_eq!(claude_slot(&path)["command"], DEV_EXE);
    }

    #[test]
    fn qwen_creates_from_nothing_with_http_url_placeholder() {
        let out = merge_qwen(None).unwrap();
        let v = parse(&out);
        assert_eq!(
            v["mcpServers"]["swarmterm"]["httpUrl"],
            "${SWARMTERM_MCP_URL}"
        );
        assert_eq!(
            v["mcpServers"]["swarmterm"]["headers"]["Authorization"],
            "Bearer ${SWARMTERM_SESSION}"
        );
    }

    #[test]
    fn qwen_preserves_settings_sections_and_other_servers() {
        let existing =
            r#"{"ui":{"autoModeAcknowledged":true},"mcpServers":{"other":{"command":"x"}}}"#;
        let out = merge_qwen(Some(existing)).unwrap();
        let v = parse(&out);
        assert_eq!(v["ui"]["autoModeAcknowledged"], true);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(
            v["mcpServers"]["swarmterm"]["httpUrl"],
            "${SWARMTERM_MCP_URL}"
        );
    }

    #[test]
    fn qwen_errors_on_malformed_json() {
        assert!(merge_qwen(Some("{not json")).is_err());
    }

    #[test]
    fn qwen_file_write_creates_parent_dir_and_is_idempotent() {
        // Unlike ~/.claude.json, ~/.qwen may not exist yet — the writer
        // creates it (codex-writer precedent).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".qwen").join("settings.json");
        write_qwen_settings_to_file(&path).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        write_qwen_settings_to_file(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn qwen_file_write_leaves_malformed_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(write_qwen_settings_to_file(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn qwen_file_write_replaces_stale_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"swarmterm":{"httpUrl":"http://127.0.0.1:9/mcp"}}}"#,
        )
        .unwrap();
        write_qwen_settings_to_file(&path).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            v["mcpServers"]["swarmterm"]["httpUrl"],
            "${SWARMTERM_MCP_URL}"
        );
    }

    #[test]
    fn qwen_path_honors_qwen_home_and_ignores_blank() {
        let p = resolve_qwen_settings_path(Path::new("/home/duong"), None);
        assert_eq!(p, Path::new("/home/duong/.qwen/settings.json"));
        let p = resolve_qwen_settings_path(Path::new("/home/duong"), Some("/custom"));
        assert_eq!(p, Path::new("/custom/settings.json"));
        let p = resolve_qwen_settings_path(Path::new("/home/duong"), Some("  "));
        assert_eq!(p, Path::new("/home/duong/.qwen/settings.json"));
    }

    fn codex_table(text: &str) -> toml_edit::Table {
        let doc: toml_edit::DocumentMut = text.parse().unwrap();
        doc["mcp_servers"]["swarmterm"].as_table().unwrap().clone()
    }

    #[test]
    fn codex_creates_from_nothing() {
        let out = merge_codex_config(None, EXE).unwrap();
        assert!(out.contains("[mcp_servers.swarmterm]"));
        assert!(!out.contains("[mcp_servers]\n"), "{out}");
        let t = codex_table(&out);
        assert_eq!(t["command"].as_str(), Some(EXE));
        assert!(codex_entry_is_current(
            Some(&toml_edit::Item::Table(t)),
            EXE
        ));
    }

    #[test]
    fn codex_preserves_other_tables_and_comments() {
        let existing =
            "# my codex settings\nmodel = \"o4\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        let out = merge_codex_config(Some(existing), EXE).unwrap();
        assert!(out.contains("# my codex settings"));
        assert!(out.contains("model = \"o4\""));
        assert!(out.contains("[mcp_servers.other]"));
        assert!(out.contains("[mcp_servers.swarmterm]"));
    }

    #[test]
    fn codex_migrates_the_legacy_entry_and_keeps_user_keys() {
        let existing = "[mcp_servers.swarmterm]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\nstartup_timeout_sec = 20\n";
        let out = merge_codex_config(Some(existing), EXE).unwrap();
        let t = codex_table(&out);
        assert!(t.get("url").is_none() && t.get("bearer_token_env_var").is_none());
        assert_eq!(t["startup_timeout_sec"].as_integer(), Some(20));
        assert!(codex_entry_is_current(
            Some(&toml_edit::Item::Table(t)),
            EXE
        ));
    }

    #[test]
    fn codex_migrates_an_inline_entry_without_losing_user_keys() {
        let existing = "[mcp_servers]\nswarmterm = { url = 'http://127.0.0.1:9/mcp', bearer_token_env_var = 'SWARMTERM_SESSION', startup_timeout_sec = 42, enabled = false }\ngh = { command = 'gh' }\n";
        let out = merge_codex_config(Some(existing), EXE).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let t = &doc["mcp_servers"]["swarmterm"];
        assert!(t.as_inline_table().is_some(), "stays inline: {out}");
        assert_eq!(t["enabled"].as_bool(), Some(false));
        assert_eq!(t["startup_timeout_sec"].as_integer(), Some(42));
        assert!(t.get("url").is_none() && t.get("bearer_token_env_var").is_none());
        assert!(codex_entry_is_current(Some(t), EXE), "{out}");
        assert_eq!(doc["mcp_servers"]["gh"]["command"].as_str(), Some("gh"));
        // A whole inline `mcp_servers` works the same way.
        let inline_root = "mcp_servers = { swarmterm = { url = 'http://127.0.0.1:9/mcp', bearer_token_env_var = 'SWARMTERM_SESSION', enabled = false } }\n";
        let out = merge_codex_config(Some(inline_root), EXE).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let t = &doc["mcp_servers"]["swarmterm"];
        assert_eq!(t["enabled"].as_bool(), Some(false));
        assert!(codex_entry_is_current(Some(t), EXE), "{out}");
    }

    #[test]
    fn codex_errors_on_malformed_toml() {
        assert!(merge_codex_config(Some("mcp_servers = ["), EXE).is_err());
    }

    #[test]
    fn codex_file_write_skips_when_current() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        write_codex_config_to_file(&path).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        write_codex_config_to_file(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn codex_writer_keeps_foreign_entries_and_defers_in_dev_builds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let foreign = "[mcp_servers.swarmterm]\ncommand = \"gh\"\n";
        std::fs::write(&path, foreign).unwrap();
        write_codex_entry(&path, EXE, false, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), foreign);

        let legacy = "[mcp_servers.swarmterm]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n";
        std::fs::write(&path, legacy).unwrap();
        write_codex_entry(&path, DEV_EXE, true, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        write_codex_entry(&path, EXE, false, |_| true).unwrap();
        let installed = std::fs::read_to_string(&path).unwrap();
        write_codex_entry(&path, DEV_EXE, true, |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), installed);
    }

    #[test]
    fn codex_file_write_leaves_malformed_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "mcp_servers = [").unwrap();
        assert!(write_codex_config_to_file(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mcp_servers = [");
    }

    #[test]
    fn codex_url_pin_only_without_a_stdio_or_foreign_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert!(codex_needs_url_pin(&path), "missing file");
        std::fs::write(&path, "model = \"o4\"\n").unwrap();
        assert!(codex_needs_url_pin(&path), "no entry");
        std::fs::write(&path, "[mcp_servers.swarmterm]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n").unwrap();
        assert!(codex_needs_url_pin(&path), "legacy");
        write_codex_entry(&path, EXE, false, |_| true).unwrap();
        assert!(!codex_needs_url_pin(&path), "stdio");
        std::fs::write(&path, "[mcp_servers.swarmterm]\ncommand = \"gh\"\n").unwrap();
        assert!(!codex_needs_url_pin(&path), "foreign");
    }

    #[test]
    fn codex_path_defaults_to_home_dot_codex() {
        let p = resolve_codex_config_path(Path::new("/home/duong"), None);
        assert_eq!(p, Path::new("/home/duong/.codex/config.toml"));
    }

    #[test]
    fn codex_path_honors_codex_home_and_ignores_blank() {
        let p = resolve_codex_config_path(Path::new("/home/duong"), Some("/custom"));
        assert_eq!(p, Path::new("/custom/config.toml"));
        let p = resolve_codex_config_path(Path::new("/home/duong"), Some("  "));
        assert_eq!(p, Path::new("/home/duong/.codex/config.toml"));
    }
}
