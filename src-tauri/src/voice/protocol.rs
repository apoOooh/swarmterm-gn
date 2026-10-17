//! Wire format of the voice pipe (SWA-12): one JSON object per line, both
//! ways. Pure — parsing, auth and limits are unit-tested here so the pipe
//! glue stays thin.
//!
//! Every request carries `v` and the per-launch `token` from the discovery
//! file. These ops exist and nothing else: `hello` negotiates capabilities,
//! `begin` pins the pane that owns the keyboard, `insert` writes a draft into
//! a pinned pane, `cancel` drops a pin. SWA-41 adds `subscribe` (status
//! pushes, see `CAP_TURNS`) and `ping` (keep-alive). SWA-58 adds
//! `read_excerpt` (Swarmterm reads an excerpt aloud itself; the text never
//! crosses the pipe). No op runs a command — the pipe can type text, never
//! execute it.
//!
//! Versioning (SWA-40): the envelope stays `v: 1` so 1.9.0 and older clients
//! keep talking. `proto` lives only inside `hello`; a client that never says
//! hello is proto 1. An unknown op answers `unknown-op` and keeps the
//! connection, so a newer client can probe (1.9.0 answers `bad-request`,
//! which clients must read the same way).
//!
//! On a negotiated connection the server may also push lines. A push carries
//! an `event` key, an answer never does; the client keeps at most one request
//! in flight, so every other line answers that request.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u64 = 1;
/// Protocol generation announced in `hello`. Proto 1 = no hello.
pub const PROTO: u64 = 2;
/// The client holds one connection per dictation; the pinned pane shows a
/// "listening" pill and the server may push `cancelled` on that connection.
pub const CAP_INDICATOR: &str = "indicator";
/// SWA-41: after `subscribe`, the connection is a status feed — the server
/// pushes `turn` events (agent done / needs input) and the client only pings.
/// Kept off the dictation connection so a slow reader never backs up
/// `begin`/`insert`.
pub const CAP_TURNS: &str = "turns";
/// SWA-42: the client accepts a `quit` push and then exits on its own, the
/// same as its tray's Quit. A request to leave, not a command it runs —
/// Settings → Voice uses it to stop or update buzzkey without a kill.
pub const CAP_QUIT: &str = "quit";
/// SWA-66: protocol support only — `turn` pushes carry `ttsHandled` and the
/// `subscribe` answer `ttsOwner`. Whether Swarmterm speaks right now is
/// those fields, never this capability.
pub const CAP_TTS: &str = "tts";
/// SWA-58: this feed also receives `error` turns and `turn_update` kind
/// corrections. Without it a client never sees a kind it does not know.
pub const CAP_TURN_KINDS: &str = "turn-kinds";
/// SWA-58: `turn` pushes carry `completionId` + `hasExcerpt`, and the client
/// may ask Swarmterm to read that excerpt (`read_excerpt`). The excerpt text
/// itself is never sent, with or without this capability.
pub const CAP_EXCERPT_READ: &str = "excerpt-read";
/// What this build offers. Active is the intersection with the client's list.
pub const CAPABILITIES: &[&str] = &[
    CAP_INDICATOR,
    CAP_TURNS,
    CAP_QUIT,
    CAP_TTS,
    CAP_TURN_KINDS,
    CAP_EXCERPT_READ,
];
/// Longest accepted request line, enforced while reading (not after).
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Longest dictated text; anything longer is not dictation. Kept small on
/// purpose: `write_terminal_checked` writes under the global `terminals`
/// lock, and an agent that is not reading stdin can stall a large block.
pub const MAX_TEXT_CHARS: usize = 8 * 1024;
const MAX_ID_LEN: usize = 64;
const MAX_LABEL_CHARS: usize = 64;
const MAX_CAPS: usize = 16;
const MAX_CAP_LEN: usize = 32;
const KNOWN_OPS: &[&str] = &[
    "hello",
    "begin",
    "insert",
    "cancel",
    "subscribe",
    "ping",
    "tts_stop",
    "read_excerpt",
];
/// Longest pane name pushed in a `turn` event.
pub const MAX_PANE_NAME_CHARS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Hello {
        request_id: String,
        proto: u64,
        app: String,
        version: String,
        capabilities: Vec<String>,
    },
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
        request_id: Option<String>,
        pin: String,
    },
    Subscribe {
        request_id: String,
    },
    Ping {
        request_id: String,
    },
    /// SWA-66: silence Swarmterm's announcement voice (buzzkey's "quiet"
    /// hotkey). Needs the `tts` capability; allowed on a status feed, since
    /// it neither dictates nor waits on anything.
    TtsStop {
        request_id: String,
    },
    /// SWA-58: speak the excerpt of one closed turn. Needs `excerpt-read`;
    /// allowed on a status feed like `tts_stop`. Idempotent per requestId.
    ReadExcerpt {
        request_id: String,
        completion_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Op {
    #[serde(rename_all = "camelCase")]
    Hello {
        request_id: String,
        proto: u64,
        app: String,
        version: String,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Begin { request_id: String },
    #[serde(rename_all = "camelCase")]
    Insert {
        request_id: String,
        pin: String,
        text: String,
        #[serde(default)]
        submit: bool,
    },
    // `requestId` is optional on purpose: a 1.9.0 server refuses the extra
    // field, so clients only add it after a successful hello.
    #[serde(rename_all = "camelCase")]
    Cancel {
        #[serde(default)]
        request_id: Option<String>,
        pin: String,
    },
    #[serde(rename_all = "camelCase")]
    Subscribe { request_id: String },
    #[serde(rename_all = "camelCase")]
    Ping { request_id: String },
    #[serde(rename = "tts_stop", rename_all = "camelCase")]
    TtsStop { request_id: String },
    #[serde(rename = "read_excerpt", rename_all = "camelCase")]
    ReadExcerpt {
        request_id: String,
        completion_id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proto: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// `subscribe`: the last seq issued so far; the next push is greater.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// `subscribe`: "swarmterm" or "none" — UI information for the client.
    /// The per-event `ttsHandled` decides who speaks, never this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts_owner: Option<String>,
}

impl Request {
    pub fn request_id(&self) -> Option<String> {
        match self {
            Self::Hello { request_id, .. }
            | Self::Begin { request_id }
            | Self::Insert { request_id, .. }
            | Self::Subscribe { request_id }
            | Self::Ping { request_id }
            | Self::TtsStop { request_id }
            | Self::ReadExcerpt { request_id, .. } => Some(request_id.clone()),
            Self::Cancel { request_id, .. } => request_id.clone(),
        }
    }
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
    pub fn hello(request_id: String, capabilities: Vec<String>) -> Self {
        Self {
            proto: Some(PROTO),
            app: Some("swarmterm".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            capabilities: Some(capabilities),
            ..Self::ok(Some(request_id))
        }
    }
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// Why the server dropped an indicator pin, as pushed to the client. Only
/// `user` means "discard the recording"; every other reason (and a plain
/// EOF) leaves the client its clipboard fallback, so no dictation is lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    User,
    Superseded,
    TargetGone,
    Expired,
    Disabled,
}

impl CancelReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Superseded => "superseded",
            Self::TargetGone => "target-gone",
            Self::Expired => "expired",
            Self::Disabled => "disabled",
        }
    }
}

/// Server push on a negotiated connection.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Event {
    pub v: u64,
    pub event: &'static str,
    pub pin: String,
    pub reason: &'static str,
}

impl Event {
    pub fn cancelled(pin: String, reason: CancelReason) -> Self {
        Self {
            v: VERSION,
            event: "cancelled",
            pin,
            reason: reason.as_str(),
        }
    }
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// `{"v":1,"event":"quit"}` — pushed on every live connection of a client
/// that negotiated `quit`.
pub fn quit_line() -> String {
    let mut s = serde_json::json!({ "v": VERSION, "event": "quit" }).to_string();
    s.push('\n');
    s
}

/// Which agent fact a `turn` push announces. `Error` (SWA-58) comes only
/// from a completion adapter that proved it (Claude's StopFailure hook) and
/// only to feeds with `turn-kinds`. There is no `interrupted` yet: no CLI
/// gives a reliable edge for it (Esc fires no hook).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
    Done,
    NeedsInput,
    Error,
}

/// Status push on a subscribed connection. `excerpt` is always null: the
/// text stays in Swarmterm (SWA-58), a client with `excerpt-read` gets
/// `completionId` + `hasExcerpt` and asks for it to be read instead.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvent {
    pub v: u64,
    pub event: &'static str,
    pub terminal_id: String,
    pub pane_name: String,
    pub agent: String,
    pub kind: TurnKind,
    pub excerpt: Option<String>,
    pub seq: u64,
    /// SWA-66: Swarmterm took this event — it says it or drops it on
    /// purpose. A fallback voice speaks only events with `false`; a client
    /// that never saw this field (older Swarmterm) decides on its own.
    pub tts_handled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_excerpt: Option<bool>,
}

impl TurnEvent {
    pub fn new(
        terminal_id: String,
        pane_name: &str,
        agent: String,
        kind: TurnKind,
        seq: u64,
        tts_handled: bool,
    ) -> Self {
        Self {
            v: VERSION,
            event: "turn",
            terminal_id,
            pane_name: clean_label(pane_name),
            agent: clean_label(&agent),
            kind,
            excerpt: None,
            seq,
            tts_handled,
            completion_id: None,
            has_excerpt: None,
        }
    }
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// SWA-58: something about an already pushed `turn` (same `seq`) became
/// known later — its excerpt is ready, or the turn turned out to have
/// failed. Never announced again by Swarmterm's own voice for an excerpt;
/// fields a feed did not negotiate stay off its copy.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnUpdate {
    pub v: u64,
    pub event: &'static str,
    pub seq: u64,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<TurnKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_excerpt: Option<bool>,
}

impl TurnUpdate {
    pub fn new(seq: u64, terminal_id: String) -> Self {
        Self {
            v: VERSION,
            event: "turn_update",
            seq,
            terminal_id,
            kind: None,
            completion_id: None,
            has_excerpt: None,
        }
    }
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// A pane title comes from the program in the pane (OSC 0/2): strip control
/// characters and cap it before it reaches a speech engine. Leading symbols
/// go too — Claude Code prefixes its title with a status glyph ("✳ ") that a
/// voice would read out as noise.
pub fn clean_label(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .skip_while(|c| !c.is_alphanumeric())
        .take(MAX_PANE_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The capabilities both sides announced, in our order. Unknown ones from
/// the client are ignored, never an error — that keeps adding a capability
/// later a one-sided change.
pub fn negotiate(client: &[String]) -> Vec<String> {
    CAPABILITIES
        .iter()
        .filter(|c| client.iter().any(|x| x == *c))
        .map(|c| (*c).to_owned())
        .collect()
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

fn valid_cap(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= MAX_CAP_LEN
        && c.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_label(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= MAX_LABEL_CHARS && !s.chars().any(char::is_control)
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
    match obj.get("op").and_then(Value::as_str) {
        Some(op) if KNOWN_OPS.contains(&op) => {}
        Some(_) => return Err("unknown-op"),
        None => return Err("bad-request"),
    }
    let op: Op = serde_json::from_value(Value::Object(obj)).map_err(|_| "bad-request")?;
    let req = match op {
        Op::Hello {
            request_id,
            proto,
            app,
            version,
            capabilities,
        } => Request::Hello {
            request_id,
            proto,
            app,
            version,
            capabilities,
        },
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
        Op::Cancel { request_id, pin } => Request::Cancel { request_id, pin },
        Op::Subscribe { request_id } => Request::Subscribe { request_id },
        Op::Ping { request_id } => Request::Ping { request_id },
        Op::TtsStop { request_id } => Request::TtsStop { request_id },
        Op::ReadExcerpt {
            request_id,
            completion_id,
        } => Request::ReadExcerpt {
            request_id,
            completion_id,
        },
    };
    match &req {
        Request::Hello {
            request_id,
            proto,
            app,
            version,
            capabilities,
        } => {
            if !valid_id(request_id)
                || *proto == 0
                || !valid_label(app)
                || !valid_label(version)
                || capabilities.len() > MAX_CAPS
                || !capabilities.iter().all(|c| valid_cap(c))
            {
                Err("bad-request")
            } else {
                Ok(req)
            }
        }
        Request::Begin { request_id }
        | Request::Subscribe { request_id }
        | Request::Ping { request_id }
        | Request::TtsStop { request_id }
            if !valid_id(request_id) =>
        {
            Err("bad-request")
        }
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
        Request::Cancel { request_id, pin }
            if !valid_id(pin) || request_id.as_deref().is_some_and(|r| !valid_id(r)) =>
        {
            Err("bad-request")
        }
        Request::ReadExcerpt {
            request_id,
            completion_id,
        } if !valid_id(request_id) || !valid_id(completion_id) => Err("bad-request"),
        _ => Ok(req),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "secret-token";

    #[test]
    fn parses_tts_stop() {
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"tts_stop","requestId":"q1"}"#,
                TOKEN
            ),
            Ok(Request::TtsStop {
                request_id: "q1".into()
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"tts_stop","requestId":"q1","all":true}"#,
                TOKEN
            ),
            Err("bad-request")
        );
    }

    #[test]
    fn parses_read_excerpt() {
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"read_excerpt","requestId":"r1","completionId":"c1"}"#,
                TOKEN
            ),
            Ok(Request::ReadExcerpt {
                request_id: "r1".into(),
                completion_id: "c1".into()
            })
        );
        for bad in [
            r#"{"v":1,"token":"secret-token","op":"read_excerpt","requestId":"r1"}"#,
            r#"{"v":1,"token":"secret-token","op":"read_excerpt","requestId":"r1","completionId":"a b"}"#,
            r#"{"v":1,"token":"secret-token","op":"read_excerpt","requestId":"r1","completionId":"c","terminalId":"t"}"#,
        ] {
            assert_eq!(parse(bad, TOKEN), Err("bad-request"), "{bad}");
        }
    }

    #[test]
    fn new_capabilities_only_when_asked_and_excerpt_stays_null() {
        assert_eq!(
            negotiate(&["excerpt-read".into(), "turns".into(), "turn-kinds".into()]),
            vec!["turns", "turn-kinds", "excerpt-read"]
        );
        let mut e = TurnEvent::new("t".into(), "A", "codex".into(), TurnKind::Error, 3, false);
        e.completion_id = Some("c1".into());
        e.has_excerpt = Some(true);
        let line = e.to_line();
        assert!(line.contains("\"kind\":\"error\""));
        assert!(line.contains("\"excerpt\":null"));
        assert!(line.contains("\"completionId\":\"c1\",\"hasExcerpt\":true"));
        let mut u = TurnUpdate::new(3, "t".into());
        u.has_excerpt = Some(true);
        assert_eq!(
            u.to_line(),
            "{\"v\":1,\"event\":\"turn_update\",\"seq\":3,\"terminalId\":\"t\",\"hasExcerpt\":true}\n"
        );
    }

    #[test]
    fn parses_subscribe_and_ping() {
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"subscribe","requestId":"s1"}"#,
                TOKEN
            ),
            Ok(Request::Subscribe {
                request_id: "s1".into()
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"ping","requestId":"p1"}"#,
                TOKEN
            ),
            Ok(Request::Ping {
                request_id: "p1".into()
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"subscribe","requestId":"a b"}"#,
                TOKEN
            ),
            Err("bad-request")
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"subscribe","requestId":"s","since":3}"#,
                TOKEN
            ),
            Err("bad-request")
        );
    }

    #[test]
    fn offers_turns_only_to_clients_that_ask() {
        assert_eq!(negotiate(&["turns".into()]), vec!["turns".to_owned()]);
        assert_eq!(
            negotiate(&["indicator".into()]),
            vec!["indicator".to_owned()]
        );
    }

    #[test]
    fn turn_event_wire_format() {
        let e = TurnEvent::new(
            "t1".into(),
            "Refactor\u{1b}[31m",
            "claude-code".into(),
            TurnKind::NeedsInput,
            7,
            true,
        );
        assert_eq!(
            e.to_line(),
            "{\"v\":1,\"event\":\"turn\",\"terminalId\":\"t1\",\"paneName\":\"Refactor[31m\",\"agent\":\"claude-code\",\"kind\":\"needs_input\",\"excerpt\":null,\"seq\":7,\"ttsHandled\":true}\n"
        );
        assert_eq!(
            clean_label(&"x".repeat(100)).chars().count(),
            MAX_PANE_NAME_CHARS
        );
        assert_eq!(clean_label("✳ Fix login"), "Fix login");
        assert_eq!(clean_label("⠂ 2 tests"), "2 tests");
    }

    #[test]
    fn subscribe_answer_carries_the_owner_only_when_set() {
        let plain = Response::ok(Some("s1".into()));
        assert!(!plain.to_line().contains("ttsOwner"));
        let owned = Response {
            tts_owner: Some("swarmterm".into()),
            ..plain
        };
        assert!(owned.to_line().contains("\"ttsOwner\":\"swarmterm\""));
    }

    #[test]
    fn cancelled_push_is_unchanged() {
        assert_eq!(
            Event::cancelled("p1".into(), CancelReason::User).to_line(),
            "{\"v\":1,\"event\":\"cancelled\",\"pin\":\"p1\",\"reason\":\"user\"}\n"
        );
    }

    #[test]
    fn parses_the_request_ops() {
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
            Ok(Request::Cancel {
                request_id: None,
                pin: "p1".into()
            })
        );
        assert_eq!(
            parse(
                r#"{"v":1,"token":"secret-token","op":"cancel","requestId":"r3","pin":"p1"}"#,
                TOKEN
            ),
            Ok(Request::Cancel {
                request_id: Some("r3".into()),
                pin: "p1".into()
            })
        );
    }

    #[test]
    fn parses_hello_and_negotiates_the_intersection() {
        let line = r#"{"v":1,"token":"secret-token","op":"hello","requestId":"h1","proto":2,"app":"buzzkey","version":"1.9.1+bk.3","capabilities":["indicator","quit","future-thing"]}"#;
        let Ok(Request::Hello {
            proto,
            app,
            capabilities,
            ..
        }) = parse(line, TOKEN)
        else {
            panic!("hello did not parse");
        };
        assert_eq!((proto, app.as_str()), (2, "buzzkey"));
        // "quit" was an unknown capability before SWA-42; now it is ours.
        assert_eq!(
            negotiate(&capabilities),
            vec!["indicator".to_owned(), "quit".to_owned()]
        );
        assert!(negotiate(&[]).is_empty());
        assert_eq!(
            negotiate(&["quit".into(), "turns".into()]),
            vec!["turns".to_owned(), "quit".to_owned()]
        );
        // SWA-66: `tts` only when asked for; a 1.9-era client never sees it.
        assert_eq!(
            negotiate(&["tts".into(), "turns".into()]),
            vec!["turns".to_owned(), "tts".to_owned()]
        );
        assert_eq!(
            quit_line(),
            "{\"v\":1,\"event\":\"quit\"}
"
        );
    }

    #[test]
    fn rejects_malformed_hello() {
        let long_app = format!(
            r#"{{"v":1,"token":"secret-token","op":"hello","requestId":"h","proto":2,"app":"{}","version":"1"}}"#,
            "a".repeat(MAX_LABEL_CHARS + 1)
        );
        assert_eq!(parse(&long_app, TOKEN), Err("bad-request"));
        let bad_cap = r#"{"v":1,"token":"secret-token","op":"hello","requestId":"h","proto":2,"app":"b","version":"1","capabilities":["Indicator"]}"#;
        assert_eq!(parse(bad_cap, TOKEN), Err("bad-request"));
        let caps: Vec<String> = (0..=MAX_CAPS).map(|i| format!("\"c{i}\"")).collect();
        let many = format!(
            r#"{{"v":1,"token":"secret-token","op":"hello","requestId":"h","proto":2,"app":"b","version":"1","capabilities":[{}]}}"#,
            caps.join(",")
        );
        assert_eq!(parse(&many, TOKEN), Err("bad-request"));
        let proto0 = r#"{"v":1,"token":"secret-token","op":"hello","requestId":"h","proto":0,"app":"b","version":"1"}"#;
        assert_eq!(parse(proto0, TOKEN), Err("bad-request"));
    }

    #[test]
    fn rejects_wrong_or_missing_token_before_anything_else() {
        let line = r#"{"v":1,"token":"secret-tokeX","op":"begin","requestId":"r1"}"#;
        assert_eq!(parse(line, TOKEN), Err("unauthorized"));
        assert_eq!(
            parse(r#"{"v":1,"op":"begin","requestId":"r1"}"#, TOKEN),
            Err("unauthorized")
        );
        let unknown_no_token = r#"{"v":1,"op":"run"}"#;
        assert_eq!(parse(unknown_no_token, TOKEN), Err("unauthorized"));
        assert!(!token_matches("secret-token-longer", TOKEN));
        assert!(!token_matches("", TOKEN));
    }

    #[test]
    fn rejects_unknown_ops_fields_and_versions() {
        let run = r#"{"v":1,"token":"secret-token","op":"run","cmd":"calc"}"#;
        assert_eq!(parse(run, TOKEN), Err("unknown-op"));
        let no_op = r#"{"v":1,"token":"secret-token","requestId":"r1"}"#;
        assert_eq!(parse(no_op, TOKEN), Err("bad-request"));
        let extra = r#"{"v":1,"token":"secret-token","op":"begin","requestId":"r1","shell":true}"#;
        assert_eq!(parse(extra, TOKEN), Err("bad-request"));
        let bad_cancel =
            r#"{"v":1,"token":"secret-token","op":"cancel","requestId":"a b","pin":"p"}"#;
        assert_eq!(parse(bad_cancel, TOKEN), Err("bad-request"));
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
    fn response_and_event_lines_are_compact_json() {
        let line = Response::err(Some("r1".into()), "no-focus").to_line();
        assert_eq!(
            line,
            "{\"v\":1,\"requestId\":\"r1\",\"ok\":false,\"reason\":\"no-focus\"}\n"
        );
        assert_eq!(
            Event::cancelled("p1".into(), CancelReason::User).to_line(),
            "{\"v\":1,\"event\":\"cancelled\",\"pin\":\"p1\",\"reason\":\"user\"}\n"
        );
        let hello = Response::hello("h1".into(), vec!["indicator".into()]);
        assert_eq!(hello.proto, Some(PROTO));
        assert!(hello.to_line().contains("\"capabilities\":[\"indicator\"]"));
        assert!(!hello.to_line().contains("event"));
    }
}
