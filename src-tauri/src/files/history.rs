//! Astera's explorer deletion policy, implemented against native Rust filesystem APIs.
use super::path::{canonical, display, unique, within};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_ITEM_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 5000;
const MAX_ROOT_BYTES: u64 = 200 * 1024 * 1024;
const RETAIN_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub path: String,
    pub created: u64,
    pub bytes: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    root: String,
    snapshots: Vec<Snapshot>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn bucket(base: &Path, root: &Path) -> PathBuf {
    let key = if cfg!(windows) {
        display(root).to_lowercase()
    } else {
        display(root)
    };
    base.join(format!("{:x}", Sha256::digest(key.as_bytes())))
}

fn load(dir: &Path, root: &Path) -> Result<Index, String> {
    let file = dir.join("index.json");
    if !file.exists() {
        return Ok(Index {
            root: display(root),
            snapshots: vec![],
        });
    }
    let index: Index = serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if Path::new(&index.root) != root {
        return Err("History belongs to a different project".into());
    }
    if index.snapshots.iter().any(|s| {
        uuid::Uuid::parse_str(&s.id).is_err()
            || !within(root, Path::new(&s.path))
            || Path::new(&s.path) == root
    }) {
        return Err("History index contains an invalid snapshot path".into());
    }
    Ok(index)
}

fn save(dir: &Path, index: &Index) -> Result<(), String> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(index).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(dir.join("index.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn measure(path: &Path, bytes: &mut u64, entries: &mut usize) -> Result<(), String> {
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    *entries += 1;
    if *entries > MAX_ENTRIES {
        return Err("Snapshot skipped: more than 5,000 entries".into());
    }
    if m.file_type().is_symlink() {
        return Err("Snapshot skipped: contains a symbolic link".into());
    }
    if m.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            measure(&entry.map_err(|e| e.to_string())?.path(), bytes, entries)?;
        }
    } else if m.is_file() {
        *bytes += m.len();
        if *bytes > MAX_ITEM_BYTES {
            return Err("Snapshot skipped: larger than 50 MB".into());
        }
    } else {
        return Err("Snapshot skipped: unsupported filesystem entry".into());
    }
    Ok(())
}

/// Copy deliberately refuses symbolic links, including links inside a selected directory.
/// Ordinary explorer copies have no history caps, but still cannot read through links.
pub fn copy_tree(src: &Path, dest: &Path, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Copying symbolic links is not supported; use the terminal".into());
    }
    if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()), progress)?;
        }
    } else if meta.is_file() {
        use std::io::{Read, Write};
        let mut source = fs::File::open(src).map_err(|e| e.to_string())?;
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let n = source.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            destination
                .write_all(&buffer[..n])
                .map_err(|e| e.to_string())?;
            progress(n as u64);
        }
        destination
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?;
    } else {
        return Err("Unsupported filesystem entry".into());
    }
    Ok(())
}

pub fn remove_entry(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    // On Windows directory symlinks/junctions are removed with remove_dir, without recursion.
    if meta.file_type().is_symlink() {
        if meta.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    } else if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|e| e.to_string())
}

pub fn list(base: &Path, root: &Path) -> Result<Vec<Snapshot>, String> {
    let dir = bucket(base, root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut index = load(&dir, root)?;
    let mut total: u64 = index.snapshots.iter().map(|s| s.bytes).sum();
    index.snapshots.sort_by_key(|s| s.created);
    index.snapshots.retain(|s| {
        let expire = now().saturating_sub(s.created) > RETAIN_MS
            || total > MAX_ROOT_BYTES
            || !dir.join(&s.id).exists();
        if expire {
            total = total.saturating_sub(s.bytes);
            let _ = fs::remove_dir_all(dir.join(&s.id));
        }
        !expire
    });
    save(&dir, &index)?;
    index.snapshots.reverse();
    Ok(index.snapshots)
}

pub fn snapshot(base: &Path, root: &Path, path: &Path) -> Result<Snapshot, String> {
    if within(path, base) {
        return Err("Snapshot skipped: selection contains the local history storage".into());
    }
    let mut bytes = 0;
    let mut entries = 0;
    measure(path, &mut bytes, &mut entries)?;
    let dir = bucket(base, root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut index = load(&dir, root)?;
    let id = uuid::Uuid::new_v4().to_string();
    let staging = tempfile::tempdir_in(&dir).map_err(|e| e.to_string())?;
    copy_tree(path, &staging.path().join("content"), &mut |_| {})?;
    super::path::rename_new(staging.path(), &dir.join(&id))?;
    let item = Snapshot {
        id,
        path: display(path),
        created: now(),
        bytes,
        is_dir: path.is_dir(),
    };
    index.snapshots.push(item.clone());
    if let Err(e) = save(&dir, &index) {
        let _ = fs::remove_dir_all(dir.join(&item.id));
        return Err(e);
    }
    list(base, root)?;
    Ok(item)
}

pub fn restore(base: &Path, root: &Path, id: &str) -> Result<String, String> {
    let dir = bucket(base, root);
    let index = load(&dir, root)?;
    let item = index
        .snapshots
        .iter()
        .find(|s| s.id == id)
        .ok_or("Snapshot no longer exists")?;
    if uuid::Uuid::parse_str(&item.id).is_err() {
        return Err("Invalid snapshot identifier".into());
    }
    let original = Path::new(&item.path);
    if !within(root, original) || original == root {
        return Err("Invalid history path".into());
    }
    // Recreate parents only below the root; validate every existing component for junction escapes.
    let parent = original.parent().ok_or("Missing original parent")?;
    let relative = parent.strip_prefix(root).map_err(|e| e.to_string())?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if current.exists() {
            if !within(root, &canonical(&current)?) {
                return Err("Restore parent is outside the project".into());
            }
        } else {
            fs::create_dir(&current).map_err(|e| e.to_string())?;
        }
    }
    let destination = unique(
        parent,
        &original
            .file_name()
            .ok_or("Invalid snapshot name")?
            .to_string_lossy(),
    );
    let staging = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
    let content = staging.path().join("content");
    copy_tree(&dir.join(&item.id).join("content"), &content, &mut |_| {})?;
    if destination.exists() {
        return Err("Destination appeared during restore; try again".into());
    }
    super::path::rename_new(&content, &destination)?;
    Ok(display(&destination))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_never_overwrites_and_roots_are_isolated() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("project");
        fs::create_dir(&root).unwrap();
        let root = canonical(&root).unwrap();
        let base = t.path().join("history");
        let file = root.join("x.txt");
        fs::write(&file, "old").unwrap();
        let snap = snapshot(&base, &root, &file).unwrap();
        fs::write(&file, "new").unwrap();
        let restored = restore(&base, &root, &snap.id).unwrap();
        assert_eq!(fs::read_to_string(restored).unwrap(), "old");
        assert_eq!(fs::read_to_string(file).unwrap(), "new");
        let other = t.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(restore(&base, &canonical(&other).unwrap(), &snap.id).is_err());
    }
    #[test]
    fn caps_and_expiry() {
        let t = tempfile::tempdir().unwrap();
        let root = canonical(t.path()).unwrap();
        let file = root.join("large.bin");
        fs::File::create(&file)
            .unwrap()
            .set_len(MAX_ITEM_BYTES + 1)
            .unwrap();
        assert!(snapshot(&root.join("history"), &root, &file)
            .unwrap_err()
            .contains("50 MB"));
        fs::write(&file, "small").unwrap();
        let base = root.join("history");
        let snap = snapshot(&base, &root, &file).unwrap();
        let dir = bucket(&base, &root);
        let mut index = load(&dir, &root).unwrap();
        index.snapshots[0].created = 0;
        save(&dir, &index).unwrap();
        assert!(list(&base, &root).unwrap().is_empty());
        assert!(!dir.join(snap.id).exists());
    }
}
