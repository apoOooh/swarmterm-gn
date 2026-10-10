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
//! - **Never print to stdout.** On `PermissionRequest` stdout is parsed as a
//!   permission *decision*; on other events it is shown to the user or fed
//!   back as context. Silence is the only safe output.
//!
//! Only `hook_event_name` and `notification_type` are ever deserialised. The
//! rest of the payload (prompt text, `last_assistant_message`, tool input,
//! cwd) must not leave the pane, so it is never even read into a struct.

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

/// The two stdin fields we read. Everything else (prompt, last_assistant_message,
/// tool_input, cwd) is deliberately never deserialised — it must not leave the
/// pane. `#[serde(default)]` keeps `{}` and missing fields parseable so an
/// unknown-shaped payload degrades to "no signal" rather than an error.
#[derive(Debug, Default, serde::Deserialize)]
pub struct HookInput {
    #[serde(default)]
    pub hook_event_name: String,
    #[serde(default)]
    pub notification_type: Option<String>,
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

/// Body of `POST /hook` — an enum only, never free text, so a compromised or
/// confused hook process can at most flip a state, never inject content.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct HookBody {
    pub signal: Signal,
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
        ("Stop", _) => Some(Signal::Idle),
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
    if let Some(signal) = signal_from_stdin(&raw) {
        let _ = post::post_signal(url.trim(), token.trim(), signal, POST_TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
