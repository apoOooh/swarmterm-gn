//! Shell catalog + per-platform probing. Probes on first use; later calls
//! return the cached vector until `recheck` (Settings → Setup) probes again,
//! so a shell installed while the app runs shows up without a restart.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::RwLock;

/// One entry in the shell catalog. `available == true` means the renderer can
/// offer this shell as a selectable option. `id` matches the frontend ShellId
/// string union.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEntry {
    pub id: String,
    pub available: bool,
    pub detected_path: Option<String>,
    pub args: Vec<String>,
}

/// Cached probe result. Lazily populated on first call to `list_shells()`.
static CACHE: RwLock<Option<Vec<ShellEntry>>> = RwLock::new(None);

/// Walk `$PATH` (split on the platform separator) looking for `exe_name`.
/// Returns the first match, or `None`.
pub fn find_in_path(path_var: &str, exe_name: &str) -> Option<PathBuf> {
    find_in_path_with(path_var, exe_name, &|p| p.is_file())
}

/// `find_in_path` with the existence check injected, so probes that take a fake
/// filesystem stay honest — a hard-coded `is_file()` here would silently bypass
/// the fake and make the caller's tests assert against the real machine.
pub fn find_in_path_with(
    path_var: &str,
    exe_name: &str,
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    for segment in std::env::split_paths(path_var) {
        let candidate = segment.join(exe_name);
        if exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Given the path to `git.exe`, derive the sibling `bin\bash.exe` (used by the
/// "Git Bash" detection fallback when the GitForWindows registry key is absent).
/// Returns `None` if `git_exe` has no parent directory.
// Only called from the Windows discovery path, but kept unconditional so the
// unit tests cover it on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn git_bash_from_git_exe(git_exe: &std::path::Path) -> Option<PathBuf> {
    // git.exe usually lives at <install>\cmd\git.exe, so the bash is two levels
    // up + \bin\bash.exe. We resolve relative to <install>.
    let cmd_dir = git_exe.parent()?;
    let install_dir = cmd_dir.parent()?;
    Some(install_dir.join("bin").join("bash.exe"))
}

/// Parse the output of `wsl.exe -l -q`. The command emits UTF-16 LE with a BOM
/// and CR-LF line endings; the caller is expected to decode to a Rust `String`
/// first. Returns the list of distro names (non-empty, BOM-stripped).
// Only called from the Windows discovery path, but kept unconditional so the
// unit tests cover it on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_wsl_distros(decoded: &str) -> Vec<String> {
    decoded
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{FEFF}').trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Return the cached shell catalog, probing the first time it is called.
pub fn list_shells() -> Vec<ShellEntry> {
    if let Some(list) = CACHE.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return list.clone();
    }
    // Probe outside the lock: the WSL probe runs a process.
    let list = probe();
    *CACHE.write().unwrap_or_else(|e| e.into_inner()) = Some(list.clone());
    list
}

/// Forget the cached catalog; the next `list_shells` probes again.
pub fn recheck() {
    *CACHE.write().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Resolve a shell id to `(executable, args)`. Returns `None` for `default`,
/// unknown ids, or shells whose probe came back `available == false`. The
/// caller (`pty::spawn_terminal`) falls back to the platform default in that
/// case.
pub fn resolve_shell(id: &str) -> Option<(String, Vec<String>)> {
    if id == "default" {
        return None;
    }
    let entry = list_shells().into_iter().find(|s| s.id == id)?;
    if !entry.available {
        return None;
    }
    let path = entry.detected_path?;
    Some((path, entry.args))
}

#[cfg(windows)]
fn probe() -> Vec<ShellEntry> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    vec![
        ShellEntry {
            id: "default".into(),
            available: true,
            detected_path: None,
            args: vec![],
        },
        ShellEntry {
            id: "powershell".into(),
            available: true,
            detected_path: Some("powershell.exe".into()),
            args: vec!["-NoLogo".into()],
        },
        ShellEntry {
            id: "cmd".into(),
            available: true,
            detected_path: Some("cmd.exe".into()),
            args: vec![],
        },
        probe_pwsh(&path_var),
        probe_git_bash(),
        probe_wsl(),
    ]
}

/// The unix shells the catalog advertises, paired with the well-known absolute
/// locations to check when the binary is not on `$PATH`. GUI apps on macOS
/// inherit a stub `$PATH` that has neither `/opt/homebrew/bin` nor
/// `/usr/local/bin`, so a `$PATH`-only probe would miss a Homebrew fish/bash
/// that the user's Terminal.app finds fine — hence the explicit fallbacks.
#[cfg(not(windows))]
const UNIX_SHELLS: &[(&str, &[&str])] = &[
    (
        "zsh",
        &["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"],
    ),
    (
        "bash",
        &[
            "/bin/bash",
            "/usr/bin/bash",
            "/opt/homebrew/bin/bash",
            "/usr/local/bin/bash",
        ],
    ),
    (
        "fish",
        &[
            "/opt/homebrew/bin/fish",
            "/usr/local/bin/fish",
            "/usr/bin/fish",
        ],
    ),
];

/// Build the unix catalog. `exists` is injected so the resolution rules can be
/// unit-tested against a fake filesystem instead of whatever happens to be
/// installed on the test machine.
///
/// Note there is intentionally no `powershell` / `cmd` / `git-bash` / `wsl`
/// entry: the renderer renders exactly the ids this probe reports, so omitting
/// them here is what keeps the Windows shells out of the macOS shell picker.
#[cfg(not(windows))]
pub fn unix_catalog(
    default_shell: &str,
    path_var: &str,
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> Vec<ShellEntry> {
    let mut entries = vec![ShellEntry {
        id: "default".into(),
        available: true,
        detected_path: Some(default_shell.to_string()),
        args: crate::pty::login_args(default_shell),
    }];

    for (id, fallbacks) in UNIX_SHELLS {
        // `$PATH` first so a user's preferred build (Homebrew bash 5 over the
        // ancient /bin/bash 3.2) wins over the system copy.
        let found = find_in_path_with(path_var, id, exists).or_else(|| {
            fallbacks
                .iter()
                .map(std::path::PathBuf::from)
                .find(|p| exists(p))
        });
        entries.push(ShellEntry {
            id: (*id).to_string(),
            available: found.is_some(),
            args: found
                .as_ref()
                .map(|p| crate::pty::login_args(&p.to_string_lossy()))
                .unwrap_or_default(),
            detected_path: found.map(|p| p.to_string_lossy().into_owned()),
        });
    }
    entries
}

#[cfg(not(windows))]
fn probe() -> Vec<ShellEntry> {
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let path_var = std::env::var("PATH").unwrap_or_default();
    unix_catalog(&default_shell, &path_var, &|p| p.is_file())
}

#[cfg(windows)]
fn probe_pwsh(path_var: &str) -> ShellEntry {
    let path = find_in_path(path_var, "pwsh.exe");
    ShellEntry {
        id: "pwsh".into(),
        available: path.is_some(),
        detected_path: path.map(|p| p.to_string_lossy().into_owned()),
        args: vec!["-NoLogo".into()],
    }
}

#[cfg(windows)]
fn probe_git_bash() -> ShellEntry {
    // Same search the setup uses to decide on hooks (SWA-83), so the shell
    // list and Settings → Setup never disagree about Git Bash.
    let path = crate::git_bash::find(None).map(|f| f.path);

    ShellEntry {
        id: "git-bash".into(),
        available: path.is_some(),
        detected_path: path.map(|p| p.to_string_lossy().into_owned()),
        args: vec!["--login".into(), "-i".into()],
    }
}

#[cfg(windows)]
fn probe_wsl() -> ShellEntry {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW = 0x08000000 — keeps the probe from flashing a console.
    let output = crate::terminal_env::command("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(0x0800_0000)
        .output();

    let available = match output {
        Ok(out) if out.status.success() => {
            // wsl.exe -l -q emits UTF-16 LE. Decode best-effort, then parse.
            let decoded = decode_utf16_lossy(&out.stdout);
            !parse_wsl_distros(&decoded).is_empty()
        }
        _ => false,
    };

    ShellEntry {
        id: "wsl".into(),
        available,
        detected_path: if available {
            Some("wsl.exe".into())
        } else {
            None
        },
        args: vec![],
    }
}

/// Decode a possibly-UTF-16-LE byte buffer (BOM-tolerant) into a `String`.
/// Falls back to UTF-8 lossy when the buffer is not valid UTF-16.
#[cfg(windows)]
fn decode_utf16_lossy(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes.len().is_multiple_of(2) {
        let words: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&words);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create tempdir")
    }

    #[test]
    fn find_in_path_returns_first_match() {
        let dir = tempdir();
        let exe = if cfg!(windows) { "tool.exe" } else { "tool" };
        let target = dir.path().join(exe);
        fs::write(&target, b"").unwrap();
        let path_var = format!(
            "{}{}{}",
            dir.path().display(),
            if cfg!(windows) { ";" } else { ":" },
            "/nonexistent"
        );
        assert_eq!(find_in_path(&path_var, exe), Some(target));
    }

    #[test]
    fn find_in_path_returns_none_when_missing() {
        let dir = tempdir();
        let path_var = dir.path().display().to_string();
        assert_eq!(find_in_path(&path_var, "absent.exe"), None);
    }

    #[test]
    fn git_bash_from_git_exe_uses_install_root() {
        let git_exe = Path::new("C:/Program Files/Git/cmd/git.exe");
        assert_eq!(
            git_bash_from_git_exe(git_exe),
            Some(PathBuf::from("C:/Program Files/Git/bin/bash.exe"))
        );
    }

    #[test]
    fn git_bash_from_git_exe_returns_none_for_root() {
        assert_eq!(git_bash_from_git_exe(Path::new("/")), None);
    }

    #[cfg(not(windows))]
    mod unix {
        use super::super::*;
        use std::collections::HashSet;
        use std::path::Path;

        fn fake_fs(present: &[&str]) -> impl Fn(&Path) -> bool {
            let set: HashSet<String> = present.iter().map(|s| s.to_string()).collect();
            move |p: &Path| set.contains(&p.to_string_lossy().into_owned())
        }

        fn ids(entries: &[ShellEntry]) -> Vec<&str> {
            entries.iter().map(|e| e.id.as_str()).collect()
        }

        fn get<'a>(entries: &'a [ShellEntry], id: &str) -> &'a ShellEntry {
            entries.iter().find(|e| e.id == id).expect(id)
        }

        #[test]
        fn never_advertises_windows_shells() {
            // The regression this whole change exists for: a macOS pane's shell
            // picker renders exactly what this probe returns.
            let entries = unix_catalog("/bin/zsh", "", &fake_fs(&[]));
            for win_only in ["powershell", "cmd", "pwsh", "git-bash", "wsl"] {
                assert!(!ids(&entries).contains(&win_only), "leaked {win_only}");
            }
        }

        #[test]
        fn always_offers_the_default_as_a_login_shell() {
            let entries = unix_catalog("/bin/zsh", "", &fake_fs(&[]));
            let default = get(&entries, "default");
            assert!(default.available);
            assert_eq!(default.detected_path.as_deref(), Some("/bin/zsh"));
            assert_eq!(default.args, vec!["-l".to_string()]);
        }

        #[test]
        fn lists_every_unix_shell_marking_missing_ones_unavailable() {
            let entries = unix_catalog("/bin/zsh", "", &fake_fs(&["/bin/zsh"]));
            assert_eq!(ids(&entries), vec!["default", "zsh", "bash", "fish"]);
            assert!(get(&entries, "zsh").available);
            assert!(!get(&entries, "bash").available);
            assert!(!get(&entries, "fish").available);
            assert!(get(&entries, "fish").detected_path.is_none());
        }

        #[test]
        fn finds_homebrew_shells_absent_from_a_gui_stub_path() {
            // A Tauri app launched from Finder gets PATH=/usr/bin:/bin:… — no
            // Homebrew. The absolute fallbacks are what keep fish discoverable.
            let entries = unix_catalog(
                "/bin/zsh",
                "/usr/bin:/bin",
                &fake_fs(&["/opt/homebrew/bin/fish"]),
            );
            let fish = get(&entries, "fish");
            assert!(fish.available);
            assert_eq!(
                fish.detected_path.as_deref(),
                Some("/opt/homebrew/bin/fish")
            );
        }

        #[test]
        fn path_hit_wins_over_the_absolute_fallback() {
            let entries = unix_catalog(
                "/bin/zsh",
                "/opt/homebrew/bin",
                &fake_fs(&["/opt/homebrew/bin/bash", "/bin/bash"]),
            );
            assert_eq!(
                get(&entries, "bash").detected_path.as_deref(),
                Some("/opt/homebrew/bin/bash")
            );
        }

        #[test]
        fn the_real_probe_reports_a_windows_free_catalog() {
            // The fake-fs tests never exercise `probe()` itself — env lookups
            // and the real `is_file` check only run here.
            let entries = list_shells();
            assert!(entries.iter().any(|e| e.id == "default" && e.available));
            for win_only in ["powershell", "cmd", "git-bash", "wsl"] {
                assert!(
                    !entries.iter().any(|e| e.id == win_only),
                    "{win_only} leaked into the unix catalog"
                );
            }
        }

        #[test]
        fn detected_shells_spawn_as_login_shells() {
            let entries = unix_catalog("/bin/zsh", "", &fake_fs(&["/bin/zsh", "/bin/bash"]));
            assert_eq!(get(&entries, "zsh").args, vec!["-l".to_string()]);
            assert_eq!(get(&entries, "bash").args, vec!["-l".to_string()]);
        }
    }

    #[test]
    fn parse_wsl_distros_strips_bom_and_blanks() {
        let raw = "\u{FEFF}Ubuntu\r\nDebian\r\n\r\n";
        assert_eq!(parse_wsl_distros(raw), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn parse_wsl_distros_empty_returns_empty() {
        assert!(parse_wsl_distros("").is_empty());
        assert!(parse_wsl_distros("\u{FEFF}\r\n").is_empty());
    }

    #[test]
    fn parse_wsl_distros_handles_lf_only() {
        assert_eq!(parse_wsl_distros("Alpine\nKali\n"), vec!["Alpine", "Kali"]);
    }
}

/// Windows build number (`CurrentBuildNumber`), handed to xterm.js as
/// `windowsPty.buildNumber`. Read from the registry rather than
/// `GetVersionEx`, which lies to unmanifested callers.
#[cfg(windows)]
pub fn windows_build_number() -> Option<u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "CurrentBuildNumber\0".encode_utf16().collect();
    let mut buf = [0u16; 32];
    let mut len = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let end = buf.iter().position(|&w| w == 0).unwrap_or(buf.len());
    parse_build_number(&String::from_utf16_lossy(&buf[..end]))
}

#[cfg(not(windows))]
pub fn windows_build_number() -> Option<u32> {
    None
}

fn parse_build_number(raw: &str) -> Option<u32> {
    raw.trim().parse().ok().filter(|&n| n > 0)
}

#[cfg(test)]
mod build_number_tests {
    use super::parse_build_number;

    #[test]
    fn parses_registry_string() {
        assert_eq!(parse_build_number("26200"), Some(26200));
        assert_eq!(parse_build_number(" 19045 "), Some(19045));
        assert_eq!(parse_build_number(""), None);
        assert_eq!(parse_build_number("abc"), None);
        assert_eq!(parse_build_number("0"), None);
    }
}
