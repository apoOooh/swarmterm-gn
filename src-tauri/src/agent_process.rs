//! Liveness proof for a pane's agent CLI, independent of what the screen shows.
//!
//! The handoff delivery must never paste a brief into a bare shell: if the CLI
//! reported its session and then exited (or crashed) back to PowerShell, the
//! shell stays `running` with the same generation and the screen heuristics
//! read "idle", so the brief's lines would run as commands. The only signal
//! that does not depend on the screen is the process tree: the agent runs as a
//! descendant of the pane's shell (it is started by a line typed into it).

/// One row of a process snapshot.
#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: u32,
    /// Executable file name as reported by the OS, e.g. `claude.exe`.
    pub exe: String,
}

/// Executable stems that count as "the agent" for a given agent id. npm-shim
/// installs run the CLI under `node`/`bun`, so those count too — a stray node
/// process under an agent pane is far rarer than a shimmed install.
fn agent_stems(agent_id: &str) -> Vec<String> {
    let mut stems = vec![agent_id.to_ascii_lowercase(), "node".into(), "bun".into()];
    stems.dedup();
    stems
}

fn stem(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => lower,
    }
}

/// Whether a process matching `agent_id` lives anywhere below `root` (the
/// shell). No agent id means there is nothing to prove: fail closed.
pub fn agent_alive_in(procs: &[ProcInfo], root: u32, agent_id: Option<&str>) -> bool {
    let Some(agent_id) = agent_id else {
        return false;
    };
    let stems = agent_stems(agent_id);
    // Breadth-first over descendants; the visited set guards against PID
    // reuse producing parent cycles in a snapshot.
    let mut visited = std::collections::HashSet::new();
    let mut frontier = vec![root];
    visited.insert(root);
    while let Some(parent) = frontier.pop() {
        for p in procs
            .iter()
            .filter(|p| p.parent == parent && p.pid != parent)
        {
            if !visited.insert(p.pid) {
                continue;
            }
            if stems.contains(&stem(&p.exe)) {
                return true;
            }
            frontier.push(p.pid);
        }
    }
    false
}

/// Snapshot of every process on the system. `None` when the snapshot fails
/// (callers then fail closed).
#[cfg(windows)]
pub fn snapshot() -> Option<Vec<ProcInfo>> {
    use std::mem;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return None;
        }
        let mut out = Vec::new();
        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            out.push(ProcInfo {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
        Some(out)
    }
}

/// Only Windows is supported; elsewhere there is no proof, so fail closed.
#[cfg(not(windows))]
pub fn snapshot() -> Option<Vec<ProcInfo>> {
    None
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

    #[test]
    fn finds_agent_below_shell() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "claude.exe")];
        assert!(agent_alive_in(&procs, 10, Some("claude")));
    }

    #[test]
    fn finds_shimmed_agent_deeper_in_tree() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "cmd.exe"),
            p(12, 11, "node.exe"),
        ];
        assert!(agent_alive_in(&procs, 10, Some("codex")));
    }

    #[test]
    fn bare_shell_after_agent_exit_is_not_alive() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "conhost.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude")));
    }

    #[test]
    fn agent_outside_the_pane_does_not_count() {
        let procs = [p(10, 1, "pwsh.exe"), p(20, 1, "claude.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude")));
    }

    #[test]
    fn other_agent_executable_does_not_count() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "codex.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude")));
    }

    #[test]
    fn no_agent_id_fails_closed() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "claude.exe")];
        assert!(!agent_alive_in(&procs, 10, None));
    }

    #[test]
    fn pid_reuse_cycle_terminates() {
        let procs = [p(10, 11, "pwsh.exe"), p(11, 10, "cmd.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude")));
    }
}
