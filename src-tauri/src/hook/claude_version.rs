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
//! The probe costs ~100 ms and runs at most once per binary: the verdict is
//! cached by path, size and modification time, so an update or a downgrade
//! of Claude Code is noticed at the next `ensure`, pane start or "Check
//! again". A failed probe is retried, but no more often than `RETRY_AFTER`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
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

enum Cached {
    Known(Stamp, bool),
    Failed(Stamp, Instant),
}

/// Does the Claude Code on this machine take exec-form hooks? `false` when
/// it is not found, too old, or its version could not be read.
pub fn exec_hooks() -> bool {
    static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
    let Some(binary) = crate::agents::find_agent_binary("claude") else {
        return false;
    };
    let Some(current) = stamp(Path::new(&binary)) else {
        return false;
    };
    // Held across the probe on purpose: concurrent pane starts wait for one
    // answer instead of spawning `claude --version` each.
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(Cached::Known(s, known)) if *s == current => return *known,
        Some(Cached::Failed(s, at)) if *s == current && at.elapsed() < RETRY_AFTER => return false,
        _ => {}
    }
    let verdict = probe(Path::new(&binary)).map(supports_exec_hooks);
    *cache = Some(match verdict {
        Some(known) => Cached::Known(current, known),
        None => Cached::Failed(current, Instant::now()),
    });
    verdict.unwrap_or(false)
}

/// `claude --version`, bounded. `None` when it fails or does not answer.
fn probe(binary: &Path) -> Option<(u32, u32, u32)> {
    let mut command = crate::terminal_env::command(binary);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read on a helper thread so a CLI that never exits cannot block us
    // past the deadline.
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = (&mut stdout).take(4096).read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    parse_version(&reader.join().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
