//! Discovery of resumable agent-CLI sessions for the composer's "Resume
//! sessions" list. Read-only over stores owned by other programs, and
//! fail-open everywhere: any parse/IO error degrades to "no suggestions",
//! never to an error the renderer must handle (roadmap doctrine: a display-
//! only surface may collapse `error` into `absent`).

pub mod claude;
pub mod codex;
pub mod opencode;
pub mod qwen;

use serde::Serialize;
use std::io::Read;
use std::path::Path;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPane {
    pub cwd: String,
    pub agent_id: String,
    pub session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInspection {
    pub directory_available: bool,
    pub session_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedInspection {
    pub root_available: bool,
    pub panes: Vec<PaneInspection>,
}

pub async fn inspect_saved(cwd: String, panes: Vec<SavedPane>) -> Result<SavedInspection, String> {
    if panes.len() > 1024
        || cwd.len() > 32768
        || panes
            .iter()
            .any(|p| p.cwd.len() > 32768 || p.session_id.as_ref().is_some_and(|s| s.len() > 128))
    {
        return Err("Saved workspace is too large".into());
    }
    let mut opencode_matches = std::collections::HashSet::new();
    for pane in &panes {
        if pane.agent_id == "opencode"
            && pane.session_id.as_deref().is_some_and(|s| {
                s.starts_with("ses_") && s[4..].chars().all(|c| c.is_ascii_alphanumeric())
            })
            && Path::new(&pane.cwd).is_dir()
            && opencode::scan(&pane.cwd)
                .await
                .iter()
                .any(|s| Some(&s.session_id) == pane.session_id.as_ref())
        {
            opencode_matches.insert((pane.cwd.clone(), pane.session_id.clone()));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root_available = Path::new(&cwd).is_dir();
        let panes = panes
            .into_iter()
            .map(|pane| {
                let directory_available = Path::new(&pane.cwd).is_dir();
                let session_available = directory_available
                    && pane.session_id.as_deref().is_some_and(|id| {
                        if pane.agent_id == "opencode" {
                            return opencode_matches
                                .contains(&(pane.cwd.clone(), pane.session_id.clone()));
                        }
                        if !is_uuid(id) {
                            return false;
                        }
                        match pane.agent_id.as_str() {
                            "claude-code" => claude_projects_root().is_some_and(|root| {
                                root.join(claude::encode_project_dir(&pane.cwd))
                                    .join(format!("{id}.jsonl"))
                                    .is_file()
                            }),
                            "codex" => codex_sessions_root()
                                .is_some_and(|root| codex::session_exists(&root, &pane.cwd, id)),
                            "qwen" => qwen_projects_root().is_some_and(|root| {
                                qwen::scan(&root, &pane.cwd)
                                    .iter()
                                    .any(|s| s.session_id == id)
                            }),
                            _ => false,
                        }
                    });
                PaneInspection {
                    directory_available,
                    session_available,
                }
            })
            .collect();
        SavedInspection {
            root_available,
            panes,
        }
    })
    .await
    .map_err(|_| "Could not inspect saved workspace".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub agent_id: String,
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at_ms: u64,
}

/// First 128 KB of a session file, lossily decoded. Session files can be
/// hundreds of MB; the title always lives in the first few lines.
const HEAD_CAP: usize = 128 * 1024;

pub(crate) fn read_head(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD_CAP];
    let mut filled = 0;
    // Loop: File::read may return short counts well before EOF.
    loop {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if filled == buf.len() {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalize a raw prompt/title for one-line display. Rejects synthetic
/// entries (command wrappers, env-context blocks — they start with `<`).
pub(crate) fn clean_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') {
        return None;
    }
    let collapsed: String = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(collapsed.chars().take(80).collect())
}

/// Strict hyphenated-UUID shape — the session file stem for claude and qwen.
pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `$CLAUDE_CONFIG_DIR` else `<home>/.claude`, then `projects/`.
fn claude_projects_root() -> Option<std::path::PathBuf> {
    let base = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))?;
    Some(base.join("projects"))
}

/// `$QWEN_HOME` else `<home>/.qwen`, then `projects/`. Blank env treated as
/// unset — the same rule as `mcp::config::resolve_qwen_settings_path`, so
/// the two qwen features never read different roots from one variable.
fn qwen_projects_root() -> Option<std::path::PathBuf> {
    let base = std::env::var("QWEN_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".qwen")))?;
    Some(base.join("projects"))
}

/// `$CODEX_HOME` else `<home>/.codex`, then `sessions/`.
fn codex_sessions_root() -> Option<std::path::PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    Some(base.join("sessions"))
}

/// HOME on unix, USERPROFILE on Windows — same convention as `agents.rs`.
fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var(var).ok().map(std::path::PathBuf::from)
}

/// Everything resumable for `folder`, all three stores, fail-open each.
/// File scans run on a blocking thread (they touch possibly-cold disk);
/// the OpenCode subprocess is already async.
pub async fn list_all(folder: String) -> Vec<SessionEntry> {
    let scan_folder = folder.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        if let Some(root) = claude_projects_root() {
            out.extend(claude::scan(&root, &scan_folder));
        }
        if let Some(root) = codex_sessions_root() {
            out.extend(codex::scan(&root, &scan_folder));
        }
        if let Some(root) = qwen_projects_root() {
            out.extend(qwen::scan(&root, &scan_folder));
        }
        out
    });
    let mut entries = files.await.unwrap_or_default();
    entries.extend(opencode::scan(&folder).await);
    entries
}
