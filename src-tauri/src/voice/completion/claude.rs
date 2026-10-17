//! Claude Code transcript → the final answer of ONE turn (SWA-58). Pure:
//! takes the tail of the session JSONL as text, so every rule is a fixture
//! test and the file I/O stays in `reader`.
//!
//! The turn is pinned by `prompt_id`, which Claude Code puts on every hook
//! payload ("UUID correlating a user prompt with all subsequent events until
//! the next prompt") and on every user row of the transcript (`promptId`).
//! That, not a hash, proves freshness: a late Stop of turn 1 carries turn 1's
//! id and is refused by the ledger before anything is read, and a tail in
//! which a newer prompt follows is refused here.
//!
//! The text is what Claude Code hands its Stop hook as
//! `last_assistant_message`: the text blocks of the LAST assistant row,
//! joined with "\n", trimmed. The hook CLI sends only a fingerprint of that
//! string; the text read here must match it byte for byte, otherwise the
//! row is not flushed yet (or is another one) and there is no excerpt.

use serde_json::Value;

use super::Fingerprint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    /// No row of this prompt in the tail (not flushed yet, or cut off).
    NoAnchor,
    /// A newer prompt follows: this turn is not the current one.
    Superseded,
    /// No assistant text after the anchor yet.
    NoAnswer,
    /// The last assistant text is not the one the hook saw (yet).
    Mismatch,
    /// A row that is not JSON or not the shape we know: fail closed.
    Schema,
}

fn is_main(row: &Value) -> bool {
    row.get("isSidechain").and_then(Value::as_bool) != Some(true)
}

fn prompt_id(row: &Value) -> Option<&str> {
    row.get("promptId").and_then(Value::as_str)
}

/// A user row the human typed (not a tool result, not injected meta text).
fn is_human_prompt(row: &Value) -> bool {
    if row.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    match row.pointer("/message/content") {
        Some(Value::String(_)) => true,
        Some(Value::Array(blocks)) => !blocks
            .iter()
            .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")),
        _ => false,
    }
}

fn assistant_text(row: &Value) -> Option<String> {
    let blocks = row.pointer("/message/content")?.as_array()?;
    let text: Vec<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    if text.is_empty() {
        return None;
    }
    let joined = text.join("\n");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `tail` holds complete lines only (the reader drops a cut first line and
/// an unterminated last one). Returns the final answer of `prompt`.
pub fn final_answer(tail: &str, prompt: &str, expected: &Fingerprint) -> Result<String, Reject> {
    let mut rows = Vec::new();
    for line in tail.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line).map_err(|_| Reject::Schema)?;
        if !row.is_object() {
            return Err(Reject::Schema);
        }
        rows.push(row);
    }
    let main = |r: &&Value| is_main(r);
    // The last user row of this prompt: its prompt, or a tool result that
    // came back within it. The answer is after it.
    let anchor = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| main(r))
        .filter(|(_, r)| r.get("type").and_then(Value::as_str) == Some("user"))
        .rfind(|(_, r)| prompt_id(r) == Some(prompt))
        .map(|(i, _)| i)
        .ok_or(Reject::NoAnchor)?;
    let after = &rows[anchor + 1..];
    if after.iter().filter(main).any(|r| {
        r.get("type").and_then(Value::as_str) == Some("user")
            && is_human_prompt(r)
            && prompt_id(r).is_some_and(|p| p != prompt)
    }) {
        return Err(Reject::Superseded);
    }
    let last = after
        .iter()
        .filter(main)
        .rfind(|r| r.get("type").and_then(Value::as_str) == Some("assistant"))
        .ok_or(Reject::NoAnswer)?;
    let text = assistant_text(last).ok_or(Reject::NoAnswer)?;
    if Fingerprint::of(&text) != *expected {
        return Err(Reject::Mismatch);
    }
    Ok(text)
}

/// What Claude Code writes as a user row when Esc stops a turn ("[Request
/// interrupted by user]", "… for tool use]"). Esc fires no hook, so this
/// row is the only proof of an interruption.
const INTERRUPT_MARKER: &str = "[Request interrupted by user";

fn is_interrupt_marker(row: &Value) -> bool {
    let starts = |t: &str| t.trim_start().starts_with(INTERRUPT_MARKER);
    match row.pointer("/message/content") {
        Some(Value::String(t)) => starts(t),
        Some(Value::Array(blocks)) => blocks.iter().any(|b| {
            b.get("type").and_then(Value::as_str) == Some("text")
                && b.get("text").and_then(Value::as_str).is_some_and(starts)
        }),
        _ => false,
    }
}

/// Whether the turn `prompt` ended with the interrupt marker: it is the last
/// main-chain user/assistant row after this prompt's first row, and no newer
/// human prompt follows. Same fail-closed parsing as `final_answer`.
pub fn interrupted(tail: &str, prompt: &str) -> Result<bool, Reject> {
    let mut rows = Vec::new();
    for line in tail.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line).map_err(|_| Reject::Schema)?;
        if !row.is_object() {
            return Err(Reject::Schema);
        }
        rows.push(row);
    }
    let kind = |r: &Value| r.get("type").and_then(Value::as_str).map(str::to_owned);
    let main: Vec<&Value> = rows
        .iter()
        .filter(|r| is_main(r))
        .filter(|r| matches!(kind(r).as_deref(), Some("user" | "assistant")))
        .collect();
    let anchor = main
        .iter()
        .position(|r| prompt_id(r) == Some(prompt))
        .ok_or(Reject::NoAnchor)?;
    let after = &main[anchor + 1..];
    if after.iter().any(|r| {
        kind(r).as_deref() == Some("user")
            && is_human_prompt(r)
            && !is_interrupt_marker(r)
            && prompt_id(r).is_some_and(|p| p != prompt)
    }) {
        return Err(Reject::Superseded);
    }
    Ok(after
        .last()
        .is_some_and(|r| kind(r).as_deref() == Some("user") && is_interrupt_marker(r)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Synthetic rows with the line structure of Claude Code 2.1.302: one
    // row per content block, `promptId` on user rows only, sidechains and
    // system rows interleaved.
    const P1: &str = "f62f9126-5c26-43d5-8bc8-3943559598b7";
    const P2: &str = "3f4fe5b8-6a2f-4bbf-a2a2-18d3fa4951e0";

    fn prompt(id: &str, text: &str) -> String {
        json!({"type":"user","promptId":id,"isSidechain":false,
               "message":{"role":"user","content":text},"origin":{"kind":"human"}})
        .to_string()
    }
    fn tool_result(id: &str) -> String {
        json!({"type":"user","promptId":id,"isSidechain":false,
               "message":{"role":"user","content":[{"type":"tool_result","content":"secret output"}]}})
        .to_string()
    }
    fn assistant(msg: &str, block: Value) -> String {
        json!({"type":"assistant","isSidechain":false,
               "message":{"id":msg,"role":"assistant","content":[block]}})
        .to_string()
    }
    fn text(msg: &str, t: &str) -> String {
        assistant(msg, json!({"type":"text","text":t}))
    }
    fn system() -> String {
        json!({"type":"system","subtype":"stop_hook_summary"}).to_string()
    }
    fn tail(rows: &[String]) -> String {
        rows.iter().map(|r| format!("{r}\n")).collect()
    }
    fn fp(s: &str) -> Fingerprint {
        Fingerprint::of(s)
    }

    #[test]
    fn reads_the_last_text_row_after_the_last_tool_result() {
        let t = tail(&[
            prompt(P1, "do it"),
            assistant("m1", json!({"type":"thinking","thinking":"hidden"})),
            text("m1", "Ich schaue nach."),
            assistant("m1", json!({"type":"tool_use","name":"Bash"})),
            tool_result(P1),
            text("m2", "  Fertig. Alles grün.\n"),
            system(),
        ]);
        assert_eq!(
            final_answer(&t, P1, &fp("Fertig. Alles grün.")).as_deref(),
            Ok("Fertig. Alles grün.")
        );
    }

    #[test]
    fn a_turn_without_tools_anchors_on_the_prompt() {
        let t = tail(&[prompt(P1, "hi"), text("m1", "Hallo.")]);
        assert_eq!(final_answer(&t, P1, &fp("Hallo.")).as_deref(), Ok("Hallo."));
    }

    #[test]
    fn several_text_blocks_in_one_row_join_like_claude_does() {
        let row = json!({"type":"assistant","message":{"id":"m","content":[
            {"type":"text","text":"Eins."},{"type":"tool_use"},{"type":"text","text":"Zwei."}]}})
        .to_string();
        let t = tail(&[prompt(P1, "x"), row]);
        assert_eq!(
            final_answer(&t, P1, &fp("Eins.\nZwei.")).as_deref(),
            Ok("Eins.\nZwei.")
        );
    }

    #[test]
    fn identical_answers_never_make_an_old_turn_current() {
        // Turn 1 P→A, turn 2 starts with the same prompt text but is not
        // answered yet. A Stop for turn 2 must not read turn 1's A.
        let t = tail(&[prompt(P1, "same"), text("m1", "A"), prompt(P2, "same")]);
        assert_eq!(final_answer(&t, P2, &fp("A")), Err(Reject::NoAnswer));
        // And a late Stop of turn 1 is refused once turn 2 is in the tail.
        assert_eq!(final_answer(&t, P1, &fp("A")), Err(Reject::Superseded));
    }

    #[test]
    fn the_previous_answer_is_not_taken_while_the_current_is_unflushed() {
        let t = tail(&[prompt(P1, "a"), text("m1", "Alt."), prompt(P2, "b")]);
        assert_eq!(final_answer(&t, P2, &fp("Neu.")), Err(Reject::NoAnswer));
        let t = tail(&[
            prompt(P1, "a"),
            text("m1", "Alt."),
            prompt(P2, "b"),
            text("m2", "Zwischenstand."),
        ]);
        assert_eq!(final_answer(&t, P2, &fp("Neu.")), Err(Reject::Mismatch));
    }

    #[test]
    fn no_anchor_in_the_tail_means_no_answer() {
        let t = tail(&[text("m1", "Ohne Prompt.")]);
        assert_eq!(
            final_answer(&t, P1, &fp("Ohne Prompt.")),
            Err(Reject::NoAnchor)
        );
    }

    #[test]
    fn sidechains_and_meta_rows_are_ignored() {
        let side = json!({"type":"assistant","isSidechain":true,
            "message":{"id":"s","content":[{"type":"text","text":"Subagent."}]}})
        .to_string();
        let side_prompt = json!({"type":"user","isSidechain":true,"promptId":P2,
            "message":{"content":"sub"}})
        .to_string();
        let meta = json!({"type":"user","isMeta":true,"promptId":P2,
            "message":{"content":"<system-reminder>"}})
        .to_string();
        let t = tail(&[
            prompt(P1, "x"),
            text("m1", "Haupt."),
            side_prompt,
            side,
            meta,
        ]);
        assert_eq!(final_answer(&t, P1, &fp("Haupt.")).as_deref(), Ok("Haupt."));
    }

    #[test]
    fn a_thinking_only_last_row_has_no_answer() {
        let t = tail(&[
            prompt(P1, "x"),
            assistant("m1", json!({"type":"thinking","thinking":"..."})),
        ]);
        assert_eq!(final_answer(&t, P1, &fp("")), Err(Reject::NoAnswer));
    }

    fn marker(id: &str) -> String {
        json!({"type":"user","promptId":id,"isSidechain":false,
               "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}})
        .to_string()
    }

    #[test]
    fn an_esc_marker_after_the_prompt_is_an_interruption() {
        let t = tail(&[prompt(P1, "x"), text("m1", "Ich fange an."), marker(P1)]);
        assert_eq!(interrupted(&t, P1), Ok(true));
        // Tool-use variant, with no promptId on the marker row.
        let tool = json!({"type":"user","message":{"content":[
            {"type":"text","text":"[Request interrupted by user for tool use]"}]}})
        .to_string();
        let t = tail(&[prompt(P1, "x"), tool_result(P1), tool]);
        assert_eq!(interrupted(&t, P1), Ok(true));
    }

    #[test]
    fn an_answer_after_the_marker_or_no_marker_is_no_interruption() {
        let t = tail(&[prompt(P1, "x"), text("m1", "Fertig.")]);
        assert_eq!(interrupted(&t, P1), Ok(false));
        let t = tail(&[prompt(P1, "x"), marker(P1), text("m1", "Weiter.")]);
        assert_eq!(interrupted(&t, P1), Ok(false));
        let t = tail(&[prompt(P1, "x"), marker(P1), prompt(P2, "neu")]);
        assert_eq!(interrupted(&t, P1), Err(Reject::Superseded));
        assert_eq!(interrupted(&tail(&[marker(P2)]), P1), Err(Reject::NoAnchor));
        assert_eq!(interrupted("nope\n", P1), Err(Reject::Schema));
    }

    #[test]
    fn unknown_shapes_fail_closed() {
        let t = format!("{}\nnot json\n", prompt(P1, "x"));
        assert_eq!(final_answer(&t, P1, &fp("x")), Err(Reject::Schema));
        assert_eq!(final_answer("[1]\n", P1, &fp("x")), Err(Reject::Schema));
    }
}
