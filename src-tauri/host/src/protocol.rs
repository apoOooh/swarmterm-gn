//! JSON envelope of the host protocol (ADR 0001), `v:1`.
//!
//! Request: `{"v":1,"id":<n>,"op":"<op>",...}`; answer: `{"v":1,"id":<n>,
//! "ok":true,...}` or `{"v":1,"id":<n>,"ok":false,"reason":"<reason>"}`;
//! event: `{"v":1,"event":"<name>",...}`. The first request of a connection
//! must be `hello` with the token from `host-endpoint.json`; it negotiates
//! `proto` and lists capabilities, as the voice pipe does since SWA-40, so a
//! newer app can tell what an older host (still running after an update)
//! understands. Unknown ops answer `unknown-op` without closing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u64 = 1;
/// Protocol revisions this host speaks; `hello` picks the highest shared one.
pub const PROTOS: &[u32] = &[1];
/// Feature flags reported by `hello`.
pub const CAPABILITIES: &[&str] = &[
    "app-state",
    "attach",
    "binary-data",
    "flow-control",
    "write-checked",
];
/// Capability a CLIENT announces in its `hello` when its renderer acks
/// parsed output (`ack`). Only such a client's panes are flow-gated; an
/// older app never acks, and gating it would stall every pane.
pub const FLOW_CONTROL: &str = "flow-control";
/// Upper bound for one `set_app_state` payload: it is a handful of numbers
/// (the MCP port), not a store.
pub const MAX_APP_STATE: usize = 4096;

/// Everything a pane needs to start, fully resolved by the app. The host does
/// not know about accounts, MCP URLs, Codex isolation or shell discovery:
/// those stay in the app (ADR 0001, "App keeps"), so the host's attack
/// surface is "spawn exactly this", and a protocol change in any of them
/// never needs a host update.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpec {
    pub terminal_id: String,
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The complete environment. The host clears its own first, so a pane
    /// never inherits whatever the host happened to be started with. The
    /// app must therefore send everything a shell needs, not just its own
    /// additions: without `SystemRoot`, `PATH`, `PATHEXT`, `ComSpec` & co.
    /// cmd and PowerShell start broken (phase 2: the app's `std::env::vars()`
    /// plus the variables `spawn_terminal` adds today).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Written right after the generation is registered (template command).
    #[serde(default)]
    pub initial_input: Option<String>,
    /// Opaque app data (agent, worktree mode, repo root, …) returned by
    /// `list`, so a restarted app can rebuild its mirror without a lookup.
    #[serde(default)]
    pub meta: Value,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Hello {
        token: String,
        #[serde(default)]
        proto: Vec<u32>,
        /// What the client supports (`flow-control`); absent = nothing.
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Create(CreateSpec),
    #[serde(rename_all = "camelCase")]
    Write {
        terminal_id: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    WriteChecked {
        terminal_id: String,
        spawn_id: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    Kill {
        terminal_id: String,
    },
    List,
    #[serde(rename_all = "camelCase")]
    Attach {
        terminal_id: String,
    },
    /// Facts a restarted app needs back (SWA-56: the MCP port its panes'
    /// `SWARMTERM_MCP_URL` points at). Merged; `hello` returns them.
    SetAppState {
        state: serde_json::Map<String, Value>,
    },
    /// The renderer parsed `bytes` more of this generation's output (perf
    /// phase 2). Never answered: acks are frequent and nothing waits on them.
    #[serde(rename_all = "camelCase")]
    Ack {
        terminal_id: String,
        spawn_id: String,
        bytes: u64,
    },
}

const KNOWN_OPS: &[&str] = &[
    "hello",
    "create",
    "write",
    "write_checked",
    "resize",
    "kill",
    "list",
    "attach",
    "set_app_state",
    "ack",
];

#[derive(Debug, PartialEq)]
pub struct Request {
    pub id: u64,
    pub op: Op,
}

/// Why a frame could not become a `Request`. `id` is echoed when it was
/// readable, so the client can fail the matching call instead of timing out.
#[derive(Debug, PartialEq)]
pub struct ParseError {
    pub id: Option<u64>,
    pub reason: &'static str,
}

pub fn parse(payload: &[u8]) -> Result<Request, ParseError> {
    let bad = |id| ParseError {
        id,
        reason: "bad-request",
    };
    let value: Value = serde_json::from_slice(payload).map_err(|_| bad(None))?;
    let obj = value.as_object().ok_or(bad(None))?;
    let id = obj.get("id").and_then(Value::as_u64);
    if obj.get("v").and_then(Value::as_u64) != Some(VERSION) {
        return Err(ParseError {
            id,
            reason: "unsupported-version",
        });
    }
    let id = id.ok_or(bad(None))?;
    let op_name = obj.get("op").and_then(Value::as_str).ok_or(bad(Some(id)))?;
    if !KNOWN_OPS.contains(&op_name) {
        return Err(ParseError {
            id: Some(id),
            reason: "unknown-op",
        });
    }
    let op = Op::deserialize(&value).map_err(|_| bad(Some(id)))?;
    Ok(Request { id, op })
}

/// Highest protocol revision both sides speak.
pub fn negotiate(offered: &[u32]) -> Option<u32> {
    // An empty offer is a client from before negotiation existed: proto 1.
    if offered.is_empty() {
        return PROTOS.contains(&1).then_some(1);
    }
    PROTOS.iter().copied().filter(|p| offered.contains(p)).max()
}

pub fn ok(id: u64, fields: Value) -> Vec<u8> {
    let mut obj = serde_json::json!({ "v": VERSION, "id": id, "ok": true });
    if let (Some(dst), Value::Object(src)) = (obj.as_object_mut(), fields) {
        dst.extend(src);
    }
    obj.to_string().into_bytes()
}

pub fn err(id: Option<u64>, reason: &str) -> Vec<u8> {
    serde_json::json!({ "v": VERSION, "id": id, "ok": false, "reason": reason })
        .to_string()
        .into_bytes()
}

/// Lifecycle events. `exit` is sent only after every `data` frame of that
/// generation, and `removed` before `exit`, so a client that respawns on
/// `exit` always finds the id free (same rule as `read_loop` in the app).
/// `removed` does NOT end the data of that generation: a killed pane keeps
/// flushing until its reader sees EOF, possibly after a same-id respawn.
/// Data frames carry the spawn id; clients drop frames whose spawn id is not
/// the one they currently track for that terminal.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Spawned {
        terminal_id: String,
        spawn_id: String,
        pid: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Removed {
        terminal_id: String,
        spawn_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Exit {
        terminal_id: String,
        spawn_id: String,
        exit_code: i32,
    },
}

impl Event {
    pub fn to_json(&self) -> Vec<u8> {
        let mut v = serde_json::to_value(self).expect("event serialises");
        v.as_object_mut()
            .expect("tagged enum is an object")
            .insert("v".into(), VERSION.into());
        v.to_string().into_bytes()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub spawn_id: String,
    pub pid: Option<u32>,
    pub cwd: String,
    pub meta: Value,
    pub cols: u16,
    pub rows: u16,
    /// Output bytes ever produced; `attach` replays at most the ring size.
    pub output_total: u64,
}

/// Answer facts of `attach`. The replay that follows was produced at
/// `cols`x`rows`; `truncated` = older output was dropped (or skipped).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub spawn_id: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub replay_bytes: usize,
    pub output_total: u64,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(v: Value) -> Result<Request, ParseError> {
        parse(v.to_string().as_bytes())
    }

    #[test]
    fn parses_create_with_defaults() {
        let r = req(json!({
            "v": 1, "id": 7, "op": "create",
            "terminalId": "t1", "shell": "cmd.exe", "cwd": "C:\\", "cols": 80, "rows": 24
        }))
        .unwrap();
        assert_eq!(r.id, 7);
        let Op::Create(spec) = r.op else {
            panic!("not create")
        };
        assert_eq!(spec.terminal_id, "t1");
        assert!(spec.args.is_empty() && spec.env.is_empty());
        assert_eq!(spec.initial_input, None);
        assert_eq!(spec.meta, Value::Null);
    }

    #[test]
    fn parses_ack_and_hello_capabilities() {
        let r = req(json!({
            "v": 1, "id": 3, "op": "ack", "terminalId": "t", "spawnId": "g", "bytes": 65536
        }))
        .unwrap();
        assert_eq!(
            r.op,
            Op::Ack {
                terminal_id: "t".into(),
                spawn_id: "g".into(),
                bytes: 65536,
            }
        );
        // An older app's hello has no capabilities: it must not be gated.
        let old = req(json!({"v": 1, "id": 0, "op": "hello", "token": "x"})).unwrap();
        assert!(matches!(old.op, Op::Hello { capabilities, .. } if capabilities.is_empty()));
        let new = req(json!({
            "v": 1, "id": 0, "op": "hello", "token": "x", "capabilities": [FLOW_CONTROL]
        }))
        .unwrap();
        assert!(matches!(new.op, Op::Hello { capabilities, .. } if capabilities == [FLOW_CONTROL]));
        assert!(CAPABILITIES.contains(&FLOW_CONTROL));
    }

    #[test]
    fn parses_write_checked_in_camel_case() {
        let r = req(json!({
            "v": 1, "id": 1, "op": "write_checked",
            "terminalId": "t", "spawnId": "g", "data": "ls\r"
        }))
        .unwrap();
        assert_eq!(
            r.op,
            Op::WriteChecked {
                terminal_id: "t".into(),
                spawn_id: "g".into(),
                data: "ls\r".into()
            }
        );
    }

    #[test]
    fn parses_set_app_state() {
        let r = req(json!({"v": 1, "id": 2, "op": "set_app_state", "state": {"mcpPort": 5000}}))
            .unwrap();
        let Op::SetAppState { state } = r.op else {
            panic!("not set_app_state")
        };
        assert_eq!(state.get("mcpPort"), Some(&json!(5000)));
        assert!(req(json!({"v": 1, "id": 2, "op": "set_app_state", "state": 5})).is_err());
    }

    #[test]
    fn unknown_op_keeps_the_id() {
        assert_eq!(
            req(json!({"v": 1, "id": 3, "op": "exec"})),
            Err(ParseError {
                id: Some(3),
                reason: "unknown-op"
            })
        );
    }

    #[test]
    fn wrong_version_is_refused() {
        assert_eq!(
            req(json!({"v": 2, "id": 3, "op": "list"}))
                .unwrap_err()
                .reason,
            "unsupported-version"
        );
    }

    #[test]
    fn missing_fields_are_bad_requests_with_id() {
        assert_eq!(
            req(json!({"v": 1, "id": 4, "op": "resize", "terminalId": "t"})),
            Err(ParseError {
                id: Some(4),
                reason: "bad-request"
            })
        );
    }

    #[test]
    fn garbage_is_a_bad_request() {
        assert_eq!(parse(b"not json").unwrap_err().reason, "bad-request");
        assert_eq!(parse(b"[1]").unwrap_err().reason, "bad-request");
    }

    #[test]
    fn negotiate_picks_the_shared_maximum() {
        assert_eq!(negotiate(&[1, 2, 3]), Some(1));
        assert_eq!(negotiate(&[]), Some(1));
        assert_eq!(negotiate(&[2]), None);
    }

    #[test]
    fn answers_carry_envelope_and_fields() {
        let v: Value = serde_json::from_slice(&ok(5, json!({"pid": 9}))).unwrap();
        assert_eq!(v, json!({"v": 1, "id": 5, "ok": true, "pid": 9}));
        let v: Value = serde_json::from_slice(&err(None, "bad-request")).unwrap();
        assert_eq!(
            v,
            json!({"v": 1, "id": null, "ok": false, "reason": "bad-request"})
        );
    }

    #[test]
    fn events_are_tagged_and_versioned() {
        let v: Value = serde_json::from_slice(
            &Event::Exit {
                terminal_id: "t".into(),
                spawn_id: "g".into(),
                exit_code: 0,
            }
            .to_json(),
        )
        .unwrap();
        assert_eq!(
            v,
            json!({"v": 1, "event": "exit", "terminalId": "t", "spawnId": "g", "exitCode": 0})
        );
    }
}
