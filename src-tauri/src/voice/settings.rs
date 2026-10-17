//! Settings → Voice, persisted in the app data dir (tmp + rename like
//! `mcp/toggle.rs`). Missing or unreadable file = defaults: endpoint on,
//! auto-Enter off — dictation is a draft unless the user opts in. The
//! built-in speech source (SWA-38) is off until the user downloads a model
//! and switches it on; status announcements (SWA-41) are opt-in as well.
//! Older files without the newer keys keep their values.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub allow_auto_enter: bool,
    pub announce_turns: bool,
    pub builtin_enabled: bool,
    /// Catalog id from `speech::model::CATALOG`.
    pub model: String,
    /// Whisper language code, or `auto` to let the model detect it.
    pub language: String,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_auto_enter: false,
            announce_turns: false,
            builtin_enabled: false,
            model: "base".into(),
            language: "auto".into(),
        }
    }
}

pub fn load(path: &Path) -> VoiceSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &VoiceSettings) -> Result<(), String> {
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
    fn defaults_to_on_without_auto_enter_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("voice-settings.json");
        assert_eq!(load(&path), VoiceSettings::default());
        assert!(!VoiceSettings::default().allow_auto_enter);
        assert!(!VoiceSettings::default().announce_turns);
        let s = VoiceSettings {
            enabled: false,
            allow_auto_enter: true,
            announce_turns: true,
            builtin_enabled: true,
            model: "small".into(),
            language: "de".into(),
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        // A file from before SWA-41 keeps its values; the new switch is off.
        fs::write(&path, r#"{"enabled":false,"allowAutoEnter":true}"#).unwrap();
        assert!(!load(&path).announce_turns && !load(&path).enabled);
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        fs::write(&path, "garbage").unwrap();
        assert_eq!(load(&path), VoiceSettings::default());
    }

    #[test]
    fn a_pre_swa38_file_keeps_its_values_and_gets_builtin_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("voice-settings.json");
        fs::write(&path, r#"{"enabled":false,"allowAutoEnter":true}"#).unwrap();
        let s = load(&path);
        assert!(!s.enabled && s.allow_auto_enter);
        assert!(!s.builtin_enabled);
        assert_eq!((s.model.as_str(), s.language.as_str()), ("base", "auto"));
    }
}
