//! Codex session capture. User hooks remain additive and require Codex's
//! normal `/hooks` trust flow; never write trust records or bypass trust.
use super::install::{merge_events, HooksWrite};
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

const EVENTS: [&str; 2] = ["SessionStart", "UserPromptSubmit"];

pub fn supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(probe)
}

fn probe() -> bool {
    let Some(binary) = crate::agents::find_agent_binary("codex") else {
        return false;
    };
    let Ok(mut output) = tempfile::tempfile() else {
        return false;
    };
    let Ok(stdout) = output.try_clone() else {
        return false;
    };
    let mut command = Command::new(binary);
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(stdout);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
    use std::io::{Seek, SeekFrom};
    if output.seek(SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut help = String::new();
    if output.take(64 * 1024).read_to_string(&mut help).is_err() {
        return false;
    }
    help.contains("--no-daemon") && help.contains("--dangerously-bypass-hook-trust")
}

pub fn isolated_command(command: &str, agent: Option<&str>, supported: bool) -> String {
    if supported && agent == Some("codex") {
        if let Some(tail) = command.strip_prefix("codex") {
            if (tail.is_empty() || tail.starts_with(' '))
                && !tail.split_whitespace().any(|arg| arg == "--no-daemon")
            {
                return format!("codex --no-daemon{tail}");
            }
        }
    }
    command.into()
}

fn is_ours(command: &str) -> bool {
    let c = command.trim().to_ascii_lowercase();
    c.contains("swarmterm") && c.trim_end_matches('"').ends_with("--codex-session-hook")
}

pub fn format_command(exe: &str, windows: bool) -> String {
    if windows {
        let path = exe.replace('\\', "/").replace('\'', "''");
        format!("powershell.exe -NoProfile -NonInteractive -Command \"& '{path}' --codex-session-hook\"")
    } else {
        format!("\"{exe}\" --codex-session-hook")
    }
}

pub fn merge_json(existing: Option<&str>, command: &str) -> Result<HooksWrite, String> {
    merge_events(existing, Some(command), &EVENTS, is_ours)
}

/// Edit the existing representation in place, preserving comments and foreign
/// groups. Mixed groups belong to the user, including copied Swarmterm hooks.
pub fn merge_toml(existing: &str, command: &str) -> Result<Option<String>, String> {
    let mut doc = existing.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    let hooks = doc
        .get_mut("hooks")
        .and_then(Item::as_table_mut)
        .ok_or("hooks is not a TOML table")?;
    let mut changed = false;
    for event in EVENTS {
        if !hooks.contains_key(event) {
            hooks.insert(event, Item::ArrayOfTables(ArrayOfTables::new()));
        }
        let groups = hooks
            .get_mut(event)
            .and_then(Item::as_array_of_tables_mut)
            .ok_or("hook event is not an array of tables")?;
        let ours = |g: &Table| {
            g.get("hooks")
                .and_then(Item::as_array_of_tables)
                .is_some_and(|hs| {
                    !hs.is_empty()
                        && hs
                            .iter()
                            .all(|h| h.get("command").and_then(Item::as_str).is_some_and(is_ours))
                })
        };
        if groups.iter().filter(|g| ours(g)).count() == 1
            && groups.iter().filter(|g| ours(g)).all(|g| {
                let hs = g["hooks"].as_array_of_tables().unwrap();
                hs.len() == 1
                    && hs.get(0).unwrap().get("command").and_then(Item::as_str) == Some(command)
                    && hs.get(0).unwrap().get("timeout").and_then(Item::as_integer) == Some(5)
            })
        {
            continue;
        }
        groups.retain(|g| !ours(g));
        let mut handler = Table::new();
        handler["type"] = value("command");
        handler["command"] = value(command);
        handler["timeout"] = value(5);
        let mut handlers = ArrayOfTables::new();
        handlers.push(handler);
        let mut group = Table::new();
        group["hooks"] = Item::ArrayOfTables(handlers);
        groups.push(group);
        changed = true;
    }
    Ok(changed.then(|| doc.to_string()))
}

pub fn install(home: &Path, command: &str) -> Result<(), String> {
    let config_path = home.join("config.toml");
    let json_path = home.join("hooks.json");
    let config = match fs::read_to_string(&config_path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let inline = if let Some(s) = &config {
        s.parse::<DocumentMut>()
            .map_err(|e| e.to_string())?
            .contains_key("hooks")
    } else {
        false
    };
    let (path, contents) = if inline {
        let Some(next) = merge_toml(config.as_deref().unwrap(), command)? else {
            return Ok(());
        };
        (config_path, next)
    } else {
        let existing = match fs::read_to_string(&json_path) {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let HooksWrite::Write(next) = merge_json(existing.as_deref(), command)? else {
            return Ok(());
        };
        (json_path, next)
    };
    fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("swarmterm-hooks.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn register(app: &AppHandle) {
    if !supported() {
        return;
    }
    let home = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|p| p.join(".codex")));
    let (Some(home), Ok(exe)) = (home, std::env::current_exe()) else {
        return;
    };
    let command = format_command(&exe.to_string_lossy(), cfg!(windows));
    if let Err(e) = install(&home, &command) {
        eprintln!("Codex session hook registration failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OURS: &str = "\"C:/Swarmterm/swarmterm.exe\" --codex-session-hook";
    #[test]
    fn isolates_supported_codex_without_changing_other_commands() {
        assert_eq!(
            isolated_command("codex resume abc", Some("codex"), true),
            "codex --no-daemon resume abc"
        );
        assert_eq!(
            isolated_command("codex --no-daemon", Some("codex"), true),
            "codex --no-daemon"
        );
        assert_eq!(isolated_command("codex", Some("codex"), false), "codex");
        assert_eq!(
            isolated_command("codex-helper", Some("codex"), true),
            "codex-helper"
        );
        assert_eq!(
            isolated_command("claude", Some("claude-code"), true),
            "claude"
        );
    }
    #[test]
    fn json_is_additive_and_idempotent() {
        let original = r#"{"other":true,"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"notify"}]}]}}"#;
        let HooksWrite::Write(next) = merge_json(Some(original), OURS).unwrap() else {
            panic!()
        };
        let parsed: serde_json::Value = serde_json::from_str(&next).unwrap();
        assert_eq!(
            parsed["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "notify"
        );
        assert_eq!(parsed["other"], true);
        assert!(matches!(
            merge_json(Some(&next), OURS).unwrap(),
            HooksWrite::Unchanged
        ));
        assert!(merge_json(Some("broken"), OURS).is_err());
    }
    #[test]
    fn toml_preserves_user_comments_and_repairs_only_ours() {
        let original = "# Keep this\nmodel = 'test'\n[features]\nhooks = false\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = 'command'\ncommand = 'notify'\n";
        let next = merge_toml(original, OURS).unwrap().unwrap();
        assert!(next.contains("# Keep this"));
        assert!(next.contains("command = 'notify'"));
        assert!(next.contains("hooks = false"));
        assert!(merge_toml(&next, OURS).unwrap().is_none());
        let moved = OURS.replace("C:/Swarmterm", "D:/Swarmterm");
        let repaired = merge_toml(&next, &moved).unwrap().unwrap();
        assert!(!repaired.contains(OURS));
        assert!(repaired.contains("D:/Swarmterm"));
    }
    #[test]
    fn malformed_config_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.toml"), "[broken").unwrap();
        assert!(install(dir.path(), OURS).is_err());
        assert!(!dir.path().join("hooks.json").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("config.toml")).unwrap(),
            "[broken"
        );
    }
}
