//! Read-only thread view (SWA-25): one Claude Code or Codex session file
//! rendered as a list of messages.
//!
//! WHY it is shaped like this:
//! - The file is found by EXACT session id (Claude: `<id>.jsonl` under any
//!   project dir; Codex: rollout whose `session_meta.payload.id` matches) —
//!   never "newest in this folder". A pane's session can live under a
//!   worktree's encoded path, so the project dir is not guessed from the cwd.
//! - Session files can be hundreds of MB. Only the TAIL (`TAIL_CAP`) is read
//!   and the result says so (`truncated`); the newest part of a conversation
//!   is what a reader wants. The first, possibly cut, line of the tail is
//!   dropped rather than mis-parsed.
//! - Both formats are undocumented, so every line is parsed best-effort:
//!   unknown shapes are skipped, never an error. Synthetic user entries
//!   (command wrappers, environment context — they start with `<`) are not
//!   part of the conversation and are skipped like `clean_title` does.
//! - Nothing here writes anywhere. Approvals, tool permission prompts and the
//!   like are shown as text at most; the view never drives the agent.

use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// How much of the file end is read.
const TAIL_CAP: u64 = 8 * 1024 * 1024;
/// Per-message text cap; a pasted log must not freeze the dialog.
const TEXT_CAP: usize = 20_000;
/// At most this many (newest) messages are returned.
const MESSAGE_CAP: usize = 1_500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub role: Role,
    pub text: String,
    /// ISO timestamp as written by the CLI, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub found: bool,
    /// Older parts of the file (or older messages) were left out.
    pub truncated: bool,
    pub messages: Vec<ThreadMessage>,
}

fn cap_text(s: &str) -> String {
    if s.chars().count() <= TEXT_CAP {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(TEXT_CAP).collect();
    out.push_str("\n… (message shortened)");
    out
}

fn is_synthetic(text: &str) -> bool {
    text.trim_start().starts_with('<')
}

fn timestamp(v: &Value) -> Option<String> {
    v.get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn push(out: &mut Vec<ThreadMessage>, role: Role, text: &str, at: Option<String>) {
    let text = text.trim();
    if text.is_empty() || (role == Role::User && is_synthetic(text)) {
        return;
    }
    out.push(ThreadMessage {
        role,
        text: cap_text(text),
        at,
    });
}

/// One Claude Code JSONL line → zero or more messages.
pub fn parse_claude_line(line: &str, out: &mut Vec<ThreadMessage>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let role = match v.get("type").and_then(Value::as_str) {
        Some("user") => Role::User,
        Some("assistant") => Role::Assistant,
        _ => return,
    };
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || v.get("isMeta").and_then(Value::as_bool) == Some(true)
    {
        return;
    }
    let at = timestamp(&v);
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return;
    };
    match content {
        Value::String(s) => push(out, role, s, at),
        Value::Array(blocks) => {
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            push(out, role, t, at.clone());
                        }
                    }
                    Some("tool_use") => {
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                        push(out, Role::Tool, &format!("→ {name}"), at.clone());
                    }
                    Some("tool_result") => {
                        let failed = b.get("is_error").and_then(Value::as_bool) == Some(true);
                        let label = if failed {
                            "← tool error"
                        } else {
                            "← tool result"
                        };
                        push(out, Role::Tool, label, at.clone());
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// One Codex rollout line → zero or more messages. Only `response_item`s are
/// read: the parallel `event_msg` stream repeats the same text.
pub fn parse_codex_line(line: &str, out: &mut Vec<ThreadMessage>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if v.get("type").and_then(Value::as_str) != Some("response_item") {
        return;
    }
    let at = timestamp(&v);
    let Some(p) = v.get("payload") else {
        return;
    };
    match p.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = match p.get("role").and_then(Value::as_str) {
                Some("user") => Role::User,
                Some("assistant") => Role::Assistant,
                _ => return,
            };
            for b in p
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if matches!(
                    b.get("type").and_then(Value::as_str),
                    Some("input_text" | "output_text")
                ) {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        push(out, role, t, at.clone());
                    }
                }
            }
        }
        Some("function_call" | "custom_tool_call" | "local_shell_call") => {
            let name = p.get("name").and_then(Value::as_str).unwrap_or("shell");
            push(out, Role::Tool, &format!("→ {name}"), at);
        }
        _ => {}
    }
}

/// The last `cap` bytes of a file as lines; `.1` is true when the head was cut.
fn read_tail(path: &Path, cap: u64) -> Option<(Vec<String>, bool)> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(cap);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let cut = start > 0;
    if cut && !lines.is_empty() {
        lines.remove(0);
    }
    Some((lines, cut))
}

pub fn read_file(path: &Path, parse: fn(&str, &mut Vec<ThreadMessage>), cap: u64) -> Thread {
    let Some((lines, mut truncated)) = read_tail(path, cap) else {
        return Thread::default();
    };
    let mut messages = Vec::new();
    for line in &lines {
        parse(line, &mut messages);
    }
    if messages.len() > MESSAGE_CAP {
        messages.drain(..messages.len() - MESSAGE_CAP);
        truncated = true;
    }
    Thread {
        found: true,
        truncated,
        messages,
    }
}

/// `<projects_root>/<any project dir>/<id>.jsonl`. Directory names only, no
/// file is opened while searching.
pub fn find_claude(projects_root: &Path, id: &str) -> Option<PathBuf> {
    if !super::is_uuid(id) {
        return None;
    }
    let name = format!("{id}.jsonl");
    std::fs::read_dir(projects_root)
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

pub fn read_claude(projects_root: &Path, id: &str) -> Thread {
    find_claude(projects_root, id)
        .map(|p| read_file(&p, parse_claude_line, TAIL_CAP))
        .unwrap_or_default()
}

pub fn read_codex(sessions_root: &Path, id: &str) -> Thread {
    super::codex::find_rollout(sessions_root, id)
        .map(|p| read_file(&p, parse_codex_line, TAIL_CAP))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn claude(lines: &[&str]) -> Vec<ThreadMessage> {
        let mut out = Vec::new();
        for l in lines {
            parse_claude_line(l, &mut out);
        }
        out
    }

    fn codex(lines: &[&str]) -> Vec<ThreadMessage> {
        let mut out = Vec::new();
        for l in lines {
            parse_codex_line(l, &mut out);
        }
        out
    }

    #[test]
    fn claude_user_assistant_and_tools() {
        let out = claude(&[
            r#"{"type":"user","timestamp":"T1","message":{"role":"user","content":"Fix the bug"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"On it."},{"type":"tool_use","name":"Edit","input":{}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"x"}]}}"#,
        ]);
        let roles: Vec<_> = out.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(
            roles,
            vec![
                (Role::User, "Fix the bug"),
                (Role::Assistant, "On it."),
                (Role::Tool, "→ Edit"),
                (Role::Tool, "← tool result"),
                (Role::Tool, "← tool error"),
            ]
        );
        assert_eq!(out[0].at.as_deref(), Some("T1"));
    }

    #[test]
    fn claude_skips_sidechain_meta_synthetic_and_garbage() {
        let out = claude(&[
            "not json",
            r#"{"type":"summary","summary":"x"}"#,
            r#"{"type":"user","isSidechain":true,"message":{"content":"sub"}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]}}"#,
        ]);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn codex_reads_response_items_only() {
        let out = codex(&[
            r#"{"type":"session_meta","payload":{"id":"x"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>..."}]}}"#,
            r#"{"type":"response_item","timestamp":"T","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add tests"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"Add tests"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}"#,
        ]);
        let roles: Vec<_> = out.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(
            roles,
            vec![
                (Role::User, "Add tests"),
                (Role::Tool, "→ shell"),
                (Role::Assistant, "Done."),
            ]
        );
    }

    #[test]
    fn long_text_is_capped() {
        let long = "a".repeat(TEXT_CAP + 10);
        let line = format!(r#"{{"type":"user","message":{{"content":"{long}"}}}}"#);
        let out = claude(&[&line]);
        assert!(out[0].text.ends_with("(message shortened)"));
    }

    #[test]
    fn tail_read_drops_the_cut_line_and_reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let first = r#"{"type":"user","message":{"content":"FIRST"}}"#;
        let second = r#"{"type":"user","message":{"content":"SECOND"}}"#;
        fs::write(&path, format!("{first}\n{second}\n")).unwrap();
        let full = read_file(&path, parse_claude_line, 1 << 20);
        assert!(full.found && !full.truncated);
        assert_eq!(full.messages.len(), 2);
        // Cap inside the first line: it is cut, so it must be dropped, not mis-parsed.
        let tail = read_file(&path, parse_claude_line, (second.len() + 10) as u64);
        assert!(tail.truncated);
        assert_eq!(tail.messages.len(), 1);
        assert_eq!(tail.messages[0].text, "SECOND");
    }

    #[test]
    fn find_claude_by_exact_id_in_any_project_dir() {
        let root = tempfile::tempdir().unwrap();
        let id = "fe845bc6-6932-4459-8fb6-cdd0e7c6cc84";
        fs::create_dir_all(root.path().join("-a")).unwrap();
        fs::create_dir_all(root.path().join("-b")).unwrap();
        fs::write(
            root.path().join("-b").join(format!("{id}.jsonl")),
            r#"{"type":"user","message":{"content":"hi"}}"#,
        )
        .unwrap();
        let t = read_claude(root.path(), id);
        assert!(t.found);
        assert_eq!(t.messages[0].text, "hi");
        assert!(!read_claude(root.path(), "fe845bc6-6932-4459-8fb6-cdd0e7c6cc85").found);
        // Not a uuid → never a path component.
        assert!(find_claude(root.path(), "../x").is_none());
    }
}
