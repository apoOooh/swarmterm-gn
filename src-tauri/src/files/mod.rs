mod clipboard;
mod git;
mod history;
mod marktext;
mod media;
pub mod path;
mod watch;

use path::{canonical, display, guarded, within};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub use media::response as media_response;
pub use watch::WatchHandle;
const READ_MAX: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContext {
    pub id: String,
    pub root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub version: String,
    pub truncated: bool,
    pub binary: bool,
    pub bom: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileRequest {
    List {
        context_id: String,
        path: String,
    },
    Read {
        context_id: String,
        path: String,
    },
    MediaStat {
        context_id: String,
        path: String,
    },
    OpenMedia {
        context_id: String,
        path: String,
    },
    Write {
        context_id: String,
        path: String,
        content: String,
        expected_version: String,
        bom: bool,
    },
    Create {
        context_id: String,
        directory: String,
        name: String,
        is_dir: bool,
    },
    Rename {
        context_id: String,
        path: String,
        name: String,
    },
    Transfer {
        context_id: String,
        source_context_id: String,
        paths: Vec<String>,
        directory: String,
        cut: bool,
        operation_id: String,
    },
    Remove {
        context_id: String,
        paths: Vec<String>,
    },
    History {
        context_id: String,
    },
    Restore {
        context_id: String,
        id: String,
    },
    Git {
        context_id: String,
    },
    ClipboardWrite {
        context_id: String,
        paths: Vec<String>,
    },
    ClipboardRead,
    ClipboardImport {
        context_id: String,
        directory: String,
        operation_id: String,
        expected_paths: Vec<String>,
    },
    Reveal {
        context_id: String,
        path: String,
    },
    OpenMarkText {
        context_id: String,
        path: String,
        executable: String,
    },
    LocateMarkText {
        executable: String,
    },
    /// Unsaved buffer the HTML preview frame should render instead of disk.
    /// `content: None` drops the draft (buffer saved or closed).
    PreviewDraft {
        context_id: String,
        path: String,
        content: Option<String>,
    },
    OpenPreviewExternal {
        context_id: String,
        path: String,
    },
}

pub struct FileService {
    contexts: Mutex<HashMap<String, PathBuf>>,
    operation: Mutex<()>,
    pub watchers: Mutex<HashMap<String, WatchHandle>>,
    history_dir: PathBuf,
    /// Keyed by canonical path. Lives only in memory: the preview protocol
    /// serves it so relative assets still resolve from the file's folder.
    drafts: Mutex<HashMap<PathBuf, String>>,
}

impl FileService {
    pub fn new(history_dir: PathBuf) -> Self {
        Self {
            contexts: Mutex::new(HashMap::new()),
            operation: Mutex::new(()),
            watchers: Mutex::new(HashMap::new()),
            history_dir,
            drafts: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn draft(&self, path: &Path) -> Option<String> {
        self.drafts.lock().ok()?.get(path).cloned()
    }

    pub fn open(&self, cwd: &Path) -> Result<FileContext, String> {
        let root = canonical(cwd)?;
        if !root.is_dir() {
            return Err("Project root is not a directory".into());
        }
        let mut contexts = self.contexts.lock().map_err(|e| e.to_string())?;
        let id = contexts
            .iter()
            .find(|(_, p)| *p == &root)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        contexts.insert(id.clone(), root.clone());
        Ok(FileContext {
            id,
            root: display(&root),
        })
    }

    pub fn open_for_terminal(
        &self,
        cwd: &Path,
        expected_cwd: Option<&str>,
    ) -> Result<FileContext, String> {
        if let Some(expected) = expected_cwd {
            if canonical(cwd)? != canonical(Path::new(expected))? {
                return Err("Terminal is not ready in the selected folder; try again".into());
            }
        }
        self.open(cwd)
    }

    pub fn root(&self, id: &str) -> Result<PathBuf, String> {
        self.contexts
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "Unknown project context; select a terminal first".into())
    }

    pub fn request(
        &self,
        request: FileRequest,
        app: Option<&tauri::AppHandle>,
    ) -> Result<Value, String> {
        match request {
            FileRequest::List { context_id, path } => {
                let root = self.root(&context_id)?;
                let directory = guarded(&root, &path, false)?;
                let mut entries = Vec::new();
                for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
                    let item = item.map_err(|e| e.to_string())?;
                    let kind = item.file_type().map_err(|e| e.to_string())?;
                    let is_dir = if kind.is_symlink() {
                        canonical(&item.path()).is_ok_and(|p| within(&root, &p) && p.is_dir())
                    } else {
                        kind.is_dir()
                    };
                    entries.push(FileEntry {
                        name: item.file_name().to_string_lossy().into_owned(),
                        path: display(&item.path()),
                        is_dir,
                        is_symlink: kind.is_symlink(),
                    });
                }
                entries.sort_by(|a, b| {
                    b.is_dir
                        .cmp(&a.is_dir)
                        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                serde_json::to_value(entries).map_err(|e| e.to_string())
            }
            FileRequest::Read { context_id, path } => {
                serde_json::to_value(self.read(&context_id, &path)?).map_err(|e| e.to_string())
            }
            FileRequest::MediaStat { context_id, path } => {
                let path = guarded(&self.root(&context_id)?, &path, false)?;
                if !media::is_media(&path) {
                    return Err("Unsupported media type".into());
                }
                let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
                let modified = meta
                    .modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                Ok(json!({ "size": meta.len(), "mtimeMs": modified }))
            }
            FileRequest::OpenMedia { context_id, path } => {
                use tauri_plugin_opener::OpenerExt;
                let path = guarded(&self.root(&context_id)?, &path, false)?;
                if !media::is_media(&path) {
                    return Err("Only images and videos can open in the default application".into());
                }
                app.ok_or("Open media requires a native application")?
                    .opener()
                    .open_path(display(&path), None::<&str>)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            FileRequest::Write {
                context_id,
                path,
                content,
                expected_version,
                bom,
            } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                let root = self.root(&context_id)?;
                let target = guarded(&root, &path, false)?;
                if target == root {
                    return Err("Cannot overwrite the project root".into());
                }
                if content.len() + if bom { 3 } else { 0 } > READ_MAX {
                    return Err("The embedded editor supports files up to 1 MB".into());
                }
                let disk = read_for_write(&target)?;
                if disk.contains(&0) || std::str::from_utf8(&disk).is_err() {
                    return Err("Binary or non-UTF-8 files are read only".into());
                }
                if version(&disk) != expected_version {
                    return Err(
                        "File changed on disk. Reload or resolve the conflict before saving."
                            .into(),
                    );
                }
                let mut temp =
                    tempfile::NamedTempFile::new_in(target.parent().ok_or("Missing parent")?)
                        .map_err(|e| e.to_string())?;
                if bom {
                    temp.write_all(&[0xef, 0xbb, 0xbf])
                        .map_err(|e| e.to_string())?;
                }
                temp.write_all(content.as_bytes())
                    .map_err(|e| e.to_string())?;
                // Preserve executable bits and filesystem permissions.
                temp.as_file()
                    .set_permissions(
                        fs::metadata(&target)
                            .map_err(|e| e.to_string())?
                            .permissions(),
                    )
                    .map_err(|e| e.to_string())?;
                temp.as_file().sync_all().map_err(|e| e.to_string())?;
                // Re-check after staging to catch changes during a long write.
                if version(&read_for_write(&target)?) != expected_version {
                    return Err("File changed while saving".into());
                }
                temp.persist(&target).map_err(|e| e.to_string())?;
                Ok(json!({ "version": version(&read_for_write(&target)?) }))
            }
            FileRequest::Create {
                context_id,
                directory,
                name,
                is_dir,
            } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                let target = path::child(&self.root(&context_id)?, &directory, &name)?;
                if is_dir {
                    fs::create_dir(&target).map_err(|e| e.to_string())?;
                } else {
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!(display(&target)))
            }
            FileRequest::Rename {
                context_id,
                path: input,
                name,
            } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                let root = self.root(&context_id)?;
                let src = guarded(&root, &input, true)?;
                if src == root {
                    return Err("Cannot rename the project root".into());
                }
                let dest = path::child(
                    &root,
                    &display(src.parent().ok_or("Missing parent")?),
                    &name,
                )?;
                if src == dest {
                    return Ok(json!(display(&src)));
                }
                if dest.exists() {
                    let same_entry = canonical(&src)? == canonical(&dest)?;
                    if !same_entry {
                        return Err("A file with that name already exists".into());
                    }
                    // Case-only renames on case-insensitive filesystems require an intermediate name.
                    let temporary =
                        src.with_file_name(format!(".swarmterm-rename-{}", uuid::Uuid::new_v4()));
                    path::rename_new(&src, &temporary)?;
                    if let Err(e) = path::rename_new(&temporary, &dest) {
                        let _ = path::rename_new(&temporary, &src);
                        return Err(e.to_string());
                    }
                } else {
                    path::rename_new(&src, &dest)?;
                }
                Ok(json!(display(&dest)))
            }
            FileRequest::Transfer {
                context_id,
                source_context_id,
                paths,
                directory,
                cut,
                operation_id,
            } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                let source_root = self.root(&source_context_id)?;
                let sources: Result<Vec<_>, _> = paths
                    .iter()
                    .map(|p| guarded(&source_root, p, true))
                    .collect();
                let sources = sources?;
                if sources.iter().any(|p| p == &source_root) {
                    return Err("Cannot copy or move the project root".into());
                }
                self.transfer(&context_id, &sources, &directory, cut, &operation_id, app)
            }
            FileRequest::Remove { context_id, paths } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                let root = self.root(&context_id)?;
                let candidates: Result<Vec<_>, _> =
                    paths.iter().map(|p| guarded(&root, p, true)).collect();
                let mut removed = vec![];
                let mut warnings = vec![];
                let mut snapshots = vec![];
                for target in top_level(candidates?) {
                    if target == root {
                        return Err("Cannot delete the project root".into());
                    }
                    match history::snapshot(&self.history_dir, &root, &target) {
                        Ok(s) => snapshots.push(s),
                        Err(e) => warnings.push(format!("{}: {e}", target.display())),
                    }
                    if let Err(e) = history::remove_entry(&target) {
                        warnings.push(format!("Delete failed for {}: {e}", target.display()));
                    } else {
                        removed.push(display(&target));
                    }
                }
                Ok(json!({ "removed": removed, "warnings": warnings, "snapshots": snapshots }))
            }
            FileRequest::History { context_id } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                serde_json::to_value(history::list(&self.history_dir, &self.root(&context_id)?)?)
                    .map_err(|e| e.to_string())
            }
            FileRequest::Restore { context_id, id } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                Ok(json!(history::restore(
                    &self.history_dir,
                    &self.root(&context_id)?,
                    &id
                )?))
            }
            FileRequest::Git { context_id } => Ok(json!(git::status(&self.root(&context_id)?)?)),
            FileRequest::ClipboardWrite { context_id, paths } => {
                let root = self.root(&context_id)?;
                let paths: Result<Vec<_>, _> = paths
                    .iter()
                    .map(|p| guarded(&root, p, true).map(|p| display(&p)))
                    .collect();
                clipboard::write(paths?)?;
                Ok(Value::Null)
            }
            FileRequest::ClipboardRead => Ok(json!(clipboard::read()?)),
            FileRequest::ClipboardImport {
                context_id,
                directory,
                operation_id,
                expected_paths,
            } => {
                let _lock = self.operation.lock().map_err(|e| e.to_string())?;
                // Only native clipboard contents can authorize reads from outside a project.
                let native_paths = clipboard::read()?;
                if native_paths != expected_paths {
                    return Err(
                        "The system clipboard changed. Paste again to review its current files."
                            .into(),
                    );
                }
                let paths = native_paths
                    .into_iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>();
                self.transfer(&context_id, &paths, &directory, false, &operation_id, app)
            }
            FileRequest::Reveal { context_id, path } => {
                let root = self.root(&context_id)?;
                let target = guarded(&root, &path, true)?;
                let app = app.ok_or("Reveal requires a native application")?;
                let _ = app;
                crate::links::reveal_in_file_manager(&display(&target))?;
                Ok(Value::Null)
            }
            FileRequest::OpenMarkText {
                context_id,
                path,
                executable,
            } => {
                let target = guarded(&self.root(&context_id)?, &path, false)?;
                marktext::open(&executable, &target)?;
                Ok(Value::Null)
            }
            FileRequest::LocateMarkText { executable } => {
                Ok(json!(marktext::locate(&executable).map(|p| display(&p))))
            }
            FileRequest::PreviewDraft {
                context_id,
                path,
                content,
            } => {
                let target = guarded(&self.root(&context_id)?, &path, false)?;
                if !media::previewable(&target) {
                    return Err("Only HTML files have a live preview draft".into());
                }
                let mut drafts = self.drafts.lock().map_err(|e| e.to_string())?;
                match content {
                    Some(content) => drafts.insert(target, content),
                    None => drafts.remove(&target),
                };
                Ok(Value::Null)
            }
            FileRequest::OpenPreviewExternal { context_id, path } => {
                use tauri_plugin_opener::OpenerExt;
                let target = guarded(&self.root(&context_id)?, &path, false)?;
                // Deliberately not `mime()`: that list now includes .js, whose
                // Windows default handler is Script Host, not a browser.
                if !media::external_preview(&target) {
                    return Err("Only HTML and SVG files open in the browser".into());
                }
                app.ok_or("Open in browser requires a native application")?
                    .opener()
                    .open_path(display(&target), None::<&str>)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
        }
    }

    fn read(&self, context_id: &str, input: &str) -> Result<TextFile, String> {
        let path = guarded(&self.root(context_id)?, input, false)?;
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let mut bytes = vec![];
        Read::by_ref(&mut file)
            .take((READ_MAX + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let truncated = len > READ_MAX as u64;
        let hash = version(&bytes);
        bytes.truncate(READ_MAX);
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
        let content = String::from_utf8_lossy(if bom { &bytes[3..] } else { &bytes }).into_owned();
        Ok(TextFile {
            content,
            version: hash,
            truncated,
            binary,
            bom,
        })
    }

    fn transfer(
        &self,
        context_id: &str,
        paths: &[PathBuf],
        directory: &str,
        cut: bool,
        operation_id: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<Value, String> {
        use tauri::Emitter;
        let root = self.root(context_id)?;
        let dir = guarded(&root, directory, false)?;
        if !dir.is_dir() {
            return Err("Destination is not a directory".into());
        }
        let mut completed = vec![];
        let mut errors = vec![];
        let mut bytes: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        for src in top_level(paths.to_vec()) {
            let outcome: Result<String, String> = (|| {
                if within(&src, &dir) {
                    return Err("Cannot copy or move a folder into itself".into());
                }
                let name = src
                    .file_name()
                    .ok_or("Missing source name")?
                    .to_string_lossy();
                if cut && src.parent() == Some(dir.as_path()) {
                    return Err("File is already in that folder".into());
                }
                let dest = path::unique(&dir, &name);
                if cut && path::rename_new(&src, &dest).is_ok() {
                    return Ok(display(&dest));
                }
                // Own a staging directory so failed recursive copies never leave partial destinations.
                let staging = tempfile::tempdir_in(&dir).map_err(|e| e.to_string())?;
                let content = staging.path().join("content");
                history::copy_tree(&src, &content, &mut |n| {
                    bytes += n;
                    if last_emit.elapsed().as_millis() >= 100 {
                        if let Some(app) = app {
                            let _ = app.emit_to("main", "files:progress", json!({"contextId": context_id, "operationId": operation_id, "bytes": bytes, "path": display(&src)}));
                        }
                        last_emit = std::time::Instant::now();
                    }
                })?;
                if fs::symlink_metadata(&dest).is_ok() {
                    return Err("Destination appeared during copy; try again".into());
                }
                path::rename_new(&content, &dest)?;
                if cut {
                    history::remove_entry(&src).map_err(|e| {
                        format!(
                            "Copied to {}, but could not remove source: {e}",
                            dest.display()
                        )
                    })?;
                }
                Ok(display(&dest))
            })();
            match outcome {
                Ok(dest) => completed.push(json!({"source": display(&src), "destination": dest})),
                Err(e) => errors.push(format!("{}: {e}", src.display())),
            }
        }
        Ok(json!({"completed": completed, "errors": errors}))
    }
}

fn read_for_write(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take((READ_MAX + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > READ_MAX {
        return Err("The embedded editor supports files up to 1 MB".into());
    }
    Ok(bytes)
}

fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn top_level(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique = vec![];
    for p in &paths {
        if !unique.contains(p) && !paths.iter().any(|q| p != q && within(q, p)) {
            unique.push(p.clone());
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, FileService, FileContext) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("project");
        fs::create_dir(&root).unwrap();
        let service = FileService::new(t.path().join("history"));
        let context = service.open(&root).unwrap();
        (t, service, context)
    }
    #[test]
    fn context_rejects_a_terminal_still_running_in_its_previous_folder() {
        let (t, service, c) = fixture();
        let next = t.path().join("new-project");
        fs::create_dir(&next).unwrap();
        assert!(service
            .open_for_terminal(Path::new(&c.root), Some(&display(&next)))
            .unwrap_err()
            .contains("not ready"));
        assert_eq!(
            service
                .open_for_terminal(&next, Some(&display(&next)))
                .unwrap()
                .root,
            display(&canonical(&next).unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_configured_roots_use_the_same_canonical_project() {
        let (t, service, c) = fixture();
        let alias = t.path().join("alias");
        std::os::unix::fs::symlink(&c.root, &alias).unwrap();
        assert_eq!(
            service.open_for_terminal(&alias, Some(&c.root)).unwrap().id,
            c.id
        );
    }

    #[test]
    fn oversized_external_files_cannot_be_written() {
        let (_t, service, c) = fixture();
        let path = Path::new(&c.root).join("large.txt");
        fs::write(&path, vec![b'x'; READ_MAX + 1]).unwrap();
        let read = service.read(&c.id, &display(&path)).unwrap();
        assert!(read.truncated);
        assert!(service
            .request(
                FileRequest::Write {
                    context_id: c.id,
                    path: display(&path),
                    content: "small".into(),
                    expected_version: read.version,
                    bom: false
                },
                None
            )
            .is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), (READ_MAX + 1) as u64);
    }

    #[test]
    fn write_checks_versions_and_keeps_bom_and_crlf() {
        let (_t, service, c) = fixture();
        let path = Path::new(&c.root).join("a.txt");
        fs::write(&path, b"\xef\xbb\xbfa\r\nb\r\n").unwrap();
        let read = service.read(&c.id, &display(&path)).unwrap();
        assert!(read.bom);
        assert_eq!(read.content, "a\r\nb\r\n");
        let write = |v| FileRequest::Write {
            context_id: c.id.clone(),
            path: display(&path),
            content: "c\r\n".into(),
            expected_version: v,
            bom: true,
        };
        fs::write(&path, "external").unwrap();
        assert!(service.request(write(read.version), None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        let current = service.read(&c.id, &display(&path)).unwrap();
        service.request(write(current.version), None).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"\xef\xbb\xbfc\r\n");
    }
    #[test]
    fn deletion_saves_and_parent_selection_is_deduplicated() {
        let (_t, service, c) = fixture();
        let dir = Path::new(&c.root).join("folder");
        fs::create_dir(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "hello").unwrap();
        let result = service
            .request(
                FileRequest::Remove {
                    context_id: c.id.clone(),
                    paths: vec![display(&dir), display(&file), display(&dir)],
                },
                None,
            )
            .unwrap();
        assert_eq!(result["removed"].as_array().unwrap().len(), 1);
        assert_eq!(result["snapshots"].as_array().unwrap().len(), 1);
        assert!(!dir.exists());
        let id = result["snapshots"][0]["id"].as_str().unwrap();
        service
            .request(
                FileRequest::Restore {
                    context_id: c.id,
                    id: id.into(),
                },
                None,
            )
            .unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "hello");
    }
    #[test]
    fn copy_collisions_and_failure_do_not_touch_existing_files() {
        let (_t, service, c) = fixture();
        let path = Path::new(&c.root).join("a.txt");
        fs::write(&path, "hello").unwrap();
        let result = service
            .request(
                FileRequest::Transfer {
                    context_id: c.id.clone(),
                    source_context_id: c.id.clone(),
                    paths: vec![display(&path)],
                    directory: c.root.clone(),
                    cut: false,
                    operation_id: "test".into(),
                },
                None,
            )
            .unwrap();
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert!(Path::new(&c.root).join("a copy.txt").exists());
        assert!(service
            .request(
                FileRequest::Remove {
                    context_id: c.id,
                    paths: vec![c.root]
                },
                None
            )
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn outside_symlinks_cannot_read_write_or_copy_but_can_be_unlinked() {
        let (t, service, c) = fixture();
        let outside = t.path().join("secret");
        fs::write(&outside, "private").unwrap();
        let link = Path::new(&c.root).join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(service.read(&c.id, &display(&link)).is_err());
        service
            .request(
                FileRequest::Remove {
                    context_id: c.id,
                    paths: vec![display(&link)],
                },
                None,
            )
            .unwrap();
        assert!(outside.exists());
        assert!(!link.exists());
    }

    #[cfg(windows)]
    #[test]
    fn outside_directory_junctions_are_unlinked_without_deleting_the_target() {
        use std::os::windows::process::CommandExt;
        let (t, service, c) = fixture();
        let target = t.path().join("outside folder");
        fs::create_dir(&target).unwrap();
        let content = target.join("keep.txt");
        fs::write(&content, "keep the target").unwrap();
        let link = Path::new(&c.root).join("directory link");
        // Junctions require no symlink privilege. Keep cmd hidden and all paths
        // inside this test-owned TempDir; no recursive shell deletion is used.
        let created = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "{}",
            String::from_utf8_lossy(&created.stderr)
        );
        assert!(service
            .read(&c.id, &display(&link.join("keep.txt")))
            .is_err());
        let result = service
            .request(
                FileRequest::Remove {
                    context_id: c.id,
                    paths: vec![display(&link)],
                },
                None,
            )
            .unwrap();
        assert_eq!(result["removed"], json!([display(&link)]));
        assert_eq!(result["snapshots"], json!([]));
        assert!(!result["warnings"].as_array().unwrap().is_empty());
        assert!(!link.exists());
        assert_eq!(fs::read_to_string(content).unwrap(), "keep the target");
    }

    #[test]
    fn marktext_only_receives_markdown_inside_the_project() {
        let (t, service, c) = fixture();
        let txt = Path::new(&c.root).join("notes.txt");
        fs::write(&txt, "x").unwrap();
        let outside = t.path().join("outside.md");
        fs::write(&outside, "# x").unwrap();
        let open = |path: &Path| FileRequest::OpenMarkText {
            context_id: c.id.clone(),
            path: display(path),
            executable: String::new(),
        };
        assert!(service
            .request(open(&txt), None)
            .unwrap_err()
            .contains("Markdown"));
        assert!(service
            .request(open(&outside), None)
            .unwrap_err()
            .contains("outside"));
    }
}
