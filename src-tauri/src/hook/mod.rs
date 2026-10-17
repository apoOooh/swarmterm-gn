//! The `swarmterm --hook` command: Claude Code runs it from its hook config on
//! every lifecycle event and pipes the event JSON to stdin. We forward a
//! *signal* (working / blocked / idle / forget) to the running Swarmterm over
//! the loopback MCP port so the pane's agent state comes from Claude itself
//! instead of the screen-scrape heuristics in `lib/agent-state`.
//!
//! Why hooks beat scraping for Claude Code: the scraper infers "done" and
//! "blocked" from screen text and needs debounce to avoid false positives;
//! `Stop`, `PermissionRequest`, and `Notification` are exact edges with no
//! heuristics. Hooks do NOT replace the scraper — `Stop` never fires on a user
//! interrupt (Esc), so hook authority expires (per-signal TTLs in S5.3) and the
//! scraper fills the gaps.
//!
//! Two hard contracts of this CLI, both because Claude Code interprets a hook
//! process's exit code and stdout:
//! - **Always exit 0.** Exit 2 on `Stop` blocks Claude from stopping; any
//!   non-zero exit is a visible warning in the Claude Code UI. A failed POST is
//!   *our* problem, never Claude's.
//! - **Never print to stdout** — with one exception. On `PermissionRequest`
//!   stdout is parsed as a permission *decision*; on other events it is shown
//!   to the user or fed back as context. The exception (SWA-58) is
//!   `UserPromptSubmit` while the app answers `{"voice":true}` (Settings →
//!   Voice "Allow excerpts"): then exactly one JSON object with
//!   `additionalContext` = `speech_text::VOICE_INSTRUCTION` is printed, a
//!   fixed string, never anything from the payload or the network.
//!
//! Only lifecycle names and identifiers cross the loopback port: the session
//! id, and (SWA-58) Claude's `prompt_id`. `last_assistant_message` is read
//! into this process for one reason — to send its length and SHA-256
//! (`Fingerprint`), never the text — so the app can tell whether the row it
//! reads from the transcript is the one this Stop saw. Prompt text, tool
//! input, cwd and `transcript_path` are never read into a struct.

pub mod adopt;
pub mod codex;
pub mod install;
pub mod post;

/// What a hook event means for the pane's agent state. `Forget` = drop hook
/// authority (SessionStart/SessionEnd) so the screen-scraper resumes alone:
/// a fresh session has no history worth trusting, and after SessionEnd the
/// pane is a plain shell until the next `claude` launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Signal {
    Working,
    Blocked,
    Idle,
    Forget,
}

/// Lifecycle names and identifiers. Everything else (prompt, tool_input,
/// cwd, transcript_path) is deliberately never deserialised — it must not
/// leave the pane. `#[serde(default)]` keeps `{}` and missing fields
/// parseable so an unknown-shaped payload degrades to "no signal" rather
/// than an error.
#[derive(Debug, Default, serde::Deserialize)]
pub struct HookInput {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub hook_event_name: String,
    #[serde(default)]
    pub notification_type: Option<String>,
    /// SWA-58: the turn this event belongs to (Claude Code 2.1+).
    #[serde(default)]
    pub prompt_id: Option<String>,
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
    /// Only ever fingerprinted, see the module doc. Never sent, never logged.
    #[serde(default)]
    pub last_assistant_message: Option<String>,
}

/// Which edge of a turn a hook event is (SWA-58).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEdge {
    Prompt,
    Stop,
    StopFailure,
}

/// The turn identity of one Claude hook event. Ids and a fingerprint only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnMark {
    pub edge: TurnEdge,
    pub prompt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<crate::voice::completion::Fingerprint>,
    /// `stop_hook_active`: a Stop hook sent Claude back to work.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub continued: bool,
}

impl TurnMark {
    /// The mark for one Claude hook payload, or `None` when the event is not
    /// a turn edge or carries no valid prompt id (older CLI → status only).
    pub fn from_input(input: &HookInput) -> Option<Self> {
        let edge = match input.hook_event_name.as_str() {
            "UserPromptSubmit" => TurnEdge::Prompt,
            "Stop" => TurnEdge::Stop,
            "StopFailure" => TurnEdge::StopFailure,
            _ => return None,
        };
        let prompt_id = input
            .prompt_id
            .clone()
            .filter(|id| crate::sessions::is_uuid(id))?;
        let answer = (edge == TurnEdge::Stop)
            .then(|| {
                input
                    .last_assistant_message
                    .as_deref()
                    .map(crate::voice::completion::Fingerprint::of)
            })
            .flatten();
        Some(Self {
            edge,
            prompt_id,
            answer,
            continued: edge == TurnEdge::Stop && input.stop_hook_active == Some(true),
        })
    }

    pub fn is_valid(&self) -> bool {
        crate::sessions::is_uuid(&self.prompt_id)
            && self.answer.as_ref().is_none_or(|a| a.is_valid())
    }
}

/// Payload of the `agent:hook` Tauri event (camelCase, lockstep with
/// `src/tauri/agent-state.ts::AgentHookEvent`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookEvent {
    pub terminal_id: String,
    pub signal: Signal,
    pub at_ms: u64,
}

/// Body of `POST /hook`: a state enum, optional session identity and turn
/// mark, never conversation content — unknown fields are a 4xx. Session
/// metadata is validated against the live PTY.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct HookBody {
    pub signal: Signal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnMark>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMetadata {
    pub agent_id: String,
    pub session_id: String,
    pub spawn_id: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionEvent {
    pub terminal_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub at_ms: u64,
}

impl SessionMetadata {
    pub fn matches(&self, spawn_id: &str, agent_id: Option<&str>) -> bool {
        self.spawn_id == spawn_id
            && agent_id == Some(self.agent_id.as_str())
            && matches!(self.agent_id.as_str(), "claude-code" | "codex")
            && crate::sessions::is_uuid(&self.session_id)
    }
}

/// The hook-event → signal table. Exact, case-sensitive: Claude Code spells
/// events in PascalCase and `notification_type` in snake_case, and matching
/// loosely would only hide a rename behind a silently-wrong state. S5.2
/// registers exactly the events that return `Some` here — anything else must
/// stay `None` so the CLI never POSTs for it (PreToolUse fires on every tool
/// call and would be pure noise on the loopback port).
///
/// `Stop` → `Idle`, not "done": whether idle means *done* depends on whether
/// the user has looked at the pane since, which only the renderer knows.
pub fn signal_for(event: &str, notification_type: Option<&str>) -> Option<Signal> {
    match (event, notification_type) {
        ("UserPromptSubmit", _) => Some(Signal::Working),
        ("PermissionRequest", _) => Some(Signal::Blocked),
        ("Notification", Some("permission_prompt" | "elicitation_dialog")) => Some(Signal::Blocked),
        ("Notification", Some("idle_prompt")) => Some(Signal::Idle),
        ("Notification", _) => None,
        ("PostToolUse", _) => Some(Signal::Working),
        ("Stop" | "StopFailure", _) => Some(Signal::Idle),
        ("SessionStart" | "SessionEnd", _) => Some(Signal::Forget),
        _ => None,
    }
}

/// Parse the raw stdin JSON into a signal. Garbage, empty input, or a wrong
/// field type all yield `None` — never an error — because the only caller is
/// the CLI, whose contract is "exit 0, print nothing" no matter what.
pub fn signal_from_stdin(raw: &str) -> Option<Signal> {
    serde_json::from_str::<HookInput>(raw)
        .ok()
        .and_then(|i| signal_for(&i.hook_event_name, i.notification_type.as_deref()))
}

/// How long the POST gets. Claude Code runs this command synchronously on
/// every hook event, so a slow answer stalls Claude itself — better to drop
/// one signal (the scraper backfills) than to hold the agent.
const POST_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

/// The `--hook` entry point. Reached from `main.rs` BEFORE the Tauri builder
/// runs — a plain CLI that reads stdin, maybe POSTs, and exits 0 no matter
/// what (see the module doc for why both contracts are non-negotiable).
pub fn run_cli() {
    run_agent_cli("claude-code")
}

pub fn run_agent_cli(agent_id: &str) {
    use std::io::Read;

    // Env first: a Claude run outside Swarmterm has no session, so exit in
    // microseconds without touching stdin — the hook is registered globally
    // in ~/.claude/settings.json and fires in every Claude Code, not just ours.
    let (Ok(url), Ok(token)) = (
        std::env::var("SWARMTERM_MCP_URL"),
        std::env::var("SWARMTERM_SESSION"),
    ) else {
        return;
    };
    if url.trim().is_empty() || token.trim().is_empty() {
        return;
    }
    // Read to EOF even though we only need two fields: closing early can EPIPE
    // Claude's writer side, and a hook error is a visible Claude Code warning.
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let Ok(input) = serde_json::from_str::<HookInput>(&raw) else {
        return;
    };
    // Stop carries the session too (SWA-58): the app closes a turn only for
    // the generation and session it was opened in.
    let session = if matches!(
        input.hook_event_name.as_str(),
        "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure"
    ) {
        input
            .session_id
            .clone()
            .filter(|id| crate::sessions::is_uuid(id))
            .and_then(|session_id| {
                std::env::var("SWARMTERM_PTY_GENERATION")
                    .ok()
                    .map(|spawn_id| SessionMetadata {
                        agent_id: agent_id.into(),
                        session_id,
                        spawn_id,
                    })
            })
    } else {
        None
    };
    let turn = (agent_id == "claude-code" && session.is_some())
        .then(|| TurnMark::from_input(&input))
        .flatten();
    let signal = if agent_id == "codex" {
        if session.is_none() {
            return;
        };
        Signal::Forget
    } else {
        let Some(signal) = signal_for(&input.hook_event_name, input.notification_type.as_deref())
        else {
            return;
        };
        signal
    };
    let is_prompt = turn.as_ref().is_some_and(|t| t.edge == TurnEdge::Prompt);
    let answer = post::post_body_answer(
        url.trim(),
        token.trim(),
        &HookBody {
            signal,
            session,
            turn,
        },
        POST_TIMEOUT,
    );
    if is_prompt && answer.as_deref().is_some_and(wants_voice) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(voice_context().as_bytes());
        let _ = out.flush();
    }
}

/// The app's answer to a prompt edge: `{"voice":true}` and nothing else
/// asks for the instruction. Any other body (204, older app) is silence.
pub fn wants_voice(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("voice").and_then(serde_json::Value::as_bool))
        == Some(true)
}

/// The one stdout line this CLI may print (UserPromptSubmit only).
pub fn voice_context() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": crate::voice::completion::speech_text::VOICE_INSTRUCTION,
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_metadata_rejects_stale_generations_and_wrong_agents() {
        let mut session = SessionMetadata {
            agent_id: "codex".into(),
            session_id: "11111111-2222-4333-8444-555555555555".into(),
            spawn_id: "new".into(),
        };
        assert!(session.matches("new", Some("codex")));
        assert!(!session.matches("old", Some("codex")));
        assert!(!session.matches("new", Some("claude-code")));
        session.session_id = "x; injected".into();
        assert!(!session.matches("new", Some("codex")));
    }

    #[test]
    fn session_input_and_event_carry_identity_without_conversation_content() {
        let input: HookInput = serde_json::from_str(r#"{"hook_event_name":"SessionStart","session_id":"11111111-2222-4333-8444-555555555555","prompt":"private","cwd":"private"}"#).unwrap();
        assert_eq!(
            input.session_id.as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        let json = serde_json::to_string(&AgentSessionEvent {
            terminal_id: "t".into(),
            agent_id: "codex".into(),
            session_id: input.session_id.unwrap(),
            at_ms: 42,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"terminalId":"t","agentId":"codex","sessionId":"11111111-2222-4333-8444-555555555555","atMs":42}"#
        );
    }

    #[test]
    fn signal_for_maps_the_registered_events() {
        // The table in tasks/S5.1/PLAN.md, row by row. S5.2 registers exactly
        // these events in ~/.claude/settings.json — keep them in lockstep.
        assert_eq!(signal_for("UserPromptSubmit", None), Some(Signal::Working));
        assert_eq!(signal_for("PermissionRequest", None), Some(Signal::Blocked));
        assert_eq!(
            signal_for("Notification", Some("permission_prompt")),
            Some(Signal::Blocked)
        );
        assert_eq!(
            signal_for("Notification", Some("elicitation_dialog")),
            Some(Signal::Blocked)
        );
        assert_eq!(
            signal_for("Notification", Some("idle_prompt")),
            Some(Signal::Idle)
        );
        assert_eq!(signal_for("Notification", Some("auth_success")), None);
        assert_eq!(signal_for("Notification", None), None);
        assert_eq!(signal_for("PostToolUse", None), Some(Signal::Working));
        assert_eq!(signal_for("Stop", None), Some(Signal::Idle));
        assert_eq!(signal_for("StopFailure", None), Some(Signal::Idle));
        assert_eq!(signal_for("SessionStart", None), Some(Signal::Forget));
        assert_eq!(signal_for("SessionEnd", None), Some(Signal::Forget));
    }

    #[test]
    fn signal_for_ignores_unknown_events() {
        // Unregistered events must map to None so the CLI makes no POST for
        // them: PreToolUse fires on every tool call and would be pure noise.
        assert_eq!(signal_for("PreToolUse", None), None);
        assert_eq!(signal_for("SubagentStop", None), None);
        assert_eq!(signal_for("", None), None);
        // Case-sensitive: Claude Code spells events in PascalCase.
        assert_eq!(signal_for("stop", None), None);
        // notification_type only matters for Notification.
        assert_eq!(
            signal_for("Stop", Some("permission_prompt")),
            Some(Signal::Idle)
        );
    }

    #[test]
    fn signal_from_stdin_reads_only_the_two_fields() {
        let long = "x".repeat(4096);
        let stop = format!(
            concat!(
                "{{\"session_id\":\"abc-123\",\"transcript_path\":\"/tmp/t.jsonl\",",
                "\"cwd\":\"/Users/me/proj\",\"hook_event_name\":\"Stop\",",
                "\"stop_hook_active\":false,\"last_assistant_message\":\"{}\"}}"
            ),
            long
        );
        assert_eq!(signal_from_stdin(&stop), Some(Signal::Idle));

        let notification = concat!(
            "{\"session_id\":\"abc-123\",\"cwd\":\"/Users/me/proj\",",
            "\"hook_event_name\":\"Notification\",",
            "\"notification_type\":\"permission_prompt\",",
            "\"message\":\"Claude needs your permission to use Bash\"}"
        );
        assert_eq!(signal_from_stdin(notification), Some(Signal::Blocked));
    }

    #[test]
    fn signal_from_stdin_survives_garbage() {
        // The CLI must never panic: a panic is a non-zero exit, which Claude
        // Code surfaces as a hook failure.
        assert_eq!(signal_from_stdin(""), None);
        assert_eq!(signal_from_stdin("not json"), None);
        assert_eq!(signal_from_stdin("{}"), None);
        assert_eq!(signal_from_stdin("{\"hook_event_name\":5}"), None);
    }

    #[test]
    fn signal_serde_is_snake_case() {
        assert_eq!(
            serde_json::to_string(&Signal::Working).unwrap(),
            "\"working\""
        );
        for s in [
            Signal::Working,
            Signal::Blocked,
            Signal::Idle,
            Signal::Forget,
        ] {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(serde_json::from_str::<Signal>(&json).unwrap(), s);
        }
        assert!(serde_json::from_str::<Signal>("\"Working\"").is_err());
    }

    #[test]
    fn agent_hook_event_serializes_camel_case() {
        // Lockstep with `src/tauri/agent-state.ts::AgentHookEvent`.
        let ev = AgentHookEvent {
            terminal_id: "t1".into(),
            signal: Signal::Blocked,
            at_ms: 42,
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            "{\"terminalId\":\"t1\",\"signal\":\"blocked\",\"atMs\":42}"
        );
    }

    #[test]
    fn hook_body_round_trips() {
        let body: HookBody = serde_json::from_str("{\"signal\":\"idle\"}").unwrap();
        assert_eq!(body.signal, Signal::Idle);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"signal\":\"idle\"}"
        );
        // The body is an enum only, never free text: anything else is a 4xx.
        assert!(serde_json::from_str::<HookBody>("{\"signal\":\"nope\"}").is_err());
        assert!(serde_json::from_str::<HookBody>("{}").is_err());
        assert!(serde_json::from_str::<HookBody>(
            "{\"signal\":\"idle\",\"lastAssistantMessage\":\"text\"}"
        )
        .is_err());
        assert!(serde_json::from_str::<HookBody>(
            "{\"signal\":\"idle\",\"turn\":{\"edge\":\"stop\",\"promptId\":\"p\",\"text\":\"x\"}}"
        )
        .is_err());
    }

    #[test]
    fn only_an_explicit_voice_answer_prints_the_fixed_instruction() {
        assert!(wants_voice(b"{\"voice\":true}"));
        assert!(!wants_voice(b""));
        assert!(!wants_voice(b"{\"voice\":false}"));
        assert!(!wants_voice(b"{\"voice\":\"yes\"}"));
        let v: serde_json::Value = serde_json::from_str(&voice_context()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
        assert_eq!(
            v["hookSpecificOutput"]["additionalContext"],
            crate::voice::completion::speech_text::VOICE_INSTRUCTION
        );
    }

    const PROMPT: &str = "f62f9126-5c26-43d5-8bc8-3943559598b7";

    fn input(json: serde_json::Value) -> HookInput {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_stop_mark_carries_ids_and_a_fingerprint_never_the_text() {
        let i = input(serde_json::json!({
            "hook_event_name": "Stop", "prompt_id": PROMPT, "stop_hook_active": false,
            "last_assistant_message": "Geheimer Text.", "transcript_path": "/x"
        }));
        let mark = TurnMark::from_input(&i).unwrap();
        assert_eq!(mark.edge, TurnEdge::Stop);
        assert_eq!(
            mark.answer,
            Some(crate::voice::completion::Fingerprint::of("Geheimer Text."))
        );
        let body = HookBody {
            signal: Signal::Idle,
            session: None,
            turn: Some(mark),
        };
        let wire = serde_json::to_string(&body).unwrap();
        assert!(!wire.contains("Geheimer"));
        assert!(!wire.contains("transcript"));
        assert!(serde_json::from_str::<HookBody>(&wire)
            .unwrap()
            .turn
            .unwrap()
            .is_valid());
    }

    #[test]
    fn turn_marks_need_a_valid_prompt_id_and_a_turn_edge() {
        let mark = |j| TurnMark::from_input(&input(j));
        // Older CLI without prompt_id, or a malformed one: status only.
        assert_eq!(mark(serde_json::json!({"hook_event_name":"Stop"})), None);
        assert_eq!(
            mark(serde_json::json!({"hook_event_name":"Stop","prompt_id":"x; y"})),
            None
        );
        assert_eq!(
            mark(serde_json::json!({"hook_event_name":"PostToolUse","prompt_id":PROMPT})),
            None
        );
        let p = mark(serde_json::json!({"hook_event_name":"UserPromptSubmit",
            "prompt_id":PROMPT,"prompt":"private"}))
        .unwrap();
        assert_eq!(
            (p.edge, p.answer, p.continued),
            (TurnEdge::Prompt, None, false)
        );
        // A Stop without last_assistant_message has no anchor for a read.
        let s = mark(
            serde_json::json!({"hook_event_name":"Stop","prompt_id":PROMPT,
            "stop_hook_active":true}),
        )
        .unwrap();
        assert_eq!((s.answer, s.continued), (None, true));
        let f = mark(
            serde_json::json!({"hook_event_name":"StopFailure","prompt_id":PROMPT,
            "error":"rate_limit","last_assistant_message":"x"}),
        )
        .unwrap();
        assert_eq!((f.edge, f.answer), (TurnEdge::StopFailure, None));
    }
}
