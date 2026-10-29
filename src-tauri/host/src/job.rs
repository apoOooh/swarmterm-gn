//! Windows Job Object helper, moved from the app's `pty.rs` (ADR 0001); the
//! app's in-process panes use this same type (ADR 0005).
//!
//! Killing a pty's shell with `TerminateProcess` leaves its child/grandchild
//! processes running (Windows does not cascade a kill down the tree). Putting
//! the shell in a job created with `KILL_ON_JOB_CLOSE` means terminating — or
//! merely dropping — the job tears down every descendant. In the host this
//! matters twice: closing a pane frees its tree, and if the host itself dies
//! the handles close with it, so no orphan outlives the process that owned
//! its console.
//!
//! The same job enforces the pane's priority (`priority.rs`, ADR 0005): a
//! `JOB_OBJECT_LIMIT_PRIORITY_CLASS` the processes inside cannot raise, an
//! optional hard CPU rate, and a nested "build" job (created on first use,
//! no kill flag of its own: it dies with the pane job) for the subtree below
//! the agent. Nested limits combine with the pane job's: the effective class
//! is the lowest in the chain.
//!
//! Why the build job is nested on purpose (`nest_build`): an empty job joins
//! the hierarchy of the first process assigned to it. libuv (Node) puts
//! itself and every child it spawns into one global job of its own
//! (`uv__init_global_job_handle`, `KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`)
//! nested in the pane job. Had an agent's direct child created the build
//! job, it would sit below the agent's libuv job: everything in it would die
//! with the agent, and processes outside that libuv job could never join.

use std::ffi::c_void;
use std::mem;
use std::ptr;
use std::sync::{Arc, Mutex, Weak};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE, STILL_ACTIVE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetPriorityClass, GetProcessTimes, OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

use crate::priority::{Level, Limits};

struct Inner {
    job: HANDLE,
    /// Nested build job, created by the first `assign_build`.
    build: Mutex<HANDLE>,
    limits: Mutex<Limits>,
    /// `nest_build` failed once: not retried (one dummy spawn per new build
    /// process otherwise); the pane keeps its own class.
    nest_failed: std::sync::atomic::AtomicBool,
    /// The shell (pid, creation time): root of every sweep.
    root: (u32, u64),
    /// Descendants the sweep found outside the job that the kernel refused
    /// (they sit in a job of their own, e.g. a profile hook's node with its
    /// libuv job), as (pid, creation time). Their class is set by hand and
    /// re-applied on every watcher pass (`tend_strays`).
    strays: Mutex<Vec<Stray>>,
}

/// A descendant the kernel refused to put into the pane job.
struct Stray {
    pid: u32,
    /// Creation time: a reused PID never matches.
    born: u64,
    exe: String,
    /// Why assignment failed (GetLastError).
    err: u32,
    /// The WARNING was printed. It comes the first time a class is forced,
    /// also for a stray first found while priority was off.
    warned: bool,
}

impl Stray {
    /// Print the forced-class WARNING once per stray.
    fn warn_forced(&mut self, root: u32) {
        if self.warned {
            return;
        }
        self.warned = true;
        eprintln!(
            "[job] WARNING: early child {} ({}) of {root} has a job of its own and cannot be \
             captured (error {}); its class is forced by hand on every watcher pass, but it \
             is not in the pane job (no kill on close, can raise itself until the next pass)",
            self.pid, self.exe, self.err
        );
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // SAFETY: both handles are owned by this value and closed once.
        unsafe {
            let build = *self.build.get_mut().unwrap_or_else(|e| e.into_inner());
            if !build.is_null() {
                CloseHandle(build);
            }
            CloseHandle(self.job);
        }
    }
}

/// Owns a kill-on-close job handle. On drop the last handle closes, which
/// terminates any process still in the job — a safety net against orphans.
/// The priority watcher holds only a [`JobRef`] and upgrades it for a pass.
pub struct JobHandle(Arc<Inner>);

/// Weak reference for the priority registry: never keeps a pane's tree alive.
pub struct JobRef(Weak<Inner>);

impl JobRef {
    pub fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }
    pub fn upgrade(&self) -> Option<JobHandle> {
        self.0.upgrade().map(JobHandle)
    }
}

// A job handle is an opaque kernel handle; it is sound to move/share across
// threads (it lives in the Mutex-guarded terminal map).
unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

/// Extended limits for a job: kill-on-close for the pane job only, plus the
/// class limit when there is one.
fn set_extended(job: HANDLE, kill: bool, class: Option<Level>) -> bool {
    // SAFETY: zeroed POD struct passed with its exact size.
    unsafe {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        if kill {
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        if let Some(level) = class {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PRIORITY_CLASS;
            info.BasicLimitInformation.PriorityClass = level.class();
        }
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0
    }
}

/// Hard CPU cap in percent of the machine, or none.
fn set_cpu(job: HANDLE, cap: Option<u8>) -> bool {
    // SAFETY: zeroed POD struct passed with its exact size.
    unsafe {
        let mut info: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = mem::zeroed();
        if let Some(pct) = cap {
            info.ControlFlags =
                JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
            info.Anonymous.CpuRate = u32::from(pct) * 100;
        }
        SetInformationJobObject(
            job,
            JobObjectCpuRateControlInformation,
            &info as *const _ as *const c_void,
            mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
        ) != 0
    }
}

/// Outcome of [`JobHandle::assign_build`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Assign {
    /// In the build job (now or already).
    Done,
    /// The process is gone (or cannot be opened).
    Gone,
    /// The kernel refused, with the Win32 error. Expected for a process in
    /// a foreign nested job (an agent's libuv job): it cannot leave that
    /// job's chain, so it keeps the pane's class; its own children break
    /// away from the libuv job silently and can still be assigned.
    Refused(u32),
    /// The build job could not be nested for this pane (logged once when
    /// that failed); the pane keeps its own class.
    NoBuildJob,
}

/// Upper bound on sweep rounds: a round that assigns something is repeated,
/// so a grandchild started between the snapshot and its parent's assignment
/// is caught by the next round.
const SWEEP_ROUNDS: usize = 8;

/// Put `job` (empty, not nested yet) below `parent`: a suspended `cmd.exe`
/// that never runs joins `parent`, then `job` (which thereby nests under
/// `parent`), and is terminated.
fn nest_build(parent: HANDLE, job: HANDLE) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let mut dummy = std::process::Command::new(format!(r"{root}\System32\cmd.exe"))
        .args(["/d", "/c", "exit"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("dummy spawn: {e}"))?;
    let h = dummy.as_raw_handle() as HANDLE;
    // SAFETY: `h` is the child's own full-access handle, valid until
    // `dummy` drops; `parent` and `job` are owned by the caller.
    let res = unsafe {
        if AssignProcessToJobObject(parent, h) == 0 {
            Err(format!("dummy into pane job: error {}", GetLastError()))
        } else if AssignProcessToJobObject(job, h) == 0 {
            Err(format!("dummy into build job: error {}", GetLastError()))
        } else {
            Ok(())
        }
    };
    let _ = dummy.kill();
    let _ = dummy.wait();
    res
}

/// Process `pid` still runs and is the one created at `born`.
fn alive(pid: u32, born: u64) -> bool {
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = creation_time(h) == Some(born)
            && GetExitCodeProcess(h, &mut code) != 0
            && code == STILL_ACTIVE as u32;
        CloseHandle(h);
        ok
    }
}

/// Set the class of a stray, opened separately with the right it needs (the
/// sweep's own handle only carries what assignment needs). True if it still
/// runs and the class was set.
fn force_class(pid: u32, born: u64, class: u32) -> bool {
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = creation_time(h) == Some(born)
            && GetExitCodeProcess(h, &mut code) != 0
            && code == STILL_ACTIVE as u32
            && SetPriorityClass(h, class) != 0;
        CloseHandle(h);
        ok
    }
}

fn creation_time(h: HANDLE) -> Option<u64> {
    // SAFETY: zeroed out-params for a valid process handle.
    unsafe {
        let mut t: [FILETIME; 4] = mem::zeroed();
        let [c, e, k, u] = &mut t;
        (GetProcessTimes(h, c, e, k, u) != 0)
            .then(|| (u64::from(c.dwHighDateTime) << 32) | u64::from(c.dwLowDateTime))
    }
}

impl JobHandle {
    /// Create a kill-on-close job without priority limits and place process
    /// `pid` in it (command routines and tests).
    pub fn capturing(pid: u32) -> Option<Self> {
        Self::capturing_with(pid, &Limits::NONE)
    }

    /// Create a kill-on-close job born with `limits` and place process `pid`
    /// in it. Every process the shell spawns afterwards inherits the job, so
    /// the whole tree is captured and limited from birth. Returns `None` if
    /// a required Win32 step fails (caller degrades to the plain
    /// single-process kill). A failed CPU cap is logged, not fatal.
    pub fn capturing_with(pid: u32, limits: &Limits) -> Option<Self> {
        Self::capturing_with_hook(pid, limits, &mut |_| {})
    }

    /// `capturing_with`, calling `hook(round)` right after each sweep
    /// round's snapshot (tests start a process in that window).
    #[doc(hidden)]
    pub fn capturing_with_hook(
        pid: u32,
        limits: &Limits,
        hook: &mut dyn FnMut(usize),
    ) -> Option<Self> {
        // SAFETY: plain Win32 calls; every handle is closed on each path or
        // owned by the returned value.
        unsafe {
            // Every failure is logged: without a job the pane runs unlimited
            // and its tree survives a close, which must leave a trace.
            let fail = |step: &str| {
                eprintln!(
                    "[job] pid {pid}: {step} failed (error {}); pane runs without job limits",
                    GetLastError()
                );
            };
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                fail("CreateJobObject");
                return None;
            }
            let inner = Inner {
                job,
                build: Mutex::new(ptr::null_mut()),
                limits: Mutex::new(*limits),
                nest_failed: std::sync::atomic::AtomicBool::new(false),
                root: (pid, 0),
                strays: Mutex::new(Vec::new()),
            };
            let mut inner = inner;
            if !set_extended(job, true, limits.pane) {
                fail("SetInformationJobObject");
                return None;
            }
            if limits.cpu_cap.is_some() && !set_cpu(job, limits.cpu_cap) {
                eprintln!(
                    "[job] CPU rate cap refused for pid {pid} (error {})",
                    GetLastError()
                );
            }
            let proc = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if proc.is_null() {
                fail("OpenProcess");
                return None;
            }
            if AssignProcessToJobObject(job, proc) == 0 {
                fail("AssignProcessToJobObject");
                CloseHandle(proc);
                return None;
            }
            let born = creation_time(proc);
            CloseHandle(proc);
            if let Some(born) = born {
                inner.root.1 = born;
            }
            let handle = JobHandle(Arc::new(inner));
            if born.is_some() {
                handle.sweep(hook);
            }
            Some(handle)
        }
    }

    /// Assign the shell's descendants that started between spawn and
    /// capture (a profile hook's child, say) and so sit outside the job.
    /// Toolhelp parent links; a row counts only if it was created after its
    /// own parent, so a reused PID never pulls in a stranger. A round that
    /// assigned something is repeated (bounded), so a grandchild started
    /// meanwhile is not missed. A process the kernel refuses (it has a job
    /// of its own) becomes a stray: its class is set by hand instead.
    fn sweep(&self, hook: &mut dyn FnMut(usize)) {
        let (root, born) = self.0.root;
        if born == 0 {
            return;
        }
        for round in 0..SWEEP_ROUNDS {
            // The sweep also runs for the pane's whole life (`tend_strays`):
            // once the shell is gone its PID may belong to a stranger whose
            // children would match, so stop unless it is still our shell.
            if !alive(root, born) {
                return;
            }
            let Some(rows) = crate::priority::snapshot() else {
                return;
            };
            hook(round);
            let mut tree: Vec<(u32, u64)> = vec![(root, born)];
            let mut assigned = false;
            let mut i = 0;
            while i < tree.len() {
                let (parent, parent_born) = tree[i];
                i += 1;
                for (&pid, (ppid, exe)) in &rows {
                    if *ppid != parent || pid == parent || tree.iter().any(|t| t.0 == pid) {
                        continue;
                    }
                    // SAFETY: handle opened and closed here.
                    unsafe {
                        let h = OpenProcess(
                            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                            0,
                            pid,
                        );
                        if h.is_null() {
                            continue;
                        }
                        let Some(t) = creation_time(h).filter(|&t| t >= parent_born) else {
                            CloseHandle(h);
                            continue;
                        };
                        tree.push((pid, t));
                        let mut inside = 0;
                        IsProcessInJob(h, self.0.job, &mut inside);
                        if inside == 0 {
                            if AssignProcessToJobObject(self.0.job, h) != 0 {
                                assigned = true;
                            } else {
                                let err = GetLastError();
                                self.add_stray(pid, t, exe, err);
                            }
                        }
                        CloseHandle(h);
                    }
                }
            }
            if !assigned {
                break;
            }
        }
    }

    fn stray_class(&self) -> Option<u32> {
        let l = self.limits();
        l.pane.or(l.build).map(|l| l.class())
    }

    /// Record a stray and force the current stray class on it, both under
    /// the strays lock with the class read there: `set_limits` stores the
    /// new limits before it takes that lock to reapply, so a racing sweep
    /// either forces the new class or is corrected by that reapply. Logs a
    /// new stray; the WARNING comes the first time a class is forced on it.
    fn add_stray(&self, pid: u32, born: u64, exe: &str, err: u32) {
        let root = self.0.root.0;
        let mut s = self.0.strays.lock().unwrap_or_else(|e| e.into_inner());
        let class = self.stray_class();
        let i = match s.iter().position(|x| x.pid == pid && x.born == born) {
            Some(i) => i,
            None => {
                eprintln!(
                    "[job] early child {pid} ({exe}) of {root} has a job of its own and cannot \
                     be captured (error {err})"
                );
                s.push(Stray {
                    pid,
                    born,
                    exe: exe.to_owned(),
                    err,
                    warned: false,
                });
                s.len() - 1
            }
        };
        if let Some(c) = class {
            if force_class(pid, born, c) {
                s[i].warn_forced(root);
            }
        }
    }

    /// Processes that could not be captured, still alive (tests, logs).
    pub fn strays(&self) -> Vec<u32> {
        self.0
            .strays
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|s| alive(s.pid, s.born))
            .map(|s| s.pid)
            .collect()
    }

    /// Watcher pass for strays: forget the dead, force the pane's class on
    /// the living again, and sweep once more so their new descendants are
    /// found (and captured when they can be). No-op, and no snapshot, while
    /// the pane has no strays or no class to force (priority off, exempt
    /// workspace): raising them back is done once, by `set_limits`.
    pub fn tend_strays(&self) {
        // Dead strays are not pruned meanwhile: entries carry a creation
        // time, so a reused PID never matches, and the next `set_limits` or
        // class-bearing pass forgets them.
        if self.stray_class().is_none() {
            return;
        }
        if self.reapply_strays(false) {
            self.sweep(&mut |_| {});
        }
    }

    /// Force the stray class again and forget dead strays; with no class
    /// left and `raise` set (a limit was just lifted), raise strays at a
    /// below-Normal class back to Normal. True if any stray is left. Runs
    /// under the strays lock with the class read there (see `add_stray`).
    /// No snapshot: cheap enough for `set_limits` on the caller's thread.
    fn reapply_strays(&self, raise: bool) -> bool {
        let mut s = self.0.strays.lock().unwrap_or_else(|e| e.into_inner());
        if s.is_empty() {
            return false;
        }
        let class = self.stray_class();
        let root = self.0.root.0;
        let mut dead = Vec::new();
        for stray in s.iter_mut() {
            let (pid, born) = (stray.pid, stray.born);
            // SAFETY: handle opened and closed here.
            unsafe {
                let h = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                    0,
                    pid,
                );
                if h.is_null() {
                    dead.push((pid, born));
                    continue;
                }
                // Same pid AND same creation time, and not exited yet.
                let mut code = 0u32;
                let live = creation_time(h) == Some(born)
                    && GetExitCodeProcess(h, &mut code) != 0
                    && code == STILL_ACTIVE as u32;
                if live {
                    let cur = GetPriorityClass(h);
                    match class {
                        Some(c) => {
                            // Warn only once the class really is `c`: a failed
                            // set must not claim a force or use up `warned`.
                            if cur == c || SetPriorityClass(h, c) != 0 {
                                stray.warn_forced(root);
                            }
                        }
                        None if raise
                            && (cur == IDLE_PRIORITY_CLASS
                                || cur == BELOW_NORMAL_PRIORITY_CLASS) =>
                        {
                            SetPriorityClass(h, NORMAL_PRIORITY_CLASS);
                        }
                        _ => {}
                    }
                } else {
                    dead.push((pid, born));
                }
                CloseHandle(h);
            }
        }
        s.retain(|x| !dead.contains(&(x.pid, x.born)));
        !s.is_empty()
    }

    pub fn downgrade(&self) -> JobRef {
        JobRef(Arc::downgrade(&self.0))
    }

    pub fn limits(&self) -> Limits {
        *self.0.limits.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Apply new limits to the running pane. Tightening is enforced by the
    /// kernel at once; when a class limit is lifted, members still at a
    /// below-Normal class are raised back to Normal (a process that lowered
    /// itself on purpose is raised too: the job cannot tell them apart).
    pub fn set_limits(&self, limits: &Limits) {
        // Lock order `build` → `limits`, as in `assign_build`: a build job
        // created concurrently then always sees the new build limit.
        let slot = self.0.build.lock().unwrap_or_else(|e| e.into_inner());
        let mut cur = self.0.limits.lock().unwrap_or_else(|e| e.into_inner());
        let old = *cur;
        *cur = *limits;
        let build = *slot;
        if !set_extended(self.0.job, true, limits.pane) {
            eprintln!("[job] priority limit refused");
        }
        if old.cpu_cap != limits.cpu_cap && !set_cpu(self.0.job, limits.cpu_cap) {
            eprintln!("[job] CPU rate cap refused");
        }
        if !build.is_null() && !set_extended(build, false, limits.build) {
            eprintln!("[job] build priority limit refused");
        }
        drop(cur);
        drop(slot);
        let lifted = (old.pane.is_some() && limits.pane.is_none())
            || (old.build.is_some() && limits.build.is_none());
        // Strays get their new class (or Normal back, only now that a limit
        // was lifted) at once; their new descendants are left to the next
        // watcher pass.
        self.reapply_strays(lifted);
        if !lifted {
            return;
        }
        for pid in self.pids() {
            // SAFETY: handle opened and closed here.
            unsafe {
                let h = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                    0,
                    pid,
                );
                if h.is_null() {
                    continue;
                }
                let mut in_build = 0;
                if !build.is_null() {
                    IsProcessInJob(h, build, &mut in_build);
                }
                let forced = limits.pane.is_some() || (in_build != 0 && limits.build.is_some());
                let class = GetPriorityClass(h);
                if !forced && (class == IDLE_PRIORITY_CLASS || class == BELOW_NORMAL_PRIORITY_CLASS)
                {
                    SetPriorityClass(h, NORMAL_PRIORITY_CLASS);
                }
                CloseHandle(h);
            }
        }
    }

    /// Move process `pid` (a member of this pane job) into the nested build
    /// job, creating it with the current build limit on first use, nested
    /// below the pane job on purpose (`nest_build`). Its later children are
    /// born there.
    pub fn assign_build(&self, pid: u32) -> Assign {
        use std::sync::atomic::Ordering;
        let build = {
            let slot = self.0.build.lock().unwrap_or_else(|e| e.into_inner());
            *slot
        };
        let build = if build.is_null() {
            if self.0.nest_failed.load(Ordering::Relaxed) {
                return Assign::NoBuildJob;
            }
            // Created and nested WITHOUT the lock: `nest_build` spawns a
            // process, and `set_limits` (main thread) must not wait on it.
            match self.new_build_job() {
                Ok(job) => job,
                Err(r) => return r,
            }
        } else {
            build
        };
        // SAFETY: plain Win32 calls; the nested handle is owned by `Inner`.
        unsafe {
            let proc = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if proc.is_null() {
                return Assign::Gone;
            }
            // Born in the build job already (a descendant of an assigned
            // root): nothing to do, and no Assign call per pass.
            let mut inside = 0;
            let res = if IsProcessInJob(proc, build, &mut inside) != 0 && inside != 0 {
                Assign::Done
            } else if AssignProcessToJobObject(build, proc) != 0 {
                Assign::Done
            } else {
                Assign::Refused(GetLastError())
            };
            CloseHandle(proc);
            res
        }
    }

    /// Create the nested build job and publish it in `build`. Another thread
    /// may have won meanwhile: then its job is used and ours is closed. The
    /// limit is (re)applied under the lock, so a `set_limits` that ran while
    /// we were nesting is not lost.
    fn new_build_job(&self) -> Result<HANDLE, Assign> {
        use std::sync::atomic::Ordering;
        // SAFETY: plain Win32 calls; `job` is closed on every failure path
        // or owned by `Inner` once published.
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                return Err(Assign::Refused(GetLastError()));
            }
            if !set_extended(job, false, self.limits().build) {
                let err = GetLastError();
                CloseHandle(job);
                return Err(Assign::Refused(err));
            }
            if let Err(e) = nest_build(self.0.job, job) {
                CloseHandle(job);
                if !self.0.nest_failed.swap(true, Ordering::Relaxed) {
                    eprintln!("[job] build job not nested, not retried for this pane: {e}");
                }
                return Err(Assign::NoBuildJob);
            }
            let mut slot = self.0.build.lock().unwrap_or_else(|e| e.into_inner());
            if !slot.is_null() {
                CloseHandle(job);
                return Ok(*slot);
            }
            // Lock order `build` → `limits`, as in `set_limits`.
            if !set_extended(job, false, self.limits().build) {
                eprintln!("[job] build priority limit refused");
            }
            *slot = job;
            Ok(job)
        }
    }

    /// PIDs of every process in the job, nested build job included.
    pub fn pids(&self) -> Vec<u32> {
        let mut cap = 64usize;
        loop {
            // Header: two u32 counts (one u64), then `cap` ULONG_PTRs.
            let mut buf = vec![0u64; 1 + cap];
            // SAFETY: the buffer is sized and aligned for the header plus
            // `cap` pointer-sized ids (x64 only).
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0.job,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr().cast(),
                    (buf.len() * 8) as u32,
                    ptr::null_mut(),
                )
            };
            let assigned = (buf[0] & 0xffff_ffff) as usize;
            let listed = (buf[0] >> 32) as usize;
            if ok != 0 && listed >= assigned {
                return buf[1..1 + listed].iter().map(|&p| p as u32).collect();
            }
            if assigned <= cap && ok == 0 {
                return Vec::new();
            }
            cap = assigned.max(cap) * 2;
            if cap > 1 << 16 {
                return Vec::new();
            }
        }
    }

    /// Immediately terminate the shell and all of its descendants.
    pub fn terminate(&self) {
        // SAFETY: owned handle.
        unsafe {
            TerminateJobObject(self.0.job, 1);
        }
    }

    /// Number of processes still alive in the job, or `None` if the query
    /// fails (callers then stop waiting and terminate).
    pub fn active_processes(&self) -> Option<u32> {
        // SAFETY: zeroed POD struct passed with its exact size.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = mem::zeroed();
            let ok = QueryInformationJobObject(
                self.0.job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            );
            (ok != 0).then_some(info.ActiveProcesses)
        }
    }
}
