use std::path::{Component, Path, PathBuf};

pub fn canonical(path: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Component comparisons avoid sibling-prefix escapes; canonicalization resolves junctions too.
pub fn within(root: &Path, path: &Path) -> bool {
    let r: Vec<_> = root.components().collect();
    let p: Vec<_> = path.components().collect();
    p.len() >= r.len()
        && r.iter().zip(&p).all(|(a, b)| {
            if cfg!(windows) {
                a.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
            } else {
                a == b
            }
        })
}

pub fn guarded(root: &Path, input: &str, entry_only: bool) -> Result<PathBuf, String> {
    let path = Path::new(input);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("An absolute project path without '..' is required".into());
    }
    // For unlink/rename check the parent, not the symlink's destination.
    let resolved = if entry_only && path != root {
        canonical(path.parent().ok_or("Missing parent directory")?)?
            .join(path.file_name().ok_or("Missing file name")?)
    } else {
        canonical(path)?
    };
    if !within(root, &resolved) {
        return Err("Path is outside this terminal's project root".into());
    }
    Ok(resolved)
}

pub fn child(root: &Path, dir: &str, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    let parent = guarded(root, dir, false)?;
    if !parent.is_dir() {
        return Err("Destination is not a directory".into());
    }
    Ok(parent.join(name))
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." {
        return Err("Enter a file name".into());
    }
    if name.len() > 255
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
    {
        return Err("Invalid file name".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Reserved Windows file name".into());
    }
    Ok(())
}

pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Atomic no-replace rename. An external agent may create the destination after our preflight check.
pub fn rename_new(src: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        fn wide(path: &Path) -> Vec<u16> {
            let text = path.to_string_lossy();
            let text = if text.starts_with(r"\\?\") {
                text.into_owned()
            } else if let Some(unc) = text.strip_prefix(r"\\") {
                format!(r"\\?\UNC\{unc}")
            } else {
                format!(r"\\?\{text}")
            };
            std::ffi::OsStr::new(&text)
                .encode_wide()
                .chain(Some(0))
                .collect()
        }
        // Omitting MOVEFILE_REPLACE_EXISTING is essential; std::fs::rename permits replacement.
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                wide(src).as_ptr(),
                wide(dest).as_ptr(),
                0,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let result = {
        use std::os::unix::ffi::OsStrExt;
        let src = std::ffi::CString::new(src.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let dest =
            std::ffi::CString::new(dest.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        let code = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                src.as_ptr(),
                libc::AT_FDCWD,
                dest.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let code = unsafe { libc::renamex_np(src.as_ptr(), dest.as_ptr(), libc::RENAME_EXCL) };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    };
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let result: Result<(), std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Atomic no-replace rename unavailable",
    ));
    result.map_err(|e| format!("{} -> {}: {e}", src.display(), dest.display()))
}

pub fn unique(dir: &Path, name: &str) -> PathBuf {
    if !dir.join(name).exists() {
        return dir.join(name);
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1.. {
        let candidate = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        let path = dir.join(candidate);
        if std::fs::symlink_metadata(&path).is_err() {
            return path;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefix_and_traversal_are_rejected() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let other = t.path().join("project-other");
        std::fs::create_dir(&other).unwrap();
        let root = canonical(&root).unwrap();
        assert!(guarded(&root, &display(&other), false).is_err());
        assert!(guarded(&root, &display(&root.join("../project-other")), false).is_err());
        assert!(child(&root, &display(&root), "../escape").is_err());
    }
    #[test]
    fn portable_names() {
        for name in [
            "",
            "..",
            "a/b",
            "a\\b",
            "CON.txt",
            "aux",
            "COM1",
            "trailing.",
            "x ",
            "x:y",
        ] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        for name in [".gitignore", "normal.txt", "COM10", "hello world"] {
            assert!(validate_name(name).is_ok());
        }
    }
    #[test]
    fn no_replace_rename_protects_an_existing_destination() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("source");
        let dest = t.path().join("destination");
        std::fs::write(&src, "source").unwrap();
        std::fs::write(&dest, "destination").unwrap();
        assert!(rename_new(&src, &dest).is_err());
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "source");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "destination");
    }
}
