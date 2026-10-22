//! Cross-subscription sessions. A profile's transcripts live inside its own
//! config dir, so a session started under one subscription is invisible to
//! another. Two user-chosen ways around that:
//!
//! * `transfer` — copy ONE session into another profile's store (same
//!   relative path, same id), so `--resume <id>` works there. A fork: the
//!   source copy is never touched and both continue independently.
//! * share mode — Claude profiles' `projects/` and `file-history/` become
//!   directory junctions to one shared store, so every subscription (and
//!   Claude's own `/resume` picker) sees every session.
//!
//! Transcripts hold no credentials (those stay in `.credentials.json` /
//! `.claude.json` / `auth.json`); a cross-account Claude resume was verified
//! by hand, thinking signatures included. Codex reasoning items carry
//! `encrypted_content` that may be bound to the OpenAI account, so Codex only
//! gets `transfer` and the CLI reports any failure itself.
//!
//! Nothing here deletes user data: an overwritten file and every folder a
//! junction replaces are moved under `backup_root()` first.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Claude subfolders keyed by session id. `todos/`, `session-env/` etc. are
/// per-run scratch and stay per profile.
pub const SHARED_SUBDIRS: [&str; 2] = ["projects", "file-history"];

static APP_DATA: OnceLock<PathBuf> = OnceLock::new();
/// Serializes share-mode switches, boot repair and enrollment repair.
static SHARE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareSettings {
    /// Share Claude Code sessions between all subscriptions.
    pub claude: bool,
    /// Also link the default profile (`~/.claude`), not just named ones.
    pub include_default: bool,
}

pub fn init(app_data: PathBuf) {
    let _ = APP_DATA.set(app_data);
}

fn app_data() -> Result<&'static Path, String> {
    APP_DATA
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| "Session sharing is not initialised".into())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data()?.join("session-share.json"))
}

pub fn shared_root() -> Result<PathBuf, String> {
    Ok(app_data()?.join("shared-sessions").join("claude"))
}

pub fn backup_root() -> Result<PathBuf, String> {
    Ok(app_data()?.join("session-share-backups"))
}

pub fn load() -> ShareSettings {
    settings_path()
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn store(settings: ShareSettings) -> Result<(), String> {
    let path = settings_path()?;
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// `$CLAUDE_CONFIG_DIR` else `<home>/.claude` / `$CODEX_HOME` else
/// `<home>/.codex` — the default profile's store, as its panes see it.
pub fn default_base(agent_id: &str) -> Option<PathBuf> {
    let (var, dir) = match agent_id {
        "claude-code" => ("CLAUDE_CONFIG_DIR", ".claude"),
        "codex" => ("CODEX_HOME", ".codex"),
        _ => return None,
    };
    std::env::var(var)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| super::home_dir().map(|h| h.join(dir)))
}

/// A fresh timestamped folder name; never reused, so backups never collide.
fn stamp() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{ms}-{}", &uuid::Uuid::new_v4().to_string()[..8])
}

fn modified(p: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Copy `src` over `dst` unless `dst` is at least as new. An older `dst` is
/// moved to `backup` first. Returns whether anything was copied.
fn copy_file_newer(src: &Path, dst: &Path, backup: &Path) -> Result<bool, String> {
    if dst.exists() {
        if modified(dst) >= modified(src) {
            return Ok(false);
        }
        fs::create_dir_all(backup.parent().unwrap_or(backup)).map_err(|e| e.to_string())?;
        fs::rename(dst, backup)
            .or_else(|_| fs::copy(dst, backup).map(|_| ()))
            .map_err(|e| format!("Cannot back up {}: {e}", dst.display()))?;
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(src, dst).map_err(|e| format!("Cannot copy {}: {e}", src.display()))?;
    Ok(true)
}

/// Recursive merge: files only, newer wins, older targets backed up under
/// `backup` with the same relative path. Links inside the tree are skipped.
/// Every read error fails the merge: callers move the source aside next, so
/// a silently skipped file would vanish from the merged store.
fn merge_tree(src: &Path, dst: &Path, backup: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot read {}: {e}", src.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read {}: {e}", src.display()))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("Cannot read {}: {e}", entry.path().display()))?;
        let name = entry.file_name();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            merge_tree(&entry.path(), &dst.join(&name), &backup.join(&name))?;
        } else if kind.is_file() {
            copy_file_newer(&entry.path(), &dst.join(&name), &backup.join(&name))?;
        }
    }
    Ok(())
}

/// The Claude transcript for `id` under `<base>/projects/*/`, wherever the
/// session's cwd slug put it.
fn find_claude(base: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    fs::read_dir(base.join("projects"))
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// Copy one session from the `from` store to the `to` store (config-dir
/// bases). Same id, same relative path; the source is never modified.
/// `Ok(false)` when the source has no transcript yet (a session that never
/// got a turn): there is nothing to carry, so the caller may start fresh.
pub fn transfer(agent_id: &str, id: &str, from: &Path, to: &Path) -> Result<bool, String> {
    if !super::is_uuid(id) {
        return Err("Invalid session id".into());
    }
    if same_target(from, to) {
        // Nothing to copy, but a session that never got a turn has no
        // transcript either: reporting it as carried would make the pane run
        // `--resume <id>` and the CLI fails with "No conversation found".
        return Ok(match agent_id {
            "claude-code" => find_claude(from, id).is_some(),
            "codex" => super::codex::find_rollout(&from.join("sessions"), id).is_some(),
            _ => true,
        });
    }
    let backup = backup_root()
        .unwrap_or_else(|_| to.join("session-share-backups"))
        .join(stamp());
    match agent_id {
        "claude-code" => {
            let Some(file) = find_claude(from, id) else {
                return Ok(false);
            };
            let rel = file.strip_prefix(from).map_err(|e| e.to_string())?;
            copy_file_newer(&file, &to.join(rel), &backup.join(rel))?;
            // Tool-result sidecars next to the transcript, rewind checkpoints.
            let sidecar = file.with_extension("");
            if sidecar.is_dir() {
                let rel = sidecar.strip_prefix(from).map_err(|e| e.to_string())?;
                merge_tree(&sidecar, &to.join(rel), &backup.join(rel))?;
            }
            let history = Path::new("file-history").join(id);
            if from.join(&history).is_dir() {
                merge_tree(
                    &from.join(&history),
                    &to.join(&history),
                    &backup.join(&history),
                )?;
            }
            Ok(true)
        }
        "codex" => {
            let Some(file) = super::codex::find_rollout(&from.join("sessions"), id) else {
                return Ok(false);
            };
            let rel = file.strip_prefix(from).map_err(|e| e.to_string())?;
            copy_file_newer(&file, &to.join(rel), &backup.join(rel)).map(|_| true)
        }
        _ => Err("This agent's sessions cannot be moved between subscriptions".into()),
    }
}

/// Two config dirs that are the same folder, or whose session stores are
/// already one shared folder (share mode): nothing to copy.
fn same_target(from: &Path, to: &Path) -> bool {
    let canon = |p: &Path| fs::canonicalize(p).ok();
    canon(from).is_some_and(|a| Some(a) == canon(to))
        || (canon(&from.join("projects")).is_some_and(|a| Some(a) == canon(&to.join("projects")))
            && canon(&from.join("file-history"))
                .is_some_and(|a| Some(a) == canon(&to.join("file-history"))))
}

/// Whether `link` is a link (junction/symlink) that resolves to `target`.
fn links_to(link: &Path, target: &Path) -> bool {
    fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink())
        && fs::canonicalize(link).ok() == fs::canonicalize(target).ok()
}

type MakeLink = fn(&Path, &Path) -> Result<(), String>;

#[cfg(windows)]
fn make_link(link: &Path, target: &Path) -> Result<(), String> {
    // A junction needs no admin rights or Developer Mode, unlike a symlink.
    // Created through the API, so cmd.exe never parses `%` or `^` in paths.
    junction::create(target, link).map_err(|e| format!("Cannot link {}: {e}", link.display()))
}

#[cfg(not(windows))]
fn make_link(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
}

fn remove_link(link: &Path) -> Result<(), String> {
    // On a junction or dir symlink this removes only the link, never the target.
    #[cfg(windows)]
    let result = fs::remove_dir(link);
    #[cfg(not(windows))]
    let result = fs::remove_file(link);
    result.map_err(|e| format!("Cannot remove link {}: {e}", link.display()))
}

/// Point `<dir>/<sub>` at the shared store for every shared subfolder. The
/// profile's own folder is merged into the store, then renamed to a sibling
/// `<sub>.pre-share-<stamp>` and kept. A sibling is on the same volume, so
/// the rename can only fail because a file is in use. Idempotent.
pub fn link_profile(dir: &Path, shared: &Path, backups: &Path) -> Result<(), String> {
    link_profile_with(dir, shared, backups, make_link)
}

fn link_profile_with(
    dir: &Path,
    shared: &Path,
    backups: &Path,
    make: MakeLink,
) -> Result<(), String> {
    for sub in SHARED_SUBDIRS {
        let target = shared.join(sub);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let own = dir.join(sub);
        if links_to(&own, &target) {
            continue;
        }
        let meta = fs::symlink_metadata(&own);
        if meta.as_ref().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!(
                "{} is already a link to another folder; leaving it alone",
                own.display()
            ));
        }
        let mut moved_aside = None;
        if meta.is_ok() {
            let losers = backups.join(stamp()).join(format!("{sub}-replaced"));
            merge_tree(&own, &target, &losers)?;
            let saved = dir.join(format!("{sub}.pre-share-{}", stamp()));
            // Windows refuses to move a folder with an open handle below it,
            // i.e. while a pane of this profile is writing a transcript.
            fs::rename(&own, &saved).map_err(|e| {
                format!(
                    "Cannot move {} aside (close panes using this subscription and retry): {e}",
                    own.display()
                )
            })?;
            // Claude reopens a transcript for each append, so a live pane can
            // write between the merge and the rename. Merge again from the
            // moved folder so the store gets those lines too.
            merge_tree(&saved, &target, &losers)?;
            moved_aside = Some(saved);
        }
        if let Err(e) = make(&own, &target) {
            // Put the profile's own folder back rather than leave it missing.
            // That fails too if a live pane recreated `<sub>` meanwhile; say
            // where the data is instead of hiding it.
            if let Some(saved) = moved_aside {
                if let Err(back) = fs::rename(&saved, &own) {
                    return Err(format!(
                        "{e}; restoring the folder also failed ({back}), its sessions are in {}",
                        saved.display()
                    ));
                }
            }
            return Err(e);
        }
    }
    Ok(())
}

/// Undo `link_profile`: replace each junction with a full private copy of
/// the shared store, so no session is lost. The copy is built beside the
/// link and swapped in only once it is complete; on failure the link stays,
/// and the next apply or boot repair retries. The shared store is kept.
pub fn unlink_profile(dir: &Path, shared: &Path, backups: &Path) -> Result<(), String> {
    unlink_profile_with(dir, shared, backups, make_link, |from, to| {
        fs::rename(from, to)
    })
}

type Swap = fn(&Path, &Path) -> std::io::Result<()>;

fn unlink_profile_with(
    dir: &Path,
    shared: &Path,
    backups: &Path,
    make: MakeLink,
    swap: Swap,
) -> Result<(), String> {
    for sub in SHARED_SUBDIRS {
        let own = dir.join(sub);
        let target = shared.join(sub);
        if !links_to(&own, &target) {
            continue;
        }
        let staging = dir.join(format!("{sub}.unshare-{}", stamp()));
        // An empty shared folder copies nothing, so the stage must exist.
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        merge_tree(&target, &staging, &backups.join(stamp()).join(sub))?;
        if let Err(e) = remove_link(&own) {
            // Nothing changed; drop our own stage so retries don't pile up
            // full copies (it only duplicates the shared store).
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
        if let Err(e) = swap(&staging, &own) {
            // Restore the link. With the link back, the stage is only a
            // duplicate of the shared store, so drop it (retries would pile
            // up full copies); it is kept only when relinking fails too.
            let failed = format!("Cannot replace {}: {e}", own.display());
            return Err(match make(&own, &target) {
                Ok(()) => {
                    let _ = fs::remove_dir_all(&staging);
                    failed
                }
                Err(relink) => format!(
                    "{failed}; restoring the link also failed ({relink}), a full copy is in {}",
                    staging.display()
                ),
            });
        }
    }
    Ok(())
}

/// The Claude config dirs share mode applies to under `settings`.
fn claude_dirs(
    accounts: &[crate::accounts::AgentAccount],
    settings: ShareSettings,
    default_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = accounts
        .iter()
        .filter(|a| a.agent_id == "claude-code")
        .map(|a| PathBuf::from(&a.config_dir))
        .collect();
    if settings.include_default {
        dirs.extend(default_dir.map(Path::to_path_buf));
    }
    dirs
}

/// Switch share mode and bring every profile in line. On a partial failure
/// the remaining profiles are still processed and the errors reported; the
/// setting is stored either way so boot repair finishes the job later.
pub fn apply(
    accounts: &[crate::accounts::AgentAccount],
    next: ShareSettings,
) -> Result<ShareSettings, String> {
    let _lock = SHARE_LOCK.lock().map_err(|e| e.to_string())?;
    let result = apply_in(
        accounts,
        next,
        default_base("claude-code").as_deref(),
        &shared_root()?,
        &backup_root()?,
    );
    if load() != next {
        store(next)?;
    }
    result.map(|_| next)
}

fn apply_in(
    accounts: &[crate::accounts::AgentAccount],
    next: ShareSettings,
    default_dir: Option<&Path>,
    shared: &Path,
    backups: &Path,
) -> Result<(), String> {
    let all = claude_dirs(
        accounts,
        ShareSettings {
            claude: true,
            include_default: true,
        },
        default_dir,
    );
    let wanted = if next.claude {
        claude_dirs(accounts, next, default_dir)
    } else {
        vec![]
    };
    let mut errors = Vec::new();
    for dir in &all {
        let result = if wanted.contains(dir) {
            fs::create_dir_all(dir)
                .map_err(|e| e.to_string())
                .and_then(|_| link_profile(dir, shared, backups))
        } else {
            unlink_profile(dir, shared, backups)
        };
        if let Err(e) = result {
            errors.push(format!("{}: {e}", dir.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// Re-link one profile if share mode is on: new profiles join automatically.
/// Called on every enrollment; log-only.
pub fn ensure_profile(dir: &Path) {
    let (Ok(shared), Ok(backups)) = (shared_root(), backup_root()) else {
        return;
    };
    let Ok(_lock) = SHARE_LOCK.lock() else { return };
    if let Err(e) = ensure_profile_in(load(), dir, &shared, &backups) {
        eprintln!("session-share: cannot link {}: {e}", dir.display());
    }
}

fn ensure_profile_in(
    settings: ShareSettings,
    dir: &Path,
    shared: &Path,
    backups: &Path,
) -> Result<(), String> {
    if settings.claude {
        link_profile(dir, shared, backups)
    } else {
        Ok(())
    }
}

/// Boot repair: re-apply the stored setting (a profile added while the app
/// was closed, a junction removed by hand). Log-only.
pub fn repair(accounts: &[crate::accounts::AgentAccount]) {
    let settings = load();
    if !settings.claude {
        return;
    }
    if let Err(e) = apply(accounts, settings) {
        eprintln!("session-share: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "e38e4b33-44c1-4987-b20c-f98fb9ec546e";

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn transfer_copies_claude_session_with_sidecars_and_leaves_source() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        write(&a.join("projects/C--x").join(format!("{ID}.jsonl")), "{}\n");
        write(
            &a.join("projects/C--x").join(ID).join("tool-results/1.txt"),
            "r",
        );
        write(&a.join("file-history").join(ID).join("f@v1"), "h");
        fs::create_dir_all(&b).unwrap();
        transfer("claude-code", ID, &a, &b).unwrap();
        assert!(b
            .join("projects/C--x")
            .join(format!("{ID}.jsonl"))
            .is_file());
        assert!(b
            .join("projects/C--x")
            .join(ID)
            .join("tool-results/1.txt")
            .is_file());
        assert!(b.join("file-history").join(ID).join("f@v1").is_file());
        assert!(a
            .join("projects/C--x")
            .join(format!("{ID}.jsonl"))
            .is_file());
    }

    #[test]
    fn transfer_keeps_a_newer_target_and_rejects_bad_ids() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        let src = a.join("projects/C--x").join(format!("{ID}.jsonl"));
        let dst = b.join("projects/C--x").join(format!("{ID}.jsonl"));
        write(&src, "old");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&dst, "newer");
        transfer("claude-code", ID, &a, &b).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "newer");
        assert!(transfer("claude-code", "../evil", &a, &b).is_err());
        assert_eq!(
            transfer(
                "claude-code",
                "00000000-0000-0000-0000-000000000000",
                &a,
                &b
            ),
            Ok(false)
        );
    }

    #[test]
    fn transfer_between_shared_stores_only_carries_a_session_with_a_transcript() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        link_profile(&a, &shared, &backups).unwrap();
        link_profile(&b, &shared, &backups).unwrap();
        // Fresh session: no transcript yet, so the pane must start fresh.
        assert_eq!(transfer("claude-code", ID, &a, &b), Ok(false));
        write(&a.join("projects/C--x").join(format!("{ID}.jsonl")), "{}\n");
        assert_eq!(transfer("claude-code", ID, &a, &b), Ok(true));
    }

    #[test]
    fn transfer_between_shared_codex_homes_needs_a_rollout() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        fs::create_dir_all(&a).unwrap();
        assert_eq!(transfer("codex", ID, &a, &a.join(".")), Ok(false));
        let rel = format!("sessions/2026/10/17/rollout-2026-10-17T10-00-00-{ID}.jsonl");
        write(&a.join(rel), &format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cwd\":\"C:/x\"}}}}
"));
        assert_eq!(transfer("codex", ID, &a, &a.join(".")), Ok(true));
    }

    #[test]
    fn transfer_copies_codex_rollout_to_same_relative_path() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        let rel = format!("sessions/2026/10/17/rollout-2026-10-17T10-00-00-{ID}.jsonl");
        write(
            &a.join(&rel),
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cwd\":\"C:/x\"}}}}\n"
            ),
        );
        fs::create_dir_all(&b).unwrap();
        transfer("codex", ID, &a, &b).unwrap();
        assert!(b.join(&rel).is_file());
    }

    #[test]
    fn link_merges_into_shared_store_and_unlink_restores_private_copy() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        let shared = root.path().join("shared");
        let backups = root.path().join("backups");
        write(&a.join("projects/p/one.jsonl"), "1");
        write(&b.join("projects/p/two.jsonl"), "2");
        link_profile(&a, &shared, &backups).unwrap();
        link_profile(&b, &shared, &backups).unwrap();
        link_profile(&b, &shared, &backups).unwrap(); // idempotent
        assert!(a.join("projects/p/two.jsonl").is_file());
        assert!(b.join("projects/p/one.jsonl").is_file());
        // The profiles' own folders were moved aside, not deleted.
        let (in_a, in_b) = (walk(&a), walk(&b));
        assert!(in_a
            .iter()
            .any(|p| p.ends_with("one.jsonl") && p.to_string_lossy().contains(".pre-share-")));
        assert!(in_b
            .iter()
            .any(|p| p.ends_with("two.jsonl") && p.to_string_lossy().contains(".pre-share-")));

        unlink_profile(&a, &shared, &backups).unwrap();
        assert!(!fs::symlink_metadata(a.join("projects"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(a.join("projects/p/two.jsonl").is_file());
        write(&a.join("projects/p/three.jsonl"), "3");
        assert!(!b.join("projects/p/three.jsonl").exists());
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().unwrap().is_dir() {
                out.extend(walk(&e.path()));
            } else {
                out.push(e.path());
            }
        }
        out
    }

    fn account(dir: &Path) -> crate::accounts::AgentAccount {
        crate::accounts::AgentAccount {
            id: uuid::Uuid::new_v4().to_string(),
            agent_id: "claude-code".into(),
            name: "t".into(),
            config_dir: dir.to_string_lossy().into_owned(),
        }
    }

    fn is_link(p: &Path) -> bool {
        fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
    }

    #[test]
    fn apply_links_named_profiles_default_only_when_included_and_unlinks_on_off() {
        let root = tempfile::tempdir().unwrap();
        let (a, def) = (root.path().join("a"), root.path().join("default"));
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        write(&a.join("projects/p/one.jsonl"), "1");
        write(&def.join("projects/p/two.jsonl"), "2");
        let accounts = [account(&a)];
        let on = ShareSettings {
            claude: true,
            include_default: false,
        };
        apply_in(&accounts, on, Some(&def), &shared, &backups).unwrap();
        assert!(is_link(&a.join("projects")) && is_link(&a.join("file-history")));
        assert!(!is_link(&def.join("projects")));

        let with_default = ShareSettings {
            claude: true,
            include_default: true,
        };
        apply_in(&accounts, with_default, Some(&def), &shared, &backups).unwrap();
        assert!(is_link(&def.join("projects")));
        assert!(a.join("projects/p/two.jsonl").is_file());

        apply_in(
            &accounts,
            ShareSettings::default(),
            Some(&def),
            &shared,
            &backups,
        )
        .unwrap();
        for dir in [&a, &def] {
            assert!(!is_link(&dir.join("projects")));
            assert!(dir.join("projects/p/one.jsonl").is_file());
            assert!(dir.join("projects/p/two.jsonl").is_file());
        }
    }

    #[test]
    fn link_refuses_a_foreign_link_and_restores_the_folder_when_linking_fails() {
        let root = tempfile::tempdir().unwrap();
        let (a, other) = (root.path().join("a"), root.path().join("other"));
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&a).unwrap();
        make_link(&a.join("projects"), &other).unwrap();
        assert!(link_profile(&a, &shared, &backups).is_err());
        assert!(links_to(&a.join("projects"), &other));

        let b = root.path().join("b");
        write(&b.join("projects/p/one.jsonl"), "1");
        let failing: MakeLink = |_, _| Err("no links here".into());
        assert!(link_profile_with(&b, &shared, &backups, failing).is_err());
        assert!(!is_link(&b.join("projects")));
        assert!(b.join("projects/p/one.jsonl").is_file());
    }

    #[test]
    fn ensure_profile_does_nothing_while_sharing_is_off() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        write(&a.join("projects/p/one.jsonl"), "1");
        ensure_profile_in(ShareSettings::default(), &a, &shared, &backups).unwrap();
        assert!(!is_link(&a.join("projects")));
        assert!(!shared.exists());
        let on = ShareSettings {
            claude: true,
            include_default: false,
        };
        ensure_profile_in(on, &a, &shared, &backups).unwrap();
        assert!(is_link(&a.join("projects")));
    }

    #[test]
    fn link_keeps_the_profile_folder_beside_it() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        write(&a.join("projects/p/one.jsonl"), "1");
        link_profile(&a, &shared, &backups).unwrap();
        let kept: Vec<_> = fs::read_dir(&a)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("projects.pre-share-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert!(a.join(&kept[0]).join("p/one.jsonl").is_file());
    }

    #[test]
    fn unlink_swaps_in_a_complete_copy_without_leftovers() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        write(&a.join("projects/p/one.jsonl"), "1");
        link_profile(&a, &shared, &backups).unwrap();
        let ok: MakeLink = make_link;
        unlink_profile_with(&a, &shared, &backups, ok, |f, t| fs::rename(f, t)).unwrap();
        assert!(!is_link(&a.join("projects")));
        assert!(a.join("projects/p/one.jsonl").is_file());
        assert!(!fs::read_dir(&a)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".unshare-")));
    }

    #[test]
    fn unlink_restores_the_link_when_the_swap_fails_and_reports_a_double_failure() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let (shared, backups) = (root.path().join("shared"), root.path().join("backups"));
        write(&a.join("projects/p/one.jsonl"), "1");
        link_profile(&a, &shared, &backups).unwrap();
        let busy: Swap = |_, _| Err(std::io::Error::other("in use"));
        let err = unlink_profile_with(&a, &shared, &backups, make_link, busy).unwrap_err();
        assert!(err.contains("in use"), "{err}");
        assert!(links_to(&a.join("projects"), &shared.join("projects")));
        assert!(a.join("projects/p/one.jsonl").is_file());
        assert!(!fs::read_dir(&a)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".unshare-")));

        let no_links: MakeLink = |_, _| Err("no links".into());
        let err = unlink_profile_with(&a, &shared, &backups, no_links, busy).unwrap_err();
        assert!(err.contains("a full copy is in"), "{err}");
        let stage = fs::read_dir(&a)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("projects.unshare-"))
            .unwrap();
        assert!(stage.join("p/one.jsonl").is_file());
    }
}
