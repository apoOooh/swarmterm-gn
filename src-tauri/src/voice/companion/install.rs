//! Placing verified files into the buzzkey install folder (SWA-42).
//!
//! Only files that already passed signature + hash checks reach this
//! module. They are written into `<dir>\.staging` (same volume, so the
//! final step is a rename, never a copy), then swapped in one by one: the
//! old file moves to `<name>.old`, the new one takes its place. If any step
//! fails, every file swapped so far is put back, so the folder ends with
//! either the complete new set or the complete old one — never half.
//!
//! Swarmterm writes the bytes itself, so the installed files carry no
//! Mark-of-the-Web; the download's own trust decision was the signature.

use std::fs;
use std::path::{Path, PathBuf};

const STAGING: &str = ".staging";

fn old_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    path.with_file_name(name)
}

/// A fresh, empty staging folder (left over ones belong to a crashed
/// install and are discarded).
pub fn staging_dir(dir: &Path) -> Result<PathBuf, String> {
    let staging = dir.join(STAGING);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("staging-cleanup: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("staging: {e}"))?;
    Ok(staging)
}

/// Swap the staged `names` into `dir`. All or nothing.
pub fn commit(dir: &Path, names: &[&str]) -> Result<(), String> {
    let staging = dir.join(STAGING);
    for name in names {
        if !staging.join(name).is_file() {
            return Err(format!("staging-missing:{name}"));
        }
    }
    let mut done: Vec<&str> = Vec::new();
    for name in names {
        if let Err(e) = swap_one(dir, &staging, name) {
            rollback(dir, &done);
            return Err(e);
        }
        done.push(name);
    }
    for name in names {
        // A running old exe cannot be deleted on Windows, only renamed; it
        // stays as `.old` and goes on the next install.
        let _ = fs::remove_file(old_of(&dir.join(name)));
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(())
}

fn swap_one(dir: &Path, staging: &Path, name: &str) -> Result<(), String> {
    let target = dir.join(name);
    let old = old_of(&target);
    if old.exists() {
        fs::remove_file(&old).map_err(|e| format!("in-use:{name}: {e}"))?;
    }
    let had_old = target.exists();
    if had_old {
        fs::rename(&target, &old).map_err(|e| format!("in-use:{name}: {e}"))?;
    }
    if let Err(e) = fs::rename(staging.join(name), &target) {
        if had_old {
            let _ = fs::rename(&old, &target);
        }
        return Err(format!("swap:{name}: {e}"));
    }
    Ok(())
}

fn rollback(dir: &Path, done: &[&str]) {
    for name in done.iter().rev() {
        let target = dir.join(name);
        let old = old_of(&target);
        let _ = fs::remove_file(&target);
        if old.exists() {
            let _ = fs::rename(&old, &target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(p: PathBuf) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn fresh_install_and_update_replace_every_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("buzzkey");
        let st = staging_dir(&dir).unwrap();
        fs::write(st.join("a.exe"), "a1").unwrap();
        fs::write(st.join("b.exe"), "b1").unwrap();
        commit(&dir, &["a.exe", "b.exe"]).unwrap();
        assert_eq!(read(dir.join("a.exe")), "a1");
        assert!(!dir.join(STAGING).exists());

        let st = staging_dir(&dir).unwrap();
        fs::write(st.join("a.exe"), "a2").unwrap();
        fs::write(st.join("b.exe"), "b2").unwrap();
        commit(&dir, &["a.exe", "b.exe"]).unwrap();
        assert_eq!(read(dir.join("a.exe")), "a2");
        assert_eq!(read(dir.join("b.exe")), "b2");
        assert!(!dir.join("a.exe.old").exists());
    }

    #[test]
    fn a_failed_swap_restores_the_old_set() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("buzzkey");
        let st = staging_dir(&dir).unwrap();
        fs::write(st.join("a.exe"), "a1").unwrap();
        fs::write(st.join("b.exe"), "b1").unwrap();
        commit(&dir, &["a.exe", "b.exe"]).unwrap();

        let st = staging_dir(&dir).unwrap();
        fs::write(st.join("a.exe"), "a2").unwrap();
        fs::write(st.join("b.exe"), "b2").unwrap();
        // b's slot is blocked: its `.old` name is a non-empty folder.
        fs::create_dir_all(dir.join("b.exe.old").join("x")).unwrap();
        assert!(commit(&dir, &["a.exe", "b.exe"]).is_err());
        assert_eq!(read(dir.join("a.exe")), "a1");
        assert_eq!(read(dir.join("b.exe")), "b1");
    }

    #[test]
    fn nothing_moves_when_the_staged_set_is_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("buzzkey");
        let st = staging_dir(&dir).unwrap();
        fs::write(st.join("a.exe"), "a1").unwrap();
        assert_eq!(
            commit(&dir, &["a.exe", "b.exe"]),
            Err("staging-missing:b.exe".into())
        );
        assert!(!dir.join("a.exe").exists());
        // A leftover staging folder is cleared on the next run.
        let st = staging_dir(&dir).unwrap();
        assert!(fs::read_dir(st).unwrap().next().is_none());
    }
}
