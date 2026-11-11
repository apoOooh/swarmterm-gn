//! Own only the two Codex status-line fields, recording each original value.

use crate::statusline::settings::{self, Preset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const FIELDS: [&str; 2] = ["status_line", "status_line_use_colors"];
const OWNERSHIP_FILE: &str = "codex-statusline-ownership.json";
const COMPACT: &[&str] = &["model-with-reasoning", "context-remaining"];
const EXTENDED: &[&str] = &[
    "model-with-reasoning",
    "context-remaining",
    "git-branch",
    "five-hour-limit",
    "weekly-limit",
];
const DETAILED: &[&str] = &[
    "model-with-reasoning",
    "context-remaining",
    "git-branch",
    "five-hour-limit",
    "weekly-limit",
    "used-tokens",
    "total-input-tokens",
    "total-output-tokens",
    "context-window-size",
];

/// Only 0.167 has been tested. A newer version is not evidence of support.
pub fn items(
    version: Option<&str>,
    preset: Preset,
    enabled: bool,
) -> (&'static [&'static str], bool) {
    let tested = version.is_some_and(|v| {
        let parts: Vec<_> = v.split('.').collect();
        parts.len() == 3 && parts[0] == "0" && parts[1] == "167" && parts[2].parse::<u32>().is_ok()
    });
    let ids = if !enabled {
        &[][..]
    } else if !tested {
        COMPACT
    } else {
        match preset {
            Preset::Compact => COMPACT,
            Preset::Extended => EXTENDED,
            Preset::Detailed => DETAILED,
        }
    };
    (ids, tested)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Ownership {
    owner_exe: String,
    fields: BTreeMap<String, OwnedField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OwnedField {
    /// TOML spelling retains the original value and its comments.
    previous: Option<String>,
    last: Value,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    homes: BTreeMap<String, Ownership>,
}

struct Merge {
    text: String,
    custom_fields: Vec<String>,
}

fn document(source: &str) -> Result<DocumentMut, String> {
    let doc = source
        .parse::<DocumentMut>()
        .map_err(|e| format!("Invalid Codex config: {e}"))?;
    if let Some(tui) = doc.get("tui") {
        if tui.as_table_like().is_none() {
            return Err("Codex tui must be a table".into());
        }
    }
    Ok(doc)
}

fn field(doc: &DocumentMut, name: &str) -> Option<Item> {
    doc.get("tui")?.as_table_like()?.get(name).cloned()
}

/// Semantic comparison avoids giving up ownership just because Codex reformats
/// quotes or spaces. Unknown original types can still be restored verbatim.
fn semantic(item: &Item) -> Value {
    if let Some(v) = item.as_bool() {
        return Value::Bool(v);
    }
    if let Some(v) = item.as_str() {
        return Value::String(v.into());
    }
    if let Some(v) = item.as_array() {
        return Value::Array(
            v.iter()
                .map(|v| semantic(&Item::Value(v.clone())))
                .collect(),
        );
    }
    Value::String(format!("toml:{}", item))
}

#[cfg(test)]
fn field_value(source: &str, name: &str) -> Result<Option<Value>, String> {
    Ok(field(&document(source)?, name).as_ref().map(semantic))
}

fn merge(
    source: &str,
    owned: &mut Ownership,
    desired: Option<(&[&str], bool)>,
) -> Result<Merge, String> {
    let mut doc = document(source)?;
    let mut custom_fields = Vec::new();
    for name in FIELDS {
        let current = field(&doc, name);
        if current
            .as_ref()
            .is_some_and(|item| item.as_value().is_none())
        {
            return Err(format!("Codex {name} must be a value"));
        }
        let ours = owned.fields.get(name);
        let matches = ours.is_none_or(|o| current.as_ref().map(semantic).as_ref() == Some(&o.last));
        if !matches {
            custom_fields.push(name.to_owned());
            continue;
        }
        let next = if let Some((ids, colors)) = desired {
            let next = if name == "status_line" {
                let mut array = Array::new();
                for id in ids {
                    array.push(*id);
                }
                Item::Value(array.into())
            } else {
                value(colors)
            };
            let previous = ours
                .map(|o| o.previous.clone())
                .unwrap_or_else(|| current.as_ref().map(ToString::to_string));
            owned.fields.insert(
                name.into(),
                OwnedField {
                    previous,
                    last: semantic(&next),
                },
            );
            Some(next)
        } else if let Some(ours) = ours {
            ours.previous
                .as_ref()
                .map(|v| {
                    let saved = format!("original = {v}")
                        .parse::<DocumentMut>()
                        .map_err(|e| e.to_string())?;
                    saved
                        .get("original")
                        .cloned()
                        .ok_or_else(|| "Invalid saved Codex value".to_owned())
                })
                .transpose()?
        } else {
            continue;
        };
        if current.as_ref().map(semantic) == next.as_ref().map(semantic) {
            continue;
        }
        if let Some(mut next) = next {
            if desired.is_some() {
                if let (Some(old), Some(new)) = (
                    current.as_ref().and_then(Item::as_value),
                    next.as_value_mut(),
                ) {
                    *new.decor_mut() = old.decor().clone();
                }
            }
            if doc.get("tui").is_none() {
                doc.insert("tui", Item::Table(Table::new()));
            }
            doc.get_mut("tui")
                .and_then(Item::as_table_like_mut)
                .ok_or("Codex tui must be a table")?
                .insert(name, next);
        } else if let Some(tui) = doc.get_mut("tui").and_then(Item::as_table_like_mut) {
            tui.remove(name);
        }
    }
    if desired.is_none() {
        owned.fields.clear();
    }
    Ok(Merge {
        text: doc.to_string(),
        custom_fields,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub codex_home: String,
    pub state: &'static str,
    pub custom_fields: Vec<String>,
    pub version: Option<String>,
    pub notice: Option<String>,
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn load_store(path: &Path) -> Result<Store, String> {
    read_optional(path)?
        .map(|s| serde_json::from_str(&s).map_err(|e| format!("Invalid Codex ownership file: {e}")))
        .unwrap_or_else(|| Ok(Store::default()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Missing config parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    tmp.write_all(bytes).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn save_store(path: &Path, store: &Store) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?,
    )
}

fn canonical_home(home: &Path, create: bool) -> Result<String, String> {
    if create {
        fs::create_dir_all(home).map_err(|e| e.to_string())?;
    }
    let absolute = if home.exists() {
        fs::canonicalize(home).map_err(|e| e.to_string())?
    } else {
        // Status must not create a profile. Canonicalize its nearest existing
        // ancestor so a later first write uses the same ownership key.
        let mut ancestor = home.to_path_buf();
        let mut suffix = Vec::new();
        while !ancestor.exists() {
            suffix.push(ancestor.file_name().ok_or("Invalid Codex home")?.to_owned());
            if !ancestor.pop() {
                return Err("Invalid Codex home".into());
            }
        }
        let mut absolute = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
        for component in suffix.into_iter().rev() {
            absolute.push(component);
        }
        absolute
    };
    let key = absolute.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    })
}

fn deferred(debug: bool, owner: Option<&Ownership>, source: &str, home: &Path, exe: &str) -> bool {
    if !debug {
        return false;
    }
    if owner.is_some_and(|o| !crate::dev_defer::same_exe(&o.owner_exe, exe)) {
        return true;
    }
    let command = super::codex::format_command(exe, cfg!(windows));
    if super::codex::has_ours(home) && !super::codex::has_command(home, &command) {
        return true;
    }
    // Status-line values contain no executable. With no record in this app's
    // data dir a debug instance cannot prove an existing entry is its own.
    owner.is_none() && document(source).is_ok_and(|d| FIELDS.iter().any(|f| field(&d, f).is_some()))
}

/// The caller holds CONFIG_WRITE, shared with hook/MCP writers of config.toml.
fn update_home(
    store_path: &Path,
    home: &Path,
    desired: Option<(&[&str], bool)>,
    write: bool,
    version: Option<String>,
    debug: bool,
    exe: &str,
) -> Result<Status, String> {
    let key = canonical_home(home, write && desired.is_some())?;
    let mut store = load_store(store_path)?;
    let path = home.join("config.toml");
    let source = read_optional(&path)?.unwrap_or_default();
    let owner = store.homes.get(&key);
    let (_, known) = items(version.as_deref(), Preset::Compact, true);
    let mut status = Status {
        codex_home: key.clone(),
        state: "unmanaged",
        custom_fields: Vec::new(),
        version,
        notice: (!known).then(|| "Untested Codex version; using Compact items".into()),
    };
    if deferred(debug, owner, &source, home, exe) {
        status.state = "deferred";
        status.notice =
            Some("Dev build leaves the installed app's Codex configuration unchanged".into());
        return Ok(status);
    }
    let mut owned = owner.cloned().unwrap_or_default();
    if !write {
        let doc = document(&source)?;
        status.custom_fields = FIELDS
            .iter()
            .filter(|f| {
                let current = field(&doc, f);
                owned.fields.get(**f).map_or(current.is_some(), |o| {
                    current.as_ref().map(semantic).as_ref() != Some(&o.last)
                })
            })
            .map(|f| (*f).to_owned())
            .collect();
        status.state = if !status.custom_fields.is_empty() {
            "custom"
        } else if owned.fields.is_empty() {
            "unmanaged"
        } else {
            "managed"
        };
        return Ok(status);
    }
    let merged = merge(&source, &mut owned, desired)?;
    status.custom_fields = merged.custom_fields;
    status.state = if !status.custom_fields.is_empty() {
        "custom"
    } else if desired.is_some() {
        "managed"
    } else {
        "unmanaged"
    };
    owned.owner_exe = exe.into();
    if desired.is_some() {
        store.homes.insert(key.clone(), owned);
        // Persist recovery data BEFORE touching the user's file. A crash can
        // leave a conservative ownership conflict, never an unbacked write.
        save_store(store_path, &store)?;
    }
    if source != merged.text {
        if read_optional(&path)?.unwrap_or_default() != source {
            return Err("Codex config changed during update; retry".into());
        }
        atomic_write(&path, merged.text.as_bytes())?;
    }
    if desired.is_none() {
        store.homes.remove(&key);
        save_store(store_path, &store)?;
    }
    Ok(status)
}

#[derive(Clone)]
struct VersionCache {
    binary: PathBuf,
    modified: Option<std::time::SystemTime>,
    checked: std::time::Instant,
    version: Option<String>,
}

pub(crate) fn version() -> Option<String> {
    // A bounded probe of the binary, never an interactive `/statusline` call.
    let binary = crate::agents::find_agent_binary("codex")?;
    let modified = fs::metadata(&binary).ok().and_then(|m| m.modified().ok());
    static CACHE: std::sync::Mutex<Option<VersionCache>> = std::sync::Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache.as_ref() {
        if cached.binary == binary
            && cached.modified == modified
            && (cached.version.is_some() || cached.checked.elapsed() < Duration::from_secs(60))
        {
            return cached.version.clone();
        }
    }
    let mut command = crate::terminal_env::command(&binary);
    command.arg("--version");
    let version =
        super::claude_version::run_bounded(command, Duration::from_secs(3)).and_then(|output| {
            output
                .split_whitespace()
                .find(|word| word.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(str::to_owned)
        });
    *cache = Some(VersionCache {
        binary,
        modified,
        checked: std::time::Instant::now(),
        version: version.clone(),
    });
    version
}

pub(crate) fn prepare_version() {
    if settings::path().is_some_and(|p| settings::load(&p).codex.is_some()) {
        let _ = version();
    }
}

fn data_file() -> Result<PathBuf, String> {
    settings::path()
        .and_then(|p| p.parent().map(|d| d.join(OWNERSHIP_FILE)))
        .ok_or_else(|| "Cannot resolve app data directory".into())
}

fn default_home(app: &AppHandle) -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME")
        .filter(|s| !s.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|p| p.join(".codex")))
        .ok_or_else(|| "Cannot resolve Codex home".into())
}

pub fn enroll_default(app: &AppHandle) -> Result<(), String> {
    enroll(&default_home(app)?)
}

/// Apply to all current profiles, plus recorded homes on release (including
/// profiles removed from the account list since they were first managed).
pub fn update(
    app: &AppHandle,
    desired: Option<(Preset, bool, bool)>,
    write: bool,
) -> Result<Vec<Status>, String> {
    let accounts = crate::accounts::list(app)?;
    let mut homes = vec![default_home(app)?];
    homes.extend(
        accounts
            .into_iter()
            .filter(|a| a.agent_id == "codex")
            .map(|a| PathBuf::from(a.config_dir)),
    );
    let version = version();
    let store_path = data_file()?;
    let _guard = crate::accounts::CONFIG_WRITE
        .lock()
        .map_err(|e| e.to_string())?;
    if write && desired.is_none() {
        homes.extend(load_store(&store_path)?.homes.keys().map(PathBuf::from));
    }
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let mut seen = std::collections::BTreeSet::new();
    let mut statuses = Vec::new();
    let mut error = None;
    for home in homes {
        let result = (|| {
            let key = canonical_home(&home, false)?;
            if !seen.insert(key) {
                return Ok(None);
            }
            let desired = desired.map(|(preset, colors, enabled)| {
                (items(version.as_deref(), preset, enabled).0, colors)
            });
            update_home(
                &store_path,
                &home,
                desired,
                write,
                version.clone(),
                cfg!(debug_assertions),
                &exe,
            )
            .map(Some)
        })();
        match result {
            Ok(Some(s)) => statuses.push(s),
            Ok(None) => {}
            Err(e) => {
                error.get_or_insert(e);
            }
        }
    }
    error.map_or(Ok(statuses), Err)
}

/// Called during enrollment with CONFIG_WRITE held. No MCP or hook policy is
/// changed: this feature only writes native, local TUI preferences.
pub fn enroll(home: &Path) -> Result<(), String> {
    let Some(file) = settings::path() else {
        return Ok(());
    };
    let settings = settings::load(&file);
    let Some(preset) = settings.codex else {
        return Ok(());
    };
    let version = version();
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    update_home(
        &data_file()?,
        home,
        Some((
            items(version.as_deref(), preset, settings.codex_enabled).0,
            settings.codex_use_colors,
        )),
        true,
        version,
        cfg!(debug_assertions),
        &exe,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_whitelist_and_off_are_explicit() {
        for (version, preset, enabled, count, known) in [
            (Some("0.167.0"), Preset::Compact, true, 2, true),
            (Some("0.167.2"), Preset::Extended, true, 5, true),
            (Some("0.167.0"), Preset::Detailed, true, 9, true),
            (Some("0.168.0"), Preset::Detailed, true, 2, false),
            (None, Preset::Extended, true, 2, false),
            (None, Preset::Compact, false, 0, false),
        ] {
            let (ids, tested) = items(version, preset, enabled);
            assert_eq!((ids.len(), tested), (count, known));
        }
    }

    #[test]
    fn persisted_ownership_is_per_canonical_home_and_per_field() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("app").join(OWNERSHIP_FILE);
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(
            first.join("config.toml"),
            "[tui]\nstatus_line = ['git-branch'] # original\nstatus_line_use_colors = false\n",
        )
        .unwrap();
        for home in [&first, &second] {
            let status = update_home(
                &store,
                home,
                Some((COMPACT, true)),
                true,
                Some("0.167.0".into()),
                false,
                "release.exe",
            )
            .unwrap();
            assert_eq!(status.state, "managed");
        }
        assert_eq!(load_store(&store).unwrap().homes.len(), 2);
        // Dot aliases share a single original, rather than backing up our own write.
        update_home(
            &store,
            &first.join("."),
            Some((EXTENDED, false)),
            true,
            None,
            false,
            "release.exe",
        )
        .unwrap();
        assert_eq!(load_store(&store).unwrap().homes.len(), 2);
        let config = fs::read_to_string(second.join("config.toml"))
            .unwrap()
            .replace(
                "status_line_use_colors = true",
                "status_line_use_colors = false # user",
            );
        fs::write(second.join("config.toml"), config).unwrap();
        let inspected =
            update_home(&store, &second, None, false, None, false, "release.exe").unwrap();
        assert_eq!(inspected.state, "custom");
        assert_eq!(inspected.custom_fields, vec!["status_line_use_colors"]);
        for home in [&first, &second] {
            update_home(&store, home, None, true, None, false, "release.exe").unwrap();
        }
        let restored = fs::read_to_string(first.join("config.toml")).unwrap();
        assert_eq!(
            field_value(&restored, "status_line").unwrap(),
            Some(serde_json::json!(["git-branch"]))
        );
        assert!(restored.contains("# original"));
        assert_eq!(
            field_value(&restored, "status_line_use_colors").unwrap(),
            Some(Value::Bool(false))
        );
        let custom = fs::read_to_string(second.join("config.toml")).unwrap();
        assert_eq!(field_value(&custom, "status_line").unwrap(), None);
        assert!(custom.contains("# user"));
        assert!(load_store(&store).unwrap().homes.is_empty());
    }

    #[test]
    fn debug_does_not_touch_another_installation_in_either_direction() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("profile");
        let store = dir.path().join(OWNERSHIP_FILE);
        update_home(
            &store,
            &home,
            Some((COMPACT, true)),
            true,
            None,
            false,
            "installed.exe",
        )
        .unwrap();
        let before = fs::read(home.join("config.toml")).unwrap();
        let ownership_before = fs::read(&store).unwrap();
        for action in [Some((EXTENDED, false)), None] {
            assert_eq!(
                update_home(&store, &home, action, true, None, true, "debug.exe")
                    .unwrap()
                    .state,
                "deferred"
            );
            assert_eq!(fs::read(home.join("config.toml")).unwrap(), before);
            assert_eq!(fs::read(&store).unwrap(), ownership_before);
        }
        assert_eq!(
            update_home(
                &store,
                &home,
                Some((EXTENDED, false)),
                true,
                None,
                true,
                "installed.exe"
            )
            .unwrap()
            .state,
            "managed"
        );
        // A separate dev app-data dir has no ownership record of the release.
        let isolated_store = dir.path().join("dev").join(OWNERSHIP_FILE);
        assert_eq!(
            update_home(
                &isolated_store,
                &home,
                Some((COMPACT, false)),
                true,
                None,
                true,
                "debug.exe"
            )
            .unwrap()
            .state,
            "deferred"
        );
        assert!(!isolated_store.exists());
    }

    #[test]
    fn debug_defers_to_existing_hooks_even_without_a_statusline() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("hooks.json"),
            r#"{"command":"swarmterm.exe --codex-session-hook"}"#,
        )
        .unwrap();
        assert!(deferred(true, None, "", dir.path(), "debug.exe"));
        assert!(!deferred(false, None, "", dir.path(), "release.exe"));
    }

    #[test]
    fn status_is_read_only_and_broken_recovery_data_prevents_writes() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("not-created");
        let store = dir.path().join(OWNERSHIP_FILE);
        assert_eq!(
            update_home(&store, &home, None, false, None, false, "app.exe")
                .unwrap()
                .state,
            "unmanaged"
        );
        assert!(!home.exists());
        assert!(!store.exists());
        fs::write(&store, "broken").unwrap();
        assert!(update_home(
            &store,
            &home,
            Some((COMPACT, true)),
            true,
            None,
            false,
            "app.exe"
        )
        .is_err());
        assert!(!home.join("config.toml").exists());
        fs::write(&store, "{}").unwrap();
        assert!(update_home(
            &store,
            &home,
            Some((COMPACT, true)),
            true,
            None,
            false,
            "app.exe"
        )
        .is_err());
    }

    #[test]
    fn merge_preserves_unrelated_config_and_restores_each_original() {
        for source in [
            "# Keep me\nmodel = 'x'\n",
            "# Keep me\nmodel = 'x'\n[tui]\nstatus_line = ['git-branch']\nstatus_line_use_colors = false\ntheme = 'dark'\n",
            "# Keep me\nmodel = 'x'\ntui = { status_line = [], theme = 'dark' }\n",
        ] {
            let mut owned = Ownership::default();
            let applied = merge(source, &mut owned, Some((&["model-with-reasoning"], true))).unwrap();
            assert!(applied.text.contains("# Keep me"));
            assert!(applied.text.contains("model = 'x'"));
            assert!(applied.custom_fields.is_empty());
            let again = merge(&applied.text, &mut owned, Some((&[], false))).unwrap();
            let restored = merge(&again.text, &mut owned, None).unwrap();
            for field in FIELDS {
                assert_eq!(field_value(source, field).unwrap(), field_value(&restored.text, field).unwrap());
            }
            assert!(owned.fields.is_empty());
        }
    }

    #[test]
    fn user_changes_and_deletions_are_never_reclaimed() {
        for changed in ["status_line = ['git-branch']", "# removed"] {
            let mut owned = Ownership::default();
            let applied = merge("", &mut owned, Some((&[], true))).unwrap();
            let edited = applied.text.replace("status_line = []", changed);
            for _ in 0..2 {
                let result = merge(&edited, &mut owned, Some((&["used-tokens"], true))).unwrap();
                assert!(result.custom_fields.contains(&"status_line".to_owned()));
                assert_eq!(result.text, edited);
            }
            let released = merge(&edited, &mut owned, None).unwrap();
            assert_eq!(
                field_value(&released.text, "status_line").unwrap(),
                field_value(&edited, "status_line").unwrap()
            );
            assert_eq!(
                field_value(&released.text, "status_line_use_colors").unwrap(),
                None
            );
        }
    }

    #[test]
    fn equivalent_user_formatting_is_still_owned() {
        let mut owned = Ownership::default();
        let applied = merge("", &mut owned, Some((&["git-branch"], true))).unwrap();
        let edited = applied.text.replace("\"git-branch\"", "'git-branch'");
        assert!(merge(&edited, &mut owned, None)
            .unwrap()
            .custom_fields
            .is_empty());
    }

    #[test]
    fn invalid_toml_or_tui_type_is_rejected() {
        for source in [
            "[broken",
            "tui = false",
            "tui = []",
            "[tui.status_line]\nfoo = true",
        ] {
            assert!(merge(source, &mut Ownership::default(), Some((&[], false))).is_err());
        }
    }
}
