//! Wire format of the voice pipe (SWA-12): one JSON object per line, both
//! ways. Pure — parsing, auth and limits are unit-tested here so the pipe
//! glue stays thin.
//!
//! Every request carries `v` and the per-launch `token` from the discovery
//! file. Three ops exist and nothing else: `begin` pins the pane that owns
//! the keyboard, `insert` writes a draft into a pinned pane, `cancel` drops
//! a pin. No op runs a command — the pipe can type text, never execute it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u64 = 1;
/// Longest accepted request line, enforced while reading (not after).
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Longest dictated text; anything longer is not dictation.
pub const MAX_TEXT_CHARS: usize = 32 * 1024;
const MAX_ID_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Begin {
        request_id: String,
    },
    Insert {
        request_id: String,
        pin: String,
        text: String,
        submit: bool,
    },
    Cancel {
        pin: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Op {
    #[serde(rename_all = "camelCase")]
    Begin {
        request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Insert {
        request_id: String,
        pin: String,
        text: String,
        #[serde(default)]
        submit: bool,
    },
    Cancel {
        pin: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub v: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit_scheduled: Option<bool>,
}

impl Response {
    pub fn ok(request_id: Option<String>) -> Self {
        Self {
            v: VERSION,
            request_id,
            ok: true,
            ..Default::default()
        }
    }
    pub fn err(request_id: Option<String>, reason: &str) -> Self {
        Self {
            v: VERSION,
            request_id,
            ok: false,
            reason: Some(reason.to_owned()),
            ..Default::default()
        }
    }
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// Compare without an early exit, so response timing does not leak how many
/// leading token characters were right.
pub fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8 | u8::from(a.len() != b.len());
    for (i, &e) in b.iter().enumerate() {
        diff |= a.get(i).copied().unwrap_or(0) ^ e;
    }
    diff == 0
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parse and authenticate one line. Errors are the `reason` sent back.
pub fn parse(line: &str, token: &str) -> Result<Request, &'static str> {
    if line.len() > MAX_LINE_BYTES {
        return Err("too-large");
    }
    let mut obj = match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(obj)) => obj,
        _ => return Err("bad-request"),
    };
    if obj.remove("v").and_then(|v| v.as_u64()) != Some(VERSION) {
        return Err("unsupported-version");
    }
    let given = obj.remove("token");
    if !given
        .as_ref()
        .and_then(Value::as_str)
        .is_some_and(|t| token_matches(t, token))
    {
        return Err("unauthorized");
    }
    let op: Op = serde_json::from_value(Value::Object(obj)).map_err(|_| "bad-request")?;
    let req = match op {
        Op::Begin { request_id } => Request::Begin { request_id },
        Op::Insert {
            request_id,
            pin,
            text,
            submit,
        } => Request::Insert {
            request_id,
            pin,
            text,
            submit,
        },
        Op::Cancel { pin } => Request::Cancel { pin },
    };
    match &req {
        Request::Begin { request_id } if !valid_id(request_id) => Err("bad-request"),
        Request::Insert {
            request_id,
            pin,
            text,
            ..
        } => {
            if !valid_id(request_id) || !valid_id(pin) {
                Err("bad-request")
            } else if text.chars().count() > MAX_TEXT_CHARS {
                Err("too-large")
            } else if text.trim().is_empty() {
                Err("empty")
            } else {
                Ok(req)
            }
        }
        Request::Cancel { pin } if !valid_id(pin) => Err("bad-request"),
        _ => Ok(req),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "secret-token";

    #[test]
    fn parses_the_three_ops() {
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"begin","requestId":"r1"}"#,
                TOKEN
            ),
            Ok(Request::Begin {
                request_id: "r1".into()
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"insert","requestId":"r2","pin":"p1","text":"hi"}"#,
                TOKEN
            ),
            Ok(Request::Insert {
                request_id: "r2".into(),
                pin: "p1".into(),
                text: "hi".into(),
                submit: false
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"cancel","pin":"p1"}"#,
                TOKEN
            ),
            Ok(Request::Cancel { pin: "p1".into() })
        );
    }

    #[test]
    fn rejects_wrong_or_missing_token_before_anything_else() {
        let line = r#"{"v":1,"token":"secret-tokeX","op":"begin","requestId":"r1"}"#;
        assert_eq!(parse(line, TOKEN), Err("unauthorized"));
        assert_eq!(
            parse(r#"{"v":1,"op":"begin","requestId":"r1"}"#, TOKEN),
            Err("unauthorized")
        );
        assert!(!token_matches("secret-token-longer", TOKEN));
        assert!(!token_matches("", TOKEN));
    }

    #[test]
    fn rejects_unknown_ops_fields_and_versions() {
        let run = r#"{"v":1,"token":"secret-token","op":"run","cmd":"calc"}"#;
        assert_eq!(parse(run, TOKEN), Err("bad-request"));
        let extra = r#"{"v":1,"token":"secret-token","op":"begin","requestId":"r1","shell":true}"#;
        assert_eq!(parse(extra, TOKEN), Err("bad-request"));
        let v2 = r#"{"v":2,"token":"secret-token","op":"begin","requestId":"r1"}"#;
        assert_eq!(parse(v2, TOKEN), Err("unsupported-version"));
        assert_eq!(parse("not json", TOKEN), Err("bad-request"));
    }

    #[test]
    fn enforces_id_shape_and_text_limits() {
        let bad_id = r#"{"v":1,"token":"secret-token","op":"begin","requestId":"a b"}"#;
        assert_eq!(parse(bad_id, TOKEN), Err("bad-request"));
        let empty =
            r#"{"v":1,"token":"secret-token","op":"insert","requestId":"r","pin":"p","text":"  "}"#;
        assert_eq!(parse(empty, TOKEN), Err("empty"));
        let long = format!(
            r#"{{"v":1,"token":"secret-token","op":"insert","requestId":"r","pin":"p","text":"{}"}}"#,
            "a".repeat(MAX_TEXT_CHARS + 1)
        );
        assert_eq!(parse(&long, TOKEN), Err("too-large"));
    }

    #[test]
    fn response_lines_are_compact_json() {
        let line = Response::err(Some("r1".into()), "no-focus").to_line();
        assert_eq!(
            line,
            "{\"v\":1,\"requestId\":\"r1\",\"ok\":false,\"reason\":\"no-focus\"}\n"
        );
    }
}
