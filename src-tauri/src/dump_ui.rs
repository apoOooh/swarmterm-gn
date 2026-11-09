//! `swarmterm --dump-ui <pid> <file>` (SWA-85): writes a minidump of a
//! stalled Swarmterm process for `ui_watchdog`. A separate process because
//! `MiniDumpWriteDump` in the stalled process itself can deadlock on a heap
//! or loader lock the stuck UI thread holds (see `ui_watchdog.rs`).
//!
//! Only a process running the SAME executable is dumped, so this entry point
//! is no general-purpose dumper. The dump type is thread list + stacks
//! (`MiniDumpWithThreadInfo`), no full heap: enough to see where the UI
//! thread waits, smaller and with less memory content than a full dump.

/// Parse `<pid> <file>`; the file must end in `.dmp`.
pub fn parse_args(args: &[String]) -> Result<(u32, std::path::PathBuf), String> {
    let [pid, file] = args else {
        return Err("usage: swarmterm --dump-ui <pid> <file.dmp>".into());
    };
    let pid: u32 = pid.parse().map_err(|_| format!("bad pid: {pid}"))?;
    if pid == 0 {
        return Err("bad pid: 0".into());
    }
    let file = std::path::PathBuf::from(file);
    if !file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("dmp"))
    {
        return Err("the dump file must end in .dmp".into());
    }
    Ok((pid, file))
}

/// The app's own gates, enforced HERE and not only in the watchdog that
/// normally starts this entry point: any process (a pane included) can run
/// `swarmterm --dump-ui`, so a lock that lived only in the app would be
/// bypassed by calling the CLI directly. Order: the admin policy / Corp
/// edition (`DisableHangDumps`), then the user's saved opt-in. Checked before
/// any file is created; a refusal writes nothing.
pub fn allowed(
    policy: &crate::policy::AdminPolicy,
    saved: &crate::diagnostics::DiagnosticsSettings,
) -> Result<(), String> {
    policy.check(crate::policy::Lock::HangDumps)?;
    if !crate::diagnostics::effective(saved, false) {
        return Err("hang dumps are off (Settings → Terminal → Diagnostics)".into());
    }
    Ok(())
}

/// `diagnostics.json` of THIS build's app instance: the roaming app data dir
/// plus the identifier compiled in by `build.rs`, the same path Tauri's
/// `app_data_dir()` gives `diagnostics.rs`. Not taken from the command line:
/// the caller must not choose which opt-in file counts. `None` = no
/// app data dir, which reads as "not opted in".
fn settings_path() -> Option<std::path::PathBuf> {
    Some(
        dirs::data_dir()?
            .join(env!("SWARMTERM_APP_IDENTIFIER"))
            .join("diagnostics.json"),
    )
}

/// Entry point from `main.rs`; exit code 0 on success.
pub fn run_cli(args: &[String]) -> i32 {
    let result = parse_args(args).and_then(|(pid, file)| {
        let saved = settings_path()
            .map(|p| crate::diagnostics::load(&p))
            .unwrap_or_default();
        allowed(&crate::policy::load(), &saved)?;
        imp::dump(pid, &file)
    });
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("dump-ui: {e}");
            1
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::Debug::{
        MiniDumpWithThreadInfo, MiniDumpWriteDump,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    struct Process(HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: handle from OpenProcess, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn image(p: &Process) -> Result<std::path::PathBuf, String> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: valid handle, buffer of `len` u16.
        let ok = unsafe {
            QueryFullProcessImageNameW(p.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(std::ffi::OsString::from_wide(&buf[..len as usize]).into())
    }

    fn same_file(a: &Path, b: &Path) -> bool {
        match (dunce::canonicalize(a), dunce::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    pub fn dump(pid: u32, file: &Path) -> Result<(), String> {
        let access =
            PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ;
        // SAFETY: plain FFI call; a null handle is checked below.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return Err(format!("open {pid}: {}", std::io::Error::last_os_error()));
        }
        let process = Process(handle);
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        if !same_file(&image(&process)?, &me) {
            return Err(format!("{pid} is not this Swarmterm executable"));
        }
        let out = std::fs::File::create(file).map_err(|e| e.to_string())?;
        // SAFETY: valid process and file handles; no exception, user stream
        // or callback parameters.
        let ok = unsafe {
            MiniDumpWriteDump(
                process.0,
                pid,
                out.as_raw_handle() as HANDLE,
                MiniDumpWithThreadInfo,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            let e = std::io::Error::last_os_error();
            drop(out);
            let _ = std::fs::remove_file(file);
            return Err(format!("MiniDumpWriteDump: {e}"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn dump(_: u32, _: &std::path::Path) -> Result<(), String> {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_pid_and_dmp_file() {
        let (pid, file) = parse_args(&args(&["42", r"C:\x\ui-stall-1.dmp"])).unwrap();
        assert_eq!(pid, 42);
        assert!(file.ends_with("ui-stall-1.dmp"));
    }

    #[test]
    fn rejects_bad_arguments() {
        assert!(parse_args(&args(&["42"])).is_err());
        assert!(parse_args(&args(&["x", "a.dmp"])).is_err());
        assert!(parse_args(&args(&["0", "a.dmp"])).is_err());
        assert!(parse_args(&args(&["42", "a.txt"])).is_err());
        assert!(parse_args(&args(&["42", "a.dmp", "extra"])).is_err());
    }

    #[test]
    fn needs_the_opt_in_and_no_lock() {
        use crate::diagnostics::DiagnosticsSettings;
        use crate::policy::{AdminPolicy, Edition};
        let on = DiagnosticsSettings { hang_dumps: true };
        let off = DiagnosticsSettings::default();
        let open = Edition::Standard.locks();
        assert!(allowed(&open, &on).is_ok());
        assert!(allowed(&open, &off).is_err());
        let admin = AdminPolicy {
            disable_hang_dumps: true,
            ..Default::default()
        };
        assert!(allowed(&admin, &on).is_err());
        // The Corp edition locks dumps without any registry value.
        assert!(Edition::Corp
            .locks()
            .check_for(Edition::Corp, crate::policy::Lock::HangDumps)
            .is_err());
    }

    #[cfg(feature = "corp")]
    #[test]
    fn corp_build_refuses_even_with_the_opt_in() {
        let on = crate::diagnostics::DiagnosticsSettings { hang_dumps: true };
        // `load` adds the compiled-in Corp locks to whatever the registry says.
        assert!(allowed(&crate::policy::load(), &on).is_err());
    }

    #[test]
    fn a_refused_cli_call_writes_no_file() {
        // No opt-in can be assumed on the test machine, and the pid is this
        // test process (same exe): only the gate can stop it, so this
        // exercises run_cli's order. Skipped when the machine opted in.
        let saved = settings_path()
            .map(|p| crate::diagnostics::load(&p))
            .unwrap_or_default();
        if allowed(&crate::policy::load(), &saved).is_ok() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("swa85-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("refused.dmp");
        let code = run_cli(&args(&[
            &std::process::id().to_string(),
            file.to_str().unwrap(),
        ]));
        assert_ne!(code, 0);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_path_uses_the_compiled_identifier() {
        let path = settings_path().expect("app data dir");
        assert!(path.ends_with(
            std::path::Path::new(env!("SWARMTERM_APP_IDENTIFIER")).join("diagnostics.json")
        ));
        assert!(env!("SWARMTERM_APP_IDENTIFIER").starts_with("com.apooooh.swarmterm.gn"));
    }

    #[cfg(windows)]
    #[test]
    fn dumps_a_process_of_the_same_executable() {
        let dir = std::env::temp_dir().join(format!("swa85-self-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("self.dmp");
        imp::dump(std::process::id(), &file).unwrap();
        assert!(std::fs::metadata(&file).unwrap().len() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_process_with_another_executable() {
        // The test binary is not the parent shell's executable; pid 4 (System)
        // cannot even be opened. Either way: no dump.
        let dir = std::env::temp_dir().join(format!("swa85-dump-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x.dmp");
        assert!(imp::dump(4, &file).is_err());
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
