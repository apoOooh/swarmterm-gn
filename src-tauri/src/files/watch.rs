use super::{
    path::{display, guarded},
    FileService,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::Emitter;

pub struct WatchHandle {
    pub leases: usize,
    stop: Arc<AtomicBool>,
    extra: mpsc::Sender<PathBuf>,
}
impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    context_id: String,
    paths: Vec<String>,
    git_changed: bool,
    error: Option<String>,
}

fn ignored(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|p| {
        p.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some(
                    ".git"
                        | "node_modules"
                        | ".venv"
                        | "venv"
                        | "target"
                        | "dist"
                        | "build"
                        | ".next"
                        | ".cache"
                        | "__pycache__"
                )
            )
        })
    })
}

/// Watched directories, keyed by `watch_key` (case-folded on Windows, where
/// the file system is case-insensitive) and mapping to the path actually
/// registered with the watcher, which `unwatch` needs verbatim.
type Watched = BTreeMap<PathBuf, PathBuf>;

fn watch_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// Record `path`; true if it was not tracked yet.
fn track(watched: &mut Watched, path: &Path) -> bool {
    match watched.entry(watch_key(path)) {
        std::collections::btree_map::Entry::Occupied(_) => false,
        std::collections::btree_map::Entry::Vacant(v) => {
            v.insert(path.to_path_buf());
            true
        }
    }
}

fn add_tree(
    watcher: &mut RecommendedWatcher,
    path: &Path,
    root: &Path,
    watched: &mut Watched,
) -> Result<(), String> {
    if ignored(path, root)
        || fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
        || !path.is_dir()
    {
        return Ok(());
    }
    if track(watched, path) {
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        for item in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
            if item
                .file_type()
                .is_ok_and(|k| k.is_dir() && !k.is_symlink())
            {
                add_tree(watcher, &item.path(), root, watched)?;
            }
        }
    }
    Ok(())
}

/// Adds a lease to an already running watcher. Returns the extra paths back when
/// the context has no watcher yet, so the caller can build one.
fn lease_existing(
    watchers: &std::sync::Mutex<std::collections::HashMap<String, WatchHandle>>,
    context_id: &str,
    extra: Vec<PathBuf>,
) -> Result<Option<Vec<PathBuf>>, String> {
    let mut watchers = watchers.lock().map_err(|e| e.to_string())?;
    match watchers.get_mut(context_id) {
        Some(handle) => {
            handle.leases += 1;
            for path in extra {
                let _ = handle.extra.send(path);
            }
            Ok(None)
        }
        None => Ok(Some(extra)),
    }
}

/// Watched directories at or below `path`, as (key, registered path). Keys of
/// descendants sort directly after their ancestor's, so a range scan replaces
/// a full pass.
fn watched_subtree(watched: &Watched, path: &Path) -> Vec<(PathBuf, PathBuf)> {
    let key = watch_key(path);
    watched
        .range(key.clone()..)
        .take_while(|(k, _)| k.starts_with(&key))
        .map(|(k, p)| (k.clone(), p.clone()))
        .collect()
}

impl FileService {
    pub fn watch(
        &self,
        context_id: &str,
        files: Vec<String>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let root = self.root(context_id)?;
        let extra: Result<Vec<_>, _> = files.iter().map(|p| guarded(&root, p, false)).collect();
        let extra = extra?;
        // Fast path: an existing watcher just gains a lease. The tree walk below runs
        // without the lock so a large project never blocks unwatch or other contexts.
        let Some(extra) = lease_existing(&self.watchers, context_id, extra)? else {
            return Ok(());
        };
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(move |e| {
            let _ = tx.send(e);
        })
        .map_err(|e| e.to_string())?;
        let mut watched = Watched::new();
        add_tree(&mut watcher, &root, &root, &mut watched)?;
        // Worktree .git files point to metadata elsewhere. Watch only that metadata, never its project tree.
        let git = root.join(".git");
        let git_dir = if git.is_file() {
            fs::read_to_string(&git).ok().and_then(|s| {
                s.trim().strip_prefix("gitdir: ").map(|p| {
                    let p = PathBuf::from(p);
                    if p.is_absolute() {
                        p
                    } else {
                        root.join(p)
                    }
                })
            })
        } else if git.is_dir() {
            Some(git)
        } else {
            None
        };
        if let Some(git) = git_dir {
            let _ = watcher.watch(&git, RecursiveMode::NonRecursive);
            let common = fs::read_to_string(git.join("commondir"))
                .ok()
                .map(|p| git.join(p.trim()));
            for metadata in [Some(git), common].into_iter().flatten() {
                for refs in [metadata.join("refs/heads"), metadata.join("refs/remotes")] {
                    if refs.is_dir() {
                        let _ = watcher.watch(&refs, RecursiveMode::Recursive);
                    }
                }
            }
        }
        let (extra_tx, extra_rx) = mpsc::channel();
        for path in extra {
            let _ = extra_tx.send(path);
        }
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = watchers.get_mut(context_id) {
            // Another call registered this context while we walked the tree; ours is dropped.
            handle.leases += 1;
            for path in extra_rx.try_iter() {
                let _ = handle.extra.send(path);
            }
            return Ok(());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let id = context_id.to_owned();
        std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                for path in extra_rx.try_iter() {
                    if let Some(parent) = path.parent() {
                        if track(&mut watched, parent) {
                            let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
                        }
                    }
                }
                let first = match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(e) => e,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                let mut batch = vec![first];
                // Drain a short burst; do not delay an active editor indefinitely under continuous writes.
                let deadline = std::time::Instant::now() + Duration::from_millis(80);
                while std::time::Instant::now() < deadline {
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(e) => batch.push(e),
                        Err(_) => break,
                    }
                }
                let mut changed = BTreeSet::new();
                let mut error = None;
                for event in batch {
                    match event {
                        Ok(e) => {
                            if !matches!(e.kind, EventKind::Access(_)) {
                                changed.extend(e.paths);
                            }
                        }
                        Err(e) => error = Some(e.to_string()),
                    }
                }
                let mut paths = BTreeSet::new();
                // Each distinct path is handled once per batch.
                for path in changed {
                    // Follow newly created folders; heavy generated directories stay pruned.
                    if !path.exists() {
                        for (key, removed) in watched_subtree(&watched, &path) {
                            let _ = watcher.unwatch(&removed);
                            watched.remove(&key);
                        }
                    }
                    if path.is_dir() {
                        if let Err(e) = add_tree(&mut watcher, &path, &root, &mut watched) {
                            error = Some(e);
                        }
                    }
                    paths.insert(display(&path));
                }
                if !paths.is_empty() || error.is_some() {
                    let _ = app.emit_to(
                        "main",
                        "files:changed",
                        Change {
                            context_id: id.clone(),
                            paths: paths.into_iter().collect(),
                            git_changed: true,
                            error,
                        },
                    );
                }
            }
        });
        watchers.insert(
            context_id.to_owned(),
            WatchHandle {
                leases: 1,
                stop,
                extra: extra_tx,
            },
        );
        Ok(())
    }

    pub fn unwatch(&self, id: &str) {
        if let Ok(mut handles) = self.watchers.lock() {
            if let Some(handle) = handles.get_mut(id) {
                handle.leases = handle.leases.saturating_sub(1);
                if handle.leases == 0 {
                    handles.remove(id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_only_generated_subtrees_and_does_not_follow_links() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("src/nested")).unwrap();
        fs::create_dir_all(t.path().join("node_modules/large")).unwrap();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        let mut watched = Watched::new();
        add_tree(&mut watcher, t.path(), t.path(), &mut watched).unwrap();
        assert!(watched.contains_key(&watch_key(&t.path().join("src/nested"))));
        assert!(!watched.contains_key(&watch_key(&t.path().join("node_modules"))));
    }
    #[test]
    fn watched_subtree_returns_only_descendants() {
        let mut watched = Watched::new();
        for p in ["a", "a/b", "a/b/c", "a/b0", "a/c", "b"] {
            track(&mut watched, Path::new(p));
        }
        let got: Vec<_> = watched_subtree(&watched, Path::new("a/b"))
            .into_iter()
            .map(|(_, p)| p)
            .collect();
        assert_eq!(got, vec![PathBuf::from("a/b"), PathBuf::from("a/b/c")]);
        assert!(watched_subtree(&watched, Path::new("z")).is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn watched_subtree_ignores_case_on_windows() {
        let mut watched = Watched::new();
        for p in [r"C:\Repo\Src", r"C:\Repo\Src\Lib", r"C:\Repo\Other"] {
            track(&mut watched, Path::new(p));
        }
        assert!(!track(&mut watched, Path::new(r"c:\repo\SRC")));
        let got: Vec<_> = watched_subtree(&watched, Path::new(r"c:\REPO\src"))
            .into_iter()
            .map(|(_, p)| p)
            .collect();
        // Originals come back verbatim for unwatch.
        assert_eq!(
            got,
            vec![
                PathBuf::from(r"C:\Repo\Src"),
                PathBuf::from(r"C:\Repo\Src\Lib")
            ]
        );
    }
    #[test]
    fn native_watcher_receives_external_creation() {
        let t = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        watcher
            .watch(t.path(), RecursiveMode::NonRecursive)
            .unwrap();
        fs::write(t.path().join("created.txt"), "external").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut received = false;
        while std::time::Instant::now() < deadline {
            if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(100)) {
                if event.paths.iter().any(|p| p.ends_with("created.txt")) {
                    received = true;
                    break;
                }
            }
        }
        assert!(received);
    }
}
