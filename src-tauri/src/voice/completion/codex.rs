//! Codex rollout → the final answer of ONE turn (SWA-71). Pure, like
//! `claude.rs`: takes the tail of the rollout JSONL as text.
//!
//! The turn is pinned by `turn_id`, which Codex puts on every hook payload
//! and on the rollout's `event_msg task_started` row that opens the turn. A
//! later `task_started` of another turn means this one is over (superseded).
//!
//! Codex runs the Stop hook BEFORE it writes `task_complete`, so at that
//! moment the answer exists only as the turn's last assistant `message` row
//! (`phase: final_answer`); `task_complete.last_agent_message` follows a few
//! milliseconds later. Either counts, and both must match the hook's
//! fingerprint byte for byte (Codex hands the hook `last_assistant_message`).

use serde_json::Value;

use super::claude::Reject;
use super::Fingerprint;

fn payload_type(row: &Value) -> Option<&str> {
    row.pointer("/payload/type").and_then(Value::as_str)
}

fn is_event(row: &Value, kind: &str) -> bool {
    row.get("type").and_then(Value::as_str) == Some("event_msg") && payload_type(row) == Some(kind)
}

fn turn_id(row: &Value) -> Option<&str> {
    row.pointer("/payload/turn_id").and_then(Value::as_str)
}

/// The `output_text` blocks of an assistant message row, as Codex joins
/// them. One block is the norm; several are tried both ways below.
fn assistant_texts(row: &Value) -> Option<Vec<&str>> {
    if row.get("type").and_then(Value::as_str) != Some("response_item")
        || payload_type(row) != Some("message")
        || row.pointer("/payload/role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    let blocks = row.pointer("/payload/content")?.as_array()?;
    let text: Vec<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    (!text.is_empty()).then_some(text)
}

fn rows(tail: &str) -> Result<Vec<Value>, Reject> {
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
    Ok(rows)
}

/// `tail` holds complete lines only. Returns the final answer of `turn`.
pub fn final_answer(tail: &str, turn: &str, expected: &Fingerprint) -> Result<String, Reject> {
    let rows = rows(tail)?;
    let anchor = rows
        .iter()
        .rposition(|r| is_event(r, "task_started") && turn_id(r) == Some(turn))
        .ok_or(Reject::NoAnchor)?;
    let after = &rows[anchor + 1..];
    if after
        .iter()
        .any(|r| is_event(r, "task_started") && turn_id(r).is_some_and(|t| t != turn))
    {
        return Err(Reject::Superseded);
    }
    let matches = |t: &str| Fingerprint::of(t) == *expected;
    if let Some(done) = after
        .iter()
        .find(|r| is_event(r, "task_complete") && turn_id(r) == Some(turn))
    {
        if let Some(text) = done
            .pointer("/payload/last_agent_message")
            .and_then(Value::as_str)
            .filter(|t| matches(t))
        {
            return Ok(text.to_owned());
        }
    }
    let last = after
        .iter()
        .rev()
        .find_map(assistant_texts)
        .ok_or(Reject::NoAnswer)?;
    [last.concat(), last.join("\n")]
        .into_iter()
        .find(|t| matches(t))
        .ok_or(Reject::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Row shapes of a Codex 0.163 rollout (keys as written, text synthetic).
    const T1: &str = "01a14f4f-9954-7f81-83d0-1c6c6065dd0b";
    const T2: &str = "01a14f50-1997-7021-ab71-85d5dde4a71e";

    fn started(turn: &str) -> String {
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}).to_string()
    }
    fn user(text: &str) -> String {
        json!({"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":text}]}})
        .to_string()
    }
    fn assistant(texts: &[&str]) -> String {
        let content: Vec<Value> = texts
            .iter()
            .map(|t| json!({"type":"output_text","text":t}))
            .collect();
        json!({"type":"response_item","payload":{"type":"message","role":"assistant",
            "phase":"final_answer","content":content}})
        .to_string()
    }
    fn complete(turn: &str, last: Option<&str>) -> String {
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,
            "last_agent_message":last}})
        .to_string()
    }
    fn noise(turn: &str) -> String {
        json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":turn}}).to_string()
    }
    fn tail(rows: &[String]) -> String {
        rows.iter().map(|r| format!("{r}\n")).collect()
    }
    fn fp(s: &str) -> Fingerprint {
        Fingerprint::of(s)
    }

    #[test]
    fn at_stop_time_the_last_assistant_row_is_the_answer() {
        let t = tail(&[
            started(T1),
            user("hi"),
            noise(T1),
            assistant(&["Zwischenstand."]),
            assistant(&["Fertig."]),
        ]);
        assert_eq!(
            final_answer(&t, T1, &fp("Fertig.")).as_deref(),
            Ok("Fertig.")
        );
    }

    #[test]
    fn task_complete_counts_once_it_is_written() {
        let t = tail(&[
            started(T1),
            assistant(&["Fertig."]),
            complete(T1, Some("Fertig.")),
        ]);
        assert_eq!(
            final_answer(&t, T1, &fp("Fertig.")).as_deref(),
            Ok("Fertig.")
        );
        // A null last_agent_message falls back to the message row.
        let t = tail(&[started(T1), assistant(&["Fertig."]), complete(T1, None)]);
        assert_eq!(
            final_answer(&t, T1, &fp("Fertig.")).as_deref(),
            Ok("Fertig.")
        );
    }

    #[test]
    fn several_blocks_match_either_join() {
        let t = tail(&[started(T1), assistant(&["Eins.", "Zwei."])]);
        assert!(final_answer(&t, T1, &fp("Eins.Zwei.")).is_ok());
        assert!(final_answer(&t, T1, &fp("Eins.\nZwei.")).is_ok());
    }

    #[test]
    fn another_turn_is_never_this_ones_answer() {
        // Turn 2 started, not answered yet: turn 1's answer is not taken.
        let t = tail(&[started(T1), assistant(&["A"]), started(T2)]);
        assert_eq!(final_answer(&t, T2, &fp("A")), Err(Reject::NoAnswer));
        assert_eq!(final_answer(&t, T1, &fp("A")), Err(Reject::Superseded));
        let t = tail(&[started(T1), assistant(&["Alt."])]);
        assert_eq!(final_answer(&t, T1, &fp("Neu.")), Err(Reject::Mismatch));
        assert_eq!(final_answer(&t, T2, &fp("Alt.")), Err(Reject::NoAnchor));
    }

    #[test]
    fn unknown_shapes_fail_closed() {
        let t = format!("{}\nnot json\n", started(T1));
        assert_eq!(final_answer(&t, T1, &fp("x")), Err(Reject::Schema));
        assert_eq!(final_answer("[1]\n", T1, &fp("x")), Err(Reject::Schema));
    }
}
