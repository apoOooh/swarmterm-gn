//! Marked copies from the Media viewer's annotate mode: the renderer flattens
//! image + marks into a PNG and hands us the bytes; we write a NEW file into a
//! private temp folder (the original is never touched) and allow-list it for
//! the unrooted media route so the gallery can show it and the user can drag
//! it into a pane. Same folder discipline as clipboard images
//! (`clipboard_media::ClipStore`): `<temp>/swarmterm-marked/<pid>`, content
//! named (`mark-<sha256 prefix>.png`, never a caller-chosen name), capped,
//! deleted on exit, and folders of crashed runs swept later.
//!
//! User-originated only: the command is main-webview-only and there is no MCP
//! tool or agent path to it.

use crate::clipboard_media::{pid_alive, prune_stale, ClipStore, Saved, STALE_AGE};
use crate::files::FileService;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// One flattened image. The renderer caps the longest side at 8192 px; a
/// noisy photo that size can still be a big PNG, so the cap is generous.
pub const MAX_PNG_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FILES: usize = 50;
pub const MAX_BYTES: u64 = 300 * 1024 * 1024;
const PREFIX: &str = "mark-";
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

fn parent_dir() -> PathBuf {
    std::env::temp_dir().join("swarmterm-marked")
}

fn instance_dir() -> PathBuf {
    parent_dir().join(std::process::id().to_string())
}

/// Accept only a PNG within the size cap. A plausibility check, not a full
/// parse (no CRCs): signature plus an IHDR chunk first, so random bytes never
/// land as `.png`. The only caller is the app's own window.
pub fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(format!(
            "marked image is larger than {} MB; try a smaller image",
            MAX_PNG_BYTES / (1024 * 1024)
        ));
    }
    if bytes.len() < 33 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Err("marked image is not a PNG".into());
    }
    Ok(())
}

/// Validate and store; returns the path inside the store's folder.
pub fn save_into(store: &mut ClipStore, png: &[u8]) -> Result<PathBuf, String> {
    validate_png(png)?;
    let path = match store.save(png)? {
        Saved::New(p) | Saved::Known(p) => p,
    };
    // Belt and braces: the name is ours, but never hand out anything else.
    if path.parent() != Some(store.dir()) {
        let _ = std::fs::remove_file(&path);
        return Err("marked image path escaped the store".into());
    }
    Ok(path)
}

/// Managed state: the store plus what we allow-listed for each stored file
/// (store path -> canonical registered path), so files the caps evict are
/// withdrawn from the unrooted route and never fill its shared cap.
pub struct MarkedMedia {
    inner: Mutex<Inner>,
}

struct Inner {
    store: ClipStore,
    registered: Vec<(PathBuf, PathBuf)>,
}

impl Default for MarkedMedia {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                store: ClipStore::with_prefix(instance_dir(), PREFIX, MAX_FILES, MAX_BYTES),
                registered: Vec::new(),
            }),
        }
    }
}

impl MarkedMedia {
    /// Validate, store and allow-list; returns the canonical path. Blocking
    /// (hash + write): call off the async executor.
    pub fn save(&self, service: &FileService, png: &[u8]) -> Result<PathBuf, String> {
        validate_png(png)?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.store.len() == 0 {
            prune_stale(
                &parent_dir(),
                &instance_dir(),
                SystemTime::now(),
                STALE_AGE,
                pid_alive,
            );
        }
        save_registered(
            &mut inner,
            png,
            |raw| service.register_media_tracked(raw, Path::new("")),
            |paths| service.unregister_media(paths),
        )
    }

    /// App exit: delete every marked copy and the folder.
    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.store.clear();
        }
    }
}

/// `save_into` plus the allow-list bookkeeping (injectable for tests).
fn save_registered(
    inner: &mut Inner,
    png: &[u8],
    register: impl Fn(&str) -> Option<(PathBuf, bool)>,
    unregister: impl Fn(&[PathBuf]),
) -> Result<PathBuf, String> {
    let stored = save_into(&mut inner.store, png)?;
    let evicted = inner.store.take_evicted();
    if !evicted.is_empty() {
        let (gone, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut inner.registered)
            .into_iter()
            .partition(|(s, _)| evicted.contains(s));
        inner.registered = keep;
        unregister(&gone.into_iter().map(|(_, c)| c).collect::<Vec<_>>());
    }
    if let Some((_, canonical)) = inner.registered.iter().find(|(s, _)| *s == stored) {
        return Ok(canonical.clone());
    }
    match register(&stored.to_string_lossy()) {
        Some((canonical, added)) => {
            // Withdraw on eviction only what this store added.
            if added {
                inner.registered.push((stored, canonical.clone()));
            }
            Ok(canonical)
        }
        None => {
            // Not servable (allow-list full): do not leave an orphan file.
            let _ = std::fs::remove_file(&stored);
            Err("too many media files opened this session".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: &[u8]) -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(&[0, 0, 0, 13]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[0; 17]);
        v.extend_from_slice(extra);
        v
    }

    #[test]
    fn rejects_non_png_and_oversize() {
        assert!(validate_png(&png(b"")).is_ok());
        assert!(validate_png(b"GIF89a-not-a-png-at-all-padding-padding").is_err());
        let mut bad = png(b"");
        bad[12..16].copy_from_slice(b"IDAT");
        assert!(validate_png(&bad).is_err());
        assert!(validate_png(&png(b"")[..20]).is_err());
        let huge = png(&vec![0; MAX_PNG_BYTES]);
        assert!(validate_png(&huge).is_err());
    }

    #[test]
    fn saves_inside_the_store_with_our_name_and_dedupes() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("m");
        let mut store = ClipStore::with_prefix(dir.clone(), PREFIX, 10, 10_000);
        let a = save_into(&mut store, &png(b"a")).unwrap();
        assert_eq!(a.parent(), Some(dir.as_path()));
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("mark-") && name.ends_with(".png"),
            "{name}"
        );
        assert_eq!(save_into(&mut store, &png(b"a")).unwrap(), a);
        assert!(save_into(&mut store, b"not a png").is_err());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn evicted_copies_are_withdrawn_and_failed_registration_leaves_no_file() {
        use std::cell::RefCell;
        let t = tempfile::tempdir().unwrap();
        let mut inner = Inner {
            store: ClipStore::with_prefix(t.path().join("m"), PREFIX, 1, 10_000),
            registered: Vec::new(),
        };
        let withdrawn = RefCell::new(Vec::new());
        let reg = |raw: &str| Some((PathBuf::from(format!("canon:{raw}")), true));
        let unreg = |p: &[PathBuf]| withdrawn.borrow_mut().extend_from_slice(p);
        let a = save_registered(&mut inner, &png(b"a"), reg, unreg).unwrap();
        assert_eq!(
            save_registered(&mut inner, &png(b"a"), reg, unreg).unwrap(),
            a
        );
        save_registered(&mut inner, &png(b"b"), reg, unreg).unwrap();
        assert_eq!(*withdrawn.borrow(), vec![a]);
        assert_eq!(inner.registered.len(), 1);
        let err = save_registered(&mut inner, &png(b"c"), |_| None, unreg);
        assert!(err.is_err());
        let files = std::fs::read_dir(t.path().join("m")).unwrap().count();
        assert_eq!(
            files, 0,
            "b evicted by c, c removed after the failed registration"
        );
    }

    #[test]
    fn caps_and_cleanup() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("m");
        let mut store = ClipStore::with_prefix(dir.clone(), PREFIX, 2, 10_000);
        let a = save_into(&mut store, &png(b"1")).unwrap();
        save_into(&mut store, &png(b"2")).unwrap();
        save_into(&mut store, &png(b"3")).unwrap();
        assert!(!a.exists(), "oldest evicted by count");
        store.clear();
        assert!(!dir.exists());
        assert!(
            save_into(&mut store, &png(b"4")).is_err(),
            "no write after exit"
        );
    }
}
