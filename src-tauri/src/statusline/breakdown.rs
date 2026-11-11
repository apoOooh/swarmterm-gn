//! The Detailed template's extra rows (SWA-92), ported from the user's skill
//! line: subagent count and estimated cost, and stacked in/out/tools bars from
//! the session transcript.
//!
//! Claude Code re-runs the status line every few seconds, so the transcript is
//! read incrementally: a small state file in the temp dir keeps the byte
//! offset and the running sums (`<tmp>/swarmterm-statusline-<session>.json`).
//! Only whole lines are consumed. Numbers here are estimates — subagent cost
//! from a fixed price table, token shares from characters / 4 — and the UI
//! says so. Every failure drops the rows; it never breaks the line.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub offset: u64,
    /// message id → [input, cache write, cache read, output]
    pub usage: BTreeMap<String, [u64; 4]>,
    pub text_chars: u64,
    pub call_chars: u64,
    /// tool name → result characters
    pub results: BTreeMap<String, u64>,
    /// tool_use id → tool name, until its result arrives
    pub pending: BTreeMap<String, String>,
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn state_path(session: &str) -> PathBuf {
    std::env::temp_dir().join(format!("swarmterm-statusline-{}.json", safe_name(session)))
}

/// Fold complete JSONL lines into the state.
pub fn fold(st: &mut State, text: &str) {
    for line in text.lines() {
        let asst = line.contains("\"usage\"");
        let res = line.contains("\"tool_result\"");
        if !asst && !res {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(m) = rec.get("message") else {
            continue;
        };
        let content = m.get("content").and_then(Value::as_array);
        match rec.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                if let (Some(id), Some(u)) = (m.get("id").and_then(Value::as_str), m.get("usage")) {
                    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                    st.usage.insert(
                        id.to_string(),
                        [
                            n("input_tokens"),
                            n("cache_creation_input_tokens"),
                            n("cache_read_input_tokens"),
                            n("output_tokens"),
                        ],
                    );
                }
                for b in content.into_iter().flatten() {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            st.text_chars += b
                                .get("text")
                                .and_then(Value::as_str)
                                .map_or(0, |t| t.chars().count() as u64);
                        }
                        Some("tool_use") => {
                            st.call_chars +=
                                b.get("input").map_or(2, |i| i.to_string().len() as u64);
                            if let Some(id) = b.get("id").and_then(Value::as_str) {
                                let name = b.get("name").and_then(Value::as_str).unwrap_or("other");
                                st.pending.insert(id.to_string(), name.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for b in content.into_iter().flatten() {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let name = st.pending.remove(id).unwrap_or_else(|| "other".into());
                    let len = match b.get("content") {
                        Some(Value::String(s)) => s.chars().count() as u64,
                        Some(Value::Array(a)) => a
                            .iter()
                            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                            .filter_map(|c| c.get("text").and_then(Value::as_str))
                            .map(|t| t.chars().count() as u64)
                            .sum(),
                        _ => 0,
                    };
                    *st.results.entry(name).or_default() += len;
                }
            }
            _ => {}
        }
    }
}

/// Read what the transcript gained since the saved offset. A shorter file
/// (rewritten / compacted) starts over.
pub fn update(transcript: &Path, state_file: &Path) -> Option<State> {
    let mut st: State = std::fs::read_to_string(state_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut f = std::fs::File::open(transcript).ok()?;
    let size = f.metadata().ok()?.len();
    if size < st.offset {
        st = State::default();
    }
    if size > st.offset {
        f.seek(SeekFrom::Start(st.offset)).ok()?;
        let mut buf = Vec::with_capacity((size - st.offset) as usize);
        f.take(size - st.offset).read_to_end(&mut buf).ok()?;
        if let Some(end) = buf.iter().rposition(|&b| b == b'\n') {
            fold(&mut st, &String::from_utf8_lossy(&buf[..=end]));
            st.offset += end as u64 + 1;
            if let Ok(json) = serde_json::to_vec(&st) {
                let tmp = state_file.with_extension(format!("{}.tmp", std::process::id()));
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, state_file);
                }
            }
        }
    }
    Some(st)
}

/// One stacked bar: label, parts (name, value), shown total.
#[derive(Debug, Clone, PartialEq)]
pub struct Bar {
    pub label: &'static str,
    pub parts: Vec<(String, f64)>,
    pub shown: u64,
}

pub fn bars(st: &State) -> Vec<Bar> {
    if st.usage.is_empty() {
        return Vec::new();
    }
    let (mut i, mut w, mut r, mut o) = (0u64, 0u64, 0u64, 0u64);
    for u in st.usage.values() {
        i += u[0];
        w += u[1];
        r += u[2];
        o += u[3];
    }
    let mut out = vec![Bar {
        label: "in",
        parts: vec![
            ("cached".into(), r as f64),
            ("written".into(), w as f64),
            ("new".into(), i as f64),
        ],
        shown: i + w + r,
    }];
    let (mut text, mut call) = (st.text_chars as f64 / 4.0, st.call_chars as f64 / 4.0);
    if text + call > o as f64 && text + call > 0.0 {
        let k = o as f64 / (text + call);
        text *= k;
        call *= k;
    }
    let think = (o as f64 - text - call).max(0.0);
    out.push(Bar {
        label: "out",
        parts: vec![
            ("think".into(), think),
            ("calls".into(), call),
            ("text".into(), text),
        ],
        shown: o,
    });
    let mut tools: Vec<_> = st.results.iter().filter(|(_, v)| **v > 0).collect();
    tools.sort_by(|a, b| b.1.cmp(a.1));
    if !tools.is_empty() {
        let mut parts: Vec<(String, f64)> = tools
            .iter()
            .take(3)
            .map(|(n, v)| ((*n).clone(), **v as f64 / 4.0))
            .collect();
        if tools.len() > 3 {
            parts.push((
                "other".into(),
                tools[3..].iter().map(|(_, v)| **v as f64 / 4.0).sum(),
            ));
        }
        let total = parts.iter().map(|p| p.1).sum::<f64>();
        out.push(Bar {
            label: "tools",
            parts,
            shown: total.round() as u64,
        });
    }
    out
}

/// Cells per part for a stacked bar of `width`: largest-remainder rounding,
/// every part of ≥ 1 % gets at least one cell, the sum is exactly `width`.
pub fn cells(parts: &[f64], width: usize) -> Vec<usize> {
    let total: f64 = parts.iter().sum();
    if total <= 0.0 || parts.is_empty() {
        return vec![0; parts.len()];
    }
    let mut c: Vec<(usize, f64)> = parts
        .iter()
        .map(|v| {
            let exact = v / total * width as f64;
            let f = exact.floor() as usize;
            (
                if f == 0 && v / total >= 0.01 { 1 } else { f },
                exact - exact.floor(),
            )
        })
        .collect();
    let mut sum: usize = c.iter().map(|x| x.0).sum();
    let mut order: Vec<usize> = (0..c.len()).collect();
    order.sort_by(|&a, &b| {
        c[b].1
            .partial_cmp(&c[a].1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut k = 0;
    while sum < width {
        c[order[k % order.len()]].0 += 1;
        sum += 1;
        k += 1;
    }
    while sum > width {
        let big = (0..c.len()).max_by_key(|&i| c[i].0).unwrap_or(0);
        c[big].0 -= 1;
        sum -= 1;
    }
    c.into_iter().map(|x| x.0).collect()
}

// ---------- Subagents ----------

/// $/MTok (input, output, cache read) by model family; first match wins.
const PRICES: &[(&str, f64, f64, f64)] = &[
    ("fable", 10.0, 50.0, 0.25),
    ("opus-5-5", 4.0, 20.0, 0.2),
    ("opus", 5.0, 25.0, 0.5),
    ("sonnet-5", 2.0, 10.0, 0.2),
    ("sonnet", 3.0, 15.0, 0.3),
    ("haiku", 1.0, 5.0, 0.1),
];

fn price(model: &str) -> (f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    PRICES
        .iter()
        .find(|(k, ..)| m.contains(k))
        .map(|&(_, i, o, r)| (i, o, r))
        .unwrap_or((4.0, 20.0, 0.2))
}

/// (tokens, estimated USD) of one subagent transcript, deduplicated by message id.
pub fn agent_cost(text: &str) -> (u64, f64) {
    let mut msgs: BTreeMap<String, Value> = BTreeMap::new();
    for line in text.lines().filter(|l| l.contains("\"usage\"")) {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(m) = v.get("message") {
                if let (Some(id), true) = (
                    m.get("id").and_then(Value::as_str),
                    m.get("usage").is_some(),
                ) {
                    msgs.insert(id.to_string(), m.clone());
                }
            }
        }
    }
    let (mut tokens, mut cost) = (0u64, 0.0);
    for m in msgs.values() {
        let u = &m["usage"];
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let (inp, cw, cr, out) = (
            n("input_tokens"),
            n("cache_creation_input_tokens"),
            n("cache_read_input_tokens"),
            n("output_tokens"),
        );
        let c1h = u
            .pointer("/cache_creation/ephemeral_1h_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let c5m = cw.saturating_sub(c1h);
        let (pi, po, pr) = price(m.get("model").and_then(Value::as_str).unwrap_or(""));
        tokens += inp + cw + out;
        cost += (inp as f64 * pi
            + c5m as f64 * pi * 1.25
            + c1h as f64 * pi * 2.0
            + cr as f64 * pr
            + out as f64 * po)
            / 1e6;
    }
    (tokens, cost)
}

/// (count, tokens, USD) over `<transcript without .jsonl>/subagents/agent-*.jsonl`.
pub fn agents(transcript: &Path) -> Option<(usize, u64, f64)> {
    let dir = transcript.with_extension("").join("subagents");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Some((0, 0, 0.0));
    };
    let (mut n, mut tokens, mut cost) = (0, 0, 0.0);
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("agent-") && name.ends_with(".jsonl")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let (t, c) = agent_cost(&text);
        n += 1;
        tokens += t;
        cost += c;
    }
    Some((n, tokens, cost))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript() -> String {
        [
            r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":1200,"cache_creation_input_tokens":30000,"cache_read_input_tokens":90000,"output_tokens":4000},"content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"f":"a"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"yyyyyyyy"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":1200,"cache_creation_input_tokens":30000,"cache_read_input_tokens":90000,"output_tokens":4000},"content":[]}}"#,
        ]
        .join("\n")
            + "\n"
    }

    #[test]
    fn fold_dedupes_messages_and_attributes_results() {
        let mut st = State::default();
        fold(&mut st, &transcript());
        assert_eq!(st.usage.len(), 1);
        assert_eq!(st.text_chars, 5);
        assert_eq!(st.results.get("Read"), Some(&8));
        assert!(st.pending.is_empty());
    }

    #[test]
    fn update_reads_incrementally_and_restarts_on_shrink() {
        let dir = tempfile::tempdir().unwrap();
        let t = dir.path().join("s.jsonl");
        let sf = dir.path().join("state.json");
        let text = transcript();
        let (a, b) = text.split_at(text.find('\n').unwrap() + 1);
        std::fs::write(&t, format!("{a}{}", &b[..10])).unwrap(); // half a line
        let st = update(&t, &sf).unwrap();
        assert_eq!(st.offset, a.len() as u64, "only whole lines are consumed");
        std::fs::write(&t, &text).unwrap();
        let st = update(&t, &sf).unwrap();
        assert_eq!(st.offset, text.len() as u64);
        assert_eq!(st.results.get("Read"), Some(&8));
        std::fs::write(&t, a).unwrap();
        assert_eq!(update(&t, &sf).unwrap().offset, a.len() as u64);
    }

    #[test]
    fn bars_sum_input_and_split_output() {
        let mut st = State::default();
        fold(&mut st, &transcript());
        let b = bars(&st);
        assert_eq!(b[0].shown, 121_200);
        assert_eq!(b[1].shown, 4000);
        assert_eq!(b[2].label, "tools");
    }

    #[test]
    fn cells_fill_the_width_exactly() {
        assert_eq!(cells(&[3.0, 1.0], 8), vec![6, 2]);
        assert_eq!(cells(&[1000.0, 1.0, 0.0], 10).iter().sum::<usize>(), 10);
        assert_eq!(cells(&[0.0, 0.0], 8), vec![0, 0]);
        assert_eq!(cells(&[99.0, 1.5], 8)[1], 1, "≥ 1 % keeps one cell");
    }

    #[test]
    fn agent_cost_uses_the_price_table() {
        let t = r#"{"message":{"id":"a","model":"claude-haiku-5-5","usage":{"input_tokens":1000000,"output_tokens":0}}}"#;
        let (tok, cost) = agent_cost(t);
        assert_eq!(tok, 1_000_000);
        assert!((cost - 1.0).abs() < 1e-9);
    }

    #[test]
    fn agents_counts_subagent_files() {
        let dir = tempfile::tempdir().unwrap();
        let t = dir.path().join("sess.jsonl");
        assert_eq!(agents(&t), Some((0, 0, 0.0)));
        let sub = dir.path().join("sess").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("agent-1.jsonl"),
            r#"{"message":{"id":"a","model":"x","usage":{"input_tokens":10}}}"#,
        )
        .unwrap();
        std::fs::write(sub.join("other.txt"), "").unwrap();
        assert_eq!(agents(&t).unwrap().0, 1);
    }
}
