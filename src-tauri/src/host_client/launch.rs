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
    // No console window, own process group (a Ctrl+C in the app's console
    // must not reach it), and out of the app's job if the job allows it: a
    // dev app started from a Swarmterm pane lives in that pane's
    // kill-on-close job, which would otherwise take the host down with it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = host_exe()?;
    let line = command_line(&[exe.as_os_str(), "--data-dir".as_ref(), data_dir.as_os_str()]);
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    let child = spawn_uninherited(&line, base | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn_uninherited(&line, base))
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
        if let Some(code) = child.exit_code() {
            if code == 3 {
                if let Some(ep) = read_endpoint(data_dir) {
                    return Ok(ep);
                }
            } else {
                return Err(format!("terminal host exited with code {code}"));
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("terminal host did not start in time".into())
}

/// The started host, only ever asked whether it exited.
struct HostProcess(windows_sys::Win32::Foundation::HANDLE);

impl HostProcess {
    fn exit_code(&self) -> Option<u32> {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        // SAFETY: the handle is ours until drop.
        unsafe {
            if WaitForSingleObject(self.0, 0) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0u32;
            (GetExitCodeProcess(self.0, &mut code) != 0).then_some(code)
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        // SAFETY: closed once; the process itself lives on.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// `CreateProcessW` with handle inheritance OFF. `std::process::Command`
/// always inherits every inheritable handle of the app, and the host outlives
/// the app: it kept the app's MCP listener alive after a crash (SWA-56 lab),
/// so the restarted app could never bind its old port again and every
/// surviving pane lost MCP. The host needs nothing from us but its command
/// line; it has no console, so no std handles either.
fn spawn_uninherited(line: &str, flags: u32) -> std::io::Result<HostProcess> {
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };
    let mut wide: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: zeroed POD structs; `wide` is a writable NUL-terminated buffer
    // as CreateProcessW requires; both handles are closed below or in drop.
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null(),
            wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            std::ptr::null(),
            std::ptr::null(),
            &si,
            &mut pi,
        );
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        windows_sys::Win32::Foundation::CloseHandle(pi.hThread);
        Ok(HostProcess(pi.hProcess))
    }
}

/// Windows command line for `args` (MSVCRT rules): an argument with a space
/// or tab is quoted, and its trailing backslashes doubled so they do not
/// escape the closing quote. Paths cannot contain `"`, but a data dir may
/// contain spaces.
fn command_line(args: &[&std::ffi::OsStr]) -> String {
    args.iter()
        .map(|a| {
            let a = a.to_string_lossy();
            if !a.is_empty() && !a.contains([' ', '\t']) {
                return a.into_owned();
            }
            let trailing = a.len() - a.trim_end_matches('\\').len();
            format!("\"{a}{}\"", "\\".repeat(trailing))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_spaces_and_trailing_backslashes() {
        let line = command_line(&[
            r"C:\Program Files\Swarmterm\swarmterm-host.exe".as_ref(),
            "--data-dir".as_ref(),
            r"C:\Users\a b\AppData\Local\x\".as_ref(),
        ]);
        assert_eq!(
            line,
            r#""C:\Program Files\Swarmterm\swarmterm-host.exe" --data-dir "C:\Users\a b\AppData\Local\x\\""#
        );
    }

    #[test]
    fn a_started_process_reports_its_exit_without_inheriting_handles() {
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        let line = command_line(&[
            cmd.as_ref(),
            "/d".as_ref(),
            "/c".as_ref(),
            "exit 7".as_ref(),
        ]);
        let p = spawn_uninherited(&line, 0x0800_0000).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while p.exit_code().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(p.exit_code(), Some(7));
    }

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
