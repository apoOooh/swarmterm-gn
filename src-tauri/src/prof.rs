//! Profiling counters (perf investigation, `docs/perf-profiling.md`).
//!
//! Everything measuring lives behind the `profiling` Cargo feature. Without
//! it every helper here compiles to the plain operation (`lock` is
//! `lock().unwrap()`, `span`/`record` are empty), so normal and A/B builds
//! are unchanged. Thread naming (`spawn_named`) is on in every build: a name
//! costs one allocation per thread and makes samply/WPA stacks readable.

use std::sync::Mutex;

/// `std::thread::spawn` with a name. Panics on spawn failure exactly like
/// `std::thread::spawn` does.
pub fn spawn_named<F, T>(name: impl Into<String>, f: F) -> std::thread::JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    std::thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .expect("failed to spawn thread")
}

#[cfg(not(feature = "profiling"))]
mod imp {
    use super::Mutex;
    use std::sync::MutexGuard;

    pub type Guard<'a, T> = MutexGuard<'a, T>;

    #[inline(always)]
    pub fn lock<'a, T>(_site: &'static str, m: &'a Mutex<T>) -> Guard<'a, T> {
        m.lock().unwrap()
    }
    /// Zero-sized stand-ins so call sites read the same in both builds.
    pub struct Span;
    pub struct Stamp;
    #[inline(always)]
    pub fn span(_name: &'static str) -> Span {
        Span
    }
    #[inline(always)]
    pub fn now() -> Stamp {
        Stamp
    }
    #[inline(always)]
    pub fn since(_name: &'static str, _start: Stamp) {}
    #[inline(always)]
    pub fn start(_app: &tauri::AppHandle) {}
    #[inline(always)]
    pub fn dump(_reason: &str) {}
}

#[cfg(feature = "profiling")]
mod imp {
    use super::Mutex;
    use std::collections::BTreeMap;
    use std::ops::{Deref, DerefMut};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{MutexGuard, OnceLock};
    use std::time::{Duration, Instant};

    /// log2 buckets over microseconds: bucket i holds [2^(i-1), 2^i) µs,
    /// bucket 0 is < 1 µs. 32 buckets reach ~35 min.
    const BUCKETS: usize = 32;

    #[derive(Clone)]
    struct Hist {
        count: u64,
        sum_us: u64,
        max_us: u64,
        buckets: [u64; BUCKETS],
    }

    impl Hist {
        const fn new() -> Self {
            Hist {
                count: 0,
                sum_us: 0,
                max_us: 0,
                buckets: [0; BUCKETS],
            }
        }
        fn add(&mut self, d: Duration) {
            let us = d.as_micros().min(u64::MAX as u128) as u64;
            self.count += 1;
            self.sum_us = self.sum_us.saturating_add(us);
            self.max_us = self.max_us.max(us);
            let b = (64 - us.leading_zeros() as usize).min(BUCKETS - 1);
            self.buckets[b] += 1;
        }
        fn quantile_us(&self, q: f64) -> u64 {
            let target = (self.count as f64 * q).ceil() as u64;
            let mut seen = 0;
            for (i, n) in self.buckets.iter().enumerate() {
                seen += n;
                if seen >= target.max(1) {
                    return if i == 0 { 1 } else { 1u64 << i };
                }
            }
            self.max_us
        }
        fn json(&self) -> serde_json::Value {
            serde_json::json!({
                "count": self.count,
                "total_ms": self.sum_us as f64 / 1000.0,
                "max_ms": self.max_us as f64 / 1000.0,
                "p50_ms_le": self.quantile_us(0.5) as f64 / 1000.0,
                "p99_ms_le": self.quantile_us(0.99) as f64 / 1000.0,
            })
        }
    }

    /// One registry lock for every histogram. It is a profiling-only lock
    /// held for a map lookup + a few adds; its own cost shows up as
    /// perturbation, documented in docs/perf-profiling.md.
    static HISTS: Mutex<BTreeMap<&'static str, Hist>> = Mutex::new(BTreeMap::new());
    static STALLS: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    static DUMP_SEQ: AtomicU64 = AtomicU64::new(0);
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    const MAX_STALLS: usize = 2000;
    const WATCHDOG_TICK: Duration = Duration::from_millis(50);
    const STALL: Duration = Duration::from_millis(16);

    fn epoch() -> Instant {
        *EPOCH.get_or_init(Instant::now)
    }

    pub fn record(name: &'static str, d: Duration) {
        if let Ok(mut h) = HISTS.lock() {
            h.entry(name).or_insert_with(Hist::new).add(d);
        }
    }

    /// Mutex guard that records hold time on drop.
    pub struct Guard<'a, T> {
        inner: MutexGuard<'a, T>,
        site: &'static str,
        since: Instant,
    }
    impl<T> Deref for Guard<'_, T> {
        type Target = T;
        fn deref(&self) -> &T {
            &self.inner
        }
    }
    impl<T> DerefMut for Guard<'_, T> {
        fn deref_mut(&mut self) -> &mut T {
            &mut self.inner
        }
    }
    impl<T> Drop for Guard<'_, T> {
        fn drop(&mut self) {
            record(self.site, self.since.elapsed());
        }
    }

    /// `lock().unwrap()` recording `<site>.wait` (here) and `<site>` hold
    /// time (on drop). Wait names are leaked once per site.
    pub fn lock<'a, T>(site: &'static str, m: &'a Mutex<T>) -> Guard<'a, T> {
        let t0 = Instant::now();
        let inner = m.lock().unwrap();
        let since = Instant::now();
        record(wait_name(site), since - t0);
        Guard { inner, site, since }
    }

    fn wait_name(site: &'static str) -> &'static str {
        static NAMES: Mutex<BTreeMap<&'static str, &'static str>> = Mutex::new(BTreeMap::new());
        let mut names = NAMES.lock().unwrap();
        names
            .entry(site)
            .or_insert_with(|| Box::leak(format!("{site}.wait").into_boxed_str()))
    }

    pub struct Span(&'static str, Instant);
    impl Drop for Span {
        fn drop(&mut self) {
            record(self.0, self.1.elapsed());
        }
    }
    pub fn span(name: &'static str) -> Span {
        Span(name, Instant::now())
    }
    pub fn now() -> Instant {
        Instant::now()
    }
    pub fn since(name: &'static str, start: Instant) {
        record(name, start.elapsed());
    }

    fn out_dir() -> PathBuf {
        std::env::var_os("SWARMTERM_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("swarmterm-profile"))
    }

    fn reset() {
        HISTS.lock().unwrap().clear();
        STALLS.lock().unwrap().clear();
    }

    fn tokio_json() -> serde_json::Value {
        let tauri::async_runtime::RuntimeHandle::Tokio(h) = tauri::async_runtime::handle();
        let m = h.metrics();
        serde_json::json!({
            "workers": m.num_workers(),
            "alive_tasks": m.num_alive_tasks(),
            "global_queue_depth": m.global_queue_depth(),
        })
    }

    /// Writes `<dir>/prof-<pid>-<seq>-<reason>.json`.
    pub fn dump(reason: &str) {
        let hists: serde_json::Map<String, serde_json::Value> = HISTS
            .lock()
            .unwrap()
            .iter()
            .map(|(k, h)| (k.to_string(), h.json()))
            .collect();
        let stalls: Vec<serde_json::Value> = STALLS
            .lock()
            .unwrap()
            .iter()
            .map(|(at, d)| serde_json::json!({ "at_ms": at, "delay_ms": *d as f64 / 1000.0 }))
            .collect();
        let doc = serde_json::json!({
            "reason": reason,
            "uptime_ms": epoch().elapsed().as_millis() as u64,
            "histograms": hists,
            "main_thread_stalls": stalls,
            "tokio": tokio_json(),
        });
        let dir = out_dir();
        let _ = std::fs::create_dir_all(&dir);
        let seq = DUMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("prof-{}-{seq}-{reason}.json", std::process::id()));
        match std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default()) {
            Ok(()) => eprintln!("[prof] wrote {}", path.display()),
            Err(e) => eprintln!("[prof] dump to {} failed: {e}", path.display()),
        }
    }

    /// Starts the main-thread watchdog. Every tick it also polls the trigger
    /// files `reset.request` / `dump.request` in the output dir (deleted
    /// once handled) so the harness can bracket a scenario without an IPC
    /// command.
    pub fn start(app: &tauri::AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        epoch();
        super::spawn_named("prof-watchdog", || {
            let app = APP.get().unwrap();
            let dir = out_dir();
            let _ = std::fs::create_dir_all(&dir);
            eprintln!("[prof] profiling build; triggers in {}", dir.display());
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                let posted = Instant::now();
                let _ = app.run_on_main_thread(move || {
                    let delay = posted.elapsed();
                    record("main.dispatch_delay", delay);
                    if delay > STALL {
                        let at = (posted - epoch()).as_millis() as u64;
                        let mut s = STALLS.lock().unwrap();
                        if s.len() < MAX_STALLS {
                            s.push((at, delay.as_micros() as u64));
                        }
                    }
                });
                if std::fs::remove_file(dir.join("reset.request")).is_ok() {
                    reset();
                    eprintln!("[prof] reset");
                }
                if std::fs::remove_file(dir.join("dump.request")).is_ok() {
                    dump("trigger");
                }
            }
        });
    }
}

pub use imp::*;
