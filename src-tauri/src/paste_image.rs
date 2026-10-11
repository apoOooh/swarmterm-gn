//! Clipboard screenshot → temp PNG. Claude Code and Codex cannot read an image
//! off the Windows clipboard themselves, but both attach an image whose path is
//! pasted at their prompt — so Ctrl+V on those panes saves the image here and
//! the renderer pastes the path. The temp dir rather than the pane's cwd so a
//! screenshot can never end up committed.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const PREFIX: &str = "paste-";
const SUFFIX: &str = ".png";
/// Long enough that an agent still reading the file mid-session finds it.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("swarmterm-paste")
}

pub fn save_clipboard_image() -> Result<Option<String>, String> {
    let Some(png) = crate::files::clipboard::image_png()? else {
        return Ok(None);
    };
    let dir = paste_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    // Pruned on save instead of at boot: no startup cost, and the folder only
    // grows when this feature is actually used.
    prune(&dir, SystemTime::now(), MAX_AGE);
    save_png(&dir, &png).map(Some)
}

fn save_png(dir: &Path, png: &[u8]) -> Result<String, String> {
    let mut file = tempfile::Builder::new()
        .prefix(PREFIX)
        .suffix(SUFFIX)
        .tempfile_in(dir)
        .map_err(|e| format!("Could not create the image file: {e}"))?;
    file.write_all(png)
        .map_err(|e| format!("Could not write the image file: {e}"))?;
    let (_, path) = file
        .keep()
        .map_err(|e| format!("Could not keep the image file: {e}"))?;
    Ok(dunce::simplified(&path).display().to_string())
}

/// Best-effort delete of our own PNGs older than `max_age`; anything else in
/// the folder is left alone.
fn prune(dir: &Path, now: SystemTime, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_png_writes_unique_named_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = save_png(dir.path(), b"one").unwrap();
        let b = save_png(dir.path(), b"two").unwrap();
        assert_ne!(a, b);
        assert!(a.ends_with(SUFFIX));
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
    }

    #[test]
    fn prune_removes_only_old_paste_files() {
        let dir = tempfile::tempdir().unwrap();
        let ours = save_png(dir.path(), b"x").unwrap();
        let foreign = dir.path().join("keep.png");
        std::fs::write(&foreign, b"y").unwrap();

        prune(dir.path(), SystemTime::now(), MAX_AGE);
        assert!(Path::new(&ours).exists(), "fresh file must survive");

        prune(dir.path(), SystemTime::now() + MAX_AGE * 2, MAX_AGE);
        assert!(!Path::new(&ours).exists(), "stale file must go");
        assert!(foreign.exists(), "foreign file must be untouched");
    }
}
