use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use swarmterm_host::output::{next_batch, take_valid_utf8, OUTPUT_IDLE, READ_BUF_BYTES};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Windows Job Object helper: the host crate's (ADR 0001, 0005), so
/// in-process and hosted panes share one implementation, priority limits
/// included. Killing a pty's shell with `TerminateProcess` leaves its
/// children running; a kill-on-close job tears the whole tree down.
#[cfg(windows)]
pub(crate) use swarmterm_host::job;

/// Output streamed to the renderer over a per-terminal channel. Sent as a raw
/// binary IPC body (perf phase 3, see `PtyOut::encode`), not JSON: a 64 KB
/// batch would otherwise pay JSON string escaping on every flush.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtyOut {
    Data(String),
    /// First message of a pane taken over from the terminal host (SWA-56):
    /// its history, rendered at `cols`x`rows`. Not new output — the renderer
    /// writes it without activity ticks and without answering queries in it.
    Replay {
        data: String,
        cols: u16,
        rows: u16,
        /// Older output was dropped by the host's ring.
        truncated: bool,
    },
    Exit {
        exit_code: i32,
    },
}

/// Trailing tag of an encoded [`PtyOut`] (mirrored in `src/tauri/terminal.ts`).
pub const OUT_DATA: u8 = 0;
pub const OUT_REPLAY: u8 = 1;
pub const OUT_EXIT: u8 = 2;

impl PtyOut {
    /// Wire layout: `[body][header json][header_len: u16 LE][tag: u8]`.
    /// The tag goes LAST so a data batch is its own `String` buffer plus
    /// three pushed bytes: no copy of the body on either side (`into_bytes`
    /// is free, the renderer reads `subarray`s). `Data` has an empty header,
    /// `Replay` carries `{cols,rows,truncated}`, `Exit` `{exitCode}` and no
    /// body. The body is exactly the UTF-8 bytes the flow gate counted.
    pub fn encode(self) -> Vec<u8> {
        let (tag, body, header) = match self {
            PtyOut::Data(text) => (OUT_DATA, text, String::new()),
            PtyOut::Replay {
                data,
                cols,
                rows,
                truncated,
            } => (
                OUT_REPLAY,
                data,
                serde_json::json!({ "cols": cols, "rows": rows, "truncated": truncated })
                    .to_string(),
            ),
            PtyOut::Exit { exit_code } => (
                OUT_EXIT,
                String::new(),
                serde_json::json!({ "exitCode": exit_code }).to_string(),
            ),
        };
        debug_assert!(
            header.len() <= u16::MAX as usize,
            "pty output header too long"
        );
        let mut out = body.into_bytes();
        out.reserve_exact(header.len() + 3);
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(&(header.len() as u16).to_le_bytes());
        out.push(tag);
        out
    }

    /// The IPC body: a JSON string for a `Data` batch that Tauri evaluates
    /// directly, else [`PtyOut::encode`] as raw bytes.
    pub fn into_body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        if let PtyOut::Data(text) = &self {
            if text.len() < DIRECT_JSON_LIMIT {
                let json = serde_json::to_string(text)?;
                if json.len() < DIRECT_JSON_LIMIT {
                    // `[utf8_len,"text"]`: the renderer acks and rates this
                    // exact byte count; sending it saves a UTF-8 length scan
                    // of every small batch on the WebView main thread.
                    return Ok(tauri::ipc::InvokeResponseBody::Json(format!(
                        "[{},{json}]",
                        text.len()
                    )));
                }
            }
        }
        Ok(tauri::ipc::InvokeResponseBody::Raw(self.encode()))
    }
}

/// Tauri's direct-eval limit for a JSON channel message (its
/// `MAX_JSON_DIRECT_EXECUTE_THRESHOLD`). A raw message is evaluated
/// directly only below 1 KiB (as a JSON number array); from there on every
/// message costs a separate fetch round trip. Under the flow gate a flood
/// sends many mid-sized batches, and as raw bodies each became one extra
/// IPC request on the WebView's main thread, delaying every pane's echo.
/// So a `Data` batch whose JSON string fits this limit goes as JSON, exactly
/// as before phase 3; only larger ones (which take the fetch path either
/// way) go raw and skip the JSON escaping and parse.
pub const DIRECT_JSON_LIMIT: usize = 8192;

impl tauri::ipc::IpcResponse for PtyOut {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        self.into_body()
    }
}

/// Options the renderer passes when asking the backend to spawn a pty.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalOptions {
    pub account_id: Option<String>,
    pub agent_id: Option<String>,
    pub cwd: Option<String>,
    pub shell_id: Option<String>,
    pub initial_command: Option<String>,
    /// The part of `initial_command` the admin bypass check reads: the agent
    /// command plus its launch-mode args, without a worker's task brief (so
    /// prose in a brief is never taken for a flag). Absent ⇒ the whole line.
    pub launch_line: Option<String>,
    /// Whether the owning workspace enables MCP worktree tools for this pty.
    pub worktree_mode: Option<bool>,
    /// The workspace's repo folder, recorded so worktree tools can resolve the
    /// main root even when this pane's own cwd is a linked worktree.
    pub repo_root: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Flat result mirroring the original TS discriminated union (`ok` / `error`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub shell: Option<String>,
    pub error: Option<String>,
    /// The generation the renderer names in `ack_output` (flow control).
    pub spawn_id: Option<String>,
}

impl CreateTerminalResult {
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            pid: None,
            shell: None,
            error: Some(msg.into()),
            spawn_id: None,
        }
    }
}

/// Input for one pty generation. The blocking `write_all` runs on that
/// generation's own writer thread: a full ConPTY input pipe (big paste into a
/// busy agent) used to stall the main thread AND every other `terminals` lock
/// user. Commands only enqueue, under the lock, so ordering is the enqueue
/// order and a respawn (new generation, new queue) can never receive bytes
/// meant for the old one. A writer parked in `write_all` is not interruptible;
/// it ends when the master closes the pipe (shutdown drops it), and queued
/// bytes are then discarded with the dropped receiver.
///
/// Queued-but-unwritten bytes are capped (INPUT_QUEUE_MAX_BYTES): a hung agent
/// whose input pipe is full would otherwise grow the queue without limit.
pub struct PtyInput {
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    queued: Arc<std::sync::atomic::AtomicUsize>,
    cap: usize,
}

/// Upper bound on bytes waiting for one pty's writer thread.
const INPUT_QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Slice size for the writer thread's pty writes.
const WRITE_CHUNK: usize = 64 * 1024;

impl PtyInput {
    pub fn spawn(writer: Box<dyn Write + Send>) -> Self {
        Self::with_cap(writer, INPUT_QUEUE_MAX_BYTES)
    }

    fn with_cap(mut writer: Box<dyn Write + Send>, cap: usize) -> Self {
        use std::sync::atomic::Ordering;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let drained = queued.clone();
        crate::prof::spawn_named("pty-writer", move || {
            while let Ok(mut bytes) = rx.recv() {
                // Coalesce whatever queued behind a slow write into one write.
                while let Ok(more) = rx.try_recv() {
                    bytes.extend_from_slice(&more);
                }
                // Written in slices so a big paste frees its queue budget as
                // it drains, not only after the very last byte. Budget is
                // released only once written, so a stuck write still counts.
                let mut written = Ok(());
                for chunk in bytes.chunks(WRITE_CHUNK) {
                    written = writer.write_all(chunk);
                    if written.is_err() {
                        break;
                    }
                    drained.fetch_sub(chunk.len(), Ordering::AcqRel);
                }
                if written.and_then(|_| writer.flush()).is_err() {
                    // The pipe is gone: later sends fail with "target-gone".
                    break;
                }
            }
        });
        PtyInput { tx, queued, cap }
    }

    /// Queue bytes for the pty. Err "target-gone" when the writer thread is
    /// gone (pipe closed), "input-queue-full" when the pty is not draining.
    /// An empty queue always accepts one write, however big: the cap guards
    /// against a pty that stopped reading, not against one large paste into
    /// an idle pane (the writer thread drains it in `WRITE_CHUNK` slices).
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        let len = data.len();
        self.queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |q| {
                (q == 0 || q + len <= self.cap).then_some(q + len)
            })
            .map_err(|_| "input-queue-full".to_string())?;
        self.tx.send(data.to_vec()).map_err(|_| {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            "target-gone".to_string()
        })
    }
}

/// A live pty the manager owns. The map entry is the one registry every
/// liveness check reads (MCP auth, War Room, voice pins, `/hook`), whichever
/// backend runs the shell: `io` says where its bytes go.
pub struct ManagedTerminal {
    pub spawn_id: String,
    /// Shell process id; root of the tree `terminal_agent_alive` searches.
    pub pid: Option<u32>,
    pub agent_id: Option<String>,
    /// Configured spawn cwd; OSC 7 shell navigation must not change the explorer's root.
    pub cwd: std::path::PathBuf,
    pub io: TerminalIo,
    pub worktree_mode: bool,
    pub repo_root: Option<String>,
    /// A Claude account profile's own `CLAUDE_CONFIG_DIR` (SWA-58: where the
    /// excerpt reader looks for this pane's transcripts). `None` = default.
    pub claude_config_dir: Option<std::path::PathBuf>,
}

/// Where a pane's PTY lives (SWA-55, ADR 0001).
pub enum TerminalIo {
    /// In this process. `resizer` owns the master (resize + close); `input` for input;
    /// `killer` to terminate the child from the command thread. On Windows
    /// `job` (when set) owns the shell's whole process tree so closing the
    /// terminal frees every descendant, not just the shell.
    Local {
        input: PtyInput,
        resizer: std::sync::Arc<swarmterm_host::resize::Resizer>,
        killer: Box<dyn ChildKiller + Send + Sync>,
        #[cfg(windows)]
        job: Option<job::JobHandle>,
        /// Output backpressure (perf phase 2), shared with the flusher. A
        /// hosted pane's gate lives in the host; its acks are forwarded.
        flow: std::sync::Arc<swarmterm_host::flow::FlowGate>,
    },
    /// In `swarmterm-host.exe`. Every call only enqueues a frame for the
    /// connection's writer, so it is as cheap under the `terminals` lock as
    /// `PtyInput::send`, and the order of enqueues is the order the host
    /// applies them in.
    #[cfg(windows)]
    Host {
        conn: std::sync::Arc<crate::host_client::conn::Conn>,
        /// The map key, repeated: requests name the pane by id.
        terminal_id: String,
    },
}

impl ManagedTerminal {
    /// Queue input. Same contract for both backends: Err "target-gone" when
    /// the pane cannot take input any more, "input-queue-full" when an
    /// in-process pty stopped draining. A hosted pane reports a full queue
    /// asynchronously (`pty:input-dropped`), because waiting for the host's
    /// answer here would hold the `terminals` lock across a pipe round trip.
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        match &self.io {
            TerminalIo::Local { input, .. } => input.send(data),
            #[cfg(windows)]
            TerminalIo::Host { conn, terminal_id } => conn.write(terminal_id, data),
        }
    }

    /// Input for the generation `expected` only (voice). The caller checked
    /// the generation under the `terminals` lock; a hosted pane is checked a
    /// second time by the host, so a respawn the mirror has not seen yet
    /// still cannot receive the bytes.
    pub fn send_checked(&self, expected: &str, data: &[u8]) -> Result<(), String> {
        crate::voice::check_generation(&self.spawn_id, expected)?;
        match &self.io {
            TerminalIo::Local { input, .. } => input.send(data),
            #[cfg(windows)]
            TerminalIo::Host { conn, terminal_id } => {
                conn.write_checked(terminal_id, expected, data)
            }
        }
    }

    /// What the hot commands (ack/release/resize) need, cloned so they can
    /// drop the `terminals` lock before touching the gate or the PTY.
    pub fn handle(&self) -> IoHandle {
        match &self.io {
            TerminalIo::Local { flow, resizer, .. } => IoHandle::Local {
                spawn_id: self.spawn_id.clone(),
                flow: flow.clone(),
                resizer: resizer.clone(),
            },
            #[cfg(windows)]
            TerminalIo::Host { conn, terminal_id } => IoHandle::Host {
                spawn_id: self.spawn_id.clone(),
                conn: conn.clone(),
                terminal_id: terminal_id.clone(),
            },
        }
    }
}

/// A pane's I/O endpoints outside the `terminals` lock (perf step C). Every
/// call here is non-blocking: gates only signal, the resizer only stores the
/// size for its worker, a hosted pane only enqueues a frame. Acks re-check
/// the generation the handle was cloned from, so a respawn racing the
/// unlocked call never pays down the new generation's gate.
#[derive(Clone)]
pub enum IoHandle {
    Local {
        spawn_id: String,
        flow: std::sync::Arc<swarmterm_host::flow::FlowGate>,
        resizer: std::sync::Arc<swarmterm_host::resize::Resizer>,
    },
    #[cfg(windows)]
    Host {
        spawn_id: String,
        conn: std::sync::Arc<crate::host_client::conn::Conn>,
        terminal_id: String,
    },
}

impl IoHandle {
    fn spawn_id(&self) -> &str {
        match self {
            IoHandle::Local { spawn_id, .. } => spawn_id,
            #[cfg(windows)]
            IoHandle::Host { spawn_id, .. } => spawn_id,
        }
    }

    pub fn ack(&self, spawn_id: &str, bytes: u64) {
        if !matches_generation(self.spawn_id(), spawn_id) {
            return;
        }
        match self {
            IoHandle::Local { flow, .. } => flow.ack(bytes),
            #[cfg(windows)]
            IoHandle::Host {
                conn, terminal_id, ..
            } => conn.ack(terminal_id, spawn_id, bytes),
        }
    }

    pub fn release_output(&self, spawn_id: &str) {
        if !matches_generation(self.spawn_id(), spawn_id) {
            return;
        }
        match self {
            IoHandle::Local { flow, .. } => flow.release(),
            #[cfg(windows)]
            IoHandle::Host {
                conn, terminal_id, ..
            // A maximal ack saturates the host gate's debt to zero, which
            // opens it like a local release.
            } => conn.ack(terminal_id, spawn_id, u64::MAX),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        match self {
            IoHandle::Local { resizer, .. } => resizer.request(cols, rows),
            #[cfg(windows)]
            IoHandle::Host {
                conn, terminal_id, ..
            } => conn.resize(terminal_id, cols, rows),
        }
    }
}

impl ManagedTerminal {
    /// Close the terminal the way a regular terminal window does, then make
    /// sure nothing survives. Returns the thread enforcing the deadline, if any.
    ///
    /// Why not just `kill()`: `TerminateJobObject` is a hard kill, so programs
    /// never run their exit handlers. Claude Code records every fullscreen
    /// launch on disk and clears the record on a clean exit; a process that
    /// vanishes before startup finished counts as a fullscreen crash, and after
    /// two strikes it turns fullscreen off machine-wide. Windows Terminal
    /// closes the pseudo console instead, which sends CTRL_CLOSE_EVENT to every
    /// attached process and lets it shut down. We do the same, give the tree
    /// `KILL_GRACE` to exit, and only then terminate the job — so the
    /// "no orphans" guarantee still holds.
    pub fn shutdown(self) -> Option<std::thread::JoinHandle<()>> {
        let (input, master, killer, job) = match self.io {
            TerminalIo::Local {
                input,
                resizer,
                killer,
                #[cfg(windows)]
                job,
                flow,
            } => {
                // The rest of the output and `Exit` must not wait on acks.
                flow.close();
                #[cfg(windows)]
                let job = job;
                #[cfg(not(windows))]
                let job = ();
                (input, resizer, killer, job)
            }
            // The host closes gracefully and enforces KILL_GRACE itself; the
            // id is free here as soon as the entry left the map.
            #[cfg(windows)]
            TerminalIo::Host { conn, terminal_id } => {
                conn.kill(&terminal_id);
                return None;
            }
        };
        #[cfg(windows)]
        {
            let Some(job) = job else {
                let mut killer = killer;
                let _ = killer.kill();
                return None;
            };
            // The deadline starts now and is enforced by its own thread: on
            // pre-24H2 conhost, ClosePseudoConsole can block until the clients
            // detach, so the close runs off the caller's (command/quit) thread
            // and can never delay the hard kill past KILL_GRACE.
            let deadline = std::time::Instant::now() + KILL_GRACE;
            crate::prof::spawn_named("pty-close", move || {
                // Dropping the sender ends the writer thread once it is idle;
                // one parked in write_all is released by the master close.
                drop(input);
                // ClosePseudoConsole: delivers CTRL_CLOSE_EVENT and closes the
                // output pipe, so the reader sees EOF and emits Exit as before.
                // Waits for a resize in flight (it cannot stay stuck: the
                // gate closed above, so the reader drains the pipe).
                drop(master.close());
            });
            Some(crate::prof::spawn_named("pty-killer", move || {
                while std::time::Instant::now() < deadline
                    && job.active_processes().is_some_and(|n| n > 0)
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                job.terminate();
                let mut killer = killer;
                let _ = killer.kill();
            }))
        }
        #[cfg(not(windows))]
        {
            let _ = (input, master.close(), job);
            let mut killer = killer;
            let _ = killer.kill();
            None
        }
    }
}

/// Whether an ack/release naming `given` is for the live generation
/// `current`; one for an older (respawned-over) generation is dropped.
fn matches_generation(current: &str, given: &str) -> bool {
    !given.is_empty() && current == given
}

/// How long a closed pane's process tree may take to exit on its own before
/// it is terminated. Windows gives CTRL_CLOSE_EVENT handlers 5 s; most agents
/// need well under one.
#[cfg(windows)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Global backend state managed by Tauri.
pub struct AppState {
    pub terminals: Mutex<HashMap<String, ManagedTerminal>>,
    /// Set when the user picks Quit from the tray, so close-to-tray is bypassed.
    pub quitting: AtomicBool,
    /// The MCP server's Streamable-HTTP endpoint URL. Set once by `mcp::start`
    /// at app boot; read by `spawn_terminal` to seed each shell's env, and by
    /// nothing else. `OnceLock` is used so the read side needs no lock; if the
    /// server failed to bind the cell stays empty and `spawn_terminal` skips
    /// the env injection (browser preview via MCP just won't work).
    pub mcp_url: OnceLock<Arc<str>>,
    /// War Room membership + inboxes, now multiple independent rooms. Its own
    /// lock (never nested with `terminals`) so MCP tools keep the
    /// lock-read-drop-before-await rule.
    pub war_rooms: Mutex<crate::warroom::WarRooms>,
    /// Panes an MCP client has actually spoken to us from. Its own lock, never
    /// nested with `terminals` or `war_rooms`, because the `/mcp` middleware
    /// touches it on every inbound request and must not contend with pty I/O.
    pub mcp_clients: Mutex<crate::mcp::clients::McpClients>,
    /// MCP bearer secret -> pane id (`mcp::session_tokens`). The pane id is
    /// public to War Room peers, so it never authorises anything itself. Its
    /// own lock, never nested with `terminals` (`live_session_owner` takes
    /// them one after the other).
    pub session_tokens: Mutex<crate::mcp::session_tokens::SessionTokens>,
    /// Last context-window percentage each Claude pane's status line reported
    /// via `/status?ctx=` (`mcp::context_usage`). Its own lock, never nested:
    /// `/status` hits it as often as every 300 ms per Claude pane while
    /// streaming, so it must not queue behind pty spawn/kill or MCP traffic.
    pub context_usage: Mutex<crate::mcp::context_usage::ContextUsage>,
    /// Last broadcast `rate_limits` per pane (`mcp::rate_limits`); own lock.
    pub rate_limit_usage: Mutex<crate::mcp::rate_limits::RateLimitUsage>,
    /// Mirror of the renderer's per-pane agent display state plus a raw
    /// screen tail (`mcp::peer_state`). Its own lock, never nested with
    /// `terminals` / `war_rooms` / `mcp_clients`: `read_loop` touches it on
    /// every pty chunk and `report_agent_state` on every renderer state
    /// change, so it must never wait behind pty spawn/kill or MCP traffic.
    pub peer_states: Mutex<crate::mcp::peer_state::PeerStates>,
    /// Woken (`notify_waiters`) on every `peer_states` mutation so T3.2's
    /// `war_room.wait_peer` can sleep event-driven instead of polling. A bare
    /// `Notify` carries no payload on purpose: waiters re-read the snapshot
    /// after each wake, which makes a lost intermediate change harmless.
    pub peer_wake: tokio::sync::Notify,
    /// Settings → Terminal "Environment": what of the app's environment a
    /// pane or command routine inherits. Read once per spawn and cloned, so
    /// the lock is never held across a spawn or nested with `terminals`.
    pub env_policy: std::sync::RwLock<crate::terminal_env::EnvPolicy>,
    /// Settings → Terminal → Agent safety: what an agent may make other panes do (War Room
    /// execute). Starts at the restrictive default until the renderer pushes
    /// the user's choice, so an early MCP call is never more permissive.
    pub agent_policy: std::sync::RwLock<crate::agent_policy::AgentPolicy>,
    /// Admin policy (`policy.rs`), read once at startup and never written
    /// afterwards: the snapshots below apply it on every read, so a renderer
    /// push can never loosen a lock.
    pub admin_policy: crate::policy::AdminPolicy,
}

impl AppState {
    /// The live pane a bearer secret belongs to, or `None` (unknown secret, or
    /// its pane is gone). The two locks are taken one after the other.
    pub fn live_session_owner(&self, token: &str) -> Option<String> {
        let id = self
            .session_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owner(token)?;
        self.terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&id)
            .then_some(id)
    }

    fn with_session_tokens<R>(
        &self,
        f: impl FnOnce(&mut crate::mcp::session_tokens::SessionTokens) -> R,
    ) -> R {
        f(&mut self
            .session_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Revoke a pane's bearer secret (closed by `kill_terminal`, which runs
    /// before any same-id respawn).
    pub fn forget_session_token(&self, id: &str) {
        self.with_session_tokens(|t| t.forget(id));
    }

    /// A copy of the current env policy; a poisoned lock still yields the
    /// last value rather than failing every spawn.
    pub fn env_policy_snapshot(&self) -> crate::terminal_env::EnvPolicy {
        let user = self
            .env_policy
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.admin_policy.apply_env(user)
    }

    /// A copy of the agent policy; a poisoned lock yields the last value.
    pub fn agent_policy_snapshot(&self) -> crate::agent_policy::AgentPolicy {
        let user = self
            .agent_policy
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.admin_policy.apply_agent(user)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            quitting: AtomicBool::new(false),
            mcp_url: OnceLock::new(),
            war_rooms: Mutex::new(crate::warroom::WarRooms::default()),
            mcp_clients: Mutex::new(crate::mcp::clients::McpClients::default()),
            session_tokens: Mutex::new(Default::default()),
            context_usage: Mutex::new(Default::default()),
            rate_limit_usage: Mutex::new(Default::default()),
            peer_states: Mutex::new(crate::mcp::peer_state::PeerStates::default()),
            peer_wake: tokio::sync::Notify::new(),
            env_policy: Default::default(),
            agent_policy: Default::default(),
            admin_policy: Default::default(),
        }
    }
}

/// The platform default shell and its launch args.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // -NoLogo drops PowerShell's startup banner so panes open clean.
        ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let args = login_args(&shell);
        (shell, args)
    }
}

/// Args that make `shell` start as a *login* shell, or empty if we don't
/// recognise it.
///
/// This matters far more than it looks: a non-login zsh reads neither
/// `/etc/zprofile` (where macOS runs `path_helper`, the source of
/// `/usr/local/bin`) nor `~/.zprofile` (where Homebrew's installer writes
/// `brew shellenv`, the source of `/opt/homebrew/bin`). Panes would inherit
/// only the stub PATH the GUI process was launched with, so `brew`, `gh`,
/// `node`, `docker`… all come back "command not found" while Terminal.app on
/// the same machine works. Every mainstream emulator (Terminal.app, iTerm2,
/// Ghostty, WezTerm, Alacritty) starts a login shell for this reason.
///
/// Unknown shells get no args on purpose: an exotic shell that rejects `-l`
/// would exit immediately and leave a dead pane, which is a worse failure than
/// a short PATH.
#[cfg(not(windows))]
pub fn login_args(shell: &str) -> Vec<String> {
    // Compare on the file name only — `$SHELL` is an absolute path, and some
    // installs carry a version suffix (`bash-5.2`).
    let name = std::path::Path::new(shell)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shell.to_string());
    let stem = name.split('-').next().unwrap_or(&name);
    match stem {
        // `-l` is the login flag for all of these (fish and csh included).
        "sh" | "bash" | "zsh" | "fish" | "ksh" | "mksh" | "dash" | "csh" | "tcsh" => {
            vec!["-l".to_string()]
        }
        _ => vec![],
    }
}

/// The `LANG` value to inject when the parent environment carries no locale at
/// all — the normal state of a GUI app launched from Finder or a desktop shell,
/// which hands us a stub environment with no `LANG`/`LC_*`. Programs in the
/// pane then run under the POSIX "C" locale, and plenty of them degrade to
/// ASCII-only output there (TUIs substitute placeholder glyphs for non-ASCII,
/// `ls` mangles filenames, sort orders change) even though xterm.js decodes
/// UTF-8 unconditionally. Every mainstream emulator (Terminal.app, iTerm2,
/// kitty, WezTerm) papers over this by exporting a UTF-8 locale itself — same
/// class of GUI-launch parity fix as the login-shell PATH story in
/// `login_args`. A user who exports any locale, even a non-UTF-8 one, made a
/// choice; only the "nothing at all" case is filled in. Empty strings count as
/// unset because they select the POSIX locale exactly like absence does.
#[cfg(not(windows))]
pub fn utf8_lang_fallback(
    lang: Option<&str>,
    lc_all: Option<&str>,
    lc_ctype: Option<&str>,
) -> Option<&'static str> {
    let missing = |v: Option<&str>| v.is_none_or(str::is_empty);
    if missing(lang) && missing(lc_all) && missing(lc_ctype) {
        // en_US.UTF-8 ships on every macOS; C.UTF-8 is the one UTF-8 locale
        // modern glibc/musl guarantee without locale generation.
        #[cfg(target_os = "macos")]
        {
            Some("en_US.UTF-8")
        }
        #[cfg(not(target_os = "macos"))]
        {
            Some("C.UTF-8")
        }
    } else {
        None
    }
}

pub fn spawn_terminal(
    app: &AppHandle,
    state: &AppState,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    if state.terminals.lock().unwrap().contains_key(&id) {
        return CreateTerminalResult::err(format!("Terminal \"{id}\" already exists"));
    }
    let result = spawn_terminal_inner(app, state, id.clone(), options, on_data);
    // A failed create never reached `terminals`: drop the pending secret it
    // minted (or adopted) so it does not linger. The duplicate check above
    // returned before any mint, so a live pane's secret is never touched.
    // A concurrent create of the same id that won keeps its secret: skip when
    // the id is live (lock released before `session_tokens` is taken).
    let live = state.terminals.lock().unwrap().contains_key(&id);
    if !result.ok && !live {
        state.forget_session_token(&id);
    }
    result
}

fn spawn_terminal_inner(
    app: &AppHandle,
    state: &AppState,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    // Admin policy: refuse bypass/YOLO lines here, on the final command, so
    // every path that builds one (menus, restore, worktree.spawn) is covered.
    if let Some(line) = launch_line_to_check(
        options.initial_command.as_deref(),
        options.launch_line.as_deref(),
    ) {
        if let Err(e) = state.admin_policy.check_launch_line(line) {
            // A pane of that kind that survived the last app instance in the
            // terminal host must not keep running detached: end it.
            #[cfg(windows)]
            if let Some((_, client)) = app
                .try_state::<crate::host_client::HostHub>()
                .and_then(|hub| hub.take_detached(&id))
            {
                client.conn.kill(&id);
            }
            return CreateTerminalResult::err(e);
        }
    }
    // A pane that survived the last app instance in the terminal host
    // (SWA-56): take it over instead of starting a new one. No template line,
    // no resume — the program is still running.
    #[cfg(windows)]
    let on_data = match app
        .try_state::<crate::host_client::HostHub>()
        .and_then(|hub| hub.take_detached(&id))
    {
        Some((pane, client)) => match attach_hosted(state, &id, pane, on_data, client) {
            Ok(result) => return result,
            Err(on_data) => on_data,
        },
        None => on_data,
    };
    let plan = match plan_spawn(app, state, &id, options) {
        Ok(plan) => plan,
        Err(e) => return CreateTerminalResult::err(e),
    };
    #[cfg(windows)]
    if let Some(client) = app
        .try_state::<crate::host_client::HostHub>()
        .and_then(|hub| hub.for_spawn(app))
    {
        return spawn_hosted(state, id, plan, on_data, client);
    }
    spawn_local(app, state, id, plan, on_data)
}

/// The line the admin bypass check reads. The renderer's `launch_line` is
/// trusted only when the typed line is that prefix plus nothing or one
/// quoted brief (optionally after a short prompt flag such as `-i`, see
/// `spawnPromptFlag` in templates.ts); otherwise the whole line is checked.
fn launch_line_to_check<'a>(initial: Option<&'a str>, launch: Option<&'a str>) -> Option<&'a str> {
    let (Some(line), Some(prefix)) = (initial, launch) else {
        return initial;
    };
    let Some(rest) = line.strip_prefix(prefix) else {
        return Some(line);
    };
    if rest.is_empty() {
        return Some(prefix);
    }
    if !rest.starts_with(' ') {
        return Some(line);
    }
    // Exactly one quoted word, or `-i` plus one (the only prompt flag).
    let quoted = |w: &str| w.starts_with(['\'', '"']);
    let words = crate::policy::shell_words(rest);
    let brief = match words.as_slice() {
        [_] => rest.trim_start(),
        [flag, _] if flag == "-i" => rest.trim_start().strip_prefix("-i ").unwrap_or(""),
        _ => return Some(line),
    };
    if quoted(brief) {
        Some(prefix)
    } else {
        Some(line)
    }
}

/// Everything a pane is started with, resolved once for either backend.
struct SpawnPlan {
    shell: String,
    args: Vec<String>,
    env: crate::terminal_env::EnvPlan,
    cwd: String,
    cols: u16,
    rows: u16,
    initial_line: Option<String>,
    agent_id: Option<String>,
    worktree_mode: bool,
    repo_root: Option<String>,
    claude_config_dir: Option<std::path::PathBuf>,
    /// This generation's MCP bearer secret (`SWARMTERM_SESSION`); kept in the
    /// host's meta so a reattached pane keeps authorising.
    #[cfg_attr(not(windows), allow(dead_code))]
    session_token: String,
}

/// One lock per account id for `accounts::enroll` (see `plan_spawn`).
fn enroll_lock(account_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::Mutex<
        Option<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>,
    > = std::sync::Mutex::new(None);
    LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .entry(account_id.to_string())
        .or_default()
        .clone()
}

fn plan_spawn(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    options: CreateTerminalOptions,
) -> Result<SpawnPlan, String> {
    let account = match options.account_id.as_deref() {
        Some(id) => {
            let account = crate::accounts::resolve(app, id, options.agent_id.as_deref())?;
            // Enrollment merge-writes the profile's config files: two panes
            // of one account starting together must not interleave those
            // read-modify-writes now that creates run concurrently. Keyed
            // per account, so different accounts enroll in parallel.
            let lock = enroll_lock(id);
            let _enroll = lock.lock().unwrap_or_else(|e| e.into_inner());
            crate::accounts::enroll(&account, state.mcp_url.get().map(|url| url.as_ref()))?;
            Some(account)
        }
        None => None,
    };
    let resolved = options
        .shell_id
        .as_deref()
        .and_then(crate::shell::resolve_shell);
    let (shell, args) = resolved.clone().unwrap_or_else(default_shell);

    // Inherit the parent environment minus what the env policy withholds
    // (secrets by default), then advertise truecolor so CLIs emit 24-bit
    // color sequences that ConPTY forwards and xterm renders verbatim. The
    // filter runs before the app's own variables are set, so those always
    // reach the pane. The plan is complete on purpose: the host clears its
    // own environment and spawns exactly this (SWA-54 `CreateSpec.env`).
    let mut env = state.env_policy_snapshot().inherited();
    if let Some(account) = &account {
        crate::accounts::apply_environment(&mut env, account);
    }
    let claude_config_dir = account
        .as_ref()
        .filter(|a| a.agent_id == "claude-code")
        .map(|a| std::path::PathBuf::from(&a.config_dir));
    env.set("COLORTERM", "truecolor");
    env.set("TERM", "xterm-256color");
    // GUI launches arrive with no locale vars; fill in a UTF-8 LANG so CLIs
    // don't degrade to ASCII-only output (see utf8_lang_fallback for the why).
    #[cfg(not(windows))]
    if let Some(lang) = utf8_lang_fallback(
        std::env::var("LANG").ok().as_deref(),
        std::env::var("LC_ALL").ok().as_deref(),
        std::env::var("LC_CTYPE").ok().as_deref(),
    ) {
        env.set("LANG", lang);
    }
    // Ask the shell to report its working directory on every prompt (OSC 7), so
    // relative path links stay resolvable after a `cd`. bash is the only shell we
    // have to arrange this for via the environment: macOS zsh already emits OSC 7
    // from /etc/zshrc and fish does it natively. PowerShell has no environment
    // hook — it falls back to the spawn cwd, so relative links there stop
    // resolving once the user cds away. Prepend rather than replace so a
    // user-configured PROMPT_COMMAND still runs.
    if shell.to_lowercase().contains("bash") {
        let osc7 = r#"printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-}" "$PWD""#;
        // Read from the app env, not the filtered plan: a prompt hook is
        // not a secret and the env policy never names it.
        let existing = std::env::var("PROMPT_COMMAND").unwrap_or_default();
        let combined = if existing.is_empty() {
            osc7.to_string()
        } else {
            format!("{osc7}; {existing}")
        };
        env.set("PROMPT_COMMAND", combined);
    }
    // Identify this session to in-terminal processes so an in-terminal agent
    // can call Swarmterm's MCP server. `SWARMTERM_SESSION` is a random secret
    // minted per spawn (a respawn rotates it) that only this shell's env
    // sees; it is NOT the terminalId, which War Room peers can list, so one
    // pane cannot impersonate another. `SWARMTERM_MCP_URL` points at the
    // Streamable-HTTP endpoint bound at app boot; if the server failed to
    // bind, we skip the URL var (agents just won't have the swarmterm server
    // available) but still set the session so future subsystems can use it.
    // `SWARMTERM_PTY_GENERATION` is stamped by whichever backend creates the
    // generation (`spawn_local` here, the host for hosted panes).
    let session_token = state.with_session_tokens(|t| t.mint(id));
    env.set("SWARMTERM_SESSION", &session_token);
    if let Some(url) = state.mcp_url.get() {
        env.set("SWARMTERM_MCP_URL", url.as_ref());
        // OpenCode gets the server per process via OPENCODE_CONFIG_CONTENT
        // (merged over its own config files), so the user's opencode.json is
        // never written. A value the user already exported wins.
        if options.agent_id.as_deref() == Some("opencode")
            && crate::mcp::toggle::is_enabled("opencode", None)
            && std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none()
        {
            env.set(
                "OPENCODE_CONFIG_CONTENT",
                crate::mcp::config::opencode_config_content(url.as_ref(), &session_token),
            );
        }
    }
    let cwd = options.cwd.clone().unwrap_or_else(|| {
        app.path()
            .home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string())
    });

    // Run the template's first command (clearing the screen first for the
    // platform default shell so the prompt/echo don't linger above the program).
    let initial_line = options.initial_command.as_ref().map(|ic| {
        let ic = crate::hook::codex::isolated_command(
            ic,
            options.agent_id.as_deref(),
            options.agent_id.as_deref() == Some("codex") && crate::hook::codex::supported(),
        );
        // A switched-off profile gets no per-process pin either.
        let mcp_on = options.agent_id.as_deref().is_none_or(|agent| {
            crate::mcp::toggle::is_enabled(agent, options.account_id.as_deref())
        });
        let ic = crate::hook::codex::with_mcp_url(
            &ic,
            options.agent_id.as_deref(),
            state
                .mcp_url
                .get()
                .map(|url| url.as_ref())
                .filter(|_| mcp_on),
        );
        if resolved.is_some() {
            format!("{ic}\r")
        } else {
            let clear = if cfg!(windows) { "Clear-Host" } else { "clear" };
            format!("{clear}; {ic}\r")
        }
    });

    Ok(SpawnPlan {
        shell,
        args,
        env,
        cwd,
        cols: options.cols,
        rows: options.rows,
        initial_line,
        agent_id: options.agent_id,
        worktree_mode: options.worktree_mode.unwrap_or(false),
        repo_root: options.repo_root,
        claude_config_dir,
        session_token,
    })
}

/// Publish the live generation before starting the agent: SessionStart may
/// arrive immediately and must never race the terminal registration. Both
/// backends therefore write the template line only after the map entry
/// exists (a hosted pane gets no `initialInput` for the same reason).
fn send_initial_line(state: &AppState, id: &str, spawn_id: &str, line: Option<String>) {
    let Some(line) = line else { return };
    if let Some(terminal) = state
        .terminals
        .lock()
        .unwrap()
        .get(id)
        .filter(|t| t.spawn_id == spawn_id)
    {
        if let Err(e) = terminal.send(line.as_bytes()) {
            eprintln!("[pty] initial command for {id} dropped: {e}");
        }
    }
}

fn spawn_local(
    app: &AppHandle,
    state: &AppState,
    id: String,
    plan: SpawnPlan,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: plan.rows,
        cols: plan.cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return CreateTerminalResult::err(e.to_string()),
    };

    let mut cmd = CommandBuilder::new(&plan.shell);
    for a in &plan.args {
        cmd.arg(a);
    }
    cmd.env_clear();
    for (k, v) in plan.env.iter() {
        cmd.env(k, v);
    }
    let spawn_id = uuid::Uuid::new_v4().to_string();
    cmd.env("SWARMTERM_PTY_GENERATION", &spawn_id);
    cmd.cwd(&plan.cwd);

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return CreateTerminalResult::err(e.to_string()),
    };
    let pid = child.process_id();
    let killer = child.clone_killer();

    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            // The child already spawned; don't leave it orphaned.
            let _ = child.clone_killer().kill();
            return CreateTerminalResult::err(e.to_string());
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.clone_killer().kill();
            return CreateTerminalResult::err(e.to_string());
        }
    };

    // Capture the shell in a job BEFORE running any command, so every process the
    // command tree spawns is born inside the job and dies with it.
    #[cfg(windows)]
    // The pane's priority limits are in force from birth (ADR 0005).
    let job = pid.and_then(|p| {
        app.state::<crate::child_priority::ChildPriority>()
            .registry()
            .capture(&id, p)
    });

    let waiter_spawn_id = spawn_id.clone();
    let reader_spawn_id = spawn_id.clone();
    let flow = std::sync::Arc::new(swarmterm_host::flow::FlowGate::default());
    state.terminals.lock().unwrap().insert(
        id.clone(),
        ManagedTerminal {
            spawn_id: spawn_id.clone(),
            pid,
            agent_id: plan.agent_id,
            io: TerminalIo::Local {
                input: PtyInput::spawn(writer),
                resizer: swarmterm_host::resize::Resizer::new(pair.master),
                killer,
                #[cfg(windows)]
                job,
                flow: flow.clone(),
            },
            worktree_mode: plan.worktree_mode,
            repo_root: plan.repo_root,
            cwd: std::path::PathBuf::from(&plan.cwd),
            claude_config_dir: plan.claude_config_dir,
        },
    );
    state.with_session_tokens(|t| t.settle(&id));
    send_initial_line(state, &id, &spawn_id, plan.initial_line);

    // A shell that exits on its own (typed `exit`, crash) never closes the
    // ConPTY output pipe while the master lives, so the reader alone would
    // park on read() forever and the pane would never report Exit. The waiter
    // owns the child: once it dies, it drops THIS generation's map entry
    // (spawn_id guards a same-id respawn — though that waits for our Exit
    // anyway) to force the reader's EOF, then hands read_loop the exit code.
    // On the kill_terminal path the entry is already gone and this is a no-op.
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<i32>();
    let waiter_app = app.clone();
    let waiter_id = id.clone();
    let waiter_flow = flow.clone();
    crate::prof::spawn_named(format!("pty-waiter-{waiter_id}"), move || {
        let mut child = child;
        let exit_code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        // The entry (and with it the ack route) goes away next: the tail of
        // the output must flow ungated so `Exit` is never held back.
        waiter_flow.close();
        drop_generation(&waiter_app, &waiter_id, &waiter_spawn_id);
        let _ = exit_tx.send(exit_code);
    });

    let app = app.clone();
    crate::prof::spawn_named(format!("pty-flusher-{id}"), move || {
        read_loop(app, id, reader_spawn_id, reader, exit_rx, on_data, flow);
    });

    CreateTerminalResult {
        ok: true,
        pid,
        shell: Some(plan.shell),
        error: None,
        spawn_id: Some(spawn_id),
    }
}

/// Spawn in the terminal host (SWA-55). The mirror entry is inserted by the
/// `spawned` event (`register_hosted`), which the host sends before the
/// pane's first byte and before this call's answer, so output and an
/// immediate exit can never outrun the registration.
#[cfg(windows)]
fn spawn_hosted(
    state: &AppState,
    id: String,
    plan: SpawnPlan,
    on_data: Channel<PtyOut>,
    client: crate::host_client::Client,
) -> CreateTerminalResult {
    // Kept by the host and returned by `list`, so phase 3 can rebuild the
    // mirror after an app restart without asking anyone.
    let meta = serde_json::json!({
        "agentId": plan.agent_id,
        "worktreeMode": plan.worktree_mode,
        "repoRoot": plan.repo_root,
        "claudeConfigDir": plan.claude_config_dir,
        "sessionToken": plan.session_token,
    });
    let op = serde_json::json!({
        "op": "create",
        "terminalId": id,
        "shell": plan.shell,
        "args": plan.args,
        "env": plan.env.into_map(),
        "cwd": plan.cwd,
        "cols": plan.cols,
        "rows": plan.rows,
        "meta": meta,
    });
    client.sink.routes.lock().unwrap().add_pending(
        &id,
        crate::host_client::PendingTerminal {
            agent_id: plan.agent_id,
            cwd: std::path::PathBuf::from(&plan.cwd),
            worktree_mode: plan.worktree_mode,
            repo_root: plan.repo_root,
            claude_config_dir: plan.claude_config_dir,
        },
        on_data,
    );
    let answer = match client
        .conn
        .request(op, crate::host_client::conn::REQUEST_TIMEOUT)
    {
        Ok(v) => v,
        Err(e) => {
            client.sink.routes.lock().unwrap().cancel_pending(&id);
            return CreateTerminalResult::err(format!("terminal host: {e}"));
        }
    };
    let Some(spawn_id) = answer["spawnId"].as_str() else {
        client.conn.kill(&id);
        return CreateTerminalResult::err("terminal host: answer without a generation");
    };
    // `spawned` precedes the answer on the same pipe, so the entry exists
    // by now — unless `register_hosted` refused it (a live generation held
    // the id). Then this pane is already being closed: say so, don't report
    // a pane that dies on its first frame.
    let registered = state
        .terminals
        .lock()
        .unwrap()
        .get(&id)
        .is_some_and(|t| t.spawn_id == spawn_id);
    if !registered {
        return CreateTerminalResult::err(format!("Terminal \"{id}\" already exists"));
    }
    send_initial_line(state, &id, spawn_id, plan.initial_line);
    CreateTerminalResult {
        ok: true,
        pid: answer["pid"].as_u64().map(|p| p as u32),
        shell: Some(plan.shell),
        error: None,
        spawn_id: Some(spawn_id.to_string()),
    }
}

/// Attach to a detached host pane. The mirror comes from the host's `meta`
/// (it, not the possibly stale saved snapshot, knows the pane's agent and
/// directory); `Conn::attach` returns only after the sink's `attached` has
/// published it and bound the route for the replay. `Err` hands the channel
/// back when the pane is gone by now, so the caller spawns a fresh one.
#[cfg(windows)]
fn attach_hosted(
    state: &AppState,
    id: &str,
    pane: crate::host_client::detached::DetachedPane,
    on_data: Channel<PtyOut>,
    client: crate::host_client::Client,
) -> Result<CreateTerminalResult, Channel<PtyOut>> {
    let meta = &pane.meta;
    let text = |k: &str| meta[k].as_str().map(str::to_string);
    let pending = crate::host_client::PendingTerminal {
        agent_id: text("agentId"),
        cwd: std::path::PathBuf::from(&pane.cwd),
        worktree_mode: meta["worktreeMode"].as_bool().unwrap_or(false),
        repo_root: text("repoRoot"),
        claude_config_dir: text("claudeConfigDir").map(std::path::PathBuf::from),
    };
    // The pane's env still carries the secret it was spawned with; re-learn
    // it so the reattached pane keeps authorising. A pane created by a build
    // before per-pane secrets has none in its meta and its env token is its
    // id, so that legacy pane keeps working until its next respawn.
    let token = text("sessionToken").unwrap_or_else(|| {
        eprintln!("[host] {id}: no session secret in meta (older build); its id stays its bearer until respawn");
        id.to_string()
    });
    state.with_session_tokens(|t| t.adopt(id, &token));
    client
        .sink
        .routes
        .lock()
        .unwrap()
        .add_pending(id, pending, on_data);
    let facts = match client
        .conn
        .attach(id, crate::host_client::conn::REQUEST_TIMEOUT)
    {
        Ok(v) => v,
        Err(e) => {
            let back = client.sink.routes.lock().unwrap().cancel_pending(id);
            return match (e.as_str(), back) {
                ("target-gone", Some((_, on_data))) => Err(on_data),
                _ => Ok(CreateTerminalResult::err(format!("terminal host: {e}"))),
            };
        }
    };
    let spawn_id = facts["spawnId"].as_str().unwrap_or("");
    let registered = state
        .terminals
        .lock()
        .unwrap()
        .get(id)
        .is_some_and(|t| t.spawn_id == spawn_id);
    if !registered {
        return Ok(CreateTerminalResult::err(format!(
            "Terminal \"{id}\" already exists"
        )));
    }
    Ok(CreateTerminalResult {
        ok: true,
        pid: facts["pid"].as_u64().map(|p| p as u32),
        shell: None,
        error: None,
        spawn_id: Some(spawn_id.to_string()),
    })
}

/// `spawned` from the host: the generation exists, publish it in the map.
#[cfg(windows)]
pub fn register_hosted(
    app: &AppHandle,
    id: &str,
    spawn_id: &str,
    pid: Option<u32>,
    pending: crate::host_client::PendingTerminal,
    conn: std::sync::Arc<crate::host_client::conn::Conn>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut map = state.terminals.lock().unwrap();
    // `create_terminal` reserved the id and `spawn_terminal` refused a live
    // duplicate already;
    // never replace a live generation from an event.
    if map.contains_key(id) {
        eprintln!("[host] spawned {id} while a generation is live; closing it");
        drop(map);
        conn.kill(id);
        return;
    }
    map.insert(
        id.to_string(),
        ManagedTerminal {
            spawn_id: spawn_id.to_string(),
            pid,
            agent_id: pending.agent_id,
            cwd: pending.cwd,
            io: TerminalIo::Host {
                conn,
                terminal_id: id.to_string(),
            },
            worktree_mode: pending.worktree_mode,
            repo_root: pending.repo_root,
            claude_config_dir: pending.claude_config_dir,
        },
    );
    // Never nest `session_tokens` inside `terminals`.
    drop(map);
    state.with_session_tokens(|t| t.settle(id));
}

/// Drop `id`'s map entry if it still belongs to `spawn_id` (the waiter's job
/// in-process, `removed` from the host). Bound before the drop so the master
/// is released outside the lock.
pub fn drop_generation(app: &AppHandle, id: &str, spawn_id: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let removed = {
            let mut map = state.terminals.lock().unwrap();
            remove_generation(&mut map, id, |t| t.spawn_id == spawn_id).0
        };
        drop(removed);
    }
}

/// Remove `id` only if it still belongs to this generation. Returns the removed
/// entry and whether a different generation now holds the id (superseded).
fn remove_generation<T>(
    map: &mut HashMap<String, T>,
    id: &str,
    is_own: impl Fn(&T) -> bool,
) -> (Option<T>, bool) {
    match map.get(id) {
        Some(t) if is_own(t) => (map.remove(id), false),
        Some(_) => (None, true),
        None => (None, false),
    }
}

/// Blocking read loop: stream decoded output, then wait for exit and clean up.
fn read_loop(
    app: AppHandle,
    id: String,
    spawn_id: String,
    mut reader: Box<dyn Read + Send>,
    exit_rx: std::sync::mpsc::Receiver<i32>,
    on_data: Channel<PtyOut>,
    flow: std::sync::Arc<swarmterm_host::flow::FlowGate>,
) {
    // Reader → flusher split. ConPTY reads block, so coalescing needs its own
    // thread: the reader decodes (UTF-8 boundary handling stays HERE, so the
    // flusher only ever joins whole strings) and the flusher below batches a
    // TUI redraw's many small reads into one tail push, one waiter wake and
    // one IPC message. The first chunk after a quiet spell is sent at once
    // (keystroke echo latency unchanged); only bursts wait up to
    // OUTPUT_COALESCE. The channel closing means EOF with every byte —
    // including the lossy trailing flush — already queued, so `Exit` below
    // can never overtake output.
    //
    // Flow control (perf phase 2): the flusher parks while the renderer is
    // more than FLOW_HIGH behind (`FlowGate`), and the queue is bounded, so
    // the reader then blocks, stops reading, and ConPTY backpressures the
    // child instead of the WebView buffering GBs. Input is a separate thread
    // (`PtyInput`) and never waits on this.
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(swarmterm_host::flow::READ_QUEUE_DEPTH);
    crate::prof::spawn_named(format!("pty-reader-{id}"), move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; READ_BUF_BYTES];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&chunk[..n]);
                    if let Some(text) = take_valid_utf8(&mut pending) {
                        // Time blocked here = the bounded queue was full,
                        // i.e. the flusher (or the flow gate) is behind.
                        let t0 = crate::prof::now();
                        if tx.send(text).is_err() {
                            return;
                        }
                        crate::prof::since("chan.read_queue.send_block", t0);
                    }
                }
            }
        }
        // Flush any trailing bytes (lossily) so nothing is lost.
        if !pending.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
        }
    });

    let mut last_flush = std::time::Instant::now() - OUTPUT_IDLE;
    while let Ok(first) = rx.recv() {
        let text = next_batch(&rx, first, last_flush.elapsed() >= OUTPUT_IDLE);
        let t0 = crate::prof::now();
        flow.wait();
        crate::prof::since("flow.park", t0);
        let n = text.len();
        deliver_output(&app, &id, text, &on_data);
        flow.sent(n);
        last_flush = std::time::Instant::now();
    }
    // The waiter thread owns the child; EOF means it is dead or about to be
    // (kill_terminal dropped the master after killing it).
    let exit_code = exit_rx.recv().unwrap_or(-1);
    finish_generation(&app, &id, &spawn_id, exit_code, &on_data);
}

/// One output batch to the renderer, for either backend.
pub fn deliver_output(app: &AppHandle, id: &str, text: String, on_data: &Channel<PtyOut>) {
    // Tee into the Rust-side screen tail BEFORE the renderer sees it, so a
    // `read_peer` racing this batch never reads less than xterm shows.
    // Lock scope is the one statement — never held across the send. `None`
    // only during teardown, when there is nobody left to read the tail.
    if let Some(state) = app.try_state::<AppState>() {
        crate::prof::lock("lock.peer_states.output", &state.peer_states).push_output(
            id,
            &text,
            crate::warroom::now_ms(),
        );
        // No `peer_wake` here: output only pushes a `wait_peer` stall verdict
        // later, never produces one, and the loop re-reads the output clock
        // on its own stall timer (`mcp::tools::peers::wait_loop`). Waking
        // every waiter per batch only churned locks under a flood.
    }
    let _span = crate::prof::span("ipc.channel_send");
    let _ = on_data.send(PtyOut::Data(text));
}

/// A reattached pane's history: into the screen tail like output (so
/// `read_peer` sees what xterm shows), then to the renderer as `Replay`.
pub fn deliver_replay(app: &AppHandle, id: &str, replay: PtyOut, on_data: &Channel<PtyOut>) {
    if let (Some(state), PtyOut::Replay { data, .. }) = (app.try_state::<AppState>(), &replay) {
        state
            .peer_states
            .lock()
            .unwrap()
            .push_output(id, data, crate::warroom::now_ms());
    }
    let _ = on_data.send(replay);
}

/// A generation ended (EOF in-process, `exit` or a lost connection for a
/// hosted pane): free the id, clean up per-pane state, then tell the
/// renderer. Every byte of the generation was delivered before this runs.
pub fn finish_generation(
    app: &AppHandle,
    id: &str,
    spawn_id: &str,
    exit_code: i32,
    on_data: &Channel<PtyOut>,
) {
    // Remove from the registry BEFORE notifying the renderer: a retry triggered by
    // the exit event must find the id free, since create rejects a duplicate live id.
    // A same-id respawn that did not wait for our Exit owns the slot now: leave
    // its entry and its per-id state alone (mirrors the waiter's spawn_id check).
    let superseded = app.try_state::<AppState>().is_some_and(|state| {
        let mut map = state.terminals.lock().unwrap();
        let (removed, superseded) = remove_generation(&mut map, id, |t| t.spawn_id == spawn_id);
        drop(map);
        drop(removed);
        superseded
    });
    if let Some(state) = app.try_state::<AppState>().filter(|_| !superseded) {
        state.mcp_clients.lock().unwrap().forget(id);
        // Settled only: a same-id respawn may already hold a pending secret.
        state.with_session_tokens(|t| t.forget_settled(id));
        // Same-id respawn must start from "no data", not its predecessor's %.
        state.context_usage.lock().unwrap().forget(id);
        state.rate_limit_usage.lock().unwrap().forget(id);
        // Drop the state mirror + screen tail and wake any `wait_peer` sleeper
        // so it can report "peer left" instead of sitting out its timeout.
        state.peer_states.lock().unwrap().forget(id);
        state.peer_wake.notify_waiters();
        let left = state
            .war_rooms
            .lock()
            .unwrap()
            .leave_everywhere(id, crate::warroom::now_ms());
        if let Some((room_id, event)) = left {
            use tauri::Emitter;
            let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
        }
        crate::voice::drop_terminal(app, id);
        // Same preview cleanup as kill_terminal: this is the path a shell
        // takes when it exits on its own (typed `exit`, crashed), where no one
        // called kill_terminal. preview:closed tells the renderer too — the
        // store's visibility effects assume webview lifetime is bounded by
        // their own setup/cleanup, and a Rust-side close they never observe
        // would leave a stale preview + a permanently hidden webview on the
        // next preview_open.
        if let Some(webview) = app.get_webview(&crate::preview::preview_label(id)) {
            let _ = webview.close();
            use tauri::Emitter;
            let _ = app.emit(
                "preview:closed",
                &crate::preview::PreviewClosedEvent {
                    terminal_id: id.to_string(),
                },
            );
        }
    }
    let _ = on_data.send(PtyOut::Exit { exit_code });
}

#[cfg(test)]
mod tests {
    #[test]
    fn launch_line_skips_only_a_quoted_brief() {
        use super::launch_line_to_check as pick;
        let base = "claude --permission-mode default";
        let brief = format!("{base} 'run npx -y and never --yolo'");
        assert_eq!(pick(Some(&brief), Some(base)), Some(base));
        for (line, prefix) in [
            ("gemini -y 'x'", "gemini"),
            ("cursor-agent -f 'x'", "cursor-agent"),
            ("claude 'a' --yolo 'b'", "claude"),
        ] {
            assert_eq!(pick(Some(line), Some(prefix)), Some(line));
        }
        let posix = format!(r"{base} 'it'\''s -y'");
        assert_eq!(pick(Some(&posix), Some(base)), Some(base));
        let flagged = "gemini -i \"use -y\"";
        assert_eq!(pick(Some(flagged), Some("gemini")), Some("gemini"));
        assert_eq!(pick(Some(base), Some(base)), Some(base));
        // Anything but a quoted brief after the prefix: check it all.
        let extra = "claude --dangerously-skip-permissions 'x'";
        assert_eq!(pick(Some(extra), Some("claude")), Some(extra));
        assert_eq!(
            pick(Some("codex -a never"), Some("claude")),
            Some("codex -a never")
        );
        assert_eq!(pick(Some(base), None), Some(base));
        assert_eq!(pick(None, Some(base)), None);
    }

    #[test]
    fn env_policy_defaults_to_filtering_and_snapshot_follows_writes() {
        use crate::terminal_env::{EnvPlan, EnvPolicy};
        let state = AppState::default();
        let secret = || EnvPlan::from_vars([("FOO_API_KEY".to_string(), "x".to_string())]);
        assert_eq!(state.env_policy_snapshot(), EnvPolicy::default());
        assert_eq!(
            state.env_policy_snapshot().filter(secret()).iter().count(),
            0
        );
        state.env_policy.write().unwrap().allow = vec!["FOO_API_KEY".into()];
        assert_eq!(
            state.env_policy_snapshot().filter(secret()).iter().count(),
            1
        );
    }

    use super::*;

    #[test]
    fn flow_acks_only_reach_the_live_generation() {
        assert!(matches_generation("gen-2", "gen-2"));
        assert!(!matches_generation("gen-2", "gen-3"));
        // A stale id from before a same-id respawn.
        assert!(!matches_generation("gen-2", "gen-1"));
        assert!(!matches_generation("gen-2", ""));
    }

    #[test]
    fn remove_generation_spares_a_respawned_entry() {
        let mut map = HashMap::from([("t".to_string(), "new".to_string())]);
        // Old generation's reader finishing after a same-id respawn.
        let (removed, superseded) = remove_generation(&mut map, "t", |g| g == "old");
        assert!(removed.is_none() && superseded);
        assert!(map.contains_key("t"));
        let (removed, superseded) = remove_generation(&mut map, "t", |g| g == "new");
        assert_eq!(removed.as_deref(), Some("new"));
        assert!(!superseded && map.is_empty());
        assert_eq!(remove_generation(&mut map, "t", |_| true), (None, false));
    }

    struct SharedSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for SharedSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BrokenSink;
    impl Write for BrokenSink {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_writes_in_enqueue_order() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::spawn(Box::new(SharedSink(buf.clone())));
        for s in ["a", "b", "c", "d"] {
            input.send(s.as_bytes()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < 4 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(&*buf.lock().unwrap(), b"abcd");
    }

    /// Blocks every write until the test releases it: a pty that stopped reading.
    struct StuckSink(std::sync::mpsc::Receiver<()>);
    impl Write for StuckSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_rejects_input_past_the_queue_cap() {
        let (release, gate) = std::sync::mpsc::channel();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"abcd"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
        drop(release); // writer drains, budget is freed
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Err(String::new());
        while std::time::Instant::now() < deadline {
            res = input.send(b"e");
            if res.is_ok() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Ok(()));
    }

    #[test]
    fn pty_input_accepts_one_oversized_write_on_an_idle_queue() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::with_cap(Box::new(SharedSink(buf.clone())), 4);
        let big = vec![b'x'; WRITE_CHUNK * 3 + 7];
        assert_eq!(input.send(&big), Ok(()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < big.len() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(buf.lock().unwrap().len(), big.len());
    }

    #[test]
    fn pty_input_oversized_write_still_blocks_followups_while_stuck() {
        let (_release, gate) = std::sync::mpsc::channel::<()>();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"0123456789"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
    }

    #[test]
    fn pty_input_reports_target_gone_after_writer_dies() {
        let input = PtyInput::spawn(Box::new(BrokenSink));
        let _ = input.send(b"x");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Ok(());
        while std::time::Instant::now() < deadline {
            res = input.send(b"y");
            if res.is_err() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Err("target-gone".to_string()));
    }

    #[test]
    fn default_shell_is_nonempty() {
        let (cmd, _args) = default_shell();
        assert!(!cmd.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn default_shell_is_a_login_shell() {
        let (_cmd, args) = default_shell();
        assert!(
            args.iter().any(|a| a == "-l"),
            "unix panes must spawn a login shell, got args {args:?}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_cover_the_common_posix_shells() {
        for shell in [
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh",
            "/opt/homebrew/bin/fish",
            "/bin/ksh",
        ] {
            assert_eq!(login_args(shell), vec!["-l".to_string()], "{shell}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_are_empty_for_unknown_shells() {
        // An unrecognised shell may reject `-l` and leave the pane dead on
        // arrival; no args is the safe fallback.
        assert!(login_args("/usr/local/bin/nu").is_empty());
        assert!(login_args("/usr/bin/xonsh").is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_ignore_the_directory_and_version_suffix() {
        assert_eq!(login_args("zsh"), vec!["-l".to_string()]);
        assert_eq!(
            login_args("/usr/local/bin/bash-5.2"),
            vec!["-l".to_string()]
        );
    }

    /// Split an encoded `PtyOut` the way `src/tauri/terminal.ts` does.
    fn split(out: &[u8]) -> (u8, &[u8], serde_json::Value) {
        let tag = out[out.len() - 1];
        let hlen = u16::from_le_bytes([out[out.len() - 3], out[out.len() - 2]]) as usize;
        let hstart = out.len() - 3 - hlen;
        let header = if hlen == 0 {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&out[hstart..out.len() - 3]).unwrap()
        };
        (tag, &out[..hstart], header)
    }

    #[test]
    fn data_encodes_its_utf8_bytes_with_a_trailing_tag() {
        let text = "h\u{e9}\u{1F600}\x1b[0m".to_string();
        let out = PtyOut::Data(text.clone()).encode();
        assert_eq!(
            split(&out),
            (OUT_DATA, text.as_bytes(), serde_json::Value::Null)
        );
        assert_eq!(out.len(), text.len() + 3);
    }

    #[test]
    fn replay_encodes_history_and_a_json_header() {
        let out = PtyOut::Replay {
            data: "hist\u{2500}".into(),
            cols: 120,
            rows: 40,
            truncated: true,
        }
        .encode();
        let (tag, body, header) = split(&out);
        assert_eq!((tag, body), (OUT_REPLAY, "hist\u{2500}".as_bytes()));
        assert_eq!(
            header,
            serde_json::json!({"cols":120,"rows":40,"truncated":true})
        );
    }

    #[test]
    fn small_data_goes_as_json_large_as_raw() {
        use tauri::ipc::InvokeResponseBody as B;
        match PtyOut::Data("a\u{1b}b".into()).into_body().unwrap() {
            B::Json(j) => assert_eq!(j, r#"[3,"a\u001bb"]"#),
            B::Raw(_) => panic!("small data must be json"),
        }
        for big in [
            "x".repeat(DIRECT_JSON_LIMIT),
            // Fits as text, but its escaped JSON does not.
            "\u{1b}".repeat(DIRECT_JSON_LIMIT / 4),
        ] {
            match PtyOut::Data(big.clone()).into_body().unwrap() {
                B::Raw(r) => assert_eq!(r, PtyOut::Data(big).encode()),
                B::Json(_) => panic!("large data must be raw"),
            }
        }
        assert!(matches!(
            PtyOut::Exit { exit_code: 0 }.into_body().unwrap(),
            B::Raw(_)
        ));
    }

    #[test]
    fn exit_encodes_an_empty_body_and_its_code() {
        let out = PtyOut::Exit { exit_code: -1 }.encode();
        assert_eq!(
            split(&out),
            (OUT_EXIT, &b""[..], serde_json::json!({"exitCode":-1}))
        );
    }

    #[test]
    fn empty_replay_still_carries_its_size() {
        let out = PtyOut::Replay {
            data: String::new(),
            cols: 80,
            rows: 24,
            truncated: false,
        }
        .encode();
        let (tag, body, header) = split(&out);
        assert_eq!(
            (tag, body.len(), header["cols"].as_u64()),
            (OUT_REPLAY, 0, Some(80))
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_fills_a_bare_gui_environment() {
        // Finder/desktop launch: no locale vars at all → inject a UTF-8 LANG.
        let lang = utf8_lang_fallback(None, None, None).unwrap();
        assert!(lang.contains("UTF-8"));
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_treats_empty_values_as_unset() {
        // An empty LANG selects the POSIX locale exactly like an absent one.
        assert!(utf8_lang_fallback(Some(""), Some(""), None).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_respects_any_explicit_locale() {
        // A user who exports a locale — even a non-UTF-8 one — keeps it.
        assert!(utf8_lang_fallback(Some("en_US.UTF-8"), None, None).is_none());
        assert!(utf8_lang_fallback(Some("C"), None, None).is_none());
        assert!(utf8_lang_fallback(None, Some("C"), None).is_none());
        assert!(utf8_lang_fallback(None, None, Some("vi_VN.UTF-8")).is_none());
    }
}
