use super::{
    path::{display, guarded},
    FileService,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

/// Raw events in one batch from which a trailing rescan is sent. The whole
/// context shares ONE ReadDirectoryChangesW buffer (16 KiB in notify 8), and
/// notify drops an overflow silently (no Rescan flag), so a burst this size may
/// have lost events we can never see.
const RESCAN_BURST: usize = 64;
/// Quiet time after the last burst before the rescan goes out, so a long
/// `npm install` triggers one rescan at its end instead of one per batch.
const RESCAN_QUIET: Duration = Duration::from_millis(500);

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
    /// Events may have been lost: reload everything shown for this context.
    rescan: bool,
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

/// Case-folded on Windows, where the file system is case-insensitive.
fn watch_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// Git metadata whose changes refresh git status: the git dir itself (HEAD,
/// index) and the branch refs. Worktree `.git` files point to metadata
/// elsewhere; watch only that metadata, never its project tree.
fn git_watches(root: &Path) -> Vec<(PathBuf, RecursiveMode)> {
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
    let Some(git) = git_dir else {
        return Vec::new();
    };
    let mut watches = vec![(git.clone(), RecursiveMode::NonRecursive)];
    let common = fs::read_to_string(git.join("commondir"))
        .ok()
        .map(|p| git.join(p.trim()));
    for metadata in [Some(git), common].into_iter().flatten() {
        for refs in [metadata.join("refs/heads"), metadata.join("refs/remotes")] {
            if refs.is_dir() {
                watches.push((refs, RecursiveMode::Recursive));
            }
        }
    }
    watches
}

/// Decides which raw events reach the renderer. The root is watched
/// recursively, so `ignored()` moves from "which folders get a watch" to "which
/// events count"; filtering on the parent keeps the old semantics (a new
/// `node_modules` shows up, churn inside it does not).
struct Filter {
    root: PathBuf,
    git: Vec<(PathBuf, RecursiveMode)>,
    /// Files a caller asked for explicitly (open documents); always reported,
    /// even inside an ignored folder.
    explicit: BTreeSet<PathBuf>,
}

impl Filter {
    fn passes(&self, path: &Path) -> bool {
        let key = watch_key(path);
        if self.explicit.contains(&key) {
            return true;
        }
        let parent = path.parent().unwrap_or(path);
        if !ignored(parent, &self.root) {
            return true;
        }
        let parent = watch_key(parent);
        self.git.iter().any(|(dir, mode)| {
            let dir = watch_key(dir);
            match mode {
                RecursiveMode::Recursive => key.starts_with(&dir),
                RecursiveMode::NonRecursive => parent == dir,
            }
        })
    }
}

/// Tracks whether a burst may have overflowed the native buffer, and when the
/// trailing rescan for it is due.
#[derive(Default)]
struct Burst {
    since: Option<Instant>,
}

impl Burst {
    fn record(&mut self, raw_events: usize, now: Instant) {
        // Any batch after a burst extends the quiet window: still busy.
        if raw_events >= RESCAN_BURST || self.since.is_some() {
            self.since = Some(now);
        }
    }
    fn due(&mut self, now: Instant) -> bool {
        match self.since {
            Some(t) if now.duration_since(t) >= RESCAN_QUIET => {
                self.since = None;
                true
            }
            _ => false,
        }
    }
}

/// One RECURSIVE watch on the root, never one per folder. On Windows each
/// watch is an open directory handle, and Windows refuses to rename or move a
/// folder while a handle is open anywhere BELOW it (ERROR_ACCESS_DENIED,
/// regardless of FILE_SHARE_DELETE). Per-folder watches therefore locked every
/// folder of the tree against renames (git, npm, pip, cargo and build tools
/// rename temp dirs); a recursive watch pins only the root itself. It also
/// spares the startup walk (40k+ folders in a large workspace).
fn native_watcher(
    root: &Path,
    git: &[(PathBuf, RecursiveMode)],
    tx: mpsc::Sender<notify::Result<Event>>,
) -> Result<RecommendedWatcher, String> {
    let mut watcher = notify::recommended_watcher(move |e| {
        let _ = tx.send(e);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    for (path, mode) in git {
        let _ = watcher.watch(path, *mode);
    }
    Ok(watcher)
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
        // Fast path: an existing watcher just gains a lease; setup below runs
        // without the lock so it never blocks unwatch or other contexts.
        let Some(extra) = lease_existing(&self.watchers, context_id, extra)? else {
            return Ok(());
        };
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let git = git_watches(&root);
        let watcher = native_watcher(&root, &git, tx)?;
        let mut filter = Filter {
            root,
            git,
            explicit: BTreeSet::new(),
        };
        let (extra_tx, extra_rx) = mpsc::channel();
        for path in extra {
            let _ = extra_tx.send(path);
        }
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = watchers.get_mut(context_id) {
            // Another call registered this context meanwhile; ours is dropped.
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
            // Owned by the thread: dropping it on stop closes the native handle.
            let _watcher = watcher;
            let mut burst = Burst::default();
            let emit = |paths: Vec<String>, rescan: bool, error: Option<String>| {
                let _ = app.emit_to(
                    "main",
                    "files:changed",
                    Change {
                        context_id: id.clone(),
                        paths,
                        git_changed: true,
                        rescan,
                        error,
                    },
                );
            };
            while !thread_stop.load(Ordering::Acquire) {
                for path in extra_rx.try_iter() {
                    filter.explicit.insert(watch_key(&path));
                }
                let first = match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(e) => e,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if burst.due(Instant::now()) {
                            emit(Vec::new(), true, None);
                        }
                        continue;
                    }
                    Err(_) => break,
                };
                let mut batch = vec![first];
                // Drain a short burst; do not delay an active editor indefinitely under continuous writes.
                let deadline = Instant::now() + Duration::from_millis(80);
                while Instant::now() < deadline {
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(e) => batch.push(e),
                        Err(_) => break,
                    }
                }
                burst.record(batch.len(), Instant::now());
                let mut paths = BTreeSet::new();
                let mut error = None;
                for event in batch {
                    match event {
                        Ok(e) => {
                            if !matches!(e.kind, EventKind::Access(_)) {
                                paths.extend(
                                    e.paths
                                        .iter()
                                        .filter(|p| filter.passes(p))
                                        .map(|p| display(p)),
                                );
                            }
                        }
                        Err(e) => error = Some(e.to_string()),
                    }
                }
                if !paths.is_empty() || error.is_some() {
                    emit(paths.into_iter().collect(), false, error);
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

    fn filter(root: &Path, git: Vec<(PathBuf, RecursiveMode)>) -> Filter {
        Filter {
            root: root.to_path_buf(),
            git,
            explicit: BTreeSet::new(),
        }
    }

    #[test]
    fn filter_drops_churn_inside_ignored_folders_but_shows_the_folder() {
        let root = Path::new("/p");
        let f = filter(root, Vec::new());
        assert!(f.passes(Path::new("/p/src/main.rs")));
        assert!(f.passes(Path::new("/p/a/b/c/deep.txt")));
        // The folder itself appears in its (watched) parent.
        assert!(f.passes(Path::new("/p/node_modules")));
        assert!(!f.passes(Path::new("/p/node_modules/x/index.js")));
        assert!(!f.passes(Path::new("/p/web/target/debug/app.exe")));
    }

    #[test]
    fn filter_keeps_git_metadata_and_explicit_files() {
        let root = Path::new("/p");
        let mut f = filter(
            root,
            vec![
                (PathBuf::from("/p/.git"), RecursiveMode::NonRecursive),
                (
                    PathBuf::from("/p/.git/refs/heads"),
                    RecursiveMode::Recursive,
                ),
            ],
        );
        assert!(f.passes(Path::new("/p/.git/index")));
        assert!(f.passes(Path::new("/p/.git/refs/heads/feature/x")));
        assert!(!f.passes(Path::new("/p/.git/objects/ab/cdef")));
        assert!(!f.passes(Path::new("/p/.git/refs/tags/v1")));
        assert!(!f.passes(Path::new("/p/dist/out.js")));
        f.explicit.insert(watch_key(Path::new("/p/dist/out.js")));
        assert!(f.passes(Path::new("/p/dist/out.js")));
    }

    #[cfg(windows)]
    #[test]
    fn filter_ignores_case_on_windows() {
        let mut f = filter(
            Path::new(r"C:\Repo"),
            vec![(PathBuf::from(r"C:\Repo\.git"), RecursiveMode::NonRecursive)],
        );
        assert!(f.passes(Path::new(r"C:\Repo\.GIT\HEAD")));
        f.explicit
            .insert(watch_key(Path::new(r"C:\Repo\Dist\A.js")));
        assert!(f.passes(Path::new(r"c:\repo\dist\a.JS")));
    }

    #[test]
    fn git_watches_follow_worktree_metadata() {
        let t = tempfile::tempdir().unwrap();
        let main_git = t.path().join("repo/.git");
        let wt_git = main_git.join("worktrees/wt");
        fs::create_dir_all(main_git.join("refs/heads")).unwrap();
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("commondir"), "../..").unwrap();
        let wt = t.path().join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        let got = git_watches(&wt);
        assert_eq!(got[0].0, wt_git);
        assert!(matches!(got[0].1, RecursiveMode::NonRecursive));
        assert_eq!(got.len(), 2);
        assert!(got[1].0.ends_with("refs/heads"));
        assert!(git_watches(t.path()).is_empty());
    }

    #[test]
    fn burst_rescans_once_after_quiet() {
        let t0 = Instant::now();
        let mut b = Burst::default();
        b.record(3, t0);
        assert!(!b.due(t0 + RESCAN_QUIET * 2), "small batches never rescan");
        b.record(RESCAN_BURST, t0);
        // Smaller follow-up batches keep the burst open.
        b.record(1, t0 + RESCAN_QUIET / 2);
        assert!(!b.due(t0 + RESCAN_QUIET));
        assert!(b.due(t0 + RESCAN_QUIET / 2 + RESCAN_QUIET));
        assert!(!b.due(t0 + RESCAN_QUIET * 10), "only once");
    }

    /// Regression for SWA-53: watching must not lock subfolders against
    /// renames, and changes deep in the tree must still arrive.
    #[test]
    fn subfolders_stay_renameable_and_deep_changes_arrive() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("a/b/c")).unwrap();
        fs::write(t.path().join("a/b/c/f.txt"), "x").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = native_watcher(t.path(), &[], tx).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // Retry briefly: a virus scanner may hold the fresh file for a moment,
        // while a watch handle below the folder would block it for good.
        let rename = |from: &str, to: &str| {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match fs::rename(t.path().join(from), t.path().join(to)) {
                    Ok(()) => return,
                    Err(e) if Instant::now() > deadline => panic!("rename {from}: {e}"),
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        };
        rename("a", "a2");
        rename("a2/b", "a2/b2");
        fs::write(t.path().join("a2/b2/c/created.txt"), "external").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut received = false;
        while Instant::now() < deadline && !received {
            if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(100)) {
                received = event.paths.iter().any(|p| p.ends_with("created.txt"));
            }
        }
        assert!(received);
    }
}
