//! Settings → Terminal → Agent safety "Allow agents to run prompts in other panes": what one
//! agent may make another agent do. Enforced here, not in the renderer, so a
//! manipulated or confused agent cannot route around it through MCP. The
//! renderer only stores the user's choice and pushes it (`agent_policy_set`);
//! the struct is the single place a later admin policy can override it.

use serde::{Deserialize, Serialize};

/// Field names are in lockstep with `src/lib/agent-policy.ts` (camelCase).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPolicy {
    /// War Room `mode: "execute"` sent by an agent over MCP. Off by default:
    /// an execute runs a prompt in another pane, which may be in a bypass
    /// mode, so one bad instruction would otherwise spread across panes.
    pub allow_war_room_execute: bool,
}

/// Returned to the agent verbatim; it names the allowed alternative so the
/// agent can recover on its own instead of retrying the same call.
pub const EXECUTE_DISABLED: &str = "war_room.send mode \"execute\" is disabled: the user has not \
allowed agents to run prompts in other panes (Settings → Terminal → Agent safety). Use mode \"probe\" instead — \
the peer reads your message and decides itself what to run.";

impl AgentPolicy {
    /// `Err` with the message for the agent when an MCP execute is refused.
    pub fn check_war_room_execute(&self) -> Result<(), &'static str> {
        if self.allow_war_room_execute {
            Ok(())
        } else {
            Err(EXECUTE_DISABLED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_is_refused_by_default_and_names_probe() {
        let err = AgentPolicy::default().check_war_room_execute().unwrap_err();
        assert!(err.contains("probe"));
    }

    #[test]
    fn execute_passes_when_allowed() {
        let p = AgentPolicy {
            allow_war_room_execute: true,
        };
        assert_eq!(p.check_war_room_execute(), Ok(()));
    }

    #[test]
    fn missing_or_unknown_fields_deserialize_to_the_secure_default() {
        let p: AgentPolicy = serde_json::from_str(r#"{"future":1}"#).unwrap();
        assert_eq!(p, AgentPolicy::default());
        let p: AgentPolicy = serde_json::from_str(r#"{"allowWarRoomExecute":true}"#).unwrap();
        assert!(p.allow_war_room_execute);
    }
}
