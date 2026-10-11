// src-tauri/src/sessions/qwen.rs
//! Qwen Code session discovery. Store layout (verified against the installed
//! qwen 0.21.12 bundle and a live `~/.qwen`): `<config>/projects/
//! <sanitized-cwd>/chats/` with one `<uuid>.jsonl` chat transcript per
//! session, plus `.runtime.json` / `.worktree.json` sidecars we ignore.
//! Records are JSON objects; a real user prompt has `type == "user"` and NO
//! `subtype` (synthetic user records — goal_runtime, mid-turn, cron — all
//! carry one). Its display text lives in `systemPayload.displayText` (what
//! qwen itself titles sessions with) or in `message.parts[].text`.

use super::{clean_title, is_uuid, mtime_ms, read_head, SessionEntry};
use serde_json::Value;
use std::path::Path;

/// Qwen's project-dir encoding (`sanitizeCwd` in the CLI): every
/// non-alphanumeric UTF-16 code unit → `-` (the JS regex has no `u` flag, so
/// a non-BMP char like an emoji becomes TWO dashes), with the whole cwd
/// lowercased FIRST on Windows. `windows` is a parameter rather than `cfg!`
/// so both branches are unit-testable on any host.
pub fn encode_project_dir(folder: &str, windows: bool) -> String {
    let normalized = if windows {
        folder.to_lowercase()
    } else {
        folder.to_string()
    };
    normalized
        .encode_utf16()
        .map(|u| match u {
            0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A => u as u8 as char,
            _ => '-',
        })
        .collect()
}

/// First real user prompt in the head of the transcript, cleaned for display.
/// `None` ⇒ nothing worth suggesting (session never got a prompt).
fn extract_title(head: &str) -> Option<String> {
    for line in head.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        // qwen's own title heuristic: user records with a subtype are
        // synthetic (mid-turn drain, cron, notifications) — never titles.
        if v.get("subtype").is_some() {
            continue;
        }
        let raw = v
            .pointer("/systemPayload/displayText")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                v.pointer("/message/parts")
                    .and_then(Value::as_array)
                    .and_then(|parts| {
                        parts
                            .iter()
                            .find_map(|p| p.get("text").and_then(Value::as_str).map(str::to_owned))
                    })
            });
        if let Some(title) = raw.as_deref().and_then(clean_title) {
            return Some(title);
        }
    }
    None
}

pub fn scan(projects_root: &Path, folder: &str) -> Vec<SessionEntry> {
    let dir = projects_root
        .join(encode_project_dir(folder, cfg!(windows)))
        .join("chats");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Sidecars (`<uuid>.runtime.json`, `<uuid>.worktree.json`) fail the
        // extension check; only the transcript itself is `.jsonl`.
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_uuid(stem) {
            continue;
        }
        let Some(title) = read_head(&path).as_deref().and_then(extract_title) else {
            continue;
        };
        out.push(SessionEntry {
            account_id: None,
            agent_id: "qwen".into(),
            session_id: stem.to_owned(),
            title,
            cwd: folder.to_owned(),
            updated_at_ms: mtime_ms(&path),
        });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn chats_dir(root: &Path, folder: &str) -> std::path::PathBuf {
        root.join(encode_project_dir(folder, cfg!(windows)))
            .join("chats")
    }

    #[test]
    fn encode_lowercases_only_on_windows() {
        assert_eq!(
            encode_project_dir("/Volumes/Wo ware/x", false),
            "-Volumes-Wo-ware-x"
        );
        assert_eq!(encode_project_dir("C:\\Users\\Me", true), "c--users-me");
    }

    #[test]
    fn encode_matches_qwen_per_utf16_unit() {
        // qwen replaces per UTF-16 code unit (JS regex without /u): an emoji
        // is a surrogate PAIR → two dashes, not one.
        assert_eq!(encode_project_dir("/repo/🚀app", false), "-repo---app");
    }

    #[test]
    fn scan_lists_sessions_with_display_text_title() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = chats_dir(tmp.path(), "/repo");
        fs::create_dir_all(&chats).unwrap();
        fs::write(
            chats.join("d1413bdb-3790-4a32-8dac-fdbea6fc11b4.jsonl"),
            concat!(
                "{\"type\":\"system\",\"subtype\":\"session_source\"}\n",
                "{\"type\":\"user\",\"provenance\":\"real_user\",\"message\":{\"role\":\"user\",\"parts\":[{\"text\":\"raw api text\"}]},\"systemPayload\":{\"displayText\":\"Fix the   login bug\"}}\n",
            ),
        )
        .unwrap();
        let out = scan(tmp.path(), "/repo");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].agent_id, "qwen");
        assert_eq!(out[0].session_id, "d1413bdb-3790-4a32-8dac-fdbea6fc11b4");
        assert_eq!(out[0].title, "Fix the login bug");
        assert_eq!(out[0].cwd, "/repo");
        assert!(out[0].updated_at_ms > 0);
    }

    #[test]
    fn scan_falls_back_to_message_parts_text() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = chats_dir(tmp.path(), "/repo");
        fs::create_dir_all(&chats).unwrap();
        fs::write(
            chats.join("11111111-2222-4333-8444-555555555555.jsonl"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"parts\":[{\"text\":\"Refactor pty module\"}]}}\n",
        )
        .unwrap();
        let out = scan(tmp.path(), "/repo");
        assert_eq!(out[0].title, "Refactor pty module");
    }

    #[test]
    fn scan_skips_noise() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = chats_dir(tmp.path(), "/repo");
        fs::create_dir_all(&chats).unwrap();
        // Only synthetic user records (subtype set) → no title → skipped.
        fs::write(
            chats.join("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"),
            "{\"type\":\"user\",\"subtype\":\"cron\",\"systemPayload\":{\"displayText\":\"cron noise\"}}\n",
        )
        .unwrap();
        // Garbage line first, real prompt after → still titled.
        fs::write(
            chats.join("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl"),
            concat!(
                "not json at all\n",
                "{\"type\":\"user\",\"systemPayload\":{\"displayText\":\"real prompt\"}}\n",
            ),
        )
        .unwrap();
        // Sidecars and non-UUID stems are not sessions.
        fs::write(
            chats.join("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.runtime.json"),
            "{\"schema_version\":1}\n",
        )
        .unwrap();
        fs::write(chats.join("notes.jsonl"), "{}\n").unwrap();
        let out = scan(tmp.path(), "/repo");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "real prompt");
    }

    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan(tmp.path(), "/never/used").is_empty());
    }
}
