//! Process priority of everything a pane runs (ADR 0005,
//! `docs/adr/0005-job-object-priority.md`).
//!
//! Why: a `cargo build -j32` (or any heavy tool an agent starts) competing at
//! Normal with the console host, the agent CLI, WebView2 and the rest of the
//! desktop makes Windows unresponsive. The old app-side poller lowered
//! processes with `SetPriorityClass` every 500 ms, which raced fast starters,
//! let a process raise itself back, and missed orphans and processes under
//! npm-shimmed agents. Enforcement now lives in the kernel: every pane shell
//! sits in a kill-on-close Job Object (`job.rs`), and
//! `JOB_OBJECT_LIMIT_PRIORITY_CLASS` on that job forces one class on every
//! process in it. Children are born inside the job (no race), cannot raise
//! their class, and cannot break away (the job never sets `BREAKAWAY_OK`).
//!
//! Modes (Settings → Terminal → "Process priority"):
//! - `strict` (default): the pane job is capped from spawn, agent included,
//!   and builds below an agent go into a nested job at the build level;
//! - `agent-normal`: the pane job has no class limit, so the shell and the
//!   agent stay Normal, and builds below an agent go into the nested job;
//! - `off`: no limits.
//!
//! The optional CPU cap is a hard `JOBOBJECT_CPU_RATE_CONTROL` rate on the
//! pane job (share of the whole machine); the nested job inherits it.
//!
//! Which processes go into the nested build job is the pure rule [`plan`]
//! over the pane job's own PID list (not a parent walk from the shell, so a
//! process whose parent exited is still found). A watcher thread per
//! [`Registry`] applies it every [`POLL`]; once a subtree root is in the
//! nested job every later descendant is born there.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Watcher period. Only the split between the agent and its builds depends
/// on it; the pane's class limit is enforced by the kernel from spawn.
pub const POLL: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Off,
    #[default]
    Strict,
    AgentNormal,
}

/// A priority class below Normal. Normal and above are deliberately not
/// representable: no setting can put a pane's work at Normal or higher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    BelowNormal,
    Idle,
}

impl Level {
    /// The Win32 priority class constant.
    pub fn class(self) -> u32 {
        match self {
            Level::BelowNormal => 0x4000,
            Level::Idle => 0x40,
        }
    }
}

/// Renderer settings, pushed by `child_priority_set` (app) and the
/// `set_priority` host op. Missing fields take the defaults and unknown
/// fields are ignored, so an older or newer app never turns enforcement off
/// by accident. An unknown enum value (a mode or level this build does not
/// know) fails the whole parse: the op is rejected and the previous settings
/// stay in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub mode: Mode,
    pub pane_level: Level,
    pub build_level: Level,
    /// Percent of the whole machine per pane (1..=99); `None` = no cap.
    pub cpu_cap: Option<u8>,
    /// Terminal ids of panes whose workspace opted out.
    pub exempt: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: Mode::Strict,
            pane_level: Level::BelowNormal,
            build_level: Level::Idle,
            cpu_cap: None,
            exempt: Vec::new(),
        }
    }
}

/// What one pane's jobs enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Limits {
    /// Class of the whole pane job (strict mode).
    pub pane: Option<Level>,
    /// Class of the nested build job.
    pub build: Option<Level>,
    /// CPU rate of the pane job in percent of the machine.
    pub cpu_cap: Option<u8>,
}

impl Limits {
    pub const NONE: Limits = Limits {
        pane: None,
        build: None,
        cpu_cap: None,
    };
}

impl Settings {
    pub fn limits_for(&self, terminal_id: &str) -> Limits {
        if self.mode == Mode::Off || self.exempt.iter().any(|e| e == terminal_id) {
            return Limits::NONE;
        }
        // 0 and 100 mean "no cap": a zero rate is rejected by the kernel and
        // 100 % caps nothing.
        let cpu_cap = self.cpu_cap.filter(|c| (1..=99).contains(c));
        Limits {
            pane: (self.mode == Mode::Strict).then_some(self.pane_level),
            build: Some(self.build_level),
            cpu_cap,
        }
    }
}

/// Native agent CLI executable stems. Mirrors the app's `agents::AGENTS`
/// (a test there keeps them in step); the host cannot see the app's catalog.
pub const AGENT_EXES: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "copilot",
    "qwen",
    "amp",
    "gemini",
    "cursor-agent",
    "agy",
    "omp",
];

/// npm package markers of agents that run under a script host (`node cli.js`).
/// Mirrors the app's `agent_process::script_markers`.
pub const AGENT_MARKERS: &[&str] = &[
    "@anthropic-ai/claude-code",
    "claude-code/cli.js",
    "@openai/codex",
    "opencode-ai",
    "@google/gemini-cli",
    "@qwen-code/qwen-code",
    "@github/copilot",
    "@sourcegraph/amp",
];

pub fn stem(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => lower,
    }
}

/// Script hosts whose identity lives in the command line.
pub fn is_script_host(exe: &str) -> bool {
    matches!(stem(exe).as_str(), "node" | "bun")
}

/// Whether a process is an agent CLI: a native catalog executable, or a
/// script host whose command line names an agent package.
pub fn is_agent(exe: &str, cmdline: Option<&str>) -> bool {
    if is_script_host(exe) {
        let Some(cmd) = cmdline else { return false };
        let cmd = cmd.replace('\\', "/").to_ascii_lowercase();
        return AGENT_MARKERS.iter().any(|m| cmd.contains(m));
    }
    let s = stem(exe);
    AGENT_EXES.contains(&s.as_str())
}

/// Script hosts, shells and console plumbing an agent may run under or be
/// started through, plus interactive programs typed into a plain shell.
/// Outside a recognised agent they stay out of the build job so an
/// unrecognised agent (or the session itself) keeps the pane's class.
pub fn is_launcher(exe: &str) -> bool {
    matches!(
        stem(exe).as_str(),
        "cmd"
            | "powershell"
            | "pwsh"
            | "node"
            | "bun"
            | "deno"
            | "python"
            | "python3"
            | "pythonw"
            | "py"
            | "uv"
            | "uvx"
            | "bash"
            | "sh"
            | "wsl"
            | "wslhost"
            | "conhost"
            | "openconsole"
            | "ssh"
            | "vim"
            | "nvim"
            | "less"
            | "more"
            | "nano"
            | "hx"
    )
}

/// One member of a pane job.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub exe: String,
    /// [`is_agent`], decided by the caller (it may need the command line).
    pub agent: bool,
}

/// PIDs among `procs` (the pane job's members) that belong in the build job:
/// - below a recognised agent: everything;
/// - elsewhere: the first non-launcher process and its whole subtree;
/// - never the shell (`root`), an agent, or an ancestor of an agent.
///
/// A member whose parent is not in the job (it exited: `start`, daemons,
/// MSBuild node reuse) hangs directly below the shell, so orphans follow
/// the same rule. The visited set guards against PID-reuse cycles.
pub fn plan(procs: &[Proc], root: u32) -> Vec<u32> {
    let members: HashSet<u32> = procs.iter().map(|p| p.pid).collect();
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        if p.pid == root {
            continue;
        }
        let parent = if p.parent != p.pid && (p.parent == root || members.contains(&p.parent)) {
            p.parent
        } else {
            root
        };
        children.entry(parent).or_default().push(p);
    }
    // Pre-order list of the pane's tree: (pid, parent index, proc).
    let mut order: Vec<(u32, Option<usize>, Option<&Proc>)> = vec![(root, None, None)];
    let mut visited = HashSet::from([root]);
    let mut i = 0;
    loop {
        while i < order.len() {
            let pid = order[i].0;
            if let Some(kids) = children.get(&pid) {
                for k in kids {
                    if visited.insert(k.pid) {
                        order.push((k.pid, Some(i), Some(k)));
                    }
                }
            }
            i += 1;
        }
        // Members in a parent cycle (PID reuse) are unreachable from the
        // shell; they are still in the job, so they hang below it too.
        match procs.iter().find(|p| p.pid != root && !visited.contains(&p.pid)) {
            Some(p) => {
                visited.insert(p.pid);
                order.push((p.pid, Some(0), Some(p)));
            }
            None => break,
        }
    }
    let agent = |j: usize| order[j].2.is_some_and(|p| p.agent);
    // Whether a node's subtree contains an agent (children come after
    // parents in `order`, so a reverse pass sees every child first).
    let mut has_agent = vec![false; order.len()];
    for j in (1..order.len()).rev() {
        if agent(j) {
            has_agent[j] = true;
        }
        if has_agent[j] {
            if let Some(p) = order[j].1 {
                has_agent[p] = true;
            }
        }
    }
    let mut lower = vec![false; order.len()];
    let mut out = Vec::new();
    for j in 1..order.len() {
        let parent = order[j].1.unwrap_or(0);
        let below_agent = parent != 0 && (lower[parent] || agent(parent));
        lower[j] = if below_agent {
            true
        } else if has_agent[j] {
            false
        } else {
            !order[j].2.is_some_and(|p| is_launcher(&p.exe))
        };
        if lower[j] {
            out.push(order[j].0);
        }
    }
    out
}

#[cfg(windows)]
pub use os::{command_line, Registry};
#[cfg(windows)]
pub(crate) use os::snapshot;

#[cfg(windows)]
mod os {
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex, Weak};

    use super::{is_agent, is_script_host, plan, Proc, Settings, POLL};
    use crate::job::{Assign, JobHandle, JobRef};

    struct PaneRef {
        terminal_id: String,
        root: u32,
        job: JobRef,
    }

    /// Settings plus every live pane job of one process (the host, or the app
    /// for its in-process panes). The watcher thread starts with the first
    /// captured pane and ends when the registry is dropped.
    pub struct Registry {
        settings: Mutex<Settings>,
        panes: Mutex<Vec<PaneRef>>,
        started: std::sync::Once,
    }

    impl Registry {
        pub fn new() -> Arc<Self> {
            Arc::new(Registry {
                settings: Mutex::new(Settings::default()),
                panes: Mutex::new(Vec::new()),
                started: std::sync::Once::new(),
            })
        }

        /// A registry whose watcher never starts: tests drive [`Self::pass`]
        /// themselves, so no second pass runs alongside.
        pub fn without_watcher() -> Arc<Self> {
            let r = Self::new();
            r.started.call_once(|| {});
            r
        }

        pub fn settings(&self) -> Settings {
            self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }

        /// Capture `pid` (a pane shell that has not run anything yet) in a
        /// kill-on-close job born with this pane's limits.
        pub fn capture(self: &Arc<Self>, terminal_id: &str, pid: u32) -> Option<JobHandle> {
            // Under the panes lock, like `set`: a settings change can then
            // never fall between reading the limits and registering the pane.
            let mut panes = self.panes.lock().unwrap_or_else(|e| e.into_inner());
            let limits = self.settings().limits_for(terminal_id);
            let job = JobHandle::capturing_with(pid, &limits)?;
            panes.retain(|p| p.job.alive());
            panes.push(PaneRef {
                terminal_id: terminal_id.to_string(),
                root: pid,
                job: job.downgrade(),
            });
            drop(panes);
            self.start_watcher();
            Some(job)
        }

        /// New settings; running panes get their new limits at once (also
        /// raising processes back when a limit is lifted).
        pub fn set(&self, settings: Settings) {
            let live = {
                let mut panes = self.panes.lock().unwrap_or_else(|e| e.into_inner());
                *self.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings.clone();
                Self::upgrade_all(&mut panes)
            };
            for (id, _, job) in live {
                job.set_limits(&settings.limits_for(&id));
            }
        }

        fn upgrade_all(panes: &mut Vec<PaneRef>) -> Vec<(String, u32, JobHandle)> {
            panes.retain(|p| p.job.alive());
            panes
                .iter()
                .filter_map(|p| Some((p.terminal_id.clone(), p.root, p.job.upgrade()?)))
                .collect()
        }

        fn live(&self) -> Vec<(String, u32, JobHandle)> {
            Self::upgrade_all(&mut self.panes.lock().unwrap_or_else(|e| e.into_inner()))
        }

        fn start_watcher(self: &Arc<Self>) {
            self.started.call_once(|| {
                let weak = Arc::downgrade(self);
                let spawned = std::thread::Builder::new()
                    .name("job-priority".into())
                    .spawn(move || watch(weak));
                if let Err(e) = spawned {
                    eprintln!("[priority] watcher thread failed to start: {e}");
                }
            });
        }

        /// One watcher pass (public for tests).
        pub fn pass(&self, memo: &mut Memo) {
            let live = self.live();
            // Uncapturable early children: class forced again every pass.
            for (_, _, job) in &live {
                job.tend_strays();
            }
            let panes: Vec<_> = live
                .into_iter()
                .filter(|(_, _, job)| job.limits().build.is_some())
                .collect();
            if panes.is_empty() {
                *memo = Memo::default();
                return;
            }
            let Some(rows) = snapshot() else { return };
            let mut keep = HashMap::new();
            for (_, root, job) in &panes {
                let members: HashSet<u32> = job.pids().into_iter().collect();
                let procs: Vec<Proc> = members
                    .iter()
                    .filter_map(|pid| {
                        let (parent, exe) = rows.get(pid)?;
                        let key = (*pid, *parent, exe.clone());
                        let agent = match memo.agent.get(&key) {
                            Some(&a) => {
                                keep.insert(key, a);
                                a
                            }
                            None if is_script_host(exe) => match command_line(*pid) {
                                Some(cmd) => {
                                    let a = is_agent(exe, Some(&cmd));
                                    keep.insert(key, a);
                                    a
                                }
                                // Unreadable (transient): not cached, so the
                                // next pass reads it again.
                                None => false,
                            },
                            None => {
                                let a = is_agent(exe, None);
                                keep.insert(key, a);
                                a
                            }
                        };
                        Some(Proc {
                            pid: *pid,
                            parent: *parent,
                            exe: exe.clone(),
                            agent,
                        })
                    })
                    .collect();
                for pid in plan(&procs, *root) {
                    let (parent, exe) = &rows[&pid];
                    let key = (pid, *parent, exe.clone());
                    if memo.assigned.contains(&key) {
                        memo.next.insert(key);
                        continue;
                    }
                    match job.assign_build(pid) {
                        Assign::Done => {
                            memo.next.insert(key);
                        }
                        Assign::Gone => {}
                        // Nesting failed for this pane (logged once in
                        // `job.rs`): nothing to retry.
                        Assign::NoBuildJob => {
                            memo.next.insert(key);
                        }
                        // A process in a foreign nested job (an agent's
                        // libuv job) can never join: logged once, then
                        // remembered so it is not retried every pass. It
                        // keeps the pane's class; its children can join.
                        Assign::Refused(err) => {
                            eprintln!(
                                "[priority] {exe} ({pid}) stays at the pane class: \
                                 build job refused (error {err})"
                            );
                            memo.next.insert(key);
                        }
                    }
                }
            }
            // Only what is still a member survives: an exited process's
            // entries go, so a reused PID is looked at again.
            memo.agent = keep;
            memo.assigned = std::mem::take(&mut memo.next);
        }
    }

    /// What earlier passes decided, keyed by (pid, parent, exe) so a process
    /// is opened (and its command line read) once, not every pass.
    #[derive(Default)]
    pub struct Memo {
        agent: HashMap<(u32, u32, String), bool>,
        assigned: HashSet<(u32, u32, String)>,
        next: HashSet<(u32, u32, String)>,
    }

    fn watch(registry: Weak<Registry>) {
        let mut memo = Memo::default();
        loop {
            std::thread::sleep(POLL);
            let Some(r) = registry.upgrade() else { return };
            r.pass(&mut memo);
        }
    }

    /// pid → (parent, exe) for every process on the system.
    pub(crate) fn snapshot() -> Option<HashMap<u32, (u32, String)>> {
        use std::mem;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        // SAFETY: plain Win32 calls on a zeroed, sized entry; the snapshot
        // handle is closed once.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap.is_null() {
                return None;
            }
            let mut out = HashMap::new();
            let mut entry: PROCESSENTRY32W = mem::zeroed();
            entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.insert(
                    entry.th32ProcessID,
                    (
                        entry.th32ParentProcessID,
                        String::from_utf16_lossy(&entry.szExeFile[..len]),
                    ),
                );
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
            Some(out)
        }
    }

    /// Command line of `pid` via `NtQueryInformationProcess`
    /// (`ProcessCommandLineInformation`, Windows 8.1+). `None` on any failure.
    pub fn command_line(pid: u32) -> Option<String> {
        use windows_sys::Wdk::System::Threading::{
            NtQueryInformationProcess, ProcessCommandLineInformation,
        };
        use windows_sys::Win32::Foundation::{CloseHandle, UNICODE_STRING};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: the first call only reports the size; the buffer is u64
        // backed so the UNICODE_STRING header is aligned, and its Buffer
        // points inside it. The handle is closed once.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut len: u32 = 0;
            NtQueryInformationProcess(
                h,
                ProcessCommandLineInformation,
                std::ptr::null_mut(),
                0,
                &mut len,
            );
            let mut result = None;
            if len as usize >= std::mem::size_of::<UNICODE_STRING>() && len < 1 << 20 {
                let mut buf = vec![0u64; (len as usize).div_ceil(8)];
                let status = NtQueryInformationProcess(
                    h,
                    ProcessCommandLineInformation,
                    buf.as_mut_ptr().cast(),
                    len,
                    &mut len,
                );
                if status >= 0 {
                    let us = &*(buf.as_ptr() as *const UNICODE_STRING);
                    if !us.Buffer.is_null() {
                        let chars =
                            std::slice::from_raw_parts(us.Buffer, (us.Length / 2) as usize);
                        result = Some(String::from_utf16_lossy(chars));
                    }
                }
            }
            CloseHandle(h);
            result
        }
    }
}

#[cfg(windows)]
pub use os::Memo;

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, exe: &str) -> Proc {
        Proc {
            pid,
            parent,
            exe: exe.into(),
            agent: is_agent(exe, None),
        }
    }

    fn sorted(mut v: Vec<u32>) -> Vec<u32> {
        v.sort();
        v
    }

    #[test]
    fn lowers_everything_below_the_agent_but_not_the_agent() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "claude.exe"),
            p(12, 11, "bash.exe"),
            p(13, 12, "cargo.exe"),
            p(14, 13, "rustc.exe"),
            p(15, 11, "node.exe"),
        ];
        assert_eq!(sorted(plan(&procs, 10)), vec![12, 13, 14, 15]);
    }

    #[test]
    fn ancestors_of_an_agent_stay_out() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "wrapper.exe"),
            p(12, 11, "codex.exe"),
            p(13, 12, "cargo.exe"),
        ];
        assert_eq!(plan(&procs, 10), vec![13]);
    }

    #[test]
    fn plain_pane_lowers_first_non_launcher_and_its_subtree() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "cargo.exe"),
            p(12, 11, "rustc.exe"),
            p(13, 10, "cmd.exe"),
            p(14, 13, "node.exe"),
            p(15, 14, "esbuild.exe"),
            p(16, 15, "node.exe"),
        ];
        assert_eq!(sorted(plan(&procs, 10)), vec![11, 12, 15, 16]);
    }

    #[test]
    fn shimmed_agent_is_recognised_by_command_line() {
        // npm shim: cmd -> node .../@anthropic-ai/claude-code/cli.js.
        let mut agent = p(12, 11, "node.exe");
        agent.agent = is_agent(
            "node.exe",
            Some(r#""C:\nodejs\node.exe" C:\npm\node_modules\@anthropic-ai\claude-code\cli.js"#),
        );
        assert!(agent.agent);
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "cmd.exe"),
            agent,
            p(13, 12, "python.exe"),
            p(14, 13, "node.exe"),
        ];
        assert_eq!(sorted(plan(&procs, 10)), vec![13, 14]);
    }

    #[test]
    fn node_without_an_agent_marker_is_a_launcher() {
        assert!(!is_agent("node.exe", Some("node server.js")));
        assert!(!is_agent("node.exe", None));
        assert!(is_agent("Claude.EXE", None));
        assert!(is_agent("cursor-agent.exe", None));
    }

    #[test]
    fn orphans_hang_below_the_shell() {
        // 11 (a `start` wrapper) exited; its child 12 is still in the job.
        let procs = [p(10, 1, "pwsh.exe"), p(12, 11, "cargo.exe"), p(13, 12, "rustc.exe")];
        assert_eq!(sorted(plan(&procs, 10)), vec![12, 13]);
        // An orphan launcher stays out, its build child goes in.
        let procs = [p(10, 1, "pwsh.exe"), p(12, 11, "python.exe"), p(13, 12, "ping.exe")];
        assert_eq!(plan(&procs, 10), vec![13]);
    }

    #[test]
    fn interactive_programs_in_a_plain_pane_stay_out() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "ssh.exe"), p(12, 10, "nvim.exe")];
        assert!(plan(&procs, 10).is_empty());
    }

    #[test]
    fn pid_reuse_cycle_terminates() {
        let procs = [p(10, 11, "pwsh.exe"), p(11, 10, "cargo.exe")];
        assert_eq!(plan(&procs, 10), vec![11]);
        let procs = [p(10, 1, "pwsh.exe"), p(11, 12, "a.exe"), p(12, 11, "b.exe")];
        // A parent cycle the shell cannot reach is still in the job.
        assert_eq!(sorted(plan(&procs, 10)), vec![11, 12]);
    }

    #[test]
    fn limits_per_mode() {
        let mut s = Settings::default();
        assert_eq!(
            s.limits_for("a"),
            Limits {
                pane: Some(Level::BelowNormal),
                build: Some(Level::Idle),
                cpu_cap: None
            }
        );
        s.mode = Mode::AgentNormal;
        s.cpu_cap = Some(50);
        assert_eq!(
            s.limits_for("a"),
            Limits {
                pane: None,
                build: Some(Level::Idle),
                cpu_cap: Some(50)
            }
        );
        s.exempt = vec!["a".into()];
        assert_eq!(s.limits_for("a"), Limits::NONE);
        assert_eq!(s.limits_for("b").build, Some(Level::Idle));
        s.mode = Mode::Off;
        assert_eq!(s.limits_for("b"), Limits::NONE);
        s.mode = Mode::Strict;
        for cap in [0, 100, 200] {
            s.cpu_cap = Some(cap);
            assert_eq!(s.limits_for("b").cpu_cap, None);
        }
    }

    #[test]
    fn settings_parse_with_defaults_and_refuse_normal() {
        let s: Settings = serde_json::from_str(r#"{"mode":"agent-normal","cpuCap":30}"#).unwrap();
        assert_eq!(s.mode, Mode::AgentNormal);
        assert_eq!(s.pane_level, Level::BelowNormal);
        assert_eq!(s.build_level, Level::Idle);
        assert_eq!(s.cpu_cap, Some(30));
        assert!(serde_json::from_str::<Settings>(r#"{"paneLevel":"normal"}"#).is_err());
        let s: Settings = serde_json::from_str(r#"{"buildLevel":"below-normal"}"#).unwrap();
        assert_eq!(s.build_level, Level::BelowNormal);
    }
}
