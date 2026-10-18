//! Find or start the terminal host for this app instance (ADR 0001,
//! lifecycle). The data dir is the app's *local* data dir, so the installed
//! app and a dev build (own identifier) each get their own host, pipe and
//! discovery file, mirroring `tauri.dev-instance.conf.json`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const ENDPOINT_FILE: &str = "host-endpoint.json";
pub const HOST_EXE: &str = "swarmterm-host.exe";
/// A freshly started host needs well under a second to publish its file.
const START_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Endpoint {
    pub pipe: String,
    pub token: String,
    pub pid: u32,
}

pub fn read_endpoint(data_dir: &Path) -> Option<Endpoint> {
    std::fs::read_to_string(data_dir.join(ENDPOINT_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// The host binary ships next to the app (phase 4 moves it into a
/// versioned directory). Dev builds find it in the same `target/` folder
/// once `cargo build -p swarmterm-host` ran.
pub fn host_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe
        .parent()
        .ok_or("app has no parent directory")?
        .join(HOST_EXE);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("terminal host not found at {}", path.display()))
    }
}

/// Start a host and wait for its discovery file. `previous` is the stale
/// endpoint (if any): a file with the same token is not a fresh host.
pub fn start(data_dir: &Path, previous: Option<&Endpoint>) -> Result<Endpoint, String> {
    use std::os::windows::process::CommandExt;
    // No console window, own process group (a Ctrl+C in the app's console
    // must not reach it), and out of the app's job if the job allows it: a
    // dev app started from a Swarmterm pane lives in that pane's
    // kill-on-close job, which would otherwise take the host down with it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = host_exe()?;
    let spawn = |flags: u32| {
        std::process::Command::new(&exe)
            .arg("--data-dir")
            .arg(data_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    let mut child = spawn(base | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(base))
        .map_err(|e| format!("start terminal host: {e}"))?;
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(ep) = read_endpoint(data_dir) {
            if previous.is_none_or(|p| p.token != ep.token) {
                return Ok(ep);
            }
        }
        // Exit code 3: another host owns this data dir (a race with a
        // second start); its file is the one to use.
        if let Ok(Some(status)) = child.try_wait() {
            if status.code() == Some(3) {
                if let Some(ep) = read_endpoint(data_dir) {
                    return Ok(ep);
                }
            } else {
                return Err(format!("terminal host exited: {status}"));
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("terminal host did not start in time".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_discovery_file_and_ignores_extra_fields() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_endpoint(dir.path()), None);
        std::fs::write(
            dir.path().join(ENDPOINT_FILE),
            r#"{"version":1,"pipe":"\\\\.\\pipe\\x","token":"t","pid":7,"proto":[1],"hostVersion":"0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(
            read_endpoint(dir.path()),
            Some(Endpoint {
                pipe: r"\\.\pipe\x".into(),
                token: "t".into(),
                pid: 7
            })
        );
    }
}
