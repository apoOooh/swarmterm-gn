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
    /// SWA-93: `claude_segments` / `codex_items` decide content and order.
    Custom,
}

/// One part of the Claude line in a Custom template (SWA-93).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Segment {
    Mcp,
    Model,
    Effort,
    Cost,
    FiveHour,
    SevenDay,
    Branch,
    Cache,
    Agents,
    TokenBars,
}

impl Segment {
    pub const ALL: [Segment; 10] = [
        Segment::Model,
        Segment::Effort,
        Segment::Cost,
        Segment::FiveHour,
        Segment::SevenDay,
        Segment::Cache,
        Segment::Agents,
        Segment::TokenBars,
        Segment::Branch,
        Segment::Mcp,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot<T> {
    pub id: T,
    pub on: bool,
}

/// Default Custom list: everything, Extended's choice switched on.
pub fn default_segments() -> Vec<Slot<Segment>> {
    use Segment::*;
    Segment::ALL
        .iter()
        .map(|&id| Slot {
            id,
            on: matches!(id, Model | Effort | FiveHour | SevenDay | Branch | Mcp),
        })
        .collect()
}

/// Every segment exactly once: duplicates dropped, missing ones appended off.
/// Unknown ids never get here (`lenient_segments` drops them while parsing).
pub fn normalize_segments(list: &[Slot<Segment>]) -> Vec<Slot<Segment>> {
    let mut out: Vec<Slot<Segment>> = Vec::new();
    for s in list {
        if !out.iter().any(|o| o.id == s.id) {
            out.push(s.clone());
        }
    }
    for id in Segment::ALL {
        if !out.iter().any(|o| o.id == id) {
            out.push(Slot { id, on: false });
        }
    }
    out
}

/// A file from a newer build may name segments this one lacks: skip those
/// entries instead of failing the whole settings file.
fn lenient_segments<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<Slot<Segment>>, D::Error> {
    let raw: Vec<serde_json::Value> = Deserialize::deserialize(d)?;
    let parsed: Vec<Slot<Segment>> = raw
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Ok(normalize_segments(&parsed))
}

/// A template from a newer build (an unknown name) falls back to the default
/// for this field only; the rest of the file stays as saved.
fn lenient_preset<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Preset, D::Error> {
    let raw: serde_json::Value = Deserialize::deserialize(d)?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

/// As `lenient_preset`; for Codex the field default is "not managed".
fn lenient_opt_preset<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Preset>, D::Error> {
    let raw: serde_json::Value = Deserialize::deserialize(d)?;
    Ok(serde_json::from_value(raw).ok().flatten())
}

/// Bounds for the Codex Custom list. Only whitelisted ids are ever written
/// (`codex_statusline::items`); these caps just keep a broken or hostile
/// file or IPC payload from growing the settings without limit.
pub const MAX_CODEX_ITEMS: usize = 32;
pub const MAX_CODEX_ITEM_LEN: usize = 64;

/// Keep well-formed ids (non-empty, short, `[a-z0-9-_]`), first occurrence
/// wins, at most `MAX_CODEX_ITEMS`. Shared by the file parser and the IPC
/// commands that take a list from the renderer.
pub fn normalize_codex_items(list: &[Slot<String>]) -> Vec<Slot<String>> {
    let mut out: Vec<Slot<String>> = Vec::new();
    for s in list {
        let ok = !s.id.is_empty()
            && s.id.len() <= MAX_CODEX_ITEM_LEN
            && s.id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
        if ok && !out.iter().any(|o| o.id == s.id) {
            out.push(s.clone());
            if out.len() == MAX_CODEX_ITEMS {
                break;
            }
        }
    }
    out
}

/// Like `lenient_segments`: malformed entries are skipped, not fatal.
fn lenient_codex_items<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<Slot<String>>, D::Error> {
    let raw: serde_json::Value = Deserialize::deserialize(d)?;
    let parsed: Vec<Slot<String>> = raw
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    Ok(normalize_codex_items(&parsed))
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
    #[serde(deserialize_with = "lenient_preset")]
    pub claude: Preset,
    /// None leaves Codex unmanaged; disabling a managed line writes `[]`.
    #[serde(deserialize_with = "lenient_opt_preset")]
    pub codex: Option<Preset>,
    pub codex_enabled: bool,
    pub codex_use_colors: bool,
    pub scheme: Scheme,
    /// 0–100, 50 = as designed.
    pub vibrance: u8,
    pub animation: Animation,
    /// `#rrggbb` of the active app theme, pushed by the renderer for `AppTheme`.
    pub theme_text: Option<String>,
    pub theme_accent: Option<String>,
    /// Custom Claude line, in order (SWA-93).
    #[serde(deserialize_with = "lenient_segments")]
    pub claude_segments: Vec<Slot<Segment>>,
    /// Custom Codex `[tui] status_line` items, in order. Only ids from the
    /// tested whitelist are ever written (`codex_statusline::items`).
    #[serde(deserialize_with = "lenient_codex_items")]
    pub codex_items: Vec<Slot<String>>,
}

impl Default for StatuslineSettings {
    fn default() -> Self {
        Self {
            claude: Preset::Compact,
            codex: None,
            codex_enabled: true,
            codex_use_colors: false,
            scheme: Scheme::Subtle,
            vibrance: 50,
            animation: Animation::Off,
            theme_text: None,
            theme_accent: None,
            claude_segments: default_segments(),
            codex_items: Vec::new(),
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

/// `incoming` with the Codex fields of `saved`, and the Claude list
/// normalised like the file parser does (an IPC payload is input too).
pub fn with_codex_of(
    incoming: StatuslineSettings,
    saved: &StatuslineSettings,
) -> StatuslineSettings {
    StatuslineSettings {
        codex: saved.codex,
        codex_enabled: saved.codex_enabled,
        codex_use_colors: saved.codex_use_colors,
        codex_items: saved.codex_items.clone(),
        claude_segments: normalize_segments(&incoming.claude_segments),
        ..incoming
    }
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
        assert_eq!(s.codex, None);
        assert!(s.codex_enabled);
        assert!(!s.codex_use_colors);
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
    }

    #[test]
    fn codex_preferences_round_trip_with_camel_case_keys() {
        let settings: StatuslineSettings = serde_json::from_str(
            r#"{"codex":"extended","codexUseColors":true,"codexEnabled":false}"#,
        )
        .unwrap();
        assert_eq!(settings.codex, Some(Preset::Extended));
        assert!(settings.codex_use_colors);
        assert!(!settings.codex_enabled);
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["codexUseColors"], true);
        assert_eq!(json["codexEnabled"], false);
    }

    #[test]
    fn legacy_file_keeps_preset() {
        let s: StatuslineSettings = serde_json::from_str(r#"{"claude":"extended"}"#).unwrap();
        assert_eq!(s.claude, Preset::Extended);
        assert_eq!(s.claude_segments, default_segments());
        assert!(s.codex_items.is_empty());
    }

    #[test]
    fn custom_segments_keep_order_and_drop_unknown_or_duplicate_ids() {
        let s: StatuslineSettings = serde_json::from_str(
            r#"{"claude":"custom","claudeSegments":[
                {"id":"mcp","on":true},{"id":"future-thing","on":true},
                {"id":"branch","on":true},{"id":"mcp","on":false}]}"#,
        )
        .unwrap();
        assert_eq!(s.claude, Preset::Custom);
        let ids: Vec<_> = s.claude_segments.iter().map(|x| x.id).collect();
        assert_eq!(ids[..2], [Segment::Mcp, Segment::Branch]);
        assert_eq!(ids.len(), Segment::ALL.len());
        assert!(s.claude_segments[0].on);
        assert!(s.claude_segments[2..].iter().all(|x| !x.on));
    }

    #[test]
    fn claude_save_keeps_the_saved_codex_fields() {
        let saved = StatuslineSettings {
            codex: Some(Preset::Custom),
            codex_enabled: false,
            codex_use_colors: true,
            codex_items: vec![Slot {
                id: "git-branch".into(),
                on: true,
            }],
            ..Default::default()
        };
        let stale = StatuslineSettings {
            claude: Preset::Detailed,
            codex: Some(Preset::Compact),
            claude_segments: vec![Slot {
                id: Segment::Mcp,
                on: true,
            }],
            ..Default::default()
        };
        let m = with_codex_of(stale, &saved);
        assert_eq!(m.claude, Preset::Detailed);
        assert_eq!(m.codex, Some(Preset::Custom));
        assert!(!m.codex_enabled);
        assert!(m.codex_use_colors);
        assert_eq!(m.codex_items, saved.codex_items);
        assert_eq!(m.claude_segments.len(), Segment::ALL.len());
        assert_eq!(
            m.claude_segments[0],
            Slot {
                id: Segment::Mcp,
                on: true
            }
        );
    }

    /// A newer build's template name must not cost the rest of the file.
    #[test]
    fn unknown_preset_falls_back_for_that_field_only() {
        let s: StatuslineSettings = serde_json::from_str(
            r#"{"claude":"future","codex":"future","scheme":"high-contrast","vibrance":80}"#,
        )
        .unwrap();
        assert_eq!(s.claude, Preset::Compact);
        assert_eq!(s.codex, None);
        assert_eq!(s.scheme, Scheme::HighContrast);
        assert_eq!(s.vibrance, 80);
        let s: StatuslineSettings = serde_json::from_str(r#"{"codex":null}"#).unwrap();
        assert_eq!(s.codex, None);
    }

    #[test]
    fn codex_items_skip_malformed_entries_and_are_capped() {
        let long = "a".repeat(MAX_CODEX_ITEM_LEN + 1);
        let json = format!(
            r#"{{"codexItems":[{{"id":"git-branch","on":true}},{{"id":7,"on":true}},"x",
                {{"id":"rm -rf","on":true}},{{"id":"{long}","on":true}},{{"id":"","on":true}},
                {{"id":"git-branch","on":false}},{{"id":"weekly-limit","on":false}}],
               "scheme":"high-contrast"}}"#
        );
        let s: StatuslineSettings = serde_json::from_str(&json).unwrap();
        let ids: Vec<_> = s.codex_items.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["git-branch", "weekly-limit"]);
        assert!(s.codex_items[0].on);
        assert_eq!(s.scheme, Scheme::HighContrast);
        // Not an array at all: empty list, rest kept.
        let s: StatuslineSettings =
            serde_json::from_str(r#"{"codexItems":"x","vibrance":10}"#).unwrap();
        assert!(s.codex_items.is_empty());
        assert_eq!(s.vibrance, 10);
        // Count cap.
        let many: Vec<Slot<String>> = (0..100)
            .map(|i| Slot {
                id: format!("i{i}"),
                on: true,
            })
            .collect();
        assert_eq!(normalize_codex_items(&many).len(), MAX_CODEX_ITEMS);
    }
}
