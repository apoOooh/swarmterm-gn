//! `statusline.json` in the app data dir (SWA-92): which template, scheme,
//! vibrance and animation the Claude status line uses. The `--statusline`
//! process reads it on every render, so a change applies on the next refresh
//! without rewriting `settings.json` (whose entry stays `<exe> --statusline`,
//! so ownership rules in `install.rs` are untouched). Missing or broken file =
//! defaults; a status line must never fail because of its own settings.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::style::Scheme;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    /// The pre-SWA-92 line plus the model: what every existing install had.
    #[default]
    Compact,
    Extended,
    Detailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Animation {
    #[default]
    Off,
    Subtle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatuslineSettings {
    pub claude: Preset,
    pub scheme: Scheme,
    /// 0–100, 50 = as designed.
    pub vibrance: u8,
    pub animation: Animation,
    /// `#rrggbb` of the active app theme, pushed by the renderer for `AppTheme`.
    pub theme_text: Option<String>,
    pub theme_accent: Option<String>,
}

impl Default for StatuslineSettings {
    fn default() -> Self {
        Self {
            claude: Preset::Compact,
            scheme: Scheme::Subtle,
            vibrance: 50,
            animation: Animation::Off,
            theme_text: None,
            theme_accent: None,
        }
    }
}

pub const FILE: &str = "statusline.json";

/// This build's file: roaming app data dir + the identifier `build.rs`
/// compiles in, i.e. what Tauri's `app_data_dir()` gives the app process.
pub fn path() -> Option<PathBuf> {
    Some(
        dirs::data_dir()?
            .join(env!("SWARMTERM_APP_IDENTIFIER"))
            .join(FILE),
    )
}

pub fn load(path: &Path) -> StatuslineSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Atomic write (temp + rename) so a render never reads half a file.
pub fn save(path: &Path, s: &StatuslineSettings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(s).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_means_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(FILE);
        assert_eq!(load(&p), StatuslineSettings::default());
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), StatuslineSettings::default());
    }

    #[test]
    fn partial_file_fills_defaults_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(FILE);
        std::fs::write(&p, r#"{"claude":"detailed","scheme":"high-contrast"}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.claude, Preset::Detailed);
        assert_eq!(s.scheme, Scheme::HighContrast);
        assert_eq!(s.vibrance, 50);
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
    }
}
