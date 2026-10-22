//! Opt-in clipboard images for the Media gallery. While the renderer's
//! "Clipboard images" setting is on, a copied bitmap is saved as PNG into a
//! private temp folder and a copied image/video FILE is used in place; both are
//! allow-listed for the unrooted media route and announced as
//! `media:clipboard`. Clipboard contents can be private, so this is off by
//! default, never leaves the machine, and our PNGs are deleted (and every
//! clipboard path withdrawn from the route) when switched off or on exit.
//!
//! Threads: the OS delivers `WM_CLIPBOARDUPDATE` to clipboard-win's
//! message-only window on a watcher thread (`ClipboardWatcherContext`); its
//! handler only pokes a channel. A worker thread coalesces bursts (an app
//! often re-renders the clipboard several times per copy), then reads,
//! encodes, hashes and writes — a 4K screenshot is tens of MB of DIB, which
//! must never touch the UI thread or the async executor. If the listener
//! cannot start, the watcher thread falls back to polling the clipboard
//! sequence number once a second.

use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const PREFIX: &str = "clip-";
const SUFFIX: &str = ".png";
/// Copies are bursts of screenshots, not an archive: keep the folder small.
pub const MAX_FILES: usize = 50;
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Folders a crashed instance left behind are swept after this long.
const STALE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Parent of every instance's folder; each process owns `<parent>/<pid>` so a
/// dev instance and the installed app never delete each other's files.
fn parent_dir() -> PathBuf {
    std::env::temp_dir().join("swarmterm-clipboard")
}

pub fn instance_dir() -> PathBuf {
    parent_dir().join(std::process::id().to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    /// A new file was written; announce it.
    New(PathBuf),
    /// The same image is already stored (re-copy, or an app re-rendering
    /// the clipboard); nothing to announce.
    Known(PathBuf),
}

struct Entry {
    hash: String,
    path: PathBuf,
    bytes: u64,
}

/// Content-addressed, capped PNG folder. Pure file logic so it is testable
/// without a clipboard.
pub struct ClipStore {
    dir: PathBuf,
    max_files: usize,
    max_bytes: u64,
    /// Oldest first.
    entries: VecDeque<Entry>,
    /// Set by `clear` (app exit): a capture still in flight on the worker
    /// must not write a private image after the folder was deleted.
    closed: bool,
}

impl ClipStore {
    pub fn new(dir: PathBuf, max_files: usize, max_bytes: u64) -> Self {
        Self {
            dir,
            max_files: max_files.max(1),
            max_bytes,
            entries: VecDeque::new(),
            closed: false,
        }
    }

    pub fn save(&mut self, png: &[u8]) -> Result<Saved, String> {
        if self.closed {
            return Err("clipboard store is closed".into());
        }
        if png.len() as u64 > self.max_bytes {
            return Err("clipboard image exceeds the size cap".into());
        }
        let hash: String = Sha256::digest(png)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if let Some(i) = self.entries.iter().position(|e| e.hash == hash) {
            // Still on disk? Then it is a duplicate; refresh its age so the
            // cap evicts something older first.
            if self.entries[i].path.is_file() {
                let entry = self.entries.remove(i).expect("index in range");
                let path = entry.path.clone();
                self.entries.push_back(entry);
                return Ok(Saved::Known(path));
            }
            self.entries.remove(i);
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("Could not create {}: {e}", self.dir.display()))?;
        let path = self.dir.join(format!("{PREFIX}{}{SUFFIX}", &hash[..16]));
        std::fs::write(&path, png)
            .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        self.entries.push_back(Entry {
            hash,
            path: path.clone(),
            bytes: png.len() as u64,
        });
        self.evict();
        Ok(Saved::New(path))
    }

    /// Drop the oldest files until both caps hold; the newest always stays.
    fn evict(&mut self) {
        while self.entries.len() > 1
            && (self.entries.len() > self.max_files || self.total_bytes() > self.max_bytes)
        {
            if let Some(old) = self.entries.pop_front() {
                let _ = std::fs::remove_file(&old.path);
            }
        }
    }

    fn total_bytes(&self) -> u64 {
        self.entries.iter().map(|e| e.bytes).sum()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Accept saves again after `clear` (clipboard images switched back on).
    pub fn reopen(&mut self) {
        self.closed = false;
    }

    /// Delete every file we wrote and the instance folder itself.
    pub fn clear(&mut self) {
        self.closed = true;
        for e in self.entries.drain(..) {
            let _ = std::fs::remove_file(&e.path);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Best-effort sweep of folders a crashed instance left behind (a crash
/// skips the exit cleanup). A folder's mtime only moves when files are added,
/// so age alone would delete the files of a live but quiet instance: the
/// folder name is its pid, and a folder is removed only when that process is
/// gone AND the folder is older than `max_age` (pid reuse is then harmless).
pub fn prune_stale(
    parent: &Path,
    own: &Path,
    now: SystemTime,
    max_age: Duration,
    alive: impl Fn(u32) -> bool,
) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == own || !path.is_dir() {
            continue;
        }
        let pid = entry.file_name().to_string_lossy().parse::<u32>().ok();
        if pid.is_none_or(&alive) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > max_age);
        if stale {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(windows)]
pub use watch::ClipboardMedia;

#[cfg(windows)]
mod watch {
    use super::*;
    use crate::files::FileService;
    use clipboard_rs::{
        ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext, WatcherShutdown,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Arc, Mutex};
    use tauri::{AppHandle, Emitter, Manager};

    /// Clipboard owners often write several formats in quick succession.
    const SETTLE: Duration = Duration::from_millis(150);
    const POLL: Duration = Duration::from_secs(1);
    /// A copied selection of hundreds of files is not a screenshot.
    const MAX_FILES_PER_COPY: usize = 20;

    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ClipboardMediaEvent {
        path: String,
    }

    struct Running {
        stop: Arc<AtomicBool>,
        /// Dropping it ends the listener's `recv`.
        shutdown: Option<WatcherShutdown>,
    }

    impl Running {
        fn halt(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            drop(self.shutdown.take());
            // The worker exits on its next wake-up; its channel closes when
            // the watcher thread (the only sender) returns.
        }
    }

    /// Managed state; `set_enabled` is idempotent.
    pub struct ClipboardMedia {
        running: Mutex<Option<Running>>,
        store: Arc<Mutex<ClipStore>>,
        /// Everything the worker allow-listed (saved PNGs and copied files),
        /// so switching off can withdraw it from the unrooted route.
        registered: Arc<Mutex<Vec<PathBuf>>>,
    }

    impl Default for ClipboardMedia {
        fn default() -> Self {
            Self {
                running: Mutex::new(None),
                store: Arc::new(Mutex::new(ClipStore::new(
                    instance_dir(),
                    MAX_FILES,
                    MAX_BYTES,
                ))),
                registered: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    struct Poke(Sender<()>);
    impl ClipboardHandler for Poke {
        fn on_clipboard_change(&mut self) {
            let _ = self.0.send(());
        }
    }

    impl ClipboardMedia {
        pub fn set_enabled(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
            let mut running = self.running.lock().map_err(|e| e.to_string())?;
            if !enabled {
                // Off means off: stop, delete our PNGs and withdraw every
                // clipboard path from the unrooted route (the gallery shows
                // them as missing). Idempotent: a repeat call finds nothing.
                if let Some(r) = running.take() {
                    r.halt();
                }
                self.forget(app);
                return Ok(());
            }
            if running.is_some() {
                return Ok(());
            }
            if let Ok(mut store) = self.store.lock() {
                store.reopen();
            }
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = channel::<()>();
            let mut ctx = ClipboardWatcherContext::new().map_err(|e| e.to_string())?;
            ctx.add_handler(Poke(tx.clone()));
            let shutdown = ctx.get_shutdown_channel();
            let watch_stop = stop.clone();
            std::thread::Builder::new()
                .name("clipboard-watch".into())
                .spawn(move || watch_loop(ctx, tx, watch_stop))
                .map_err(|e| e.to_string())?;
            let worker_stop = stop.clone();
            let store = self.store.clone();
            let registered = self.registered.clone();
            let app = app.clone();
            std::thread::Builder::new()
                .name("clipboard-media".into())
                .spawn(move || worker(rx, worker_stop, store, registered, app))
                .map_err(|e| e.to_string())?;
            *running = Some(Running {
                stop,
                shutdown: Some(shutdown),
            });
            Ok(())
        }

        fn forget(&self, app: &AppHandle) {
            if let Ok(mut store) = self.store.lock() {
                store.clear();
            }
            let paths = self
                .registered
                .lock()
                .map(|mut r| std::mem::take(&mut *r))
                .unwrap_or_default();
            app.state::<Arc<FileService>>().unregister_media(&paths);
        }

        /// App exit: stop watching and delete every PNG we wrote.
        pub fn shutdown(&self) {
            if let Ok(mut running) = self.running.lock() {
                if let Some(r) = running.take() {
                    r.halt();
                }
            }
            if let Ok(mut store) = self.store.lock() {
                store.clear();
            }
        }
    }

    /// For `prune_stale`: is the process that owns a clipboard folder alive?
    fn pid_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                // Access denied means it exists; only a missing pid is dead.
                return windows_sys::Win32::Foundation::GetLastError()
                    == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            !ok || code == STILL_ACTIVE as u32
        }
    }

    fn watch_loop(mut ctx: ClipboardWatcherContext<Poke>, tx: Sender<()>, stop: Arc<AtomicBool>) {
        // clipboard-win's Monitor `expect`s on window creation; a panic there
        // must degrade to polling, not kill the feature silently.
        let listened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ctx.start_watch()));
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if listened.is_err() {
            eprintln!("[clipboard] listener failed; polling the sequence number");
        }
        // The listener returned without a stop (error or panic): poll. A
        // listener that hangs instead is not detectable from here; it is a
        // blocking GetMessage on a message-only window, which only ends on
        // shutdown, so that case is the normal one.
        // eprintln! is the backend's log channel (no logger crate).
        let seq =
            || unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        let mut last = seq();
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            let now = seq();
            if now != last {
                last = now;
                if tx.send(()).is_err() {
                    return;
                }
            }
        }
    }

    fn worker(
        rx: Receiver<()>,
        stop: Arc<AtomicBool>,
        store: Arc<Mutex<ClipStore>>,
        registered: Arc<Mutex<Vec<PathBuf>>>,
        app: AppHandle,
    ) {
        while rx.recv().is_ok() {
            std::thread::sleep(SETTLE);
            while rx.try_recv().is_ok() {}
            if stop.load(Ordering::SeqCst) {
                return;
            }
            for path in capture(&store, &stop) {
                // Capture can take a while (a big bitmap): a switch-off in
                // the meantime must not still announce clipboard content.
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let service = app.state::<Arc<FileService>>();
                // Holding `registered` across the check and the insert means a
                // concurrent switch-off (`forget` takes this lock after
                // setting `stop`) either sees this path or we see `stop`.
                let Ok(mut mine) = registered.lock() else {
                    return;
                };
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                // Re-validates (canonical regular image/video file) and
                // allow-lists it; capped like passive detection, because
                // every copy would otherwise grow the allow-list for good.
                let Some((path, added)) =
                    service.register_media_tracked(&path.to_string_lossy(), Path::new(""))
                else {
                    continue;
                };
                // Only paths this watcher added are withdrawn on switch-off.
                if added {
                    mine.push(path.clone());
                }
                drop(mine);
                let _ = app.emit(
                    "media:clipboard",
                    ClipboardMediaEvent {
                        path: crate::files::path::display(&path),
                    },
                );
            }
        }
    }

    /// Paths to announce for the current clipboard: copied media files as
    /// they are, else a bitmap saved as a NEW png (a duplicate yields none).
    fn capture(store: &Mutex<ClipStore>, stop: &AtomicBool) -> Vec<PathBuf> {
        if let Ok(files) = crate::files::clipboard::read() {
            let media: Vec<PathBuf> = files
                .iter()
                .take(MAX_FILES_PER_COPY)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute() && crate::files::FileService::is_media_path(p))
                .collect();
            // A file copy (even of non-media files) never falls through to
            // the bitmap path: Explorer also puts a thumbnail bitmap there.
            if !files.is_empty() {
                return media;
            }
        }
        let png = match crate::files::clipboard::image_png() {
            Ok(Some(png)) => png,
            _ => return Vec::new(),
        };
        let Ok(mut store) = store.lock() else {
            return Vec::new();
        };
        // Checked under the store lock: a quick off/on (`clear` + `reopen`)
        // must not let this stale worker save into the reopened store.
        if stop.load(Ordering::SeqCst) {
            return Vec::new();
        }
        if store.len() == 0 {
            prune_stale(
                &parent_dir(),
                &instance_dir(),
                SystemTime::now(),
                STALE_AGE,
                pid_alive,
            );
        }
        match store.save(&png) {
            Ok(Saved::New(path)) => vec![path],
            Ok(Saved::Known(_)) => Vec::new(),
            Err(e) => {
                eprintln!("[clipboard] {e}");
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_dedupes_by_content() {
        let t = tempfile::tempdir().unwrap();
        let mut s = ClipStore::new(t.path().join("c"), 10, 1000);
        let Saved::New(a) = s.save(b"one").unwrap() else {
            panic!("first save must be new")
        };
        assert_eq!(s.save(b"one").unwrap(), Saved::Known(a.clone()));
        assert!(matches!(s.save(b"two").unwrap(), Saved::New(_)));
        assert_eq!(s.len(), 2);
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        // A deleted file is written again instead of being reported known.
        std::fs::remove_file(&a).unwrap();
        assert_eq!(s.save(b"one").unwrap(), Saved::New(a.clone()));
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn caps_evict_oldest_by_count_and_bytes() {
        let t = tempfile::tempdir().unwrap();
        let mut s = ClipStore::new(t.path().join("c"), 2, 1000);
        let Saved::New(a) = s.save(b"a").unwrap() else {
            panic!()
        };
        let Saved::New(b) = s.save(b"b").unwrap() else {
            panic!()
        };
        // Re-copying `a` makes it the newest, so `b` is evicted next.
        assert!(matches!(s.save(b"a").unwrap(), Saved::Known(_)));
        let Saved::New(c) = s.save(b"c").unwrap() else {
            panic!()
        };
        assert!(a.exists() && c.exists() && !b.exists());

        let mut s = ClipStore::new(t.path().join("d"), 10, 10);
        let Saved::New(x) = s.save(&[1; 6]).unwrap() else {
            panic!()
        };
        let Saved::New(y) = s.save(&[2; 6]).unwrap() else {
            panic!()
        };
        assert!(!x.exists() && y.exists());
        assert!(s.save(&[3; 11]).is_err(), "over the byte cap on its own");
    }

    #[test]
    fn clear_removes_files_and_folder() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("c");
        let mut s = ClipStore::new(dir.clone(), 10, 1000);
        s.save(b"x").unwrap();
        s.clear();
        assert!(!dir.exists());
        assert_eq!(s.len(), 0);
        assert!(s.save(b"late").is_err(), "no write after exit cleanup");
        assert!(!dir.exists());
        s.reopen();
        assert!(matches!(s.save(b"again").unwrap(), Saved::New(_)));
    }

    #[test]
    fn prune_stale_spares_own_and_fresh_folders() {
        let t = tempfile::tempdir().unwrap();
        let own = t.path().join("1");
        let other = t.path().join("2");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let foreign = t.path().join("not-a-pid");
        std::fs::create_dir_all(&foreign).unwrap();
        let dead = |_: u32| false;
        prune_stale(t.path(), &own, SystemTime::now(), STALE_AGE, dead);
        assert!(other.exists(), "fresh folder survives");
        let later = SystemTime::now() + STALE_AGE * 2;
        prune_stale(t.path(), &own, later, STALE_AGE, |_| true);
        assert!(other.exists(), "a live instance's quiet folder survives");
        prune_stale(t.path(), &own, later, STALE_AGE, dead);
        assert!(!other.exists() && own.exists() && foreign.exists());
    }
}
