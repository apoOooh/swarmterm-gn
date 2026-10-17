//! Reading one Claude Code transcript for an excerpt (SWA-58). Runs only
//! after the ledger asked for it, i.e. only with "Allow excerpts" on.
//!
//! The hook's `transcript_path` is never used. The file is located from the
//! pane's own config dir (account profiles have their own
//! `CLAUDE_CONFIG_DIR`) and the session id the ledger already validated:
//! `<config>/projects/<dir>/<session>.jsonl`. Opening it follows a strict
//! contract, because the path crosses directories a same-user program could
//! swap for a junction between our check and our open:
//! - the file itself must not be a reparse point (opened with
//!   FILE_FLAG_OPEN_REPARSE_POINT, attribute checked on the handle);
//! - the handle's FINAL path must lie inside the canonical config root,
//!   compared component by component — never a string prefix;
//! - the name is `<uuid>.jsonl`, built here, so no `..`, ADS or device name.
//!
//! None of this proves the content is genuine — the same user can write any
//! file — it only keeps us from being pointed at files outside the root.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use super::claude::{self, Reject};
use super::Fingerprint;

/// Tail read per attempt. The final answer and its prompt sit at the end;
/// a turn with megabytes of tool output after its prompt has no excerpt.
pub const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// Whole budget for one turn, retries and parsing included.
pub const BUDGET: Duration = Duration::from_millis(200);
/// Pause between attempts while Claude Code flushes the final row.
const RETRY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    NotFound,
    Refused,
    Io,
}

/// The Claude config dir of a pane: its account profile, else
/// `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn claude_config_dir(profile: Option<&Path>, home: &Path) -> PathBuf {
    if let Some(p) = profile {
        return p.to_path_buf();
    }
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
}

/// `<root>/projects/*/<session>.jsonl`, the first regular file found.
pub fn locate(root: &Path, session_id: &str) -> Option<PathBuf> {
    if !crate::sessions::is_uuid(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(root.join("projects"))
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file()))
}

/// Whether `path` lies inside `root`, both already canonical (`\\?\`).
/// Case-insensitive like NTFS; a root that is a prefix of a sibling's name
/// (`.claude` vs `.claude-evil`) does not count.
pub fn within(root: &Path, path: &Path) -> bool {
    let norm = |c: Component| c.as_os_str().to_string_lossy().to_lowercase();
    let mut r = root
        .components()
        .filter(|c| !matches!(c, Component::CurDir));
    let mut p = path.components();
    loop {
        match (r.next(), p.next()) {
            (None, Some(Component::Normal(_))) => return true,
            (None, _) => return false,
            (Some(a), Some(b)) if norm(a) == norm(b) => {}
            _ => return false,
        }
    }
}

/// Complete lines of the last `max` bytes: a line cut at the start of the
/// window and an unterminated last line (being written) are dropped.
pub fn complete_lines(buf: &[u8], cut_at_start: bool) -> &[u8] {
    let start = if cut_at_start {
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) => i + 1,
            None => return &[],
        }
    } else {
        0
    };
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    if end <= start {
        return &[];
    }
    &buf[start..end]
}

#[cfg(windows)]
fn open_checked(root: &Path, path: &Path) -> Result<std::fs::File, ReadError> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        VOLUME_NAME_DOS,
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| ReadError::NotFound)?;
    let meta = file.metadata().map_err(|_| ReadError::Io)?;
    if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(ReadError::Refused);
    }
    let mut buf = vec![0u16; 1024];
    // SAFETY: a valid handle and a buffer of the length passed.
    let n = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buf.as_mut_ptr(),
            buf.len() as u32,
            VOLUME_NAME_DOS,
        )
    } as usize;
    if n == 0 || n >= buf.len() {
        return Err(ReadError::Refused);
    }
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
    let root = std::fs::canonicalize(root).map_err(|_| ReadError::Refused)?;
    if !within(&root, &final_path) {
        return Err(ReadError::Refused);
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_checked(root: &Path, path: &Path) -> Result<std::fs::File, ReadError> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| ReadError::NotFound)?;
    if !meta.file_type().is_file() {
        return Err(ReadError::Refused);
    }
    let real = std::fs::canonicalize(path).map_err(|_| ReadError::Refused)?;
    let root = std::fs::canonicalize(root).map_err(|_| ReadError::Refused)?;
    if !within(&root, &real) {
        return Err(ReadError::Refused);
    }
    std::fs::File::open(path).map_err(|_| ReadError::NotFound)
}

/// The tail of the transcript as text, complete lines only.
pub fn read_tail(root: &Path, path: &Path) -> Result<String, ReadError> {
    let mut file = open_checked(root, path)?;
    let len = file.metadata().map_err(|_| ReadError::Io)?.len();
    let start = len.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| ReadError::Io)?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(MAX_TAIL_BYTES)
        .read_to_end(&mut buf)
        .map_err(|_| ReadError::Io)?;
    let lines = complete_lines(&buf, start > 0);
    // A cut multibyte sequence can only sit at the window start, which
    // `complete_lines` already dropped; anything else invalid fails closed.
    String::from_utf8(lines.to_vec()).map_err(|_| ReadError::Io)
}

/// Read until the answer the hook saw is in the file or the budget is gone.
/// `read` is the file access, injected so tests count opens without a disk.
pub fn final_answer_within(
    mut read: impl FnMut() -> Result<String, ReadError>,
    prompt_id: &str,
    expected: &Fingerprint,
    budget: Duration,
) -> Option<String> {
    let deadline = Instant::now() + budget;
    loop {
        let tail = read().ok()?;
        match claude::final_answer(&tail, prompt_id, expected) {
            Ok(text) => return Some(text),
            // Not flushed yet: worth another look within the budget.
            Err(Reject::NoAnchor | Reject::NoAnswer | Reject::Mismatch) => {}
            Err(Reject::Superseded | Reject::Schema) => return None,
        }
        if Instant::now() + RETRY >= deadline {
            return None;
        }
        std::thread::sleep(RETRY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "3f4fe5b8-6a2f-4bbf-a2a2-18d3fa4951e0";
    const P: &str = "f62f9126-5c26-43d5-8bc8-3943559598b7";

    fn transcript(answer: Option<&str>) -> String {
        let mut s =
            serde_json::json!({"type":"user","promptId":P,"message":{"content":"x"}}).to_string();
        s.push('\n');
        if let Some(a) = answer {
            s.push_str(
                &serde_json::json!({"type":"assistant",
                    "message":{"id":"m","content":[{"type":"text","text":a}]}})
                .to_string(),
            );
            s.push('\n');
        }
        s
    }

    #[test]
    fn keeps_complete_lines_only() {
        assert_eq!(complete_lines(b"a\nb\nc", false), b"a\nb\n");
        assert_eq!(complete_lines(b"cut\nb\n", true), b"b\n");
        assert_eq!(complete_lines(b"only cut", true), b"");
        assert_eq!(complete_lines(b"half", false), b"");
    }

    #[test]
    fn within_compares_components_not_prefixes() {
        let root = Path::new(r"C:\Users\u\.claude");
        assert!(within(
            root,
            Path::new(r"C:\Users\u\.claude\projects\x\a.jsonl")
        ));
        assert!(within(
            root,
            Path::new(r"c:\users\U\.CLAUDE\projects\a.jsonl")
        ));
        assert!(!within(
            root,
            Path::new(r"C:\Users\u\.claude-evil\projects\a.jsonl")
        ));
        assert!(!within(root, Path::new(r"C:\Users\u\.claude")));
        assert!(!within(root, Path::new(r"C:\Users\u\other\a.jsonl")));
        assert!(!within(root, Path::new(r"\\server\share\.claude\a.jsonl")));
    }

    #[test]
    fn locates_the_session_file_only_by_a_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("projects").join("D--repo");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join(format!("{S}.jsonl")), "x\n").unwrap();
        assert_eq!(locate(dir.path(), S), Some(proj.join(format!("{S}.jsonl"))));
        assert_eq!(locate(dir.path(), "../../etc"), None);
        assert_eq!(
            locate(dir.path(), "11111111-2222-3333-4444-555555555555"),
            None
        );
        // A directory with the session's name is not a transcript.
        std::fs::create_dir_all(proj.join("11111111-2222-3333-4444-555555555555.jsonl")).unwrap();
        assert_eq!(
            locate(dir.path(), "11111111-2222-3333-4444-555555555555"),
            None
        );
    }

    #[test]
    fn reads_a_tail_inside_the_root_and_refuses_one_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cfg");
        let proj = root.join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join(format!("{S}.jsonl"));
        std::fs::write(&file, transcript(Some("Fertig."))).unwrap();
        let tail = read_tail(&root, &file).unwrap();
        assert!(tail.ends_with("\n"));
        let other = dir.path().join("cfg-other");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(read_tail(&other, &file), Err(ReadError::Refused));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_root_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cfg");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("projects")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join(format!("{S}.jsonl")), transcript(Some("x"))).unwrap();
        junction::create(&outside, root.join("projects").join("p")).unwrap();
        let path = locate(&root, S).unwrap();
        assert_eq!(read_tail(&root, &path), Err(ReadError::Refused));
    }

    #[test]
    fn a_huge_transcript_without_its_prompt_in_the_window_has_no_answer() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join(format!("{S}.jsonl"));
        let filler = format!(
            "{}\n",
            serde_json::json!({"type":"system","x":"y".repeat(1000)})
        );
        let mut body = transcript(None);
        body.push_str(&filler.repeat((MAX_TAIL_BYTES as usize / filler.len()) + 10));
        body.push_str(transcript(Some("Ende.")).lines().nth(1).unwrap());
        body.push('\n');
        std::fs::write(&file, body).unwrap();
        let got = final_answer_within(
            || read_tail(dir.path(), &file),
            P,
            &Fingerprint::of("Ende."),
            Duration::ZERO,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn retries_until_the_final_row_is_flushed_within_the_budget() {
        let mut calls = 0;
        let got = final_answer_within(
            || {
                calls += 1;
                Ok(transcript(if calls < 3 { None } else { Some("Fertig.") }))
            },
            P,
            &Fingerprint::of("Fertig."),
            BUDGET,
        );
        assert_eq!(got.as_deref(), Some("Fertig."));
        assert_eq!(calls, 3);
    }

    #[test]
    fn gives_up_at_the_budget_and_on_a_newer_prompt() {
        let t0 = Instant::now();
        let got = final_answer_within(
            || Ok(transcript(Some("Alt."))),
            P,
            &Fingerprint::of("Neu."),
            BUDGET,
        );
        assert_eq!(got, None);
        assert!(t0.elapsed() < BUDGET + Duration::from_millis(100));
        let mut calls = 0;
        let newer = format!(
            "{}{}\n",
            transcript(Some("A")),
            serde_json::json!({"type":"user","promptId":"other","message":{"content":"y"}})
        );
        let got = final_answer_within(
            || {
                calls += 1;
                Ok(newer.clone())
            },
            P,
            &Fingerprint::of("A"),
            BUDGET,
        );
        assert_eq!((got, calls), (None, 1));
    }
}
