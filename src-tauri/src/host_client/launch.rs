//! Find or start the terminal host for this app instance (ADR 0001,
//! lifecycle). Everything lives in the app's *local* data dir, so the
//! installed app and a dev build (own identifier) each get their own hosts,
//! pipes and discovery files, mirroring `tauri.dev-instance.conf.json`.
//!
//! Versioned layout (SWA-82, ADR 0001 "Update"): the installer ships
//! `swarmterm-host.exe` next to the app, but it never runs from there.
//! Before a start it is copied to `<local data>\host\<version>-<hash>\` and
//! runs from that copy, with that directory as its data dir. So the
//! installer can always replace the shipped binary, and since the pipe name
//! and the discovery file derive from the data dir, every host build is a
//! host of its own: an updated app starts a new one for new panes while the
//! old one keeps the panes it holds until they exit. Directories whose host
//! is gone are pruned. Debug builds keep the unversioned layout (host next
//! to the exe, data dir = local data dir) unless `SWARMTERM_HOST_VERSIONED=1`,
//! because `cargo build -p swarmterm-host` and the perf scripts rely on it.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const ENDPOINT_FILE: &str = "host-endpoint.json";
pub const HOST_EXE: &str = "swarmterm-host.exe";
/// Parent of the version directories, inside the local data dir.
pub const HOSTS_DIR: &str = "host";
/// A freshly started host needs well under a second to publish its file.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// Hex digits of the binary's SHA-256 in a version directory's name.
const HASH_CHARS: usize = 12;

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

/// The host binary the installer (or `cargo build -p swarmterm-host`) put
/// next to the app exe.
pub fn bundled_exe() -> Result<PathBuf, String> {
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

/// Release builds always use the versioned layout; debug builds only on
/// request (testlab).
pub fn versioned_layout() -> bool {
    !cfg!(debug_assertions) || std::env::var("SWARMTERM_HOST_VERSIONED").is_ok_and(|v| v == "1")
}

/// One host: its data dir (pipe name and discovery file derive from it) and
/// the binary started for it. `source` is set in the versioned layout: the
/// shipped binary and its SHA-256, which `install` copies to `exe`.
#[derive(Debug, Clone, PartialEq)]
pub struct HostDir {
    pub data_dir: PathBuf,
    pub exe: PathBuf,
    source: Option<(PathBuf, String)>,
}

impl HostDir {
    /// A host found on disk (another version): only ever connected to.
    pub fn found(data_dir: PathBuf) -> Self {
        HostDir {
            exe: data_dir.join(HOST_EXE),
            data_dir,
            source: None,
        }
    }
}

/// The host this build starts for new panes; `bundled` is the shipped
/// binary (`bundled_exe`).
pub fn locate(
    local: &Path,
    app_version: &str,
    bundled: &Path,
    versioned: bool,
) -> Result<HostDir, String> {
    if !versioned {
        return Ok(HostDir {
            data_dir: local.to_path_buf(),
            exe: bundled.to_path_buf(),
            source: None,
        });
    }
    let hash = sha256_file(bundled).map_err(|e| format!("read {}: {e}", bundled.display()))?;
    let data_dir = local
        .join(HOSTS_DIR)
        .join(format!("{app_version}-{}", &hash[..HASH_CHARS]));
    Ok(HostDir {
        exe: data_dir.join(HOST_EXE),
        data_dir,
        source: Some((bundled.to_path_buf(), hash)),
    })
}

/// Copy the shipped binary into the version directory unless an intact
/// copy is there. Checked by hash on every start, not by existence: a copy
/// that was cut short or altered must not run. Written under a temporary
/// name and renamed, so a half-written file never has the final name.
pub fn install(host: &HostDir) -> Result<(), String> {
    let Some((source, hash)) = &host.source else {
        return Ok(());
    };
    if sha256_file(&host.exe).is_ok_and(|h| &h == hash) {
        return Ok(());
    }
    std::fs::create_dir_all(&host.data_dir).map_err(|e| format!("create host dir: {e}"))?;
    let part = host
        .data_dir
        .join(format!("{HOST_EXE}.{}.part", std::process::id()));
    let result = (|| {
        std::fs::copy(source, &part).map_err(|e| format!("copy terminal host: {e}"))?;
        if sha256_file(&part).map_err(|e| e.to_string())? != *hash {
            return Err("terminal host copy does not match the shipped binary".to_string());
        }
        std::fs::rename(&part, &host.exe).map_err(|e| format!("install terminal host: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// Data dirs of every other host that may run: the unversioned layout's
/// (the local data dir itself) and each version directory, if it holds a
/// discovery file. Whether that host still runs is for the connect to find.
pub fn others(local: &Path, current: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if local != current && local.join(ENDPOINT_FILE).is_file() {
        out.push(local.to_path_buf());
    }
    out.extend(
        version_dirs(local)
            .into_iter()
            .filter(|d| d != current && d.join(ENDPOINT_FILE).is_file()),
    );
    out
}

/// Remove version directories no host runs from: no discovery file (the
/// host deletes it on exit) or one whose pid is gone (a crash). A running
/// host also locks its binary, so a wrong guess fails to delete instead of
/// breaking it. Returns the removed directories.
pub fn prune(local: &Path, current: &Path) -> Vec<PathBuf> {
    prune_with(local, current, is_running)
}

fn prune_with(local: &Path, current: &Path, alive: impl Fn(u32) -> bool) -> Vec<PathBuf> {
    version_dirs(local)
        .into_iter()
        .filter(|d| d != current)
        .filter(|d| !read_endpoint(d).is_some_and(|ep| alive(ep.pid)))
        .filter(|d| std::fs::remove_dir_all(d).is_ok())
        .collect()
}

/// Real directories directly under `<local>\host`; links are skipped, so
/// pruning never follows one out of the tree.
fn version_dirs(local: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(local.join(HOSTS_DIR)) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Whether a process with this pid runs (or exists but may not be queried).
pub fn is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked before use and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // Access denied: it exists (a process we may not query).
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Start a host and wait for its discovery file. `previous` is the stale
/// endpoint (if any): a file with the same token is not a fresh host.
pub fn start(host: &HostDir, previous: Option<&Endpoint>) -> Result<Endpoint, String> {
    // No console window, own process group (a Ctrl+C in the app's console
    // must not reach it), and out of the app's job if the job allows it: a
    // dev app started from a Swarmterm pane lives in that pane's
    // kill-on-close job, which would otherwise take the host down with it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    install(host)?;
    let data_dir = host.data_dir.as_path();
    let line = command_line(&[
        host.exe.as_os_str(),
        "--data-dir".as_ref(),
        data_dir.as_os_str(),
    ]);
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

    fn shipped(dir: &Path, body: &[u8]) -> PathBuf {
        let p = dir.join("app").join(HOST_EXE);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn unversioned_layout_runs_the_shipped_binary_in_the_local_dir() {
        let dir = tempfile::tempdir().unwrap();
        let src = shipped(dir.path(), b"host");
        let local = dir.path().join("local");
        let h = locate(&local, "1.2.3", &src, false).unwrap();
        assert_eq!(h.data_dir, local);
        assert_eq!(h.exe, src);
        install(&h).unwrap();
        assert!(!local.exists(), "nothing is copied without versioning");
    }

    #[test]
    fn version_directory_is_named_by_version_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("local");
        let a = locate(&local, "1.2.3", &shipped(dir.path(), b"one"), true).unwrap();
        let name = a.data_dir.file_name().unwrap().to_string_lossy().into_owned();
        let (version, hash) = name.split_once('-').unwrap();
        assert_eq!(version, "1.2.3");
        assert_eq!(hash.len(), HASH_CHARS);
        assert_eq!(a.data_dir.parent().unwrap(), local.join(HOSTS_DIR));
        assert_eq!(a.exe, a.data_dir.join(HOST_EXE));
        // A rebuilt host of the same version is a different host.
        let b = locate(&local, "1.2.3", &shipped(dir.path(), b"two"), true).unwrap();
        assert_ne!(a.data_dir, b.data_dir);
    }

    #[test]
    fn install_copies_once_and_repairs_an_altered_copy() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("local");
        let h = locate(&local, "1.0.0", &shipped(dir.path(), b"binary"), true).unwrap();
        install(&h).unwrap();
        assert_eq!(std::fs::read(&h.exe).unwrap(), b"binary");
        std::fs::write(&h.exe, b"tampered").unwrap();
        install(&h).unwrap();
        assert_eq!(std::fs::read(&h.exe).unwrap(), b"binary");
        let leftovers: Vec<_> = std::fs::read_dir(&h.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }

    fn version_dir(local: &Path, name: &str, pid: Option<u32>) -> PathBuf {
        let d = local.join(HOSTS_DIR).join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(HOST_EXE), b"x").unwrap();
        if let Some(pid) = pid {
            std::fs::write(
                d.join(ENDPOINT_FILE),
                format!(r#"{{"pipe":"p","token":"t","pid":{pid}}}"#),
            )
            .unwrap();
        }
        d
    }

    #[test]
    fn others_lists_every_host_with_a_discovery_file_but_the_current() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path();
        let current = version_dir(local, "2.0.0-bbbbbbbbbbbb", Some(1));
        let old = version_dir(local, "1.0.0-aaaaaaaaaaaa", Some(2));
        version_dir(local, "0.9.0-cccccccccccc", None);
        assert_eq!(others(local, &current), vec![old.clone()]);
        // The unversioned layout of an older build counts as another host.
        std::fs::write(local.join(ENDPOINT_FILE), "{}").unwrap();
        assert_eq!(others(local, &current), vec![local.to_path_buf(), old]);
        assert!(!others(local, local).contains(&local.to_path_buf()));
    }

    #[test]
    fn prune_removes_only_directories_no_host_runs_from() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path();
        let current = version_dir(local, "3.0.0-cccccccccccc", None);
        let running = version_dir(local, "2.0.0-bbbbbbbbbbbb", Some(20));
        let crashed = version_dir(local, "1.5.0-dddddddddddd", Some(15));
        let exited = version_dir(local, "1.0.0-aaaaaaaaaaaa", None);
        let mut removed = prune_with(local, &current, |pid| pid == 20);
        removed.sort();
        assert_eq!(removed, vec![exited.clone(), crashed.clone()]);
        assert!(current.exists() && running.exists());
        assert!(!crashed.exists() && !exited.exists());
    }

    #[test]
    fn this_process_is_alive_and_a_finished_one_is_not() {
        assert!(is_running(std::process::id()));
        let mut child = std::process::Command::new(
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        )
        .args(["/d", "/c", "exit 0"])
        .spawn()
        .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // The handle `child` still holds keeps the pid from being reused.
        assert!(!is_running(pid));
    }
}
