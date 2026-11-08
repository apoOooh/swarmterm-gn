//! MCP orchestrator verbs over the peer-state mirror: `war_room.read_peer`
//! (last lines of a peer's screen) and `war_room.wait_peer` (block until a
//! peer reaches a state). Both read `AppState.peer_states` (`mcp/peer_state`),
//! the table the renderer mirrors its display state into and `read_loop` tees
//! output into. Gated per-call on live room membership like every other
//! `war_room.*` tool.
//!
//! Why these verbs exist: without them an orchestrating agent that handed a
//! peer a prompt (`war_room.send` mode `execute`) has no way to know when the
//! peer needs input or finished, so it polls `list_peers` / re-sends probes —
//! burning its own turns and the peer's inbox on noise. `wait_peer` turns that
//! into one blocking call; `read_peer` answers "what is it actually showing"
//! without a hand-typed `read_inbox` round-trip through the peer.
//!
//! The wait loop is event-driven over `AppState.peer_wake`, a broadcast
//! `tokio::sync::Notify`. Every verdict-relevant mutation (state report,
//! room membership, forget on pty death) calls `notify_waiters`, never
//! `notify_one`: several orchestrators may wait on the same peer, and
//! `notify_one` would wake exactly one of them and strand the rest until the
//! next mutation. `notify_waiters` has no permit semantics, which forces the
//! ordering rule below.
//!
//! Lost-wakeup rule: each iteration pins `peer_wake.notified()` and calls
//! `enable()` BEFORE taking the snapshot. `Notified` only starts listening
//! once enabled (or first polled); a wake that lands between "snapshot says
//! not yet" and "start listening" would otherwise be dropped and the loop
//! would sleep until the next unrelated mutation or the stall/deadline timer.
//! Enable first, then look, then await: a wake after the look is captured, a
//! wake before it is irrelevant because the look already sees the new value.
//!
//! Locking: the loop takes three SEQUENTIAL scoped `std::sync::Mutex` guards
//! (`terminals`, `peer_states`, `war_rooms`) and drops each before the next —
//! never one guard across the `.await`. `std::sync::MutexGuard` is `!Send`, so
//! the compiler rejects holding it across an await point in a tool future;
//! this is deliberate, not an inconvenience — the pty reader thread and the
//! renderer's `report_agent_state` command contend on the same locks and must
//! never queue behind a sleeping waiter. The three reads are not atomic as a
//! set, but the death paths remove the terminal BEFORE forgetting its row, so
//! `!pty_live` is observed no later than the row vanishes and the `PeerLeft`
//! verdict closes the race.
//!
//! Stall only counts after a hand-off (`afterChange`): a peer that is `idle`
//! and silent is simply idle, not stuck. But a peer that was just given a
//! prompt and neither changes state nor prints anything for `STALL_MS` most
//! likely never received it (paste landed in a modal, wrong pane, CLI hung on
//! a permission dialog the heuristics do not recognise). Reporting `stalled`
//! early lets the orchestrator `read_peer` and recover instead of burning the
//! whole timeout.
//!
//! Neither verb calls `mark_connected`: the statusline's "connected" proof is
//! an MCP handshake from THAT pane's agent, and these verbs are the caller
//! observing someone else — recording them would mislabel a plain-shell peer
//! as connected the moment anyone looked at it.

use rmcp::schemars;
use serde::{Deserialize, Serialize};

use crate::mcp::peer_state::PeerSnapshot;

/// Silence budget after a hand-off before `wait_peer` reports `stalled`.
/// 5 s covers a CLI's thinking pause before its first token (the agent-state
/// heuristics flip to `working` on output, so a live peer changes something
/// well within this) while still being short enough that a lost paste is
/// surfaced long before the 60 s default deadline.
pub const STALL_MS: u64 = 5_000;
/// Default `wait_peer` deadline: long enough for a real turn, short enough
/// that an orchestrator whose peer went quiet gets control back to re-plan.
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Hard cap on a single `wait_peer` call. A tool call that blocks longer than
/// this pins an MCP request (and a tokio task) for as long as the model's own
/// client timeout allows; callers that need more simply call again.
pub const MAX_TIMEOUT_MS: u64 = 300_000;
/// `read_peer` default: roughly one screenful, the same order of magnitude as
/// what the user sees in the pane.
pub const DEFAULT_LINES: usize = 40;
/// `read_peer` cap: the ring behind `screen()` is byte-bounded anyway
/// (`SCREEN_TAIL_BYTES`), so this only keeps the tool result a sane size.
pub const MAX_LINES: usize = 200;
/// Every state the renderer mirror can report (`lib/agent-state` display
/// states) plus the "no row yet" placeholder. `parse_until` rejects anything
/// else so a typo like `"finished"` fails fast instead of waiting 60 s.
pub const KNOWN_STATES: [&str; 5] = ["working", "blocked", "idle", "done", "unknown"];

/// Why a `wait_peer` call returned. `snake_case` on the wire so the values
/// read like the state strings next to them (`"peer_left"`, not `"PeerLeft"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The peer is in one of the `until` states (and, with `afterChange`,
    /// got there after the wait began).
    Reached,
    /// Deadline passed with no verdict.
    Timeout,
    /// `afterChange` was set and the peer neither changed state nor printed
    /// anything for `STALL_MS` — the hand-off most likely never landed.
    Stalled,
    /// The peer's pty died or it left the caller's room mid-wait.
    PeerLeft,
}

/// Everything one `wait_peer` iteration observed, gathered under three
/// sequential locks and then judged lock-free so the rule set is unit-testable
/// without an `AppState`.
pub struct WaitInput<'a> {
    /// State the peer was in when the wait began (`"unknown"` if no row).
    pub initial_state: &'a str,
    /// `None` = the row does not exist yet: the peer is live but has never
    /// reported a state nor printed a byte. Treated as `"unknown"` since the
    /// wait began, NOT as gone — `pty_live`/`in_room` decide "gone".
    pub current: Option<&'a PeerSnapshot>,
    pub pty_live: bool,
    pub in_room: bool,
    pub until: &'a [String],
    pub after_change: bool,
    pub start_ms: u64,
    pub now_ms: u64,
    pub deadline_ms: u64,
}

/// `None` = keep waiting. Precedence: `PeerLeft` → `Reached` → `Timeout` →
/// `Stalled`. Gone beats everything because any other verdict would invite
/// the caller to `read_peer`/`send` toward a pane that no longer exists;
/// reached beats timeout so a wake that races the deadline still reports the
/// useful answer; stall is last because it is a heuristic, not a fact.
pub fn wait_verdict(i: &WaitInput) -> Option<Outcome> {
    if !i.pty_live || !i.in_room {
        return Some(Outcome::PeerLeft);
    }
    // A missing row is a peer that has been silent since before the wait —
    // the same thing as a row stamped at `start` in every rule below.
    let (state, since_ms, last_output_ms) = match i.current {
        Some(s) => (s.state.as_str(), s.since_ms, s.last_output_ms),
        None => ("unknown", i.start_ms, i.start_ms),
    };
    // A `since` bump with the same state string is still a change: the peer
    // left the state and came back (idle → working → idle) between two looks.
    let changed = state != i.initial_state || since_ms > i.start_ms;
    if i.until.iter().any(|u| u == state) && (!i.after_change || changed) {
        return Some(Outcome::Reached);
    }
    if i.now_ms >= i.deadline_ms {
        return Some(Outcome::Timeout);
    }
    // Output that predates the wait does not count as "alive": measure the
    // silence from the wait start or the last chunk, whichever is later.
    let quiet_since = i.start_ms.max(last_output_ms);
    if i.after_change && !changed && i.now_ms.saturating_sub(quiet_since) >= STALL_MS {
        return Some(Outcome::Stalled);
    }
    None
}

/// One look at the peer, taken by `wait_loop` after arming the wake.
pub struct Look {
    pub pty_live: bool,
    pub snapshot: Option<PeerSnapshot>,
    pub in_room: bool,
}

/// The `wait_peer` loop, generic over the look and the clock so tests can
/// drive it without an `AppState`. Arms the listener BEFORE each look
/// (lost-wakeup rule, see module doc): `notify_waiters` carries no permit, so
/// a wake that fires before `enable()` would otherwise vanish.
///
/// `wake` fires on state reports, membership changes and pty death only —
/// NOT on output. Output can only move `last_output_ms` forward, which only
/// pushes the stall verdict later; no verdict can flip TO a result because of
/// a chunk. So the loop sleeps until the stall deadline computed from the
/// last look, re-reads `last_output_ms` there and re-arms if output arrived
/// meanwhile. Waking every waiter per output batch (hundreds per second
/// under a flood) bought nothing but lock traffic.
#[allow(clippy::too_many_arguments)]
pub async fn wait_loop(
    wake: &tokio::sync::Notify,
    mut look: impl FnMut() -> Look,
    clock: impl Fn() -> u64,
    initial_state: &str,
    until: &[String],
    after_change: bool,
    start: u64,
    deadline: u64,
) -> (Outcome, Option<PeerSnapshot>) {
    loop {
        let mut notified = std::pin::pin!(wake.notified());
        notified.as_mut().enable();
        let Look {
            pty_live,
            snapshot,
            in_room,
        } = look();
        let now = clock();
        let verdict = wait_verdict(&WaitInput {
            initial_state,
            current: snapshot.as_ref(),
            pty_live,
            in_room,
            until,
            after_change,
            start_ms: start,
            now_ms: now,
            deadline_ms: deadline,
        });
        if let Some(o) = verdict {
            return (o, snapshot);
        }
        // The stall timer is only armed with `afterChange` and is measured
        // from the later of the wait start and the last output chunk — the
        // same clock `wait_verdict` judges by, so the forced re-check lands
        // exactly when the verdict can flip.
        let stall_deadline = after_change.then(|| {
            let last_output = snapshot.as_ref().map_or(start, |s| s.last_output_ms);
            start.max(last_output) + STALL_MS
        });
        let wait = Duration::from_millis(next_wake_ms(now, deadline, stall_deadline));
        // Either a mutation woke us or the timer fired; both just mean "look
        // again", so the result is irrelevant.
        let _ = tokio::time::timeout(wait, notified).await;
    }
}

/// `None` → default; capped at `MAX_TIMEOUT_MS`; floored at 1 so a caller
/// passing 0 gets one immediate look instead of a zero-length sleep loop.
pub fn clamp_timeout(ms: Option<u64>) -> u64 {
    ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS)
}

/// `None` → `DEFAULT_LINES`; capped at `MAX_LINES`; floored at 1 (zero lines
/// is a pointless call, not an error worth a round-trip).
pub fn clamp_lines(n: Option<usize>) -> usize {
    n.unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES)
}

/// Milliseconds until the loop must re-check even without a wake: the
/// earlier of the deadline and the stall deadline (when armed), never below
/// 1 ms so a past deadline yields one more look that turns into `Timeout`
/// rather than a `timeout(0)` that never polls the `Notified` future.
pub fn next_wake_ms(now_ms: u64, deadline_ms: u64, stall_deadline_ms: Option<u64>) -> u64 {
    let target = match stall_deadline_ms {
        Some(s) => deadline_ms.min(s),
        None => deadline_ms,
    };
    target.saturating_sub(now_ms).max(1)
}

/// Validate the caller's `until` list. `None` → the "needs attention" set
/// (`blocked`, `idle`, `done`): the three states after which the peer will
/// not make progress on its own. An empty list is rejected rather than
/// defaulted because it can only ever time out, which is never what a caller
/// meant.
pub fn parse_until(until: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let Some(list) = until else {
        return Ok(["blocked", "idle", "done"]
            .iter()
            .map(|s| s.to_string())
            .collect());
    };
    if list.is_empty() {
        return Err(format!(
            "`until` must name at least one state (one of {})",
            KNOWN_STATES.join(", ")
        ));
    }
    if let Some(bad) = list.iter().find(|s| !KNOWN_STATES.contains(&s.as_str())) {
        return Err(format!(
            "unknown state {bad:?} in `until` (expected one of {})",
            KNOWN_STATES.join(", ")
        ));
    }
    Ok(list)
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadPeerResult {
    pub peer: String,
    pub name: String,
    pub state: String,
    /// When `state` was entered (unix ms); 0 when the peer has no row yet.
    pub since_ms: u64,
    /// ANSI-stripped last N lines of the peer's screen buffer.
    pub text: String,
    /// True when the buffer held more lines than were returned.
    pub truncated: bool,
    pub note: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitPeerResult {
    pub peer: String,
    /// The peer's state at the moment the verdict was reached.
    pub state: String,
    pub outcome: Outcome,
    pub waited_ms: u64,
    pub note: String,
}

// --- tool methods on the shared server struct ---

use rmcp::handler::server::wrapper::{Json, Parameters};
// `tool` / `tool_router` MUST be imported bare — see mcp/server.rs module docs.
use rmcp::{tool, tool_router};
use tauri::Manager;

use crate::mcp::peer_state::tail_lines;
use crate::mcp::server::SwarmtermMcpServer;
use crate::mcp::tools::warroom::NOT_IN_ROOM;
use crate::pty::AppState;
use crate::warroom::{now_ms, MODERATOR_ID};
use std::time::Duration;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadPeerArgs {
    /// Target peer's terminalId (from war_room.list_peers). Must be another
    /// member of your room — not yourself, not the Moderator.
    pub peer: String,
    /// How many lines from the bottom of the peer's screen to return
    /// (default 40, max 200).
    pub lines: Option<usize>,
}

/// Wire keys are camelCase (`timeoutMs`, `afterChange`) to match the result
/// structs and the `PeerEntry` rows of `list_peers` — one casing across the
/// whole `war_room.*` surface. `WarRoomSendArgs` gets away without the rename
/// only because every field there is a single word.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitPeerArgs {
    /// Target peer's terminalId (from war_room.list_peers). Must be another
    /// agent member of your room — a plain shell has no agent state to wait on.
    pub peer: String,
    /// States that end the wait; any of working, blocked, idle, done, unknown.
    /// Default ["blocked", "idle", "done"]: the states after which the peer
    /// makes no progress without input.
    pub until: Option<Vec<String>>,
    /// Give up after this many milliseconds (default 60000, max 300000).
    /// On "timeout" nothing is lost — call again to keep waiting.
    pub timeout_ms: Option<u64>,
    /// Set true right after a war_room.send mode "execute" hand-off: only a
    /// state entered AFTER this call began counts as reached, and 5 s with
    /// neither a state change nor any output returns "stalled" (the prompt
    /// most likely never landed — read_peer to check).
    pub after_change: Option<bool>,
}

/// Room-membership gate shared by both verbs. Resolves the caller's room,
/// rejects the targets that can never be observed, and hands back the
/// target's display name plus whether it runs an agent CLI (`wait_peer`
/// refuses plain shells — they have no state to wait on). Takes and drops
/// the `war_rooms` lock inside; the result carries no borrow so callers can
/// go on to the next lock without nesting.
fn peer_target(
    state: &AppState,
    caller: &str,
    peer: &str,
) -> Result<(String, bool), rmcp::ErrorData> {
    let mut rooms = state
        .war_rooms
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let entry = rooms
        .find_room_of(caller)
        .ok_or_else(|| rmcp::ErrorData::invalid_request(NOT_IN_ROOM, None))?;
    if peer == caller {
        return Err(rmcp::ErrorData::invalid_params(
            "that is your own terminal — read your own screen directly instead of \
             going through war_room",
            None,
        ));
    }
    if peer == MODERATOR_ID {
        return Err(rmcp::ErrorData::invalid_params(
            "the Moderator is the human user and has no terminal — probe them with \
             war_room.send instead",
            None,
        ));
    }
    let member = entry
        .room
        .peers()
        .into_iter()
        .find(|(id, _)| id == peer)
        .map(|(_, m)| (m.display_name.clone(), m.agent_id.is_some()))
        .ok_or_else(|| {
            rmcp::ErrorData::invalid_params(
                format!("{peer:?} is not in your room — call war_room.list_peers for the current members"),
                None,
            )
        })?;
    Ok(member)
}

#[tool_router(router = tool_router_peers, vis = "pub")]
impl SwarmtermMcpServer {
    #[tool(
        name = "war_room.read_peer",
        description = "Read the last lines of a War Room peer's terminal screen (ANSI stripped) together with its current agent state (working/blocked/idle/done/unknown). Use it to see what a peer is actually showing — a permission prompt, an error, its final answer — without sending it a message. Only works when both panes are in the same War Room."
    )]
    pub async fn war_room_read_peer(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<ReadPeerArgs>,
    ) -> Result<Json<ReadPeerResult>, rmcp::ErrorData> {
        let terminal = self.war_room_caller(&parts)?;
        let state = self.app.state::<AppState>();
        // Membership and screen live under different locks; the gate drops
        // `war_rooms` before `peer_states` is taken (see module doc). A peer
        // that leaves between the two reads still gets its (now stale) screen
        // back — harmless, and the next call fails the gate.
        let (name, _is_agent) = peer_target(&state, &terminal.0, &args.peer)?;
        let (screen, snapshot) = {
            let peers = state
                .peer_states
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (peers.screen(&args.peer), peers.snapshot(&args.peer))
        };
        let (text, truncated) = tail_lines(&screen.unwrap_or_default(), clamp_lines(args.lines));
        // No row yet = live pane that never printed nor reported: report it
        // as `unknown` since "never", not as an error — a freshly spawned
        // shell is a legitimate thing to look at.
        let (peer_state, since_ms) = snapshot
            .map(|s| (s.state, s.since_ms))
            .unwrap_or_else(|| ("unknown".to_string(), 0));
        Ok(Json(ReadPeerResult {
            peer: args.peer,
            name,
            state: peer_state,
            since_ms,
            text,
            truncated,
            note: "This is the ANSI-stripped tail of the peer's screen buffer, not a live \
                   view — call again for fresh output. To block until the peer needs \
                   input or finishes, use war_room.wait_peer."
                .into(),
        }))
    }

    #[tool(
        name = "war_room.wait_peer",
        description = "Block until a War Room peer reaches one of the `until` states (default: blocked, idle or done — i.e. it needs input or finished), then return its state. Call it right after handing a peer a prompt with war_room.send mode \"execute\" (set afterChange true) instead of polling list_peers or re-sending probes. Returns outcome reached | timeout | stalled | peer_left; on timeout simply call again. Agent peers only — plain shells have no state (use read_peer)."
    )]
    pub async fn war_room_wait_peer(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<WaitPeerArgs>,
    ) -> Result<Json<WaitPeerResult>, rmcp::ErrorData> {
        let terminal = self.war_room_caller(&parts)?;
        let state = self.app.state::<AppState>();
        let (_name, is_agent) = peer_target(&state, &terminal.0, &args.peer)?;
        if !is_agent {
            return Err(rmcp::ErrorData::invalid_params(
                format!(
                    "{:?} is a plain shell and has no agent state to wait on — use \
                     war_room.read_peer to see its screen",
                    args.peer
                ),
                None,
            ));
        }
        let until =
            parse_until(args.until).map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;
        let after_change = args.after_change.unwrap_or(false);
        let start = now_ms();
        let deadline = start + clamp_timeout(args.timeout_ms);
        // `start` is stamped BEFORE this look so a state change that lands in
        // between still carries `since_ms > start` and counts as "changed".
        let initial = state
            .peer_states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot(&args.peer)
            .map(|s| s.state)
            .unwrap_or_else(|| "unknown".to_string());
        let look = || {
            // Three sequential scoped locks; each guard is dropped at the end
            // of its statement so nothing is held across the `.await`.
            let pty_live = state
                .terminals
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains_key(&args.peer);
            let snapshot = state
                .peer_states
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .snapshot(&args.peer);
            let in_room = state
                .war_rooms
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .find_room_of(&terminal.0)
                .is_some_and(|e| e.room.is_member(&args.peer));
            Look {
                pty_live,
                snapshot,
                in_room,
            }
        };
        let (outcome, snapshot) = wait_loop(
            &state.peer_wake,
            look,
            now_ms,
            &initial,
            &until,
            after_change,
            start,
            deadline,
        )
        .await;
        let peer_state = snapshot
            .map(|s| s.state)
            .unwrap_or_else(|| "unknown".to_string());
        let note = match outcome {
            Outcome::Reached => format!(
                "peer is {peer_state} — call war_room.read_peer for its screen and \
                 war_room.read_inbox for anything it sent you"
            ),
            Outcome::Timeout => format!(
                "deadline passed with the peer still {peer_state} — call war_room.wait_peer \
                 again to keep waiting, or war_room.read_peer to see what it is doing"
            ),
            Outcome::Stalled => format!(
                "the peer neither changed state nor printed anything for {} s after the \
                 hand-off — the prompt most likely did not land; call war_room.read_peer to \
                 see its screen and re-send if needed",
                STALL_MS / 1_000
            ),
            Outcome::PeerLeft => "the peer left the room or its pane closed — call \
                                  war_room.list_peers for the current members"
                .to_string(),
        };
        Ok(Json(WaitPeerResult {
            peer: args.peer,
            state: peer_state,
            outcome,
            waited_ms: now_ms().saturating_sub(start),
            note,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::peer_state::PeerSnapshot;

    fn snap(state: &str, since_ms: u64, last_output_ms: u64) -> PeerSnapshot {
        PeerSnapshot {
            state: state.to_string(),
            since_ms,
            last_output_ms,
        }
    }

    fn until(states: &[&str]) -> Vec<String> {
        states.iter().map(|s| s.to_string()).collect()
    }

    /// Builder over the `wait_verdict` input with the boring fields defaulted:
    /// peer live and in-room, wait started at t=1000, deadline 60 s later.
    fn input<'a>(
        initial_state: &'a str,
        current: Option<&'a PeerSnapshot>,
        until: &'a [String],
        after_change: bool,
        now_ms: u64,
    ) -> WaitInput<'a> {
        WaitInput {
            initial_state,
            current,
            pty_live: true,
            in_room: true,
            until,
            after_change,
            start_ms: 1_000,
            now_ms,
            deadline_ms: 61_000,
        }
    }

    // --- wait_loop (paused tokio clock; output never notifies) ---

    use std::sync::{Arc, Mutex};

    /// Shared fake peer the tests mutate the way the real mutators do:
    /// state/exit changes call `notify_waiters`, output only stamps
    /// `last_output_ms` (exactly what `deliver_output` now does).
    struct Fake {
        epoch: tokio::time::Instant,
        live: Mutex<bool>,
        snap: Mutex<Option<PeerSnapshot>>,
        wake: tokio::sync::Notify,
    }

    impl Fake {
        fn new(state: &str) -> Arc<Fake> {
            Arc::new(Fake {
                epoch: tokio::time::Instant::now(),
                live: Mutex::new(true),
                snap: Mutex::new(Some(snap(state, 0, 0))),
                wake: tokio::sync::Notify::new(),
            })
        }
        fn now(&self) -> u64 {
            self.epoch.elapsed().as_millis() as u64
        }
        fn set_state(&self, state: &str) {
            let now = self.now();
            let mut g = self.snap.lock().unwrap();
            let last = g.as_ref().map_or(0, |s| s.last_output_ms);
            *g = Some(snap(state, now, last));
            drop(g);
            self.wake.notify_waiters();
        }
        fn output(&self) {
            let now = self.now();
            if let Some(s) = self.snap.lock().unwrap().as_mut() {
                s.last_output_ms = now;
            }
        }
        fn exit(&self) {
            *self.live.lock().unwrap() = false;
            *self.snap.lock().unwrap() = None;
            self.wake.notify_waiters();
        }
    }

    async fn run(
        f: Arc<Fake>,
        until: Vec<String>,
        after_change: bool,
        timeout: u64,
    ) -> (Outcome, u64) {
        let look = || Look {
            pty_live: *f.live.lock().unwrap(),
            snapshot: f.snap.lock().unwrap().clone(),
            in_room: true,
        };
        let (o, _) = wait_loop(
            &f.wake,
            look,
            || f.now(),
            "working",
            &until,
            after_change,
            0,
            timeout,
        )
        .await;
        (o, f.now())
    }

    #[tokio::test(start_paused = true)]
    async fn wait_loop_resolves_on_idle_without_output_wakes() {
        let f = Fake::new("working");
        let g = f.clone();
        tokio::spawn(async move {
            // Output keeps flowing (no wakes), then the state report wakes.
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(300)).await;
                g.output();
            }
            g.set_state("idle");
        });
        let (o, at) = run(f, until(&["idle"]), true, 60_000).await;
        assert_eq!(o, Outcome::Reached);
        assert_eq!(at, 3_000);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_loop_stall_counts_from_last_output_seen_on_timer() {
        let f = Fake::new("working");
        let g = f.clone();
        tokio::spawn(async move {
            // Output at 4 s with no wake: the 5 s re-check must see it and
            // re-arm instead of reporting a stall.
            tokio::time::sleep(Duration::from_millis(4_000)).await;
            g.output();
        });
        let (o, at) = run(f, until(&["idle"]), true, 60_000).await;
        assert_eq!(o, Outcome::Stalled);
        assert_eq!(at, 4_000 + STALL_MS);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_loop_stalls_on_silence() {
        let (o, at) = run(Fake::new("working"), until(&["idle"]), true, 60_000).await;
        assert_eq!(o, Outcome::Stalled);
        assert_eq!(at, STALL_MS);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_loop_resolves_on_exit() {
        let f = Fake::new("working");
        let g = f.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1_234)).await;
            g.exit();
        });
        let (o, at) = run(f, until(&["idle"]), false, 60_000).await;
        assert_eq!(o, Outcome::PeerLeft);
        assert_eq!(at, 1_234);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_loop_times_out_under_output_only() {
        let f = Fake::new("working");
        let g = f.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                g.output();
            }
        });
        let (o, at) = run(f, until(&["idle"]), true, 20_000).await;
        assert_eq!(o, Outcome::Timeout);
        assert_eq!(at, 20_000);
    }

    // --- wait_verdict ---

    #[test]
    fn reached_default_until_on_idle() {
        let u = parse_until(None).unwrap();
        let s = snap("idle", 500, 500);
        let i = input("working", Some(&s), &u, false, 1_100);
        assert_eq!(wait_verdict(&i), Some(Outcome::Reached));
    }

    #[test]
    fn reached_requires_change_when_after_change() {
        let u = until(&["idle"]);
        // Same state, same `since` as before the wait: nothing happened yet.
        let same = snap("idle", 500, 500);
        let i = input("idle", Some(&same), &u, true, 1_100);
        assert_eq!(wait_verdict(&i), None);
        // A later `since` proves the peer left idle and came back.
        let bumped = snap("idle", 1_050, 1_050);
        let i = input("idle", Some(&bumped), &u, true, 1_100);
        assert_eq!(wait_verdict(&i), Some(Outcome::Reached));
    }

    #[test]
    fn since_bump_counts_as_changed() {
        let u = until(&["done"]);
        let s = snap("done", 2_000, 2_000);
        let i = input("done", Some(&s), &u, true, 2_100);
        assert_eq!(wait_verdict(&i), Some(Outcome::Reached));
    }

    #[test]
    fn timeout_when_deadline_passed() {
        let u = until(&["done"]);
        let s = snap("working", 900, 60_900);
        let i = input("working", Some(&s), &u, false, 61_000);
        assert_eq!(wait_verdict(&i), Some(Outcome::Timeout));
        let i = input("working", Some(&s), &u, false, 70_000);
        assert_eq!(wait_verdict(&i), Some(Outcome::Timeout));
    }

    #[test]
    fn stalled_after_5s_no_output_after_change() {
        let u = until(&["done"]);
        // Last output predates the wait; nothing since. 5 s later → stalled.
        let s = snap("working", 900, 900);
        let i = input("working", Some(&s), &u, true, 1_000 + STALL_MS);
        assert_eq!(wait_verdict(&i), Some(Outcome::Stalled));
        // One ms short is still waiting.
        let i = input("working", Some(&s), &u, true, 1_000 + STALL_MS - 1);
        assert_eq!(wait_verdict(&i), None);
    }

    #[test]
    fn not_stalled_when_output_arrived() {
        let u = until(&["done"]);
        let s = snap("working", 900, 4_000);
        let i = input("working", Some(&s), &u, true, 1_000 + STALL_MS);
        assert_eq!(wait_verdict(&i), None);
    }

    #[test]
    fn not_stalled_without_after_change() {
        let u = until(&["done"]);
        let s = snap("working", 900, 900);
        let i = input("working", Some(&s), &u, false, 1_000 + STALL_MS);
        assert_eq!(wait_verdict(&i), None);
    }

    #[test]
    fn peer_left_when_pty_dead() {
        let u = until(&["done"]);
        let s = snap("working", 900, 900);
        let mut i = input("working", Some(&s), &u, false, 1_100);
        i.pty_live = false;
        assert_eq!(wait_verdict(&i), Some(Outcome::PeerLeft));
    }

    #[test]
    fn peer_left_when_not_in_room() {
        let u = until(&["done"]);
        let s = snap("working", 900, 900);
        let mut i = input("working", Some(&s), &u, false, 1_100);
        i.in_room = false;
        assert_eq!(wait_verdict(&i), Some(Outcome::PeerLeft));
    }

    #[test]
    fn none_snapshot_is_unknown_not_left() {
        // A live pane that never reported and never printed has no row yet —
        // that is "unknown", not "gone".
        let u = until(&["unknown"]);
        let i = input("unknown", None, &u, false, 1_100);
        assert_eq!(wait_verdict(&i), Some(Outcome::Reached));
        let d = parse_until(None).unwrap();
        let i = input("unknown", None, &d, false, 1_100);
        assert_eq!(wait_verdict(&i), None);
    }

    #[test]
    fn peer_left_beats_reached() {
        let u = until(&["idle"]);
        let s = snap("idle", 1_050, 1_050);
        let mut i = input("working", Some(&s), &u, false, 1_100);
        i.pty_live = false;
        assert_eq!(wait_verdict(&i), Some(Outcome::PeerLeft));
    }

    #[test]
    fn reached_beats_timeout() {
        let u = until(&["idle"]);
        let s = snap("idle", 1_050, 1_050);
        let i = input("working", Some(&s), &u, false, 99_000);
        assert_eq!(wait_verdict(&i), Some(Outcome::Reached));
    }

    // --- clamps ---

    #[test]
    fn clamp_timeout_defaults_caps_and_floors() {
        assert_eq!(clamp_timeout(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(None), 60_000);
        assert_eq!(clamp_timeout(Some(1_000_000)), MAX_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(1_000_000)), 300_000);
        assert_eq!(clamp_timeout(Some(0)), 1);
        assert_eq!(clamp_timeout(Some(5_000)), 5_000);
    }

    #[test]
    fn clamp_lines_defaults_caps_and_floors() {
        assert_eq!(clamp_lines(None), DEFAULT_LINES);
        assert_eq!(clamp_lines(None), 40);
        assert_eq!(clamp_lines(Some(999)), MAX_LINES);
        assert_eq!(clamp_lines(Some(999)), 200);
        assert_eq!(clamp_lines(Some(0)), 1);
        assert_eq!(clamp_lines(Some(10)), 10);
    }

    // --- next_wake_ms ---

    #[test]
    fn next_wake_picks_stall_when_earlier_than_deadline() {
        assert_eq!(next_wake_ms(1_000, 61_000, Some(6_000)), 5_000);
    }

    #[test]
    fn next_wake_picks_deadline_without_stall() {
        assert_eq!(next_wake_ms(1_000, 61_000, None), 60_000);
        // A stall deadline later than the real deadline never extends it.
        assert_eq!(next_wake_ms(1_000, 61_000, Some(70_000)), 60_000);
    }

    #[test]
    fn next_wake_never_below_one_ms() {
        assert_eq!(next_wake_ms(61_000, 61_000, None), 1);
        assert_eq!(next_wake_ms(70_000, 61_000, Some(6_000)), 1);
    }

    // --- parse_until ---

    #[test]
    fn parse_until_none_is_the_attention_set() {
        assert_eq!(
            parse_until(None).unwrap(),
            until(&["blocked", "idle", "done"])
        );
    }

    #[test]
    fn parse_until_keeps_known_states() {
        assert_eq!(
            parse_until(Some(until(&["done"]))).unwrap(),
            until(&["done"])
        );
        assert!(parse_until(Some(until(&KNOWN_STATES))).is_ok());
    }

    #[test]
    fn parse_until_rejects_unknown_state_by_name() {
        let err = parse_until(Some(until(&["done", "nope"]))).unwrap_err();
        assert!(
            err.contains("nope"),
            "error should name the bad entry: {err}"
        );
    }

    #[test]
    fn parse_until_rejects_empty_list() {
        // An empty `until` can never be reached — only ever time out.
        assert!(parse_until(Some(vec![])).is_err());
    }

    // --- serde ---

    #[test]
    fn wait_peer_result_serializes_camelcase_and_snake_outcome() {
        let r = WaitPeerResult {
            peer: "t2".into(),
            state: "unknown".into(),
            outcome: Outcome::PeerLeft,
            waited_ms: 1_234,
            note: String::new(),
        };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["waitedMs"], 1_234);
        assert_eq!(j["outcome"], "peer_left");
        assert!(j.get("waited_ms").is_none());
    }

    #[test]
    fn outcome_variants_serialize_snake_case() {
        for (o, s) in [
            (Outcome::Reached, "reached"),
            (Outcome::Timeout, "timeout"),
            (Outcome::Stalled, "stalled"),
            (Outcome::PeerLeft, "peer_left"),
        ] {
            assert_eq!(serde_json::to_value(o).unwrap(), s);
        }
    }

    #[test]
    fn read_peer_result_serializes_camelcase() {
        let r = ReadPeerResult {
            peer: "t2".into(),
            name: "Codex".into(),
            state: "working".into(),
            since_ms: 42,
            text: "hello".into(),
            truncated: false,
            note: String::new(),
        };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["sinceMs"], 42);
        assert_eq!(j["truncated"], false);
        assert!(j.get("since_ms").is_none());
    }
}
