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

/// Native executable stem for a template id, from the backend agent catalog
/// (`agents::AGENTS`) — the template id is not the binary name
/// (`claude-code` runs as `claude.exe`).
fn native_stem(agent_id: &str) -> Option<&'static str> {
    crate::agents::AGENTS
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, exe)| *exe)
}

/// Package markers that identify an npm-shim install running under a script
/// host. A bare `node`/`bun` proves nothing (a dev server or profile hook
/// would fake liveness), so the host only counts when its command line names
/// the agent's own package. Agents without a marker are accepted natively only.
pub(crate) fn script_markers(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        "claude-code" => &["@anthropic-ai/claude-code", "claude-code/cli.js"],
        "codex" => &["@openai/codex"],
        "opencode" => &["opencode-ai"],
        "gemini" => &["@google/gemini-cli"],
        "qwen" => &["@qwen-code/qwen-code"],
        "copilot" => &["@github/copilot"],
        "amp" => &["@sourcegraph/amp"],
        _ => &[],
    }
}

fn stem(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => lower,
    }
}

/// Whether `exe` is a script host whose identity lives in its command line.
pub fn is_script_host(exe: &str) -> bool {
    matches!(stem(exe).as_str(), "node" | "bun")
}

/// Identity rule for one process. Native: executable stem equals the agent's
/// catalog executable. Script host: the command line (normalised to forward
/// slashes, lower case) contains one of the agent's package markers; an
/// unreadable command line fails closed.
pub fn process_is_agent(exe: &str, cmdline: Option<&str>, agent_id: &str) -> bool {
    if is_script_host(exe) {
        let Some(cmd) = cmdline else { return false };
        let cmd = cmd.replace('\\', "/").to_ascii_lowercase();
        return script_markers(agent_id).iter().any(|m| cmd.contains(m));
    }
    native_stem(agent_id).is_some_and(|n| stem(exe) == n)
}

/// Whether a process matching `agent_id` lives anywhere below `root` (the
/// shell). No agent id means there is nothing to prove: fail closed.
/// `cmdline` is only consulted for script hosts (it is an OS call per pid).
pub fn agent_alive_in(
    procs: &[ProcInfo],
    root: u32,
    agent_id: Option<&str>,
    cmdline: impl Fn(u32) -> Option<String>,
) -> bool {
    let Some(agent_id) = agent_id else {
        return false;
    };
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
            let cmd = if is_script_host(&p.exe) {
                cmdline(p.pid)
            } else {
                None
            };
            if process_is_agent(&p.exe, cmd.as_deref(), agent_id) {
                return true;
            }
            frontier.push(p.pid);
        }
    }
    false
}

/// Command line of `pid` (`NtQueryInformationProcess`,
/// `ProcessCommandLineInformation`); shared with the host's priority watcher.
/// `None` on any failure — the caller then fails closed.
#[cfg(windows)]
pub fn command_line(pid: u32) -> Option<String> {
    swarmterm_host::priority::command_line(pid)
}

#[cfg(not(windows))]
pub fn command_line(_pid: u32) -> Option<String> {
    None
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

    fn none(_: u32) -> Option<String> {
        None
    }

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
        assert!(agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn finds_shimmed_agent_deeper_in_tree() {
        let procs = [
            p(10, 1, "pwsh.exe"),
            p(11, 10, "cmd.exe"),
            p(12, 11, "node.exe"),
        ];
        let cmd = |_| Some(r"node C:\npm\node_modules\@openai\codex\bin\codex.js".to_string());
        assert!(agent_alive_in(&procs, 10, Some("codex"), cmd));
    }

    #[test]
    fn bare_shell_after_agent_exit_is_not_alive() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "conhost.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn agent_outside_the_pane_does_not_count() {
        let procs = [p(10, 1, "pwsh.exe"), p(20, 1, "claude.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn other_agent_executable_does_not_count() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "codex.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn no_agent_id_fails_closed() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "claude.exe")];
        assert!(!agent_alive_in(&procs, 10, None, none));
    }

    #[test]
    fn pid_reuse_cycle_terminates() {
        let procs = [p(10, 11, "pwsh.exe"), p(11, 10, "cmd.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn unrelated_node_does_not_count() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "node.exe")];
        let cmd = |_| Some("node C:/proj/node_modules/vite/bin/vite.js".to_string());
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), cmd));
    }

    #[test]
    fn script_host_without_cmdline_fails_closed() {
        let procs = [p(10, 1, "pwsh.exe"), p(11, 10, "bun.exe")];
        assert!(!agent_alive_in(&procs, 10, Some("claude-code"), none));
    }

    #[test]
    fn identity_rules_with_real_ids() {
        assert!(process_is_agent("claude.exe", None, "claude-code"));
        assert!(!process_is_agent("claude-code.exe", None, "claude-code"));
        assert!(process_is_agent("codex.exe", None, "codex"));
        assert!(process_is_agent("OpenCode.exe", None, "opencode"));
        assert!(process_is_agent("cursor-agent.exe", None, "cursor"));
        assert!(!process_is_agent("claude.exe", None, "codex"));
        assert!(!process_is_agent("claude.exe", None, "unknown-agent"));
        let claude =
            r"node C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js";
        assert!(process_is_agent("node.exe", Some(claude), "claude-code"));
        assert!(!process_is_agent("node.exe", Some(claude), "codex"));
        assert!(process_is_agent(
            "node.exe",
            Some("node /x/@openai/codex/bin/codex.js"),
            "codex"
        ));
        assert!(!process_is_agent(
            "node.exe",
            Some("node server.js"),
            "codex"
        ));
        assert!(!process_is_agent("node.exe", None, "claude-code"));
    }
}
