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
    sync::mpsc,
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
/// How long one batch keeps draining after its first event, so an editor save
/// (write + rename + attrib) coalesces into one change without delaying it.
const BATCH_WINDOW: Duration = Duration::from_millis(80);
const BATCH_GAP: Duration = Duration::from_millis(10);

/// Everything the watcher thread reacts to arrives on ONE channel, so with no
/// storm pending it blocks without any idle tick and still stops at once.
enum Msg {
    Event(notify::Result<Event>),
    Extra(PathBuf),
    Stop,
}

pub struct WatchHandle {
    pub leases: usize,
    tx: mpsc::Sender<Msg>,
}
impl Drop for WatchHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
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

/// Storm mode. A batch of `RESCAN_BURST` raw events (cargo build, npm install)
/// may have overflowed the native buffer, so its individual paths are not
/// trustworthy anyway: from then on batches are only counted, never filtered
/// or emitted, and one rescan goes out once the tree has been quiet for
/// `RESCAN_QUIET`. The rescan reloads everything, so no final state is lost.
#[derive(Default)]
struct Storm {
    since: Option<Instant>,
}

impl Storm {
    /// Records a batch; true when its events should be processed one by one.
    fn record(&mut self, raw_events: usize, now: Instant) -> bool {
        // Any batch during a storm extends the quiet window: still busy.
        if raw_events >= RESCAN_BURST || self.since.is_some() {
            self.since = Some(now);
            false
        } else {
            true
        }
    }
    /// How long to wait for the next event: forever when calm, until the
    /// rescan is due during a storm.
    fn wait(&self, now: Instant) -> Option<Duration> {
        self.since
            .map(|t| RESCAN_QUIET.saturating_sub(now.saturating_duration_since(t)))
    }
    fn due(&mut self, now: Instant) -> bool {
        match self.since {
            Some(t) if now.saturating_duration_since(t) >= RESCAN_QUIET => {
                self.since = None;
                true
            }
            _ => false,
        }
    }
}

enum Recv {
    Msg(Msg),
    Timeout,
    Closed,
}

/// The watcher thread's input, abstracted so tests can script events and time.
trait Source {
    /// `None` blocks until a message arrives.
    fn recv(&mut self, timeout: Option<Duration>) -> Recv;
}

impl Source for mpsc::Receiver<Msg> {
    fn recv(&mut self, timeout: Option<Duration>) -> Recv {
        let got = match timeout {
            None => mpsc::Receiver::recv(self).map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            Some(t) => self.recv_timeout(t),
        };
        match got {
            Ok(m) => Recv::Msg(m),
            Err(mpsc::RecvTimeoutError::Timeout) => Recv::Timeout,
            Err(mpsc::RecvTimeoutError::Disconnected) => Recv::Closed,
        }
    }
}

/// Watcher thread body: batches events, filters them, and switches to storm
/// mode under event floods. `emit(paths, rescan, error)`. Returns on `Stop` or
/// when every sender is gone.
fn pump(
    src: &mut impl Source,
    now: impl Fn() -> Instant,
    filter: &mut Filter,
    mut emit: impl FnMut(Vec<String>, bool, Option<String>),
) {
    let mut storm = Storm::default();
    loop {
        let first = match src.recv(storm.wait(now())) {
            Recv::Msg(m) => m,
            Recv::Timeout => {
                if storm.due(now()) {
                    emit(Vec::new(), true, None);
                }
                continue;
            }
            // Every sender is gone, so nobody listens for a pending rescan.
            Recv::Closed => return,
        };
        let mut batch = Vec::new();
        let take = |m: Msg, batch: &mut Vec<_>, filter: &mut Filter| match m {
            Msg::Event(e) => {
                batch.push(e);
                true
            }
            Msg::Extra(p) => {
                filter.explicit.insert(watch_key(&p));
                true
            }
            // Queued behind earlier events; returning drops the rest unread.
            Msg::Stop => false,
        };
        if !take(first, &mut batch, filter) {
            return;
        }
        // Drain a short burst; do not delay an active editor indefinitely under continuous writes.
        let deadline = now() + BATCH_WINDOW;
        while now() < deadline {
            match src.recv(Some(BATCH_GAP)) {
                Recv::Msg(m) => {
                    if !take(m, &mut batch, filter) {
                        return;
                    }
                }
                // Closed: still report this batch; the next recv returns.
                Recv::Timeout | Recv::Closed => break,
            }
        }
        if batch.is_empty() || !storm.record(batch.len(), now()) {
            continue;
        }
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
    tx: mpsc::Sender<Msg>,
) -> Result<RecommendedWatcher, String> {
    let mut watcher = notify::recommended_watcher(move |e| {
        let _ = tx.send(Msg::Event(e));
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
                let _ = handle.tx.send(Msg::Extra(path));
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
        let (tx, rx) = mpsc::channel::<Msg>();
        let git = git_watches(&root);
        let watcher = native_watcher(&root, &git, tx.clone())?;
        let mut filter = Filter {
            root,
            git,
            explicit: extra.iter().map(|p| watch_key(p)).collect(),
        };
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = watchers.get_mut(context_id) {
            // Another call registered this context meanwhile; ours is dropped.
            handle.leases += 1;
            for path in extra {
                let _ = handle.tx.send(Msg::Extra(path));
            }
            return Ok(());
        }
        let id = context_id.to_owned();
        std::thread::spawn(move || {
            // Owned by the thread: dropping it on stop closes the native handle.
            let _watcher = watcher;
            let mut rx = rx;
            pump(
                &mut rx,
                Instant::now,
                &mut filter,
                |paths, rescan, error| {
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
                },
            );
        });
        watchers.insert(context_id.to_owned(), WatchHandle { leases: 1, tx });
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
    fn storm_rescans_once_after_quiet() {
        let t0 = Instant::now();
        let mut b = Storm::default();
        assert!(b.record(3, t0), "small batches are processed");
        assert_eq!(b.wait(t0), None, "calm: block without an idle tick");
        assert!(!b.due(t0 + RESCAN_QUIET * 2), "small batches never rescan");
        assert!(!b.record(RESCAN_BURST, t0));
        // Smaller follow-up batches keep the storm open and are skipped.
        assert!(!b.record(1, t0 + RESCAN_QUIET / 2));
        assert_eq!(b.wait(t0 + RESCAN_QUIET), Some(RESCAN_QUIET / 2));
        assert!(!b.due(t0 + RESCAN_QUIET));
        assert!(b.due(t0 + RESCAN_QUIET / 2 + RESCAN_QUIET));
        assert!(!b.due(t0 + RESCAN_QUIET * 10), "only once");
        assert!(b.record(1, t0 + RESCAN_QUIET * 10), "calm again");
    }

    enum Step {
        Msg(Msg),
        Gap(Duration),
    }

    /// Scripted event source over a fake clock: `Gap`s advance time, messages
    /// arrive instantly. Records every timeout the pump asked for.
    struct Fake {
        steps: std::collections::VecDeque<Step>,
        clock: std::rc::Rc<std::cell::Cell<Instant>>,
        waits: Vec<Option<Duration>>,
    }

    impl Source for Fake {
        fn recv(&mut self, timeout: Option<Duration>) -> Recv {
            self.waits.push(timeout);
            loop {
                match self.steps.pop_front() {
                    None => return Recv::Closed,
                    Some(Step::Msg(m)) => return Recv::Msg(m),
                    Some(Step::Gap(d)) => match timeout {
                        Some(t) if t < d => {
                            self.clock.set(self.clock.get() + t);
                            self.steps.push_front(Step::Gap(d - t));
                            return Recv::Timeout;
                        }
                        _ => self.clock.set(self.clock.get() + d),
                    },
                }
            }
        }
    }

    fn ev(path: &str) -> Step {
        Step::Msg(Msg::Event(Ok(Event::new(EventKind::Modify(
            notify::event::ModifyKind::Any,
        ))
        .add_path(PathBuf::from(path)))))
    }

    type Emitted = Vec<(Vec<String>, bool)>;

    fn run(steps: Vec<Step>) -> (Emitted, Vec<Option<Duration>>) {
        let clock = std::rc::Rc::new(std::cell::Cell::new(Instant::now()));
        let mut src = Fake {
            steps: steps.into(),
            clock: clock.clone(),
            waits: Vec::new(),
        };
        let mut f = filter(Path::new("/p"), Vec::new());
        let mut out = Vec::new();
        pump(
            &mut src,
            || clock.get(),
            &mut f,
            |paths, rescan, _| out.push((paths, rescan)),
        );
        (out, src.waits)
    }

    #[test]
    fn pump_coalesces_a_batch_into_one_change() {
        let ms = Duration::from_millis;
        let (out, waits) = run(vec![
            ev("/p/a.txt"),
            Step::Gap(ms(5)),
            ev("/p/a.txt"),
            ev("/p/b.txt"),
            ev("/p/node_modules/x/y.js"),
            Step::Gap(ms(1000)),
            ev("/p/c.txt"),
        ]);
        let a = display(Path::new("/p/a.txt"));
        let b = display(Path::new("/p/b.txt"));
        let c = display(Path::new("/p/c.txt"));
        assert_eq!(out, vec![(vec![a, b], false), (vec![c], false)]);
        assert_eq!(waits[0], None, "idle waits block, no tick");
    }

    #[test]
    fn pump_skips_storm_events_and_rescans_once_when_quiet() {
        let ms = Duration::from_millis;
        let mut steps = Vec::new();
        // A flood: several full batches back to back, then a lone straggler.
        for i in 0..(RESCAN_BURST * 3) {
            steps.push(ev(&format!("/p/src/f{i}.rs")));
            if i % 100 == 99 {
                steps.push(Step::Gap(ms(100)));
            }
        }
        steps.push(Step::Gap(ms(300)));
        steps.push(ev("/p/src/late.rs"));
        // Quiet: the rescan goes out, then normal processing resumes.
        steps.push(Step::Gap(RESCAN_QUIET * 3));
        steps.push(ev("/p/after.txt"));
        let (out, waits) = run(steps);
        assert_eq!(
            out,
            vec![
                (Vec::new(), true),
                (vec![display(Path::new("/p/after.txt"))], false)
            ],
            "no per-file changes during the storm, one rescan after it"
        );
        assert!(
            waits.contains(&Some(RESCAN_QUIET)),
            "a storm waits exactly for the quiet window"
        );
    }

    #[test]
    fn pump_stop_mid_batch_drops_the_batch() {
        let (out, _) = run(vec![ev("/p/a.txt"), Step::Msg(Msg::Stop), ev("/p/b.txt")]);
        assert!(out.is_empty());
    }

    #[test]
    fn pump_closed_during_a_storm_ends_without_rescan() {
        let steps = (0..RESCAN_BURST).map(|i| ev(&format!("/p/f{i}"))).collect();
        let (out, _) = run(steps);
        assert!(out.is_empty());
    }

    #[test]
    fn pump_tracks_extra_files_and_stops() {
        let (out, _) = run(vec![
            Step::Msg(Msg::Extra(PathBuf::from("/p/dist/out.js"))),
            Step::Gap(Duration::from_secs(1)),
            ev("/p/dist/out.js"),
            Step::Gap(Duration::from_secs(1)),
            Step::Msg(Msg::Stop),
            ev("/p/never.txt"),
        ]);
        assert_eq!(
            out,
            vec![(vec![display(Path::new("/p/dist/out.js"))], false)]
        );
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
            if let Ok(Msg::Event(Ok(event))) = rx.recv_timeout(Duration::from_millis(100)) {
                received = event.paths.iter().any(|p| p.ends_with("created.txt"));
            }
        }
        assert!(received);
    }
}
