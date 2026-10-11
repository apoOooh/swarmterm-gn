//! Directory listing for the in-app folder picker.
//!
//! The webview has no filesystem, so the picker asks Rust for one level of
//! subfolders at a time. Only directory NAMES leave this module — no file
//! names, sizes or contents — which keeps the bridge as narrow as the picker
//! needs. An empty path lists the drive roots (Windows) or `/` elsewhere, so
//! the picker can always climb above any start folder.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    /// Canonical-ish display path of the listed folder ("" = drive roots).
    pub path: String,
    /// Parent to climb to; "" means the drive-root view, `None` means top.
    pub parent: Option<String>,
    /// Absolute paths of the subfolders, sorted case-insensitively.
    pub folders: Vec<String>,
}

/// Strip the `\\?\` verbatim prefix `canonicalize` adds on Windows — shells and
/// the rest of the app expect plain `C:\...` paths.
fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => rest.to_string(),
        _ => s,
    }
}

fn roots() -> FolderListing {
    #[cfg(windows)]
    let folders: Vec<String> = (b'A'..=b'Z')
        .map(|c| format!("{}:\\", c as char))
        .filter(|d| Path::new(d).is_dir())
        .collect();
    #[cfg(not(windows))]
    let folders = vec!["/".to_string()];
    FolderListing {
        path: String::new(),
        parent: None,
        folders,
    }
}

pub fn list_folders(path: &str) -> Result<FolderListing, String> {
    if path.trim().is_empty() {
        return Ok(roots());
    }
    let dir: PathBuf = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("{path}: not a folder"));
    }
    let mut folders: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{path}: {e}"))?
        .filter_map(|entry| entry.ok())
        // file_type() does not follow symlinks; metadata() does, so a linked
        // folder (junction) still shows up as navigable.
        .filter(|entry| {
            std::fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false)
        })
        .map(|entry| plain(&entry.path()))
        .collect();
    folders.sort_by_key(|f| f.to_lowercase());
    let parent = match dir.parent() {
        Some(p) => Some(plain(p)),
        // A drive root climbs to the drive list.
        None => Some(String::new()),
    };
    Ok(FolderListing {
        path: plain(&dir),
        parent,
        folders,
    })
}

/// At most this many listings run at once. A typed path on a dead network
/// share can stall `read_dir` for many seconds; without a cap each keystroke
/// would park another blocking-pool thread on it.
pub const MAX_CONCURRENT_LISTINGS: usize = 4;

static LISTING_SLOTS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONCURRENT_LISTINGS);

/// Async entry for the command: the filesystem walk runs on the blocking pool
/// so a slow drive never stalls an async runtime worker (and with it IPC).
pub async fn list_folders_blocking(path: String) -> Result<FolderListing, String> {
    let _slot = LISTING_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || list_folders(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "swarmterm-folder-list-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_only_subfolders_sorted() {
        let d = tmp("sorted");
        std::fs::create_dir(d.join("beta")).unwrap();
        std::fs::create_dir(d.join("Alpha")).unwrap();
        std::fs::write(d.join("file.txt"), "x").unwrap();
        let l = list_folders(d.to_str().unwrap()).unwrap();
        let names: Vec<_> = l
            .folders
            .iter()
            .map(|f| {
                Path::new(f)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        assert!(l.parent.is_some());
        assert!(!l.path.starts_with(r"\\?\"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn missing_and_file_paths_error() {
        let d = tmp("err");
        std::fs::write(d.join("f"), "x").unwrap();
        assert!(list_folders(d.join("nope").to_str().unwrap()).is_err());
        assert!(list_folders(d.join("f").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn empty_path_lists_roots() {
        let l = list_folders("").unwrap();
        assert_eq!(l.path, "");
        assert!(l.parent.is_none());
        assert!(!l.folders.is_empty());
    }

    #[test]
    fn plain_strips_verbatim_prefix() {
        assert_eq!(plain(Path::new(r"\\?\C:\x")), r"C:\x");
    }

    #[test]
    fn blocking_entry_lists_off_the_runtime_and_reports_errors() {
        let dir = std::env::temp_dir().join(format!("fl-async-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("child")).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let ok = rt
            .block_on(list_folders_blocking(dir.to_string_lossy().into_owned()))
            .unwrap();
        assert_eq!(ok.folders.len(), 1);
        let missing = rt.block_on(list_folders_blocking(
            dir.join("nope").to_string_lossy().into_owned(),
        ));
        assert!(missing.is_err());
        // Every permit came back: no slot leaks on success or error.
        assert_eq!(LISTING_SLOTS.available_permits(), MAX_CONCURRENT_LISTINGS);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
