//! Reviewed, versioned MCP definitions. Only config is written: no download,
//! process launch, credential handling, or automatic authentication.
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{json, Value};
use toml_edit::{DocumentMut, Item, Table};

pub const VERSION: u32 = 1;

fn entry(id: &str, directories: &[String], windows: bool) -> Result<Value, String> {
    if id != "filesystem" && !directories.is_empty() {
        return Err("Only Filesystem accepts directories".into());
    }
    match id {
        "github" => return Ok(json!({"url": "https://api.githubcopilot.com/mcp/"})),
        "context7" => return Ok(json!({"url": "https://mcp.context7.com/mcp/oauth"})),
        _ => {}
    }
    let (command, mut args): (&str, Vec<String>) = match id {
        "playwright" => (
            "npx",
            vec!["-y".into(), "@playwright/mcp".into(), "--headless".into()],
        ),
        "filesystem" => (
            "npx",
            vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
            ],
        ),
        "memory" => (
            "npx",
            vec!["-y".into(), "@modelcontextprotocol/server-memory".into()],
        ),
        "sequential-thinking" => (
            "npx",
            vec![
                "-y".into(),
                "@modelcontextprotocol/server-sequential-thinking".into(),
            ],
        ),
        "fetch" => ("uvx", vec!["mcp-server-fetch".into()]),
        _ => return Err("Unknown MCP catalogue entry".into()),
    };
    if id == "filesystem" {
        if directories.is_empty() || directories.len() > 16 {
            return Err("Choose between 1 and 16 Filesystem directories".into());
        }
        for directory in directories {
            // Windows npm is a batch launcher. Reject cmd metacharacters even
            // on other platforms so saved selections are safe when moved.
            if directory.len() > 4096
                || directory
                    .chars()
                    .any(|c| c.is_control() || "\"%&|^<>!()".contains(c))
                || !Path::new(directory).is_absolute()
                || !Path::new(directory).is_dir()
            {
                return Err("Filesystem requires existing absolute directories without shell metacharacters".into());
            }
            args.push(directory.clone());
        }
    }
    if windows && command == "npx" {
        let mut wrapped = vec!["/d".into(), "/c".into(), "npx".into()];
        wrapped.extend(args);
        Ok(json!({"command": "cmd", "args": wrapped}))
    } else {
        Ok(json!({"command": command, "args": args}))
    }
}

fn merge_json(existing: Option<&str>, id: &str, mut entry: Value) -> Result<String, String> {
    if entry.get("url").is_some() {
        entry["type"] = json!("http");
    }
    let mut root: Value = match existing {
        Some(text) => {
            serde_json::from_str(text).map_err(|_| "Invalid JSON config; file left unchanged")?
        }
        None => json!({}),
    };
    let object = root.as_object_mut().ok_or("Config must be a JSON object")?;
    let servers = object.entry("mcpServers").or_insert_with(|| json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or("mcpServers must be an object")?;
    if let Some(current) = servers.get(id) {
        if current == &entry {
            return Ok(existing.unwrap_or_default().into());
        }
        return Err(format!(
            "MCP server '{id}' already exists; existing configuration left unchanged"
        ));
    }
    servers.insert(id.into(), entry);
    crate::json_style::JsonStyle::detect(existing).render(&root)
}

fn merge_toml(existing: Option<&str>, id: &str, entry: &Value) -> Result<String, String> {
    let mut doc: DocumentMut = existing
        .unwrap_or("")
        .parse()
        .map_err(|_| "Invalid TOML config; file left unchanged")?;
    let mut table = Table::new();
    for (key, value) in entry.as_object().ok_or("Invalid catalogue definition")? {
        let item = match value {
            Value::String(s) => toml_edit::value(s),
            Value::Array(args) => {
                let mut array = toml_edit::Array::new();
                for arg in args {
                    array.push(arg.as_str().ok_or("Invalid catalogue argument")?);
                }
                toml_edit::value(array)
            }
            _ => return Err("Invalid catalogue field".into()),
        };
        table.insert(key, item);
    }
    let servers = doc
        .entry("mcp_servers")
        .or_insert_with(|| {
            let mut parent = Table::new();
            parent.set_implicit(true);
            Item::Table(parent)
        })
        .as_table_like_mut()
        .ok_or("mcp_servers must be a TOML table")?;
    if let Some(current) = servers.get(id) {
        let identical = current.as_table_like().is_some_and(|current| {
            current.len() == table.len()
                && table.iter().all(|(key, value)| {
                    match (current.get(key).and_then(Item::as_value), value.as_value()) {
                        (Some(a), Some(b)) if a.as_str().is_some() => a.as_str() == b.as_str(),
                        (Some(a), Some(b)) => {
                            a.as_array().zip(b.as_array()).is_some_and(|(a, b)| {
                                a.len() == b.len()
                                    && a.iter()
                                        .zip(b.iter())
                                        .all(|(a, b)| a.as_str() == b.as_str())
                            })
                        }
                        _ => false,
                    }
                })
        });
        if identical {
            return Ok(existing.unwrap_or_default().into());
        }
        return Err(format!(
            "MCP server '{id}' already exists; existing configuration left unchanged"
        ));
    }
    servers.insert(id, Item::Table(table));
    Ok(doc.to_string())
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read agent configuration".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub version: u32,
    pub entries: Vec<CatalogEntryStatus>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryStatus {
    pub id: String,
    pub status: &'static str,
}
const IDS: [&str; 7] = [
    "playwright",
    "github",
    "context7",
    "filesystem",
    "memory",
    "sequential-thinking",
    "fetch",
];

fn toml_json(item: &Item) -> Value {
    if let Some(table) = item.as_table_like() {
        return Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.into(), toml_json(value)))
                .collect(),
        );
    }
    if let Some(value) = item.as_value() {
        if let Some(text) = value.as_str() {
            return json!(text);
        }
        if let Some(array) = value.as_array() {
            return Value::Array(
                array
                    .iter()
                    .map(|v| v.as_str().map(|s| json!(s)).unwrap_or(Value::Null))
                    .collect(),
            );
        }
    }
    Value::Null
}

/// Returns only catalogue IDs and statuses; never returns config or headers.
pub fn inspect_catalog(path: &Path, agent_id: &str) -> Result<CatalogStatus, String> {
    let existing = read(path)?;
    let servers = match agent_id {
        "claude-code" => {
            let root: Value = serde_json::from_str(existing.as_deref().unwrap_or("{}"))
                .map_err(|_| "Invalid JSON agent configuration")?;
            if !root.is_object() {
                return Err("Config must be a JSON object".into());
            }
            let servers = root.get("mcpServers").cloned().unwrap_or_else(|| json!({}));
            if !servers.is_object() {
                return Err("mcpServers must be an object".into());
            }
            servers
        }
        "codex" => {
            let root: DocumentMut = existing
                .as_deref()
                .unwrap_or("")
                .parse()
                .map_err(|_| "Invalid TOML agent configuration")?;
            match root.get("mcp_servers") {
                None => json!({}),
                Some(item) if item.as_table_like().is_some() => toml_json(item),
                Some(_) => return Err("mcp_servers must be a TOML table".into()),
            }
        }
        _ => return Err("MCP catalogue supports Claude and Codex profiles".into()),
    };
    let entries = IDS
        .iter()
        .map(|id| {
            let status = match servers.get(*id) {
                None => "available",
                Some(current) => {
                    let directories: Vec<String> = if *id == "filesystem" {
                        let offset = if cfg!(windows) { 5 } else { 2 };
                        current
                            .get("args")
                            .and_then(Value::as_array)
                            .map(|args| {
                                args.iter()
                                    .skip(offset)
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default()
                    } else {
                        vec![]
                    };
                    match entry(id, &directories, cfg!(windows)) {
                        Ok(mut expected) => {
                            if agent_id == "claude-code" && expected.get("url").is_some() {
                                expected["type"] = json!("http");
                            }
                            if &expected == current {
                                "configured"
                            } else {
                                "conflict"
                            }
                        }
                        Err(_) => "conflict",
                    }
                }
            };
            CatalogEntryStatus {
                id: (*id).into(),
                status,
            }
        })
        .collect();
    Ok(CatalogStatus {
        version: VERSION,
        entries,
    })
}

/// `path` must be resolved by the account backend, never accepted over IPC.
/// Foreign entries and conflicting same-key entries are never replaced.
pub fn configure_catalog(
    path: &Path,
    agent_id: &str,
    id: &str,
    directories: &[String],
) -> Result<(), String> {
    if !matches!(agent_id, "claude-code" | "codex") {
        return Err("MCP catalogue supports Claude and Codex profiles".into());
    }
    let definition = entry(id, directories, cfg!(windows))?;
    let _lock = crate::accounts::CONFIG_WRITE
        .lock()
        .map_err(|_| "Config writer unavailable")?;
    let original = read(path)?;
    let merged = if agent_id == "claude-code" {
        merge_json(original.as_deref(), id, definition)?
    } else {
        merge_toml(original.as_deref(), id, &definition)?
    };
    if original.as_deref() == Some(merged.as_str()) {
        return Ok(());
    }
    let parent = path.parent().ok_or("Config has no parent directory")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create profile configuration directory")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Cannot prepare configuration update")?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|_| "Cannot preserve configuration permissions")?;
    }
    temporary
        .write_all(merged.as_bytes())
        .map_err(|_| "Cannot write configuration update")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot flush configuration update")?;
    // Detect a concurrent CLI edit before replacing the file. The agent CLI
    // does not participate in our lock, so callers can retry on this error.
    if read(path)? != original {
        return Err(
            "Agent configuration changed during update; retry after the CLI finishes writing"
                .into(),
        );
    }
    temporary
        .persist(path)
        .map_err(|_| "Cannot atomically replace agent configuration")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_preserves_foreign_entries_and_refuses_collision() {
        let original = r#"{"theme":"dark","mcpServers":{"foreign":{"command":"custom"},"github":{"url":"private"}}}"#;
        let memory = entry("memory", &[], false).unwrap();
        let merged = merge_json(Some(original), "memory", memory.clone()).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcpServers"]["foreign"]["command"], "custom");
        assert!(merge_json(
            Some(original),
            "github",
            entry("github", &[], false).unwrap()
        )
        .is_err());
        assert_eq!(merge_json(Some(&merged), "memory", memory).unwrap(), merged);
        assert!(merge_json(Some("broken"), "memory", json!({})).is_err());
    }

    #[test]
    fn toml_preserves_comments_and_foreign_entries() {
        let original =
            "# personal\nmodel = 'chosen'\n[mcp_servers.foreign]\ncommand = 'custom' # keep\n";
        let definition = entry("playwright", &[], true).unwrap();
        let merged = merge_toml(Some(original), "playwright", &definition).unwrap();
        assert!(merged.contains("# personal"));
        assert!(merged.contains("# keep"));
        assert_eq!(
            merge_toml(Some(&merged), "playwright", &definition).unwrap(),
            merged
        );
        assert!(merge_toml(Some(&merged), "foreign", &definition).is_err());
        assert!(merge_toml(Some("broken = ["), "memory", &definition).is_err());
        let inline = "# inline owned by user\nmcp_servers = { foreign = { command = 'mine' }, context7 = { url = 'https://mcp.context7.com/mcp/oauth' } }\n";
        assert_eq!(
            merge_toml(
                Some(inline),
                "context7",
                &entry("context7", &[], false).unwrap()
            )
            .unwrap(),
            inline
        );
        let merged = merge_toml(
            Some(inline),
            "github",
            &entry("github", &[], false).unwrap(),
        )
        .unwrap();
        assert!(merged.contains("# inline owned by user"));
        assert!(merged.contains("command = 'mine'"));
        assert!(merged.parse::<DocumentMut>().is_ok());
    }

    #[test]
    fn safe_definitions_and_directory_validation() {
        assert!(entry("unknown", &[], false).is_err());
        assert!(entry("filesystem", &[], true).is_err());
        assert!(entry("filesystem", &["relative".into()], true).is_err());
        assert!(entry("filesystem", &["C:/bad%PATH%".into()], true).is_err());
        let directory = tempfile::tempdir().unwrap();
        let with_spaces = directory.path().join("allowed folder with spaces");
        fs::create_dir(&with_spaces).unwrap();
        let path = with_spaces.to_string_lossy().into_owned();
        let definition = entry("filesystem", std::slice::from_ref(&path), true).unwrap();
        assert_eq!(definition["args"][5], path);
        assert_eq!(
            entry("playwright", &[], true).unwrap()["args"][5],
            "--headless"
        );
        assert!(entry("github", &[path], false).is_err());
    }

    #[test]
    fn concurrent_writes_preserve_all_servers_and_atomic_failure_preserves_file() {
        for (agent, extension) in [("claude-code", "json"), ("codex", "toml")] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("config.{extension}"));
            std::thread::scope(|scope| {
                for id in ["github", "memory", "fetch", "context7"] {
                    let path = &path;
                    scope.spawn(move || configure_catalog(path, agent, id, &[]).unwrap());
                }
            });
            let original = fs::read_to_string(&path).unwrap();
            for id in ["github", "memory", "fetch", "context7"] {
                assert!(original.contains(id));
            }
            let statuses = inspect_catalog(&path, agent).unwrap();
            assert_eq!(statuses.version, 1);
            assert_eq!(
                statuses
                    .entries
                    .iter()
                    .find(|s| s.id == "github")
                    .unwrap()
                    .status,
                "configured"
            );
            assert_eq!(
                statuses
                    .entries
                    .iter()
                    .find(|s| s.id == "playwright")
                    .unwrap()
                    .status,
                "available"
            );
            fs::write(&path, "malformed = [}").unwrap();
            assert!(configure_catalog(&path, agent, "playwright", &[]).is_err());
            assert_eq!(fs::read_to_string(path).unwrap(), "malformed = [}");
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn inspect_reports_conflicts_without_exposing_private_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".claude.json");
        fs::write(&path, r#"{"mcpServers":{"github":{"url":"private","headers":{"Authorization":"secret-marker"}},"foreign":{"env":{"TOKEN":"secret-marker"}}},"apiKey":"secret-marker"}"#).unwrap();
        let statuses = inspect_catalog(&path, "claude-code").unwrap();
        assert_eq!(
            statuses
                .entries
                .iter()
                .find(|s| s.id == "github")
                .unwrap()
                .status,
            "conflict"
        );
        let serialized = serde_json::to_string(&statuses).unwrap();
        assert!(!serialized.contains("secret-marker"));
        assert!(!serialized.contains("foreign"));
        assert!(!serialized.contains("private"));
    }
}
