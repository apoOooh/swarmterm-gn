//! Standard edition: fetch the source, fingerprint the package tree and run
//! `install.mjs`. Compiled out of Corp (`corp.rs` takes this module's place).

use super::source::{self, Op, Source};
use super::{gate, load_settings, settings_path, state, RunOutcome, Settings, TeamPackageState};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Under the local app data dir: `src` is our checkout, `source.txt` the
/// source it was cloned from (a source switch discards the checkout).
const CHECKOUT_DIR: &str = "team-package";
const TIMEOUT: Duration = Duration::from_secs(120);
const KEEP_OUTPUT: usize = 64 * 1024;
/// Upper bounds for the fingerprint walk: a package is a few hundred small
/// files; anything far bigger is a wrong folder, not a package.
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// One action at a time: a second click must not fetch into a checkout the
/// first one is running from.
static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}
fn take_busy() -> Result<BusyGuard, String> {
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("busy".into());
    }
    Ok(BusyGuard)
}

// ---------- fingerprint ----------

/// SHA-256 over every file below `root` (relative path + length + content,
/// sorted), skipping only `.git` at the root. Links and
/// junctions are refused rather than followed, so the tree cannot point the
/// hash at one set of files while node resolves another.
pub fn fingerprint(root: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    for rel in &files {
        // Size from metadata first: a wrong folder with one huge file must
        // be refused before it is read into memory.
        let len = std::fs::metadata(root.join(rel))
            .map_err(|e| format!("read {rel}: {e}"))?
            .len();
        total += len;
        if total > MAX_BYTES {
            return Err("The package folder is too large.".into());
        }
        let bytes = std::fs::read(root.join(rel)).map_err(|e| format!("read {rel}: {e}"))?;
        hasher.update(rel.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        // Only git's own metadata is skipped: node resolves imports from a
        // node_modules in the package, so it must be part of the hash.
        if dir == root && name == ".git" {
            continue;
        }
        let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || is_reparse(&meta) {
            return Err(format!(
                "The package contains a link ({}); links are not supported.",
                name.to_string_lossy()
            ));
        }
        if meta.is_dir() {
            walk(root, &entry.path(), out)?;
        } else if meta.is_file() {
            let rel = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(rel);
            if out.len() > MAX_FILES {
                return Err("The package folder has too many files.".into());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}
#[cfg(not(windows))]
fn is_reparse(_: &std::fs::Metadata) -> bool {
    false
}

// ---------- source and checkout ----------

fn checkout_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join(CHECKOUT_DIR))
        .map_err(|e| e.to_string())
}

fn save_source(app: &AppHandle, source: Option<String>) -> Result<(), String> {
    // Checkout first: if it cannot be removed (a locked file), the old
    // source stays saved and the error matches what the UI still shows.
    // Only our own checkout is removed; a local source folder never is.
    let root = checkout_root(app)?;
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("could not reset the checkout: {e}"))?;
    }
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Settings { source }).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_package_set_source(
    webview: tauri::Webview,
    app: AppHandle,
    source: Option<String>,
) -> Result<TeamPackageState, String> {
    gate(&webview, &app)?;
    let source = match source.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(s) => {
            source::parse(s)?;
            Some(s.to_string())
        }
    };
    let busy = take_busy()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy; // see team_package_preview
        save_source(&app, source)?;
        Ok(state(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cfg_args() -> Vec<std::ffi::OsString> {
    source::git_config_args()
        .into_iter()
        .map(Into::into)
        .collect()
}

/// Run git with our config and no prompts; `Err` carries git's last lines,
/// prefixed `unreachable:` (no access is an expected state, not a failure).
fn git(args: Vec<std::ffi::OsString>, cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = crate::terminal_env::command("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    let c = crate::routine_cmd::run_captured(cmd, TIMEOUT, KEEP_OUTPUT)
        .map_err(|e| format!("Could not run git ({e}). Is Git installed?"))?;
    if c.timed_out {
        return Err("unreachable: git did not finish in time.".into());
    }
    if c.exit_code != Some(0) {
        return Err(format!(
            "unreachable: {}",
            crate::routine_cmd::tail(&c.output)
        ));
    }
    Ok(c.output)
}

/// Bring our checkout to the newest commit of the source's default branch.
fn fetch(app: &AppHandle, url: &str) -> Result<PathBuf, String> {
    let root = checkout_root(app)?;
    let dir = root.join("src");
    let marker = root.join("source.txt");
    let same = std::fs::read_to_string(&marker).ok().as_deref() == Some(url);
    if !same && root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if dir.join(".git").is_dir() {
        for step in [
            &["fetch", "--depth", "1", "--no-tags", "origin"][..],
            &["reset", "--hard", "FETCH_HEAD"][..],
            &["clean", "-ffdx"][..],
        ] {
            let mut a = cfg_args();
            a.extend(step.iter().map(Into::into));
            git(a, Some(&dir))?;
        }
    } else {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        git(source::clone_args(url, &dir), None)?;
        std::fs::write(&marker, url).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn commit_of(dir: &Path) -> Option<String> {
    let mut a = cfg_args();
    a.extend(["rev-parse", "--short=12", "HEAD"].map(Into::into));
    git(a, Some(dir)).ok().map(|s| s.trim().to_string())
}

fn run_script(dir: &Path, op: Op, dry_run: bool) -> Result<crate::routine_cmd::Captured, String> {
    let mut cmd = crate::terminal_env::command("node");
    cmd.current_dir(dir)
        .args(source::node_args(dir, op, dry_run));
    crate::routine_cmd::run_captured(cmd, TIMEOUT, KEEP_OUTPUT)
        .map_err(|e| format!("Could not run Node.js ({e}). Is Node.js installed?"))
}

/// Resolve the package folder: fetch a Git source (`refresh`) or use the
/// local folder; then require the script. Also returns the saved source
/// text, which the bound fingerprint covers.
fn package_dir(app: &AppHandle, refresh: bool) -> Result<(PathBuf, bool, String), String> {
    let raw = load_settings(app)
        .source
        .ok_or("No team package source is set.")?;
    let (dir, is_git) = match source::parse(&raw)? {
        Source::Git(url) if refresh => (fetch(app, &url)?, true),
        Source::Git(_) => (checkout_root(app)?.join("src"), true),
        Source::Local(p) => (p, false),
    };
    if !dir.join(source::SCRIPT).is_file() {
        return Err(if !dir.exists() {
            "unreachable: the source folder does not exist or is not readable.".into()
        } else {
            format!("The source has no {} in its root folder.", source::SCRIPT)
        });
    }
    Ok((dir, is_git, raw))
}

/// What the confirmation is bound to: the action, the saved source and the
/// package tree. A preview of `update` cannot confirm an `uninstall`, and a
/// preview taken before a source switch cannot confirm a run against the new
/// source, even if both trees happen to hash the same.
pub fn bound_fingerprint(op: Op, source: &str, tree: &str) -> String {
    let mut h = Sha256::new();
    for part in [op.arg(), source, tree] {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part.as_bytes());
    }
    format!("{:x}", h.finalize())
}

fn outcome(
    op: Op,
    dry_run: bool,
    dir: &Path,
    is_git: bool,
    fingerprint: String,
    c: crate::routine_cmd::Captured,
) -> RunOutcome {
    RunOutcome {
        op,
        dry_run,
        commit: if is_git { commit_of(dir) } else { None },
        fingerprint,
        exit_code: c.exit_code,
        timed_out: c.timed_out,
        output: c.output,
    }
}

/// Fetch (Git) and run `<op> --dry-run`; `check` runs as is (read-only).
/// The returned fingerprint is what `team_package_run` must see again.
#[tauri::command]
pub async fn team_package_preview(
    webview: tauri::Webview,
    app: AppHandle,
    op: Op,
) -> Result<RunOutcome, String> {
    gate(&webview, &app)?;
    let busy = take_busy()?;
    tauri::async_runtime::spawn_blocking(move || {
        // The guard lives in the closure: if the webview reloads, the
        // future is dropped but git/node keep running here, and a second
        // action must still be refused until they finish.
        let _busy = busy;
        let (dir, is_git, source) = package_dir(&app, true)?;
        let dry = op.writes();
        // Hashed BEFORE the dry run and compared after it: the user
        // confirms the tree the dry run saw. A dry run that changes the
        // package (it must not write) invalidates the preview.
        let before = fingerprint(&dir)?;
        let c = run_script(&dir, op, dry)?;
        if fingerprint(&dir)? != before {
            return Err(
                "The package changed during the preview; its dry run must not write.".into(),
            );
        }
        let fp = bound_fingerprint(op, &source, &before);
        Ok(outcome(op, dry, &dir, is_git, fp, c))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The confirmed run: no fetch, and only if the package tree still has the
/// fingerprint the user saw in the preview.
#[tauri::command]
pub async fn team_package_run(
    webview: tauri::Webview,
    app: AppHandle,
    op: Op,
    fingerprint: String,
) -> Result<RunOutcome, String> {
    gate(&webview, &app)?;
    if !op.writes() {
        return Err("check runs from the preview.".into());
    }
    let busy = take_busy()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy; // see team_package_preview
        let (dir, is_git, source) = package_dir(&app, false)?;
        let now = bound_fingerprint(op, &source, &self::fingerprint(&dir)?);
        if now != fingerprint {
            return Err("changed-since-preview".into());
        }
        let c = run_script(&dir, op, false)?;
        Ok(outcome(op, false, &dir, is_git, now, c))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_changes_with_any_file_and_skips_git() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("install.mjs"), "a").unwrap();
        std::fs::create_dir(d.path().join("rules")).unwrap();
        std::fs::write(d.path().join("rules/x.md"), "1").unwrap();
        let a = fingerprint(d.path()).unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".git/HEAD"), "x").unwrap();
        assert_eq!(fingerprint(d.path()).unwrap(), a);
        std::fs::write(d.path().join("rules/x.md"), "2").unwrap();
        let b = fingerprint(d.path()).unwrap();
        assert_ne!(a, b);
        std::fs::write(d.path().join("rules/y.md"), "").unwrap();
        assert_ne!(fingerprint(d.path()).unwrap(), b);
    }

    #[test]
    fn bound_fingerprint_covers_op_and_source() {
        let a = bound_fingerprint(Op::Update, "https://x/pkg.git", "t");
        assert_eq!(a, bound_fingerprint(Op::Update, "https://x/pkg.git", "t"));
        assert_ne!(
            a,
            bound_fingerprint(Op::Uninstall, "https://x/pkg.git", "t")
        );
        assert_ne!(a, bound_fingerprint(Op::Update, "https://y/pkg.git", "t"));
        assert_ne!(a, bound_fingerprint(Op::Update, "https://x/pkg.git", "u"));
        // Length-prefixed: moving text from one part to the next changes it.
        assert_ne!(
            bound_fingerprint(Op::Update, "ab", "c"),
            bound_fingerprint(Op::Update, "a", "bc")
        );
    }

    /// The guard is released where it is dropped (the blocking closure),
    /// not where it was taken.
    #[test]
    fn busy_guard_moves_with_the_work() {
        let g = take_busy().unwrap();
        assert!(take_busy().is_err());
        std::thread::spawn(move || drop(g)).join().unwrap();
        assert!(take_busy().is_ok());
    }

    #[test]
    fn fingerprint_separates_name_and_content() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("ab"), "c").unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(b.path().join("a"), "bc").unwrap();
        assert_ne!(
            fingerprint(a.path()).unwrap(),
            fingerprint(b.path()).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn fingerprint_refuses_junctions() {
        let d = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let link = d.path().join("j");
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(target.path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            assert!(fingerprint(d.path()).is_err());
        }
    }

    /// End to end against a local package: the script sees exactly the
    /// arguments, and a run after an edit is refused.
    #[test]
    fn script_gets_exact_args_and_edits_invalidate_the_preview() {
        let mut probe = crate::terminal_env::command("node");
        probe.arg("--version");
        if crate::routine_cmd::run_captured(probe, TIMEOUT, 1024).is_err() {
            return; // no Node.js on this machine
        }
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("install.mjs"),
            "console.log(JSON.stringify(process.argv.slice(2)))",
        )
        .unwrap();
        let c = run_script(d.path(), Op::Uninstall, true).unwrap();
        assert_eq!(c.exit_code, Some(0));
        assert_eq!(c.output.trim(), r#"["uninstall","--dry-run"]"#);
        let before = fingerprint(d.path()).unwrap();
        std::fs::write(d.path().join("install.mjs"), "process.exit(3)").unwrap();
        assert_ne!(fingerprint(d.path()).unwrap(), before);
    }
}
