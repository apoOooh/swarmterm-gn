//! Command routines (SWA-67): run one shell line in the background — no pane,
//! no agent, no tokens — and report exit code plus the tail of its output.
//!
//! The line comes only from the user's own routine list (renderer local
//! storage, main webview); nothing reaches this from MCP or the War Room. It
//! runs through `cmd.exe /d /s /c` without a console window, inside a
//! kill-on-close Job Object so a timeout — or a command that leaves background
//! children behind — never outlives the run.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MAX_COMMAND_CHARS: usize = 4000;
pub const MAX_TIMEOUT_SECS: u64 = 3600;
/// Bytes of combined output kept while the command runs (oldest dropped).
const KEEP_BYTES: usize = 16 * 1024;
const TAIL_LINES: usize = 12;
const TAIL_CHARS: usize = 1500;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    /// `None` when the process was killed (timeout) or reported no code.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Last lines of stdout+stderr, interleaved as they arrived.
    pub output: String,
    pub duration_ms: u64,
}

/// Last `TAIL_LINES` non-empty lines, capped at `TAIL_CHARS` from the end —
/// enough for a notification, never a log dump.
pub fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    let count = joined.chars().count();
    if count <= TAIL_CHARS {
        return joined;
    }
    let cut: String = joined.chars().skip(count - TAIL_CHARS).collect();
    format!("…{cut}")
}

pub fn validate(command: &str, cwd: &str, timeout_secs: u64) -> Result<(), String> {
    let c = command.trim();
    if c.is_empty() {
        return Err("The command is empty.".into());
    }
    if c.chars().count() > MAX_COMMAND_CHARS || c.contains(['\r', '\n']) {
        return Err(format!(
            "The command must be one line of up to {MAX_COMMAND_CHARS} characters."
        ));
    }
    if !(1..=MAX_TIMEOUT_SECS).contains(&timeout_secs) {
        return Err(format!(
            "The time limit must be 1 to {MAX_TIMEOUT_SECS} seconds."
        ));
    }
    if !Path::new(cwd).is_dir() {
        return Err("The working folder does not exist.".into());
    }
    Ok(())
}

fn keep_tail(buf: &Arc<Mutex<Vec<u8>>>, mut src: impl Read) {
    let mut chunk = [0u8; 4096];
    while let Ok(n) = src.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if let Ok(mut b) = buf.lock() {
            b.extend_from_slice(&chunk[..n]);
            if b.len() > KEEP_BYTES {
                let drop = b.len() - KEEP_BYTES;
                b.drain(..drop);
            }
        }
    }
}

/// `env` is the complete environment the line runs with (the caller's env
/// policy applied): a routine is user-authored but may run agent CLIs or
/// scripts, so it gets the same secret filtering as a pane.
pub fn run(
    command: &str,
    cwd: &str,
    timeout: Duration,
    env: &crate::terminal_env::EnvPlan,
) -> Result<CommandOutcome, String> {
    let started = Instant::now();
    let mut cmd = Command::new("cmd.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg: cmd's /s rule strips exactly the outer quotes, so the line
        // reaches cmd verbatim (Rust's argv quoting would mangle inner quotes).
        cmd.raw_arg(format!("/d /s /c \"{}\"", command.trim()));
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new("sh");
        cmd.arg("-c").arg(command.trim());
    }
    cmd.env_clear();
    cmd.envs(env.iter());
    let mut child = cmd
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start: {e}"))?;
    #[cfg(windows)]
    let job = crate::pty::job::JobHandle::capturing(child.id());

    let buf = Arc::new(Mutex::new(Vec::new()));
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|src| {
        let buf = buf.clone();
        std::thread::spawn(move || keep_tail(&buf, src))
    })
    .collect();

    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if started.elapsed() >= timeout => break (None, true),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    // Tear down the whole tree (timeout, or children the line left running):
    // grandchildren holding the pipes open would otherwise block the readers.
    #[cfg(windows)]
    if let Some(job) = &job {
        job.terminate();
    }
    if timed_out {
        let _ = child.kill();
        let _ = child.wait();
    }
    for r in readers {
        let _ = r.join();
    }
    let text = String::from_utf8_lossy(&buf.lock().map_err(|e| e.to_string())?).into_owned();
    Ok(CommandOutcome {
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        output: tail(&text),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_last_lines_and_caps_length() {
        let text: String = (1..=30).map(|i| format!("line {i}\r\n\r\n")).collect();
        let t = tail(&text);
        assert!(t.starts_with("line 19") && t.ends_with("line 30"));
        let long = "x".repeat(5000);
        assert_eq!(tail(&long).chars().count(), TAIL_CHARS + 1);
    }

    #[test]
    fn validate_rejects_bad_input() {
        let dir = std::env::temp_dir();
        let d = dir.to_str().unwrap();
        assert!(validate("echo hi", d, 60).is_ok());
        assert!(validate("  ", d, 60).is_err());
        assert!(validate("a\nb", d, 60).is_err());
        assert!(validate("echo", d, 0).is_err());
        assert!(validate("echo", "Z:\\does\\not\\exist\\x", 60).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn runs_reports_exit_code_and_times_out() {
        let d = std::env::temp_dir();
        let d = d.to_str().unwrap();
        let ok = run(
            "echo \"hello world\" & exit 3",
            d,
            Duration::from_secs(20),
            &crate::terminal_env::EnvPlan::inherited(),
        )
        .unwrap();
        assert_eq!(ok.exit_code, Some(3));
        assert!(!ok.timed_out);
        assert_eq!(ok.output, "\"hello world\"");
        let slow = run(
            r"%SystemRoot%\System32\PING.EXE -n 30 127.0.0.1 >nul",
            d,
            Duration::from_secs(1),
            &crate::terminal_env::EnvPlan::inherited(),
        )
        .unwrap();
        assert!(slow.timed_out && slow.exit_code.is_none(), "{slow:?}");
        assert!(slow.duration_ms < 10_000);
    }

    /// The line sees exactly the plan it is given, not the app's own
    /// environment: secrets withheld by the env policy stay withheld.
    #[cfg(windows)]
    #[test]
    fn runs_with_only_the_given_environment() {
        let d = std::env::temp_dir();
        let d = d.to_str().unwrap();
        let mut env = crate::terminal_env::EnvPolicy::default().inherited();
        env.set("ROUTINE_PROBE", "seen");
        // Not in the plan, so cmd leaves `%PATH%` unexpanded.
        env.remove("PATH");
        let out = run(
            "echo %ROUTINE_PROBE%-%PATH%",
            d,
            Duration::from_secs(20),
            &env,
        )
        .unwrap();
        assert_eq!(out.output, "seen-%PATH%");
    }
}
