//! UI-thread stall watchdog (SWA-85).
//!
//! Windows reports a window as "not responding" (AppHangB1) when its UI
//! thread stops pumping messages for 5 s. In Tauri that thread also runs every
//! synchronous `#[tauri::command]`, synchronous scheme handlers and the
//! WebView2 callbacks, so a stall leaves no trace: release builds write no
//! log and WER keeps no dump for a hang the user closed. This watchdog makes
//! the next stall diagnosable:
//!
//! - one ping at a time is posted with `run_on_main_thread`; the closure
//!   stamps when it ran. A stall is the time a ping stays unanswered, measured
//!   by this thread, so it is seen while it lasts, not only afterwards (the
//!   `profiling` build's `main.dispatch_delay` only learns of it at the end);
//! - every stall of at least `LOG_MS` ends as one line in
//!   `<local data>\diagnostics\ui-stalls.log` (time and duration, no content);
//! - with the opt-in setting, a stall of `DUMP_MS` writes ONE minidump per
//!   stall, taken by a separate process (`swarmterm --dump-ui`, see
//!   `dump_ui.rs`). Never in-process: `MiniDumpWriteDump` suspends the other
//!   threads, and if the stuck UI thread holds the heap or loader lock, the
//!   dumping thread would wait on it forever and turn a recoverable stall
//!   into a permanent hang.
//!
//! When the watchdog itself was not scheduled for `MAX_TICK_GAP_MS` (sleep,
//! hibernate, the whole machine starving) the current measurement is
//! dropped: it would blame the UI thread for time nobody ran.

use std::path::{Path, PathBuf};

/// Watchdog period. Coarse on purpose: a stall shorter than this is not news.
pub const TICK_MS: u64 = 250;
/// A ping open this long is logged as a stall once it is answered.
pub const LOG_MS: u64 = 2_000;
/// A ping open this long takes the dump (if enabled), once per stall. Below
/// Windows' 5 s so the dump shows the stack before the user closes the app.
pub const DUMP_MS: u64 = 4_000;
/// Gap between two watchdog ticks after which the measurement is distrusted.
pub const MAX_TICK_GAP_MS: u64 = 2_000;
/// Dump slots `ui-stall-<n>.dmp`; the oldest is replaced.
pub const DUMP_SLOTS: usize = 3;
/// The log is rotated to `ui-stalls.old.log` beyond this size.
pub const LOG_CAP: u64 = 64 * 1024;

/// What one tick asks the runtime to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step {
    /// Post a new ping (none is in flight).
    pub post: bool,
    /// Take the dump of this stall now.
    pub dump: bool,
    /// A stall ended: its length in ms.
    pub log: Option<u64>,
}

/// Pure stall bookkeeping; times are monotonic milliseconds.
#[derive(Debug, Default)]
pub struct Monitor {
    posted: Option<u64>,
    last_tick: Option<u64>,
    dumped: bool,
    tainted: bool,
}

impl Monitor {
    /// `answered`: when the closure of the ping in flight ran, if it did.
    pub fn tick(&mut self, now: u64, answered: Option<u64>) -> Step {
        if self
            .last_tick
            .is_some_and(|t| now.saturating_sub(t) > MAX_TICK_GAP_MS)
        {
            self.tainted = true;
        }
        self.last_tick = Some(now);
        let mut step = Step::default();
        match (self.posted, answered) {
            (Some(posted), Some(at)) => {
                let stalled = at.saturating_sub(posted);
                if stalled >= LOG_MS && !self.tainted {
                    step.log = Some(stalled);
                }
                self.posted = None;
                self.dumped = false;
                self.tainted = false;
            }
            (Some(posted), None) => {
                if now.saturating_sub(posted) >= DUMP_MS && !self.dumped && !self.tainted {
                    self.dumped = true;
                    step.dump = true;
                }
            }
            (None, _) => {}
        }
        if self.posted.is_none() {
            self.posted = Some(now);
            // A ping posted after a gap is a fresh measurement.
            self.tainted = false;
            step.post = true;
        }
        step
    }
}

/// Slot to write the next dump to: the first free one, else the oldest.
/// `modified[i]` is the age key of `ui-stall-<i+1>.dmp` (`None` = missing).
pub fn pick_slot<T: Ord + Copy>(modified: &[Option<T>]) -> usize {
    if let Some(free) = modified.iter().position(Option::is_none) {
        return free;
    }
    modified
        .iter()
        .enumerate()
        .min_by_key(|(_, m)| m.expect("all present"))
        .map_or(0, |(i, _)| i)
}

pub fn dump_path(dir: &Path, slot: usize) -> PathBuf {
    dir.join(format!("ui-stall-{}.dmp", slot + 1))
}

/// One log line: Unix ms (local clock) and the stall length.
pub fn log_line(unix_ms: u64, stalled_ms: u64, dumped: bool) -> String {
    format!(
        "{unix_ms} ui-stall {stalled_ms} ms{}\n",
        if dumped { " (dump written)" } else { "" }
    )
}

#[cfg(windows)]
mod runtime {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Manager};

    /// Set by the Diagnostics setting (and forced off by the admin policy
    /// when the watchdog reads it).
    static DUMPS_WANTED: AtomicBool = AtomicBool::new(false);

    pub fn set_dumps_enabled(on: bool) {
        DUMPS_WANTED.store(on, Ordering::Release);
    }

    fn epoch() -> Instant {
        static E: OnceLock<Instant> = OnceLock::new();
        *E.get_or_init(Instant::now)
    }

    fn now_ms() -> u64 {
        // +1 keeps 0 free as "not answered" in the atomic.
        epoch().elapsed().as_millis() as u64 + 1
    }

    pub fn start(app: &AppHandle) {
        let Ok(dir) = app
            .path()
            .app_local_data_dir()
            .map(|d| d.join("diagnostics"))
        else {
            return;
        };
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let app = app.clone();
        let answered = Arc::new(AtomicU64::new(0));
        let _ = std::thread::Builder::new()
            .name("ui-watchdog".into())
            .spawn(move || {
                let mut monitor = Monitor::default();
                let pid = std::process::id().to_string();
                let mut dumped_this_stall = false;
                loop {
                    std::thread::sleep(Duration::from_millis(TICK_MS));
                    let at = answered.swap(0, Ordering::AcqRel);
                    let step = monitor.tick(now_ms(), (at != 0).then_some(at));
                    if let Some(stalled) = step.log {
                        write_log(&dir, stalled, dumped_this_stall);
                    }
                    if step.log.is_some() || step.post {
                        dumped_this_stall = false;
                    }
                    if step.dump && dumps_allowed(&app) {
                        dumped_this_stall = spawn_dump(&exe, &pid, &dir);
                    }
                    if step.post {
                        let answered = answered.clone();
                        let _ = app.run_on_main_thread(move || {
                            answered.store(now_ms(), Ordering::Release);
                        });
                    }
                }
            });
    }

    fn dumps_allowed(app: &AppHandle) -> bool {
        DUMPS_WANTED.load(Ordering::Acquire)
            && app
                .state::<crate::pty::AppState>()
                .admin_policy
                .check(crate::policy::Lock::HangDumps)
                .is_ok()
    }

    fn write_log(dir: &Path, stalled: u64, dumped: bool) {
        use std::io::Write;
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("ui-stalls.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_CAP) {
            let _ = std::fs::rename(&path, dir.join("ui-stalls.old.log"));
        }
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(log_line(unix, stalled, dumped).as_bytes());
        }
    }

    /// Starts the dumper and returns at once; the UI thread may still be
    /// stuck, so nothing here waits for it. Allocation in this thread is
    /// fine: the dump runs in another process, so a heap lock held by the
    /// stuck thread can delay this call at worst, never deadlock the dumper.
    fn spawn_dump(exe: &Path, pid: &str, dir: &Path) -> bool {
        let _ = std::fs::create_dir_all(dir);
        let ages: Vec<Option<SystemTime>> = (0..DUMP_SLOTS)
            .map(|i| {
                std::fs::metadata(dump_path(dir, i))
                    .and_then(|m| m.modified())
                    .ok()
            })
            .collect();
        let target = dump_path(dir, pick_slot(&ages));
        use std::os::windows::process::CommandExt;
        crate::terminal_env::command(exe)
            // Debug builds use the console subsystem: never flash a window.
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .arg("--dump-ui")
            .arg(pid)
            .arg(&target)
            .spawn()
            .map(|mut child| {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            })
            .is_ok()
    }
}

#[cfg(windows)]
pub use runtime::{set_dumps_enabled, start};

#[cfg(not(windows))]
pub fn start(_: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn set_dumps_enabled(_: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the monitor with a ping answered `delay` ms after each post.
    fn run(m: &mut Monitor, from: u64, ticks: u64) -> Vec<Step> {
        (0..ticks)
            .map(|i| m.tick(from + i * TICK_MS, None))
            .collect()
    }

    #[test]
    fn posts_one_ping_and_waits_for_it() {
        let mut m = Monitor::default();
        assert!(m.tick(0, None).post);
        // Unanswered: never a second ping in flight.
        assert!(run(&mut m, TICK_MS, 4).iter().all(|s| !s.post));
    }

    #[test]
    fn short_delays_are_not_logged() {
        let mut m = Monitor::default();
        m.tick(0, None);
        let s = m.tick(TICK_MS, Some(30));
        assert_eq!(
            s,
            Step {
                post: true,
                dump: false,
                log: None
            }
        );
    }

    #[test]
    fn a_stall_dumps_once_and_logs_its_length_when_it_ends() {
        let mut m = Monitor::default();
        m.tick(0, None);
        let steps = run(&mut m, TICK_MS, 40); // up to 10 s unanswered
        assert_eq!(steps.iter().filter(|s| s.dump).count(), 1);
        let first_dump = steps.iter().position(|s| s.dump).unwrap() as u64;
        assert_eq!((first_dump + 1) * TICK_MS, DUMP_MS);
        let end = m.tick(41 * TICK_MS, Some(10_123));
        assert_eq!(end.log, Some(10_123));
        assert!(end.post && !end.dump);
        // The next stall may dump again.
        let again = run(&mut m, 42 * TICK_MS, 20);
        assert_eq!(again.iter().filter(|s| s.dump).count(), 1);
    }

    #[test]
    fn stall_between_log_and_dump_threshold_logs_without_dump() {
        let mut m = Monitor::default();
        m.tick(0, None);
        let steps = run(&mut m, TICK_MS, 10);
        assert!(steps.iter().all(|s| !s.dump));
        assert_eq!(
            m.tick(11 * TICK_MS, Some(LOG_MS + 500)).log,
            Some(LOG_MS + 500)
        );
    }

    #[test]
    fn a_gap_in_the_watchdog_itself_drops_the_measurement() {
        let mut m = Monitor::default();
        m.tick(0, None);
        m.tick(TICK_MS, None);
        // The machine slept for a minute; the ping ran right after wake-up.
        let woke = m.tick(60_000, None);
        assert!(!woke.dump, "sleep is not a UI stall");
        let end = m.tick(60_000 + TICK_MS, Some(60_010));
        assert_eq!(end.log, None);
        // Fresh measurement afterwards counts again.
        let steps = run(&mut m, 60_000 + 2 * TICK_MS, 20);
        assert_eq!(steps.iter().filter(|s| s.dump).count(), 1);
    }

    #[test]
    fn picks_free_slot_then_oldest() {
        assert_eq!(pick_slot::<u32>(&[None, None, None]), 0);
        assert_eq!(pick_slot(&[Some(5), None, Some(1)]), 1);
        assert_eq!(pick_slot(&[Some(5), Some(2), Some(9)]), 1);
    }

    #[test]
    fn log_line_has_no_content_only_time_and_length() {
        assert_eq!(log_line(1700, 4200, false), "1700 ui-stall 4200 ms\n");
        assert_eq!(log_line(1, 2, true), "1 ui-stall 2 ms (dump written)\n");
        assert!(dump_path(Path::new("d"), 2).ends_with("ui-stall-3.dmp"));
    }
}
