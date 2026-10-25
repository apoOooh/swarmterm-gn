//! Keeps a pane's build from starving the UI: every process below a pane's
//! agent CLI runs at `BELOW_NORMAL_PRIORITY_CLASS`.
//!
//! Why: a `cargo build -j32` started by an agent competes at Normal with the
//! console host, the agent CLI and WebView2, so typing and the agent's own UI
//! stall although the input path never blocks. Swarmterm and the agent stay at
//! Normal (nothing is raised); the build is lowered. Windows hands
//! BelowNormal on to child processes created afterwards, so once a build's top
//! process is lowered, the compilers it starts are BelowNormal from birth; the
//! poll only has to catch processes that were already running.
//!
//! Which processes are lowered (pure rule in [`plan`]):
//! - Below a recognised agent (native catalog executable, see
//!   `agents::AGENTS`): everything.
//! - Elsewhere below the shell (a plain Terminal pane, or an agent pane whose
//!   agent is not running / not recognised, e.g. an npm-shimmed CLI under
//!   `node.exe`): launchers (`node`, `cmd`, `pwsh`, `python`, `bash`, …, see
//!   [`is_launcher`]) are kept at Normal because an unrecognised agent may be
//!   one of them, and the first non-launcher process with its whole subtree is
//!   lowered (`cargo`, `msbuild`, `esbuild`, …).
//! - The shell itself, the agent and the ancestors of an agent never are.
//!
//! Processes already at BelowNormal or Idle and anything above Normal are left
//! alone. Handled processes are remembered by PID + creation time so a reused
//! PID is looked at again. Switching the setting off does not raise processes
//! already lowered; it only stops lowering new ones.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::agent_process::ProcInfo;

/// Poll period. Short enough that a build's first compilers are caught within
/// a beat (later ones inherit), long enough to cost nothing measurable.
pub const POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Renderer-controlled settings (`child_priority_set`). On by default so the
/// window between boot and the renderer's first push behaves like the default.
pub struct ChildPriority {
    settings: Mutex<Settings>,
}

struct Settings {
    enabled: bool,
    /// Terminal ids of panes whose workspace opted out.
    exempt: HashSet<String>,
}

impl Default for ChildPriority {
    fn default() -> Self {
        Self {
            settings: Mutex::new(Settings {
                enabled: true,
                exempt: HashSet::new(),
            }),
        }
    }
}

impl ChildPriority {
    pub fn set(&self, enabled: bool, exempt: Vec<String>) {
        let mut s = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.enabled = enabled;
        s.exempt = exempt.into_iter().collect();
    }

    fn filter(&self, panes: Vec<(String, u32)>) -> Vec<u32> {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        if !s.enabled {
            return Vec::new();
        }
        panes
            .into_iter()
            .filter(|(id, _)| !s.exempt.contains(id))
            .map(|(_, pid)| pid)
            .collect()
    }
}

fn stem(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => lower,
    }
}

/// A native agent CLI from the catalog (any agent, not only the pane's own:
/// the user may start a different CLI in a pane, or one in a Terminal pane).
fn is_agent(exe: &str) -> bool {
    let s = stem(exe);
    crate::agents::AGENTS.iter().any(|(_, native)| *native == s)
}

/// Script hosts, shells and console plumbing an agent may run under or be
/// started through (npm `.cmd` shims, `node cli.js`, Git Bash). Kept at Normal
/// outside a recognised agent so an unrecognised agent is never lowered.
fn is_launcher(exe: &str) -> bool {
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
            // Interactive programs typed into a plain shell: lowering them
            // would make the session itself (not a build) lag behind.
            | "ssh"
            | "vim"
            | "nvim"
            | "less"
            | "more"
            | "nano"
            | "hx"
    )
}

/// PIDs below `root` that should run at BelowNormal (see module docs). The
/// visited set guards against PID-reuse parent cycles in a snapshot.
pub fn plan(procs: &[ProcInfo], root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<&ProcInfo>> = HashMap::new();
    for p in procs {
        if p.pid != p.parent {
            children.entry(p.parent).or_default().push(p);
        }
    }
    // Pre-order list of the pane's tree: (pid, parent index, exe).
    let mut order: Vec<(u32, Option<usize>, &str)> = vec![(root, None, "")];
    let mut visited = HashSet::from([root]);
    let mut i = 0;
    while i < order.len() {
        let pid = order[i].0;
        if let Some(kids) = children.get(&pid) {
            for k in kids {
                if visited.insert(k.pid) {
                    order.push((k.pid, Some(i), k.exe.as_str()));
                }
            }
        }
        i += 1;
    }
    // Whether a node's subtree contains an agent (children come after parents
    // in `order`, so a reverse pass sees every child first).
    let mut has_agent = vec![false; order.len()];
    for j in (1..order.len()).rev() {
        if is_agent(order[j].2) {
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
        let (pid, parent, exe) = order[j];
        let parent = parent.unwrap_or(0);
        let below_agent = parent != 0 && (lower[parent] || is_agent(order[parent].2));
        lower[j] = if below_agent {
            true
        } else if has_agent[j] {
            // The agent itself or one of its ancestors.
            false
        } else {
            !is_launcher(exe)
        };
        if lower[j] {
            out.push(pid);
        }
    }
    out
}

/// Starts the watcher on its own thread. It copies the panes' shell pids
/// under the `terminals` lock and does all OS work after releasing it.
pub fn start(app: tauri::AppHandle) {
    use tauri::Manager;
    let spawned = std::thread::Builder::new()
        .name("child-priority".into())
        .spawn(move || {
            let mut memo = Memo::default();
            loop {
                std::thread::sleep(POLL);
                let panes: Vec<(String, u32)> = {
                    let state = app.state::<crate::pty::AppState>();
                    // A poisoned lock must not end the watcher for the session.
                    let map = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
                    map.iter()
                        .filter_map(|(id, t)| t.pid.map(|p| (id.clone(), p)))
                        .collect()
                };
                let roots = app.state::<ChildPriority>().filter(panes);
                if roots.is_empty() {
                    memo = Memo::default();
                    continue;
                }
                let Some(procs) = crate::agent_process::snapshot() else {
                    continue;
                };
                pass(&procs, &roots, &mut memo);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[child-priority] watcher thread failed to start: {e}");
    }
}

/// What earlier passes already did. `seen` maps a snapshot row's
/// (pid, parent, exe) to its (pid, creation time) key so a process is opened
/// once, not every pass: a big build has hundreds of compilers. A reused PID
/// that also has the same parent and executable skips the check, which is
/// harmless: its parent is in the plan too, so it was born BelowNormal.
#[derive(Default)]
pub struct Memo {
    seen: HashMap<(u32, u32, String), (u32, u64)>,
    handled: HashSet<(u32, u64)>,
}

/// One watcher pass over a snapshot; the memo is pruned to planned processes.
pub fn pass(procs: &[ProcInfo], roots: &[u32], memo: &mut Memo) {
    let rows: HashMap<u32, &ProcInfo> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut seen = HashMap::new();
    for &root in roots {
        for pid in plan(procs, root) {
            let Some(row) = rows.get(&pid) else { continue };
            let id = (pid, row.parent, row.exe.clone());
            let key = match memo.seen.get(&id) {
                Some(&key) => Some(key),
                None => os::lower(pid, &mut memo.handled),
            };
            if let Some(key) = key {
                seen.insert(id, key);
            }
        }
    }
    // Only processes still planned survive; an exited one's entries go, and
    // a reused PID has a new creation time anyway.
    memo.handled = seen.values().copied().collect();
    memo.seen = seen;
}

#[cfg(windows)]
mod os {
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetPriorityClass, GetProcessTimes, OpenProcess, SetPriorityClass,
        BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_INFORMATION,
    };

    /// Lowers `pid` once per (PID, creation time); returns that key, or `None`
    /// when the process cannot be opened (gone, or not ours).
    pub fn lower(pid: u32, handled: &mut HashSet<(u32, u64)>) -> Option<(u32, u64)> {
        unsafe {
            let h = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                0,
                pid,
            );
            if h.is_null() {
                return None;
            }
            let z = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut c, mut e, mut k, mut u) = (z, z, z, z);
            let key = if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
                Some((
                    pid,
                    ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64,
                ))
            } else {
                None
            };
            if let Some(key) = key {
                if handled.insert(key) {
                    // Only exactly Normal is lowered: BelowNormal/Idle are
                    // already there, above Normal was someone's choice.
                    if GetPriorityClass(h) == NORMAL_PRIORITY_CLASS {
                        SetPriorityClass(h, BELOW_NORMAL_PRIORITY_CLASS);
                    }
                }
            }
            CloseHandle(h);
            key
        }
    }
}

#[cfg(not(windows))]
mod os {
    use std::collections::HashSet;
    pub fn lower(_pid: u32, _handled: &mut HashSet<(u32, u64)>) -> Option<(u32, u64)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, exe: &str) -> ProcInfo {
        ProcInfo {
            pid,
            parent,
            exe: exe.into(),
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
    fn ancestors_of_an_agent_stay_normal() {
        // An unknown wrapper between the shell and the agent.
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
    fn shimmed_agent_under_node_is_never_lowered() {
        // npm shim: cmd -> node cli.js (not recognisable without a cmdline).
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "cmd.exe"),
            p(12, 11, "node.exe"),
            p(13, 12, "rg.exe"),
        ];
        assert_eq!(plan(&procs, 10), vec![13]);
    }

    #[test]
    fn agent_started_later_turns_its_ancestors_back_to_kept() {
        // Pass 1: an unknown program that is not a launcher is lowered...
        let before = [p(10, 1, "pwsh.exe"), p(11, 10, "wrapper.exe")];
        assert_eq!(plan(&before, 10), vec![11]);
        // ...pass 2: it started an agent, so only the agent's children are
        // planned. Known limit: nothing is raised, so an agent started by an
        // already-lowered wrapper inherits BelowNormal (an agent started from
        // the shell or a launcher, the normal case, is unaffected).
        let after = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "wrapper.exe"),
            p(12, 11, "claude.exe"),
            p(13, 12, "cargo.exe"),
        ];
        assert_eq!(plan(&after, 10), vec![13]);
    }

    #[test]
    fn interactive_programs_in_a_plain_pane_stay_normal() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "ssh.exe"),
            p(12, 10, "nvim.exe"),
        ];
        assert!(plan(&procs, 10).is_empty());
    }

    #[test]
    fn processes_outside_the_pane_are_ignored() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(20, 1, "cargo.exe"),
            p(21, 20, "rustc.exe"),
        ];
        assert!(plan(&procs, 10).is_empty());
    }

    #[test]
    fn pid_reuse_cycle_terminates() {
        let procs = [p(10, 11, "pwsh.exe"), p(11, 10, "cargo.exe")];
        assert_eq!(plan(&procs, 10), vec![11]);
    }

    #[test]
    fn settings_filter_disabled_and_exempt_panes() {
        let cp = ChildPriority::default();
        let panes = || vec![("a".to_string(), 1), ("b".to_string(), 2)];
        assert_eq!(cp.filter(panes()), vec![1, 2]);
        cp.set(true, vec!["a".into()]);
        assert_eq!(cp.filter(panes()), vec![2]);
        cp.set(false, vec![]);
        assert!(cp.filter(panes()).is_empty());
    }

    /// Cost of one watcher pass on this machine (snapshot + plan for 8 panes
    /// rooted at this process). `cargo test -- --ignored watcher_pass_cost --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn watcher_pass_cost() {
        let roots = [std::process::id(); 8];
        let mut memo = Memo::default();
        let t = std::time::Instant::now();
        let n = 200;
        for _ in 0..n {
            let procs = crate::agent_process::snapshot().unwrap();
            pass(&procs, &roots, &mut memo);
        }
        let per = t.elapsed() / n;
        let procs = crate::agent_process::snapshot().unwrap().len();
        println!(
            "watcher pass: {per:?} per pass, {procs} processes, {:.3}% of one core at {POLL:?}",
            per.as_secs_f64() / POLL.as_secs_f64() * 100.0
        );
    }

    /// End to end with synthetic processes: a copy of `cmd.exe` named
    /// `claude.exe` plays the agent below this test process, and the `ping`
    /// it starts must come out BelowNormal while the "agent" keeps the class it
    /// inherited from this test (Normal outside a Swarmterm pane).
    #[cfg(windows)]
    #[test]
    fn real_tree_lowers_child_of_synthetic_agent() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let dir = std::env::temp_dir().join(format!("swarmterm-cp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude.exe");
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        std::fs::copy(format!(r"{sysroot}\System32\cmd.exe"), &fake).unwrap();
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let class = |pid: u32| unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            assert!(!h.is_null());
            let c = GetPriorityClass(h);
            CloseHandle(h);
            c
        };
        // The "agent" inherits this test's class, read before it is spawned.
        // Inside a Swarmterm pane the live watcher lowered `cargo` already, so
        // this test binary is BelowNormal from birth and so is the agent; the
        // strict "pass leaves the agent alone" check then only holds when run
        // outside a pane (inherited Normal, no live watcher).
        let inherited = class(std::process::id());
        let mut agent = std::process::Command::new(&fake)
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let me = std::process::id();
        let mut ping = None;
        for _ in 0..50 {
            let procs = crate::agent_process::snapshot().unwrap();
            ping = procs
                .iter()
                .find(|x| x.parent == agent.id() && stem(&x.exe) == "ping")
                .map(|x| x.pid);
            if ping.is_some() {
                let mut memo = Memo::default();
                pass(&procs, &[me], &mut memo);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let ping = ping.expect("ping child");
        let (agent_class, ping_class) = (class(agent.id()), class(ping));
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &agent.id().to_string()])
            .output();
        let _ = agent.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            inherited == NORMAL_PRIORITY_CLASS || inherited == BELOW_NORMAL_PRIORITY_CLASS,
            "unexpected test priority class {inherited:#x}"
        );
        assert_eq!(agent_class, inherited);
        assert_eq!(ping_class, BELOW_NORMAL_PRIORITY_CLASS);
    }
}
