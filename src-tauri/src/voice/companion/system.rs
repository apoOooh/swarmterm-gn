//! The Windows side of the companion: where buzzkey lives, whether it (or
//! the whisper-key it replaces) runs, starting it, its autostart entry and
//! its read-only hardware probe. Everything here only reads state or acts
//! on an explicit click; nothing kills a process.

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// buzzkey's own names (`branding.py`): the single-instance mutex is
/// `<INSTANCE_NAME>_SingleInstance`, the Run value is `AUTOSTART_VALUE_NAME`.
/// Sharing the Run value means buzzkey's own tray toggle and ours agree.
#[cfg(windows)]
const BUZZKEY_MUTEX: &str = "buzzkey_SingleInstance";
#[cfg(windows)]
const WHISPER_KEY_MUTEX: &str = "WhisperKeyLocal_SingleInstance";
#[cfg(windows)]
const WHISPER_KEY_EXES: &[&str] = &["whisper-key.exe", "whisper-key-console.exe"];
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "buzzkey";
#[cfg(windows)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROBE_FIELD: usize = 120;

/// `%LOCALAPPDATA%\Programs\buzzkey` — per user, no admin rights. Debug
/// builds may point elsewhere so the testlab never touches a real install.
pub fn install_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Ok(dir) = std::env::var("SWARMTERM_BUZZKEY_DIR") {
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("Programs").join("buzzkey"))
}

/// What `buzzkey-console.exe --probe-hardware --json` reports. buzzkey owns
/// the classification (it picks the model); Swarmterm only shows it, so
/// every field is optional and unknown ones are ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HardwareProbe {
    /// e.g. "NVIDIA GeForce RTX 5090, 32 GB VRAM".
    pub summary: Option<String>,
    pub model: Option<String>,
    pub runtime: Option<String>,
    /// false = buzzkey advises keeping voice off on this machine.
    pub voice_advised: Option<bool>,
}

/// Parse the probe's stdout; anything unexpected is `None` (fail-open —
/// the panel then just shows no suggestion).
pub fn parse_probe(stdout: &str) -> Option<HardwareProbe> {
    let mut p: HardwareProbe = serde_json::from_str(stdout.trim()).ok()?;
    for field in [&mut p.summary, &mut p.model, &mut p.runtime] {
        if let Some(s) = field.take() {
            let clean: String = s
                .chars()
                .filter(|c| !c.is_control())
                .take(MAX_PROBE_FIELD)
                .collect();
            *field = Some(clean).filter(|s| !s.trim().is_empty());
        }
    }
    Some(p)
}

/// Whether the Run value points into our install folder. A value pointing
/// at another launcher (a pip install, an old whisper-key) is not ours.
pub fn run_value_is_ours(value: &str, dir: &Path) -> bool {
    let value = value.trim().trim_matches('"').to_lowercase();
    let dir = dir.to_string_lossy().to_lowercase();
    value.starts_with(&dir)
}

pub fn run_value_for(dir: &Path) -> String {
    format!("\"{}\"", dir.join(super::release::EXE).display())
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn mutex_held(name: &str) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let name = wide(name);
    // SAFETY: valid NUL-terminated name; the handle is closed right away.
    unsafe {
        let h = OpenMutexW(SYNCHRONIZE, 0, name.as_ptr());
        if h.is_null() {
            return false;
        }
        CloseHandle(h);
        true
    }
}

#[cfg(windows)]
fn process_running(names: &[&str]) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: standard snapshot walk; the entry size is set before use.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            if names.iter().any(|n| *n == exe) {
                found = true;
                break;
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        found
    }
}

/// Debug builds may watch another mutex name, so the testlab's fake
/// install never sees (or is blocked by) the buzzkey the developer runs.
#[cfg(windows)]
pub fn buzzkey_running() -> bool {
    if cfg!(debug_assertions) {
        if let Ok(name) = std::env::var("SWARMTERM_BUZZKEY_MUTEX") {
            if !name.is_empty() {
                return mutex_held(&name);
            }
        }
    }
    mutex_held(BUZZKEY_MUTEX)
}

/// whisper-key (the original buzzkey is forked from) holds the same hotkey
/// and microphone; installing next to a running one would fight over both.
#[cfg(windows)]
pub fn whisper_key_running() -> bool {
    mutex_held(WHISPER_KEY_MUTEX) || process_running(WHISPER_KEY_EXES)
}

#[cfg(windows)]
pub fn start(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = dir.join(super::release::EXE);
    if !exe.is_file() {
        return Err("not-installed".into());
    }
    let spawn = |flags: u32| {
        std::process::Command::new(&exe)
            .current_dir(dir)
            .creation_flags(flags)
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // Breakaway: a dev Swarmterm started from a pane sits in that pane's
    // kill-on-close job, and buzzkey must not die with the pane. A job
    // that forbids breakaway refuses the flag, so retry without it.
    spawn(base | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(base))
        .map(|_| ())
        .map_err(|e| format!("start: {e}"))
}

#[cfg(windows)]
pub fn read_run_value() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: buffer and size describe the same allocation.
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(windows)]
pub fn set_autostart(dir: &Path, on: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    };
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    if on {
        let data = wide(&run_value_for(dir));
        // SAFETY: data is a NUL-terminated UTF-16 buffer of the given size.
        let rc = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        if rc != 0 {
            return Err(format!("autostart: {rc}"));
        }
    } else {
        // Only our own entry is removed; a foreign launcher stays.
        if read_run_value().is_some_and(|v| !run_value_is_ours(&v, dir)) {
            return Ok(());
        }
        // SAFETY: valid NUL-terminated key and value names.
        let rc = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
        const ERROR_FILE_NOT_FOUND: u32 = 2;
        if rc != 0 && rc != ERROR_FILE_NOT_FOUND {
            return Err(format!("autostart: {rc}"));
        }
    }
    Ok(())
}

/// Run the read-only probe of the installed console launcher. Older
/// buzzkey builds do not know the flag: they fail or print something
/// else, which is `None`.
#[cfg(windows)]
pub async fn probe(dir: &Path) -> Option<HardwareProbe> {
    let exe = dir.join(super::release::CONSOLE_EXE);
    if !exe.is_file() {
        return None;
    }
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(["--probe-hardware", "--json"])
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
pub fn buzzkey_running() -> bool {
    false
}
#[cfg(not(windows))]
pub fn whisper_key_running() -> bool {
    false
}
#[cfg(not(windows))]
pub fn start(_dir: &Path) -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(not(windows))]
pub fn read_run_value() -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn set_autostart(_dir: &Path, _on: bool) -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(not(windows))]
pub async fn probe(_dir: &Path) -> Option<HardwareProbe> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_output_is_parsed_leniently_and_cleaned() {
        let p = parse_probe(
            r#"{"summary":"RTX\u0007 5090, 32 GB","model":"large-v3-turbo","runtime":"cuda","voiceAdvised":true,"extra":1}"#,
        )
        .unwrap();
        assert_eq!(p.summary.as_deref(), Some("RTX 5090, 32 GB"));
        assert_eq!(p.voice_advised, Some(true));
        assert_eq!(parse_probe("{}"), Some(HardwareProbe::default()));
        assert!(parse_probe("usage: buzzkey [-h]").is_none());
        let long = format!(r#"{{"summary":"{}"}}"#, "x".repeat(500));
        assert_eq!(parse_probe(&long).unwrap().summary.unwrap().len(), MAX_PROBE_FIELD);
    }

    #[test]
    fn only_a_run_value_into_our_folder_is_ours() {
        let dir = Path::new(r"C:\Users\u\AppData\Local\Programs\buzzkey");
        assert!(run_value_is_ours(&run_value_for(dir), dir));
        assert!(run_value_is_ours(
            r#""c:\users\U\appdata\local\programs\buzzkey\buzzkey.exe""#,
            dir
        ));
        assert!(!run_value_is_ours(r#""C:\Python\pythonw.exe" -m whisper_key"#, dir));
    }
}
