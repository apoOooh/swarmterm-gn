//! MCP War Room tools: list peers, send (probe/execute), read inbox. Gated
//! per-call on live room membership — drag-out revokes by removing the map
//! entry, so the next call from an evicted pane fails right here. See the
//! 2026-07-27 war-room spec.

use serde::{Deserialize, Serialize};

/// Told to any caller outside every room. Written for the agent: it names the
/// user action that fixes it, mirroring worktree_ctx's error posture.
pub const NOT_IN_ROOM: &str =
    "this terminal is not in a War Room — ask the user to drag this pane into a room \
     in the War Room panel (right sidebar) to join";

/// `war_room.send` mode "execute" toward a peer the renderer mirrored as
/// `blocked` (sitting on a permission / question prompt). Pasting a prompt
/// there would be read as the ANSWER to that prompt, so the send is refused
/// outright instead of held. Every other state — including `None` (no report
/// yet / plain shell / forgotten on pty death) — fails OPEN: `working` is a
/// renderer-side hold (T1) that still delivers on idle, `done` is exactly the
/// hand-off case, and an unknown state must never block a legitimate send.
pub fn execute_refusal(peer_name: &str, state: Option<&str>) -> Option<String> {
    if state != Some("blocked") {
        return None;
    }
    Some(format!(
        "{peer_name} is blocked on a prompt (permission or question) — a pasted \
         prompt would be taken as its answer. Call war_room.wait_peer with until \
         [\"idle\",\"done\"] and re-send once it returns, or war_room.read_peer to \
         see what it is asking"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_entry_serializes_camelcase() {
        let p = PeerEntry {
            terminal_id: "t1".into(),
            name: "Claude".into(),
            agent_id: Some("claude-code".into()),
            cwd: "/x".into(),
            is_self: true,
            connected: false,
        };
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["terminalId"], "t1");
        assert_eq!(j["isSelf"], true);
        assert_eq!(j["agentId"], "claude-code");
        assert_eq!(j["connected"], false);
    }

    #[test]
    fn not_in_room_message_names_the_fix() {
        assert!(NOT_IN_ROOM.contains("drag"));
        assert!(NOT_IN_ROOM.contains("War Room"));
    }

    #[test]
    fn list_peers_result_serializes_room() {
        let result = ListPeersResult {
            room: "Website A".into(),
            peers: vec![],
            note: String::new(),
        };
        let j = serde_json::to_value(&result).unwrap();
        assert_eq!(j["room"], "Website A");
    }

    #[test]
    fn execute_refusal_only_for_blocked() {
        let msg = execute_refusal("Codex", Some("blocked")).expect("blocked must refuse");
        assert!(msg.contains("Codex"));
        assert!(msg.contains("war_room.wait_peer"));
        assert!(msg.contains("war_room.read_peer"));
    }

    #[test]
    fn execute_refusal_fails_open_for_every_other_state() {
        for s in [
            None,
            Some("working"),
            Some("idle"),
            Some("done"),
            Some("unknown"),
            Some(""),
        ] {
            assert!(
                execute_refusal("Codex", s).is_none(),
                "{s:?} must not refuse"
            );
        }
    }

    #[test]
    fn execute_refusal_is_exact_match() {
        assert!(execute_refusal("Codex", Some("Blocked")).is_none());
        assert!(execute_refusal("Codex", Some("blocked ")).is_none());
        assert!(execute_refusal("Codex", Some("blocked-ish")).is_none());
    }
}

// --- tool methods on the shared server struct ---

use rmcp::handler::server::wrapper::{Json, Parameters};
// `tool` / `tool_router` MUST be imported bare — see mcp/server.rs module docs.
use rmcp::{schemars, tool, tool_router};
use tauri::{Emitter, Manager};

use crate::mcp::server::SwarmtermMcpServer;
use crate::pty::AppState;
use crate::warroom::{now_ms, MessageMode, RoomMessage};

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeerEntry {
    pub terminal_id: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub cwd: String,
    pub is_self: bool,
    /// False = dragged in but no agent has made a war_room call from that
    /// pane yet — it cannot receive messages until it does.
    pub connected: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ListPeersResult {
    /// Display name of the room this terminal is in.
    pub room: String,
    pub peers: Vec<PeerEntry>,
    pub note: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WarRoomSendArgs {
    /// Target peer's terminalId (from war_room.list_peers). Omit to broadcast
    /// to every other member. Required when mode is "execute".
    pub to: Option<String>,
    /// The message (probe) or the exact prompt to run in the peer's terminal (execute).
    pub content: String,
    /// "probe" (default): deliver to the peer's inbox; they read it with
    /// war_room.read_inbox. "execute": paste into the peer's terminal and run.
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct WarRoomSendResult {
    pub delivered: usize,
    pub note: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ReadInboxResult {
    pub messages: Vec<RoomMessage>,
    pub note: String,
}

#[tool_router(router = tool_router_warroom, vis = "pub")]
impl SwarmtermMcpServer {
    #[tool(
        name = "war_room.list_peers",
        description = "List the terminals currently in Swarmterm's War Room: name, agent type, working directory. Only works when the user has dragged this pane into the War Room."
    )]
    pub async fn war_room_list_peers(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> Result<Json<ListPeersResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let state = self.app.state::<AppState>();
        // Lock scoped to a block so the handshake event is emitted lock-free.
        let (room_id, connected_ev, room_name, peers) = {
            let mut rooms = state.war_rooms.lock().unwrap();
            let entry = rooms
                .find_room_of(&terminal.0)
                .ok_or_else(|| rmcp::ErrorData::invalid_request(NOT_IN_ROOM, None))?;
            let room_id = entry.id.clone();
            let room = &mut entry.room;
            let connected_ev = room.mark_connected(&terminal.0, now_ms());
            let peers: Vec<PeerEntry> = room
                .peers()
                .into_iter()
                .map(|(id, m)| PeerEntry {
                    is_self: id == terminal.0,
                    terminal_id: id,
                    name: m.display_name.clone(),
                    agent_id: m.agent_id.clone(),
                    cwd: m.cwd.clone(),
                    connected: m.connected,
                })
                .collect();
            (room_id, connected_ev, entry.name.clone(), peers)
        };
        if let Some(ev) = connected_ev {
            let _ = self
                .app
                .emit("warroom:event", &crate::warroom::scoped(&room_id, ev));
        }
        Ok(Json(ListPeersResult {
            room: room_name,
            peers,
            note: "Message a peer with war_room.send (mode \"probe\"), or hand one a task \
                   with mode \"execute\". Peers inspect their own codebase — ask them \
                   instead of requesting their files. The peer \"Moderator\" is the human \
                   user: probe them for a decision, never send them mode \"execute\" (they \
                   have no terminal)."
                .into(),
        }))
    }

    #[tool(
        name = "war_room.send",
        description = "Send to War Room peers. mode \"probe\" (default): the content goes to the peer's inbox and they are nudged to read it — use for questions, debate, coordination. mode \"execute\": the content is pasted into the peer's terminal and run as their next prompt — use to hand over an agreed task. Omit \"to\" to broadcast a probe to all peers. An execute toward a peer that is blocked on a prompt is refused — war_room.wait_peer for idle/done first."
    )]
    pub async fn war_room_send(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<WarRoomSendArgs>,
    ) -> Result<Json<WarRoomSendResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let mode = MessageMode::parse(args.mode.as_deref())
            .map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;
        let state = self.app.state::<AppState>();
        // Mirror lookup for the execute→blocked refusal. `peer_states` is its
        // own lock (pty.rs) and must never be taken inside `war_rooms`, so read
        // the target's state here, scoped, and carry only the String across.
        // Snapshot→send is a µs TOCTOU; T1's renderer hold is the backstop if
        // the peer flips to blocked in between.
        let target_state: Option<String> = match (mode, args.to.as_deref()) {
            (MessageMode::Execute, Some(to)) => state
                .peer_states
                .lock()
                .unwrap()
                .snapshot(to)
                .map(|s| s.state),
            _ => None,
        };
        // Lock, mutate, collect what to emit, drop the lock BEFORE emitting —
        // emit re-enters Tauri and must never run under our mutex.
        let (room_id, connected_ev, event, deliveries) = {
            let mut rooms = state.war_rooms.lock().unwrap();
            let entry = rooms
                .find_room_of(&terminal.0)
                .ok_or_else(|| rmcp::ErrorData::invalid_request(NOT_IN_ROOM, None))?;
            let room_id = entry.id.clone();
            let room = &mut entry.room;
            // Refuse BEFORE mark_connected/send so nothing is queued or emitted.
            // Guarded on membership + agent_id so self / non-member / plain-shell
            // targets keep `WarRoom::send`'s own clearer errors, and so the mirror
            // leaks nothing about ids outside this room.
            if mode == MessageMode::Execute {
                if let Some(to) = args.to.as_deref() {
                    let target = room
                        .peers()
                        .into_iter()
                        .find(|(id, m)| id == to && m.agent_id.is_some())
                        .map(|(_, m)| m.display_name.clone());
                    if let Some(name) = target {
                        if let Some(msg) = execute_refusal(&name, target_state.as_deref()) {
                            return Err(rmcp::ErrorData::invalid_params(msg, None));
                        }
                    }
                }
            }
            // The call itself IS the handshake — a sender is proven by definition.
            let connected_ev = room.mark_connected(&terminal.0, now_ms());
            let out = room
                .send(
                    &terminal.0,
                    args.to.as_deref(),
                    &args.content,
                    mode,
                    now_ms(),
                )
                .map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;
            (room_id, connected_ev, out.event, out.deliveries)
        };
        let delivered = deliveries.len();
        if let Some(ev) = connected_ev {
            let _ = self
                .app
                .emit("warroom:event", &crate::warroom::scoped(&room_id, ev));
        }
        let _ = self
            .app
            .emit("warroom:event", &crate::warroom::scoped(&room_id, event));
        for d in deliveries {
            let _ = self.app.emit("warroom:deliver", &d);
        }
        Ok(Json(WarRoomSendResult {
            delivered,
            note: match mode {
                MessageMode::Probe => "Delivered to the peer's inbox; they will be nudged when idle. \
                                       Expect a reply via your own inbox — check war_room.read_inbox."
                    .into(),
                MessageMode::Execute => "The prompt will be pasted into the peer's terminal and run \
                                         when that pane is idle. Follow up with war_room.wait_peer \
                                         (afterChange true) to learn when it needs input or finishes."
                    .into(),
            },
        }))
    }

    #[tool(
        name = "war_room.read_inbox",
        description = "Read and clear your pending War Room messages. Call this when nudged; reply with war_room.send."
    )]
    pub async fn war_room_read_inbox(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> Result<Json<ReadInboxResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let state = self.app.state::<AppState>();
        let (room_id, connected_ev, messages) = {
            let mut rooms = state.war_rooms.lock().unwrap();
            let entry = rooms
                .find_room_of(&terminal.0)
                .ok_or_else(|| rmcp::ErrorData::invalid_request(NOT_IN_ROOM, None))?;
            let room_id = entry.id.clone();
            let room = &mut entry.room;
            let connected_ev = room.mark_connected(&terminal.0, now_ms());
            let messages = room.drain_inbox(&terminal.0).unwrap_or_default();
            (room_id, connected_ev, messages)
        };
        if let Some(ev) = connected_ev {
            let _ = self
                .app
                .emit("warroom:event", &crate::warroom::scoped(&room_id, ev));
        }
        let note = if messages.is_empty() {
            "No pending messages.".into()
        } else {
            "Reply with war_room.send — keep the conversation in the tools, not the terminal."
                .to_string()
        };
        Ok(Json(ReadInboxResult { messages, note }))
    }
}
