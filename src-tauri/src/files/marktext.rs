//! "Open in MarkText": hands a Markdown file to the external MarkText editor.
//!
//! The executable path can come from the renderer (Settings override), and the
//! renderer is not a trust boundary — so whatever it sends must still *be*
//! MarkText by file name and exist as a regular file. That keeps a tampered
//! setting from turning this into "launch any program". The file itself goes
//! through `guarded` like every other file request and is passed as a single
//! argv entry, never through a shell.

use std::path::{Path, PathBuf};

#[cfg(windows)]
const EXE: &str = "marktext.exe";
#[cfg(not(windows))]
const EXE: &str = "marktext";

/// Standard install locations, most likely first. The NSIS installer defaults
/// to a per-user install under `%LOCALAPPDATA%\Programs`; the per-machine
/// variant lands in Program Files. Pure so it is testable on any OS.
pub fn candidates(local_app_data: Option<&str>, program_files: &[Option<&str>]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(base) = local_app_data {
        out.push(Path::new(base).join("Programs").join("marktext").join(EXE));
        out.push(Path::new(base).join("Programs").join("MarkText").join(EXE));
    }
    for base in program_files.iter().flatten() {
        out.push(Path::new(base).join("MarkText").join(EXE));
    }
    out
}

/// True when `path` names the MarkText binary (case-insensitive on the name).
pub fn is_marktext(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(EXE))
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// An explicit setting wins and is never silently swapped for an auto-detected
/// install: if the user pointed somewhere wrong they should see that.
pub fn resolve(explicit: &str, auto: &[PathBuf]) -> Option<PathBuf> {
    let explicit = explicit.trim();
    if !explicit.is_empty() {
        let path = PathBuf::from(explicit);
        return (is_marktext(&path) && path.is_file()).then_some(path);
    }
    auto.iter().find(|p| p.is_file()).cloned()
}

pub fn locate(explicit: &str) -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok();
    let pf = std::env::var("ProgramFiles").ok();
    let pf86 = std::env::var("ProgramFiles(x86)").ok();
    resolve(
        explicit,
        &candidates(local.as_deref(), &[pf.as_deref(), pf86.as_deref()]),
    )
}

pub fn open(explicit: &str, file: &Path) -> Result<(), String> {
    if !is_markdown(file) {
        return Err("Only Markdown files open in MarkText".into());
    }
    let exe = locate(explicit).ok_or_else(|| {
        if explicit.trim().is_empty() {
            "MarkText is not installed. Install it from marktext.cc or set its path in Settings → Files.".to_string()
        } else {
            format!("The configured MarkText path is not a MarkText executable: {explicit}")
        }
    })?;
    crate::terminal_env::command(exe)
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_cover_per_user_and_per_machine_installs() {
        let c = candidates(Some("L"), &[Some("P"), None]);
        assert_eq!(
            c[0],
            Path::new("L").join("Programs").join("marktext").join(EXE)
        );
        assert_eq!(
            c.last().unwrap(),
            &Path::new("P").join("MarkText").join(EXE)
        );
        assert_eq!(c.len(), 3);
        assert!(candidates(None, &[None]).is_empty());
    }

    #[test]
    fn only_the_marktext_binary_is_accepted() {
        assert!(is_marktext(&Path::new("x").join(EXE.to_uppercase())));
        assert!(!is_marktext(Path::new("x/cmd.exe")));
        assert!(!is_marktext(Path::new("x/marktext.exe.bat")));
    }

    #[test]
    fn markdown_extensions_only() {
        assert!(is_markdown(Path::new("a/README.MD")));
        assert!(is_markdown(Path::new("a/b.markdown")));
        assert!(!is_markdown(Path::new("a/b.txt")));
        assert!(!is_markdown(Path::new("a/md")));
    }

    #[test]
    fn explicit_path_wins_and_is_validated() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join(EXE);
        std::fs::write(&real, b"").unwrap();
        let other = t.path().join("evil.exe");
        std::fs::write(&other, b"").unwrap();
        let auto = vec![real.clone()];
        assert_eq!(resolve("", &auto), Some(real.clone()));
        assert_eq!(resolve(&real.to_string_lossy(), &[]), Some(real.clone()));
        // A wrong explicit setting is reported, not papered over by auto-detect.
        assert_eq!(resolve(&other.to_string_lossy(), &auto), None);
        assert_eq!(
            resolve(&t.path().join("missing").join(EXE).to_string_lossy(), &auto),
            None
        );
        assert_eq!(resolve("", &[t.path().join("nope").join(EXE)]), None);
    }
}
