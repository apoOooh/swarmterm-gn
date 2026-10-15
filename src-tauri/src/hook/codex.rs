//! Codex session capture. User hooks remain additive and require Codex's
//! normal `/hooks` trust flow; never write trust records or bypass trust.
use super::install::{merge_events, HooksWrite};
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

const EVENTS: [&str; 2] = ["SessionStart", "UserPromptSubmit"];

/// Whether the installed Codex supports hook isolation. A definite answer is
/// cached for the process; a probe that timed out (cold disk, AV scan) is not,
/// so the next caller retries. Warmed off-thread at startup (`warm`), so pane
/// spawns normally hit the cache. Concurrent first callers wait on the lock.
pub fn supported() -> bool {
    static SUPPORTED: Mutex<Option<bool>> = Mutex::new(None);
    let mut cached = SUPPORTED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(known) = *cached {
        return known;
    }
    match probe() {
        Some(known) => {
            *cached = Some(known);
            known
        }
        None => false,
    }
}

/// Run the first probe on a blocking worker so no IPC/async thread pays it.
pub fn warm() {
    tauri::async_runtime::spawn_blocking(|| {
        supported();
    });
}

/// `None` = undecided (timed out); retried on the next call.
fn probe() -> Option<bool> {
    let Some(binary) = crate::agents::find_agent_binary("codex") else {
        return Some(false);
    };
    let Ok(mut output) = tempfile::tempfile() else {
        return Some(false);
    };
    let Ok(stdout) = output.try_clone() else {
        return Some(false);
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
        return Some(false);
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return Some(false),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    use std::io::{Seek, SeekFrom};
    if output.seek(SeekFrom::Start(0)).is_err() {
        return Some(false);
    }
    let mut help = String::new();
    if output.take(64 * 1024).read_to_string(&mut help).is_err() {
        return Some(false);
    }
    Some(help.contains("--no-daemon") && help.contains("--dangerously-bypass-hook-trust"))
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

/// Pin the pane's Codex to THIS app's MCP server via `-c` overrides. The
/// shared `config.toml` holds one URL, and a second Swarmterm (the dev build
/// next to the installed one) rewrites it on boot with its own port — every
/// pane of the other app then talks to a server that does not know its
/// bearer and silently never joins the War Room. A per-process override
/// cannot be clobbered. The URL is our own loopback string; anything outside
/// a plain URL charset is refused rather than quoted into a shell line.
pub fn with_mcp_url(command: &str, agent: Option<&str>, url: Option<&str>) -> String {
    let safe = |u: &str| {
        u.starts_with("http://127.0.0.1:")
            && u.chars()
                .all(|c| c.is_ascii_alphanumeric() || ":/.".contains(c))
    };
    match (agent, url) {
        (Some("codex"), Some(url)) if safe(url) => match command.strip_prefix("codex") {
            Some(tail) if tail.is_empty() || tail.starts_with(' ') => format!(
                "codex -c mcp_servers.swarmterm.url={url} \
                 -c mcp_servers.swarmterm.bearer_token_env_var=SWARMTERM_SESSION{tail}"
            ),
            _ => command.into(),
        },
        _ => command.into(),
    }
}

fn is_ours(command: &str) -> bool {
    let c = command.trim().to_ascii_lowercase();
    c.contains("swarmterm") && c.trim_end_matches('"').ends_with("--codex-session-hook")
}

pub fn format_command(exe: &str, windows: bool) -> String {
    if windows {
        // Codex on Windows already runs hook commands through PowerShell, so
        // the call operator is enough; a nested powershell.exe doubled the
        // startup cost and pushed cold starts past the 5 s hook timeout.
        let path = exe.replace('\\', "/").replace('\'', "''");
        format!("& '{path}' --codex-session-hook")
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
            return remove_ours_from_json(&json_path);
        };
        (config_path.clone(), next)
    } else {
        let existing = match fs::read_to_string(&json_path) {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let HooksWrite::Write(next) = merge_json(existing.as_deref(), command)? else {
            return Ok(());
        };
        (json_path.clone(), next)
    };
    // Codex reads both representations, so an entry left behind in the other
    // one (written before `config.toml` gained a [hooks] table) fires twice.
    if path == config_path {
        remove_ours_from_json(&json_path)?;
    }
    fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("swarmterm-hooks.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn has_ours(home: &Path) -> bool {
    ["config.toml", "hooks.json"].iter().any(|f| {
        fs::read_to_string(home.join(f)).is_ok_and(|s| {
            s.lines().any(|l| {
                let l = l.to_ascii_lowercase();
                l.contains("swarmterm") && l.contains("--codex-session-hook")
            })
        })
    })
}

fn remove_ours_from_json(json_path: &Path) -> Result<(), String> {
    let existing = match fs::read_to_string(json_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let HooksWrite::Write(next) = merge_events(Some(&existing), None, &EVENTS, is_ours)? else {
        return Ok(());
    };
    let tmp = json_path.with_extension("swarmterm-hooks.tmp");
    fs::write(&tmp, next).map_err(|e| e.to_string())?;
    fs::rename(&tmp, json_path).map_err(|e| {
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
    // A dev build next to the installed app would swap the exe path on every
    // boot, and Codex re-asks for hook trust each time the command changes.
    // The hook only reads env, so the installed app's entry serves dev panes.
    if cfg!(debug_assertions) && has_ours(&home) {
        return;
    }
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
    fn pins_codex_to_this_apps_mcp_url() {
        let url = Some("http://127.0.0.1:56330/mcp");
        assert_eq!(
            with_mcp_url("codex --no-daemon resume abc", Some("codex"), url),
            "codex -c mcp_servers.swarmterm.url=http://127.0.0.1:56330/mcp \
             -c mcp_servers.swarmterm.bearer_token_env_var=SWARMTERM_SESSION --no-daemon resume abc"
        );
        assert_eq!(with_mcp_url("codex", Some("codex"), None), "codex");
        assert_eq!(with_mcp_url("claude", Some("claude-code"), url), "claude");
        assert_eq!(
            with_mcp_url("codex-helper", Some("codex"), url),
            "codex-helper"
        );
        // Never splice anything shell-active into the typed line.
        assert_eq!(
            with_mcp_url("codex", Some("codex"), Some("http://127.0.0.1:1/mcp; rm x")),
            "codex"
        );
        assert_eq!(
            with_mcp_url("codex", Some("codex"), Some("http://evil.example/mcp")),
            "codex"
        );
    }
    #[test]
    fn windows_hook_runs_in_codexs_own_powershell() {
        let c = format_command(r"C:\Users\x\AppData\Local\Swarmterm GN\swarmterm.exe", true);
        assert_eq!(
            c,
            "& 'C:/Users/x/AppData/Local/Swarmterm GN/swarmterm.exe' --codex-session-hook"
        );
        assert!(is_ours(&c));
    }
    #[test]
    fn inline_install_drops_a_stale_json_copy_of_ours() {
        let dir = tempfile::tempdir().unwrap();
        let stale = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"notify"}]},{"hooks":[{"type":"command","command":"& 'D:/dev/swarmterm.exe' --codex-session-hook","timeout":5}]}]}}"#;
        fs::write(dir.path().join("hooks.json"), stale).unwrap();
        fs::write(dir.path().join("config.toml"), "[hooks]\n").unwrap();
        install(dir.path(), OURS).unwrap();
        let json = fs::read_to_string(dir.path().join("hooks.json")).unwrap();
        assert!(json.contains("notify"));
        assert!(!json.contains("codex-session-hook"));
        assert!(fs::read_to_string(dir.path().join("config.toml"))
            .unwrap()
            .contains("--codex-session-hook"));
    }
    #[test]
    fn current_toml_still_drops_a_stale_json_copy() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("config.toml"),
            "[hooks]
",
        )
        .unwrap();
        install(dir.path(), OURS).unwrap();
        let stale = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"& 'D:/dev/swarmterm.exe' --codex-session-hook","timeout":5}]}]}}"#;
        fs::write(dir.path().join("hooks.json"), stale).unwrap();
        install(dir.path(), OURS).unwrap();
        let json = fs::read_to_string(dir.path().join("hooks.json")).unwrap();
        assert!(!json.contains("codex-session-hook"));
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
