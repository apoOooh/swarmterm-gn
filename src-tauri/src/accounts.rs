//! Account metadata only: credentials stay in the CLIs' config directories.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};

static STORE_LOCK: Mutex<()> = Mutex::new(());
pub static CONFIG_WRITE: Mutex<()> = Mutex::new(());
pub static STATUSLINE_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn credential_overrides(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        "claude-code" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        _ => &[],
    }
}

pub fn apply_environment(cmd: &mut portable_pty::CommandBuilder, account: &AgentAccount) {
    // The default account never calls this helper, preserving its inherited env.
    for key in credential_overrides(&account.agent_id) {
        cmd.env_remove(key);
    }
    cmd.env(
        if account.agent_id == "claude-code" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "CODEX_HOME"
        },
        &account.config_dir,
    );
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAccount {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub config_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountInput {
    pub id: Option<String>,
    pub agent_id: String,
    pub name: String,
    pub config_dir: Option<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("agent-accounts.json"))
        .map_err(|e| e.to_string())
}

pub fn read(path: &Path) -> Result<Vec<AgentAccount>, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Cannot read account profiles: {e}")),
    };
    if raw.len() > 1024 * 1024 {
        return Err("Account profile file is too large".into());
    }
    let accounts: Vec<AgentAccount> =
        serde_json::from_slice(&raw).map_err(|_| "Invalid account profile file")?;
    if accounts.len() > 128 {
        return Err("Too many account profiles".into());
    }
    let mut ids = std::collections::HashSet::new();
    for account in &accounts {
        validate(account)?;
        if !ids.insert(&account.id) {
            return Err("Duplicate account profile id".into());
        }
    }
    Ok(accounts)
}

fn validate(account: &AgentAccount) -> Result<(), String> {
    if uuid::Uuid::parse_str(&account.id).is_err()
        || !matches!(account.agent_id.as_str(), "claude-code" | "codex")
        || account.name.trim().is_empty()
        || account.name.len() > 120
        || account.name.chars().any(char::is_control)
        || account.config_dir.len() > 32768
        || account.config_dir.contains('\0')
        || !Path::new(&account.config_dir).is_absolute()
    {
        return Err("Invalid account profile".into());
    }
    Ok(())
}

fn write(path: &Path, accounts: &[AgentAccount]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid account store path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?;
    if content.len() > 1024 * 1024 {
        return Err("Account profile file is too large".into());
    }
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn list(app: &AppHandle) -> Result<Vec<AgentAccount>, String> {
    let _lock = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    read(&store_path(app)?)
}

#[cfg(test)]
pub fn save_at(path: &Path, input: AccountInput) -> Result<AgentAccount, String> {
    save_at_with(path, input, |_| Ok(()))
}

fn save_at_with(
    path: &Path,
    input: AccountInput,
    prepare: impl FnOnce(&AgentAccount) -> Result<(), String>,
) -> Result<AgentAccount, String> {
    let mut accounts = read(path)?;
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = accounts.iter().position(|a| a.id == id);
    if existing.is_none() && accounts.len() >= 128 {
        return Err("Too many account profiles".into());
    }
    let config_dir = input
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| path.parent().unwrap().join("accounts").join(&id));
    let account = AgentAccount {
        id,
        agent_id: input.agent_id,
        name: input.name.trim().into(),
        config_dir: config_dir.to_string_lossy().into_owned(),
    };
    validate(&account)?;
    if let Some(index) = existing {
        if accounts[index].agent_id != account.agent_id
            || accounts[index].config_dir != account.config_dir
        {
            return Err(
                "An existing profile's agent and config directory cannot be changed".into(),
            );
        }
    }
    if accounts
        .iter()
        .any(|a| a.id != account.id && same_dir(&a.config_dir, &account.config_dir))
    {
        return Err("This config directory already belongs to another profile".into());
    }
    fs::create_dir_all(&config_dir).map_err(|e| format!("Cannot create account directory: {e}"))?;
    // Enrollment can fail on a user's malformed or unwritable config. The UI
    // must not report failure after silently committing a new/renamed profile.
    // CLI config changes remain additive; credentials/directories are never
    // rolled back or deleted if a later metadata write fails.
    prepare(&account)?;
    match existing {
        Some(index) => accounts[index] = account.clone(),
        None => accounts.push(account.clone()),
    }
    write(path, &accounts)?;
    Ok(account)
}

fn same_dir(a: &str, b: &str) -> bool {
    if let (Ok(a), Ok(b)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return a == b;
    }
    let normalized = |value: &str| {
        let value = value.replace('\\', "/").trim_end_matches('/').to_owned();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    normalized(a) == normalized(b)
}

pub fn save(
    app: &AppHandle,
    input: AccountInput,
    url: Option<&str>,
) -> Result<AgentAccount, String> {
    let _lock = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    save_at_with(&store_path(app)?, input, |account| enroll(account, url))
}

pub fn delete_at(path: &Path, id: &str) -> Result<(), String> {
    let mut accounts = read(path)?;
    accounts.retain(|a| a.id != id);
    write(path, &accounts)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    delete_at(&store_path(app)?, id)
}

pub fn resolve(app: &AppHandle, id: &str, agent_id: Option<&str>) -> Result<AgentAccount, String> {
    let account = list(app)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or("Account profile no longer exists")?;
    if agent_id != Some(account.agent_id.as_str()) {
        return Err("Account profile does not match this agent".into());
    }
    if !Path::new(&account.config_dir).is_dir() {
        return Err("Account config directory is unavailable".into());
    }
    Ok(account)
}

pub fn enroll(account: &AgentAccount, url: Option<&str>) -> Result<(), String> {
    // Concurrent pane starts may enroll the same profile. Serialize the entire
    // read/merge/rename sequence so a second writer cannot consume our temp file.
    let _lock = CONFIG_WRITE.lock().map_err(|e| e.to_string())?;
    let dir = Path::new(&account.config_dir);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    let mcp_on = crate::mcp::toggle::is_enabled(&account.agent_id, Some(&account.id));
    match account.agent_id.as_str() {
        "claude-code" => {
            if mcp_on {
                crate::mcp::config::write_mcp_config_to_file(&dir.join(".claude.json"))?;
            }
            crate::hook::install::write_hooks_to_file(
                &dir.join("settings.json"),
                Some(&crate::hook::install::format_command(&exe, cfg!(windows))),
            )?;
            let command = STATUSLINE_ENABLED
                .load(Ordering::Relaxed)
                .then(|| crate::statusline::install::format_command(&exe, cfg!(windows)));
            // A foreign status line remains owned by the user.
            if let Err(e) = crate::statusline::install::write_settings_to_file(
                &dir.join("settings.json"),
                command.as_deref(),
            ) {
                if !e.contains("custom statusLine") {
                    return Err(e);
                }
            }
        }
        "codex" => {
            // Dev builds leave the Codex URL to the installed app even in a
            // shared configDir; their panes are pinned per process instead.
            if let Some(url) = url.filter(|_| mcp_on && !cfg!(debug_assertions)) {
                crate::mcp::config::write_codex_config_to_file(&dir.join("config.toml"), url)?;
            }
            // Same rule as the default profile: a dev build must not swap the
            // exe path under the installed app's hook and trigger re-trust.
            if crate::hook::codex::supported()
                && !(cfg!(debug_assertions) && crate::hook::codex::has_ours(dir))
            {
                crate::hook::codex::install(
                    dir,
                    &crate::hook::codex::format_command(&exe, cfg!(windows)),
                )?;
            }
        }
        _ => return Err("Unsupported account agent".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> AccountInput {
        AccountInput {
            id: None,
            agent_id: "codex".into(),
            name: " Work ".into(),
            config_dir: None,
        }
    }
    #[test]
    fn persists_metadata_and_delete_preserves_cli_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let account = save_at(&path, input()).unwrap();
        fs::write(
            Path::new(&account.config_dir).join("auth.json"),
            "private cli credentials",
        )
        .unwrap();
        assert_eq!(read(&path).unwrap()[0].name, "Work");
        assert!(!fs::read_to_string(&path).unwrap().contains("credentials"));
        delete_at(&path, &account.id).unwrap();
        assert!(read(&path).unwrap().is_empty());
        assert!(Path::new(&account.config_dir).join("auth.json").is_file());
    }
    #[test]
    fn rejects_invalid_and_duplicate_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let first = save_at(&path, input()).unwrap();
        let mut duplicate = input();
        duplicate.config_dir = Some(first.config_dir);
        assert!(save_at(&path, duplicate).is_err());
        let mut invalid = input();
        invalid.agent_id = "shell".into();
        assert!(save_at(&path, invalid).is_err());
        let mut invalid = input();
        invalid.config_dir = Some("relative".into());
        assert!(save_at(&path, invalid).is_err());
        assert_eq!(read(&path).unwrap().len(), 1);
    }

    #[test]
    fn failed_enrollment_does_not_commit_metadata_or_rename_existing_profile() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        assert!(save_at_with(&path, input(), |_| Err("invalid CLI config".into())).is_err());
        assert!(!path.exists());
        let account = save_at(&path, input()).unwrap();
        let original = fs::read(&path).unwrap();
        let mut change = input();
        change.id = Some(account.id.clone());
        change.name = "New name".into();
        assert!(save_at_with(&path, change, |_| Err("invalid CLI config".into())).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let mut change = input();
        change.id = Some(account.id);
        change.name = "Renamed".into();
        save_at(&path, change).unwrap();
        assert_eq!(read(&path).unwrap()[0].name, "Renamed");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn named_profile_environment_isolates_only_its_agent_credentials() {
        let profile = AgentAccount {
            id: uuid::Uuid::new_v4().to_string(),
            agent_id: "codex".into(),
            name: "Test".into(),
            config_dir: "profile-dir".into(),
        };
        let mut cmd = portable_pty::CommandBuilder::new("test");
        cmd.env_clear();
        cmd.env("OPENAI_API_KEY", "parent-private");
        cmd.env("ANTHROPIC_API_KEY", "other-agent");
        assert_eq!(
            cmd.get_env("OPENAI_API_KEY"),
            Some(std::ffi::OsStr::new("parent-private"))
        );
        apply_environment(&mut cmd, &profile);
        assert!(cmd.get_env("OPENAI_API_KEY").is_none());
        assert_eq!(
            cmd.get_env("ANTHROPIC_API_KEY"),
            Some(std::ffi::OsStr::new("other-agent"))
        );
        assert_eq!(
            cmd.get_env("CODEX_HOME"),
            Some(std::ffi::OsStr::new("profile-dir"))
        );
    }

    #[test]
    fn corrupt_or_credential_bearing_metadata_is_not_treated_as_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let profile = save_at(&path, input()).unwrap();
        let mut unsupported = serde_json::to_value(vec![profile]).unwrap();
        unsupported[0]["token"] = serde_json::json!("CLI-owned credential");
        for contents in [
            "malformed metadata".to_owned(),
            serde_json::to_string(&unsupported).unwrap(),
        ] {
            fs::write(&path, &contents).unwrap();
            assert!(read(&path).is_err());
            assert!(save_at(&path, input()).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
    }
}
