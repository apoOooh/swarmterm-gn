//! Which hook shape the installed Claude Code understands (SWA-83 1c-ii).
//!
//! Exec-form hooks (`command` + `args`, spawned without a shell) exist since
//! Claude Code 2.1.139 ("Added hook `args: string[]` field (exec form)").
//! They are the only shape that runs both under Git Bash and under the
//! PowerShell that Claude Code falls back to without it. An older CLI must
//! not get them: how it treats the unknown `args` key is undocumented — at
//! best it runs `swarmterm.exe` without `--hook` (which starts the app), at
//! worst its settings validation drops the user's whole `settings.json`.
//! So `--version` decides, and an unknown answer keeps the shell form (with
//! the Git Bash gate from 1c-i).
//!
//! What is checked is the `claude` that `agents::find_agent_binary` finds —
//! the one panes start. A `claude` reached through a shell alias or a
//! wrapper script elsewhere is not; the stamp (path, size, modification
//! time) only tells when to ask again.
//!
//! The probe costs ~100 ms and runs at most once per binary: the verdict is
//! cached by that stamp, so an update or a downgrade of Claude Code is
//! noticed at the next `ensure`, pane start or "Check again"
//! (`still_current`). A failed probe is retried, but no more often than
//! `RETRY_AFTER`. It never runs on the UI thread: `setup::boot` hands it to
//! a blocking worker.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// First Claude Code version with exec-form hooks.
pub const EXEC_HOOKS_SINCE: (u32, u32, u32) = (2, 1, 139);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// `2.1.319 (Claude Code)` → `(2, 1, 319)`. Pre-release or build suffixes on
/// the patch number (`2.1.140-beta.1`) are ignored.
pub fn parse_version(output: &str) -> Option<(u32, u32, u32)> {
    let token = output.split_whitespace().next()?;
    let mut parts = token.trim_start_matches('v').splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    Some((major, minor, patch.parse().ok()?))
}

pub fn supports_exec_hooks(version: (u32, u32, u32)) -> bool {
    version >= EXEC_HOOKS_SINCE
}

#[derive(Clone, PartialEq, Debug)]
struct Stamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp {
        path: path.to_path_buf(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// The `claude` panes would start, as a stamp; `None` when there is none.
fn current_stamp() -> Option<Option<Stamp>> {
    match crate::agents::find_agent_binary("claude") {
        None => Some(None),
        Some(binary) => stamp(Path::new(&binary)).map(Some),
    }
}

/// One answer of `current`: which hook form to write, for which binary, and
/// whether it is settled (a failed or pending probe is not).
#[derive(Clone, PartialEq, Debug)]
pub struct Verdict {
    stamp: Option<Stamp>,
    pub exec: bool,
    settled: bool,
}

enum Cached {
    Known(Stamp, bool),
    Failed(Stamp, Instant),
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

fn cached(current: &Stamp) -> Option<Verdict> {
    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(Cached::Known(s, exec)) if s == current => Some(Verdict {
            stamp: Some(s.clone()),
            exec: *exec,
            settled: true,
        }),
        Some(Cached::Failed(s, at)) if s == current && at.elapsed() < RETRY_AFTER => {
            Some(Verdict {
                stamp: Some(s.clone()),
                exec: false,
                settled: false,
            })
        }
        _ => None,
    }
}

/// The verdict for the `claude` on this machine now, probing when the cache
/// has no answer for its stamp. The cache lock is NOT held across the probe:
/// two first callers may both probe (bounded, rare), but nobody waits on a
/// lock for up to `PROBE_TIMEOUT`.
pub fn current() -> Verdict {
    let Some(binary) = crate::agents::find_agent_binary("claude") else {
        return Verdict {
            stamp: None,
            exec: false,
            settled: true,
        };
    };
    let Some(now) = stamp(Path::new(&binary)) else {
        return Verdict {
            stamp: None,
            exec: false,
            settled: false,
        };
    };
    if let Some(v) = cached(&now) {
        return v;
    }
    let found = probe(Path::new(&binary)).map(supports_exec_hooks);
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(match found {
        Some(exec) => Cached::Known(now.clone(), exec),
        None => Cached::Failed(now.clone(), Instant::now()),
    });
    Verdict {
        stamp: Some(now),
        exec: found.unwrap_or(false),
        settled: found.is_some(),
    }
}

/// Does the Claude Code on this machine take exec-form hooks? `false` when
/// it is not found, too old, or its version could not be read.
pub fn exec_hooks() -> bool {
    current().exec
}

/// Is `v` still the answer for the `claude` panes would start now? Cheap: a
/// PATH lookup and a `stat`, no process. `false` for an unsettled verdict,
/// so a failed probe is retried by the next ensure.
pub fn still_current(v: &Verdict) -> bool {
    current_for(v, current_stamp())
}

/// Pure half of `still_current`; `now` is `None` when the binary could not
/// be stat'ed.
fn current_for(v: &Verdict, now: Option<Option<Stamp>>) -> bool {
    v.settled && now.is_some_and(|now| now == v.stamp)
}

/// `claude --version`, bounded. `None` when it fails or does not answer.
fn probe(binary: &Path) -> Option<(u32, u32, u32)> {
    let mut command = crate::terminal_env::command(binary);
    command.arg("--version");
    parse_version(&run_bounded(command, PROBE_TIMEOUT)?)
}

/// Run `command` and collect its stdout, process exit AND output under ONE
/// deadline. A wrapper (`claude.cmd`, a version manager shim) may leave a
/// child behind that inherited the stdout pipe: the pipe then never reaches
/// EOF, so nothing here waits for EOF without a bound, and the whole tree is
/// captured in a kill-on-close job and torn down at the end, which closes
/// the pipe for the reader thread too. `None` when the process failed, did
/// not finish in time, printed nothing, or could not be put in the job.
///
/// The process is created suspended and resumed only once it is in the job:
/// a running wrapper could start a pipe-holding child and exit before
/// `AssignProcessToJobObject`, which then fails (access denied on a dead
/// root), and that child would outlive the probe. No job, no probe — the
/// caller's verdict stays unsettled and the shell form is kept.
fn run_bounded(mut command: Command, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    #[cfg(windows)]
    let job = match crate::pty::job::JobHandle::capturing(child.id()) {
        Some(job) if resume(child.id()) => job,
        // Not in the job, or never resumed: kill it before it runs a single
        // instruction (a resumed-but-failed case dies with the job's drop).
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut out) = child.stdout.take() {
        // Detached on purpose: it ends at EOF, which the teardown below
        // guarantees for every process in the job.
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut total = 0usize;
            while total < 4096 {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        total += n;
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let exited_ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => break false,
        }
    };
    let mut text = Vec::new();
    if exited_ok {
        // Output may still be in flight after the exit. Stop at EOF, at the
        // deadline, or as soon as a complete version line is there (a
        // leftover grandchild keeps the pipe open, never the answer back).
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(chunk) => {
                    text.extend_from_slice(&chunk);
                    let s = String::from_utf8_lossy(&text);
                    if s.contains('\n') && parse_version(&s).is_some() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    #[cfg(windows)]
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    (exited_ok && !text.is_empty()).then(|| String::from_utf8_lossy(&text).into_owned())
}

/// Resume every thread of the suspended process `pid` (a fresh process has
/// exactly one). `std` keeps the primary thread handle to itself, so the
/// threads are found by snapshot. False if none could be resumed.
#[cfg(windows)]
fn resume(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: every handle is opened and closed here; the entry is a plain
    // out-struct with its size set as the API requires.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = false;
        let mut more = Thread32First(snap, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    resumed |= ResumeThread(thread) != u32::MAX;
                    CloseHandle(thread);
                }
            }
            more = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        resumed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resuming_an_unknown_process_fails() {
        assert!(!resume(u32::MAX));
    }

    #[test]
    fn reads_the_version_line() {
        assert_eq!(parse_version("2.1.319 (Claude Code)\n"), Some((2, 1, 319)));
        assert_eq!(parse_version("v2.1.140-beta.1"), Some((2, 1, 140)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("Claude Code"), None);
        assert_eq!(parse_version("2.1"), None);
    }

    #[test]
    fn exec_hooks_start_at_2_1_139() {
        assert!(!supports_exec_hooks((2, 1, 138)));
        assert!(supports_exec_hooks((2, 1, 139)));
        assert!(supports_exec_hooks((2, 2, 0)));
        assert!(supports_exec_hooks((3, 0, 0)));
        assert!(!supports_exec_hooks((1, 9, 999)));
    }

    #[test]
    fn an_unsettled_verdict_is_never_current() {
        let v = Verdict {
            stamp: None,
            exec: false,
            settled: false,
        };
        assert!(!still_current(&v));
        assert!(!current_for(&v, Some(None)));
    }

    /// Review finding 3: once set up, a pane start must still notice a
    /// replaced Claude Code (update or downgrade) and a probe that failed at
    /// first, without "Check again".
    #[test]
    fn a_replaced_binary_or_a_failed_probe_is_not_current() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("claude.exe");
        std::fs::write(&exe, b"v1").unwrap();
        let first = stamp(&exe);
        let done = Verdict {
            stamp: first.clone(),
            exec: true,
            settled: true,
        };
        assert!(current_for(&done, Some(first.clone())));
        // Same path, other build (size differs): written for another binary.
        std::fs::write(&exe, b"downgraded").unwrap();
        assert!(!current_for(&done, Some(stamp(&exe))));
        // Uninstalled, or not stat-able.
        assert!(!current_for(&done, Some(None)));
        assert!(!current_for(&done, None));
        // A failed probe (shell form for now) is retried by the next ensure.
        let failed = Verdict {
            stamp: first.clone(),
            exec: false,
            settled: false,
        };
        assert!(!current_for(&failed, Some(first)));
    }

    /// `cmd /c <line>`, as a wrapper script would run.
    #[cfg(windows)]
    fn cmd(line: &str) -> Command {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{line}\""));
        c
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_plain_answer() {
        let out = run_bounded(cmd("echo 2.1.200 (Claude Code)"), PROBE_TIMEOUT).unwrap();
        assert_eq!(parse_version(&out), Some((2, 1, 200)));
    }

    /// Review finding: the wrapper exits, but a grandchild that inherited
    /// stdout keeps the pipe open. The answer must come back at once and the
    /// call must not outlive its deadline.
    #[cfg(windows)]
    #[test]
    fn a_grandchild_holding_the_pipe_does_not_stall_the_probe() {
        let started = Instant::now();
        let out = run_bounded(
            cmd("echo 2.1.200 (Claude Code)& start /b ping -n 30 127.0.0.1 >nul"),
            PROBE_TIMEOUT,
        );
        assert_eq!(out.as_deref().and_then(parse_version), Some((2, 1, 200)));
        assert!(started.elapsed() < PROBE_TIMEOUT, "{:?}", started.elapsed());

        // Nothing useful printed: bounded by the deadline, not by the
        // grandchild's 30 s.
        let started = Instant::now();
        let out = run_bounded(
            cmd("start /b ping -n 30 127.0.0.1 >nul"),
            Duration::from_millis(800),
        );
        assert_eq!(out, None);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_hanging_cli_is_cut_off() {
        let started = Instant::now();
        let out = run_bounded(cmd("ping -n 30 127.0.0.1 >nul"), Duration::from_millis(500));
        assert_eq!(out, None);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_failing_cli_has_no_answer() {
        assert_eq!(
            run_bounded(cmd("echo 2.1.200& exit 1"), PROBE_TIMEOUT),
            None
        );
    }
}
