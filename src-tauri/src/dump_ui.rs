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

/// Entry point from `main.rs`; exit code 0 on success.
pub fn run_cli(args: &[String]) -> i32 {
    match parse_args(args).and_then(|(pid, file)| imp::dump(pid, &file)) {
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
