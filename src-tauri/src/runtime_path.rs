//! The PATH a pane should see *now*, not the one the app was started with
//! (SWA-83 V3).
//!
//! A GUI process keeps the environment snapshot Explorer handed it at launch.
//! Installers (winget, the native Claude installer, Git for Windows) write the
//! new folder into the *registry* PATH and broadcast `WM_SETTINGCHANGE`,
//! which Explorer picks up but a running Swarmterm does not. Without this,
//! a CLI installed while Swarmterm runs stays "not installed" and its pane
//! cannot start it until the app restarts.
//!
//! The registry folders are only ever **appended** to the inherited PATH:
//! whatever the user arranged in the process environment (a venv, a shim dir
//! put first on purpose) keeps its precedence.

use std::path::{Path, PathBuf};

/// `%NAME%` expansion as `REG_EXPAND_SZ` values use it. Unknown names and a
/// lone `%` stay as written, like `ExpandEnvironmentStringsW` does. Names
/// are case-insensitive on Windows; `lookup` gets the name as written.
pub fn expand(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                // `%%` or an unterminated `%`: keep the percent sign literally.
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One PATH entry in the form two entries are compared in: Windows paths
/// are case-insensitive and a trailing separator does not change the folder.
fn folder_key(entry: &str) -> String {
    entry
        .trim()
        .trim_matches('"')
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// `current` with every folder of `additions` that it does not already hold
/// appended, in order. Empty entries are skipped; `current` itself is kept
/// byte for byte (including its own duplicates) so nothing the user set up
/// moves.
pub fn append_missing(current: &str, additions: &[String]) -> String {
    let mut seen: Vec<String> = current
        .split(';')
        .map(folder_key)
        .filter(|k| !k.is_empty())
        .collect();
    let mut out = current.trim_end_matches(';').to_string();
    for entry in additions {
        for part in entry.split(';') {
            let key = folder_key(part);
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key);
            if !out.is_empty() {
                out.push(';');
            }
            out.push_str(part.trim());
        }
    }
    out
}

/// The folders to add to a PATH, in the order Windows builds a login PATH:
/// the machine PATH, then the user PATH, then `%USERPROFILE%\.local\bin`
/// (where the native Claude installer puts `claude.exe`; it adds the folder
/// to the user PATH, but only from the next login on). The last one only
/// when it exists.
pub fn additions(
    machine: Option<String>,
    user: Option<String>,
    local_bin: Option<PathBuf>,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<String> {
    let mut out: Vec<String> = machine.into_iter().chain(user).collect();
    if let Some(dir) = local_bin.filter(|d| exists(d)) {
        out.push(dir.to_string_lossy().into_owned());
    }
    out
}

/// `current` extended by the registry PATH and `.local\bin` as of now.
/// On other platforms `current` unchanged.
pub fn refreshed(current: &str) -> String {
    append_missing(current, &live_additions())
}

/// The app's own PATH, refreshed. For lookups the app does itself
/// (`agents::find_agent_binary`, the Git Bash search).
pub fn current() -> String {
    refreshed(&std::env::var("PATH").unwrap_or_default())
}

#[cfg(windows)]
fn live_additions() -> Vec<String> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let lookup = |name: &str| std::env::var(name).ok();
    let read = |root, key: &str| {
        registry::string(root, key, "Path").map(|(value, _expand)| expand(&value, &lookup))
    };
    let machine = read(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    );
    let user = read(HKEY_CURRENT_USER, "Environment");
    let local_bin =
        std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".local").join("bin"));
    additions(machine, user, local_bin, &|p| p.is_dir())
}

#[cfg(not(windows))]
fn live_additions() -> Vec<String> {
    Vec::new()
}

/// Small registry reader shared with the Git Bash search.
#[cfg(windows)]
pub mod registry {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, REG_EXPAND_SZ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A `REG_SZ` / `REG_EXPAND_SZ` value, unexpanded, and whether it was
    /// `REG_EXPAND_SZ`. `None` when the key or value is missing or another
    /// type. Values up to 32 KiB characters (a PATH's own limit).
    pub fn string(root: HKEY, key: &str, name: &str) -> Option<(String, bool)> {
        let key = wide(key);
        let name = wide(name);
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        // SAFETY: null data pointer asks only for the size.
        let rc = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if rc != 0 || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: buffer and size describe the same allocation.
        let rc = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some((String::from_utf16_lossy(&buf[..len]), kind == REG_EXPAND_SZ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_uppercase().as_str() {
            "USERPROFILE" => Some(r"C:\Users\dev".into()),
            "SYSTEMROOT" => Some(r"C:\Windows".into()),
            _ => None,
        }
    }

    #[test]
    fn expands_known_names_and_keeps_the_rest() {
        assert_eq!(
            expand(r"%USERPROFILE%\bin;%SystemRoot%\system32", &env),
            r"C:\Users\dev\bin;C:\Windows\system32"
        );
        assert_eq!(expand(r"%NOPE%\x", &env), r"%NOPE%\x");
        assert_eq!(expand("100%", &env), "100%");
        assert_eq!(expand("a%%b", &env), "a%%b");
        assert_eq!(expand("plain", &env), "plain");
    }

    #[test]
    fn appends_only_missing_folders_and_keeps_the_order() {
        let current = r"C:\venv\Scripts;C:\Windows\system32";
        let added = append_missing(
            current,
            &[
                r"C:\WINDOWS\System32\;C:\Program Files\Git\cmd".into(),
                r"C:\Users\dev\.local\bin;;C:\Program Files\Git\cmd\".into(),
            ],
        );
        assert_eq!(
            added,
            r"C:\venv\Scripts;C:\Windows\system32;C:\Program Files\Git\cmd;C:\Users\dev\.local\bin"
        );
    }

    #[test]
    fn an_empty_path_gets_the_additions() {
        assert_eq!(append_missing("", &[r"C:\a;C:\b".into()]), r"C:\a;C:\b");
        assert_eq!(append_missing(r"C:\a;", &[r"C:\b".into()]), r"C:\a;C:\b");
    }

    #[test]
    fn local_bin_is_added_only_when_it_exists() {
        let dir = PathBuf::from(r"C:\Users\dev\.local\bin");
        let with = additions(
            Some("M".into()),
            Some("U".into()),
            Some(dir.clone()),
            &|_| true,
        );
        assert_eq!(with, vec!["M", "U", r"C:\Users\dev\.local\bin"]);
        let without = additions(None, Some("U".into()), Some(dir), &|_| false);
        assert_eq!(without, vec!["U"]);
    }
}
