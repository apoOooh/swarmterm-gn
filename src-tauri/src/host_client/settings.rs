//! Settings → Terminal → "Run terminals in the terminal host" (SWA-55),
//! persisted as `terminal-host.json` in the app data dir (tmp + rename like
//! `voice/settings.rs`). Missing or unreadable file = off: until phase 4 the
//! host is opt-in, and the in-process PTY stays the default.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostSettings {
    /// New panes spawn in `swarmterm-host.exe`. Running panes keep their
    /// backend; the switch only decides where the next pane starts.
    pub enabled: bool,
}

pub fn load(path: &Path) -> HostSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &HostSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_off_when_missing_or_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terminal-host.json");
        assert!(!load(&path).enabled);
        fs::write(&path, "{not json").unwrap();
        assert!(!load(&path).enabled);
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("terminal-host.json");
        save(&path, &HostSettings { enabled: true }).unwrap();
        assert!(load(&path).enabled);
    }
}
