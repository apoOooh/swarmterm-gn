//! The MCP server surface. One struct = the whole tool set; tool groups are
//! added as additional `impl SwarmtermMcpServer` blocks in dedicated files
//! (e.g. `mcp/tools/browser.rs`). Each such block gets its own
//! `#[tool_router(router = tool_router_<group>)]` (rmcp's macro emits a
//! generated fn per `impl` block, so every group needs a distinct name to
//! avoid colliding on the default `tool_router`); `SwarmtermMcpServer::new`
//! below merges every group's router with `ToolRouter`'s `+` into the single
//! `tool_router` field `#[tool_handler]` reads from.
//!
//! Adding a tool later:
//! 1. Add `pub mod <group>;` in `mcp/tools/mod.rs`.
//! 2. Write an `impl SwarmtermMcpServer` block in `mcp/tools/<group>.rs`
//!    annotated `#[tool_router(router = tool_router_<group>, vis = "pub")]`
//!    (see `mcp/tools/browser.rs`) with `#[tool]` methods, importing
//!    `use rmcp::{tool, tool_router};` (the macros must be in scope
//!    unqualified — invoking them via a fully-qualified `rmcp::tool_router`
//!    path does not expand correctly with this rmcp version).
//! 3. Register that block's router in `SwarmtermMcpServer::new` below via
//!    `Self::tool_router_<group>()`, merged into the `tool_router` field with
//!    `+` if more than one group exists.
//!
//! rmcp 2.1 API notes (verified via context7 / docs.rs, since the plan was
//! written against a hypothetical 0.7 shape that does not match this pin):
//! - `#[tool_router]` on an `impl Self` block collects `#[tool]` methods into
//!   a `ToolRouter<Self>` returned by a generated fn (default name
//!   `tool_router`); `#[tool_handler(router = self.tool_router)]` on
//!   `impl ServerHandler for Self` wires whatever `ToolRouter` is stored in
//!   that field into `ServerHandler::call_tool`/`list_tools` automatically.
//! - A tool method can take `rmcp::handler::server::tool::Extension<http::request::Parts>`
//!   as a parameter to read the raw HTTP request (headers etc.) — the
//!   Streamable-HTTP transport stashes `Parts` in the request extensions
//!   before consuming the body, and `Extension<T>` (like arguments structs)
//!   is extracted via rmcp's `FromContextPart`, so it composes with a
//!   `Parameters<Args>` parameter on the same method.
//! - `rmcp::transport::streamable_http_server::tower::StreamableHttpService::new`
//!   takes `(service_factory: impl Fn() -> Result<S, io::Error>, session_manager: Arc<M>, config: StreamableHttpServerConfig)`.
//!   `StreamableHttpService` implements `tower_service::Service` and is
//!   `Clone`, so it mounts directly via `axum::Router::route_service`.
//! - `rmcp::ErrorData::{invalid_request, invalid_params, internal_error}(message, data: Option<Value>)`
//!   are the constructors used to map auth/validation failures to
//!   JSON-RPC-shaped protocol errors (the MCP client renders these as 4xx-ish
//!   failures, distinct from a tool-level `CallToolResult::error`).
//! - `ServerInfo` (`= InitializeResult`) and `Implementation` are both
//!   `#[non_exhaustive]`, so `get_info` below builds them via their `new`/
//!   `with_*` builder methods rather than a struct literal.

use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool_handler, ServerHandler};
use tauri::{AppHandle, Manager};

use axum::extract::RawQuery;
use axum::extract::State as AxumState;
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;

use crate::mcp::auth::{self, AuthError, TerminalId};
use crate::mcp::context_usage::{self, AgentContextEvent};
use crate::mcp::rate_limits::{self, AgentUsageEvent};
use crate::pty::AppState;

#[derive(Clone)]
pub struct SwarmtermMcpServer {
    pub app: AppHandle,
    tool_router: ToolRouter<Self>,
}

impl SwarmtermMcpServer {
    fn new(app: AppHandle) -> Self {
        // Merge every tool group's router. `+` combines `ToolRouter`s so
        // `#[tool_handler]` sees the union of both groups' `#[tool]` methods.
        Self {
            app,
            tool_router: Self::tool_router_browser()
                + Self::tool_router_worktree()
                + Self::tool_router_warroom()
                + Self::tool_router_peers(),
        }
    }

    /// Resolve the caller's terminal from the bearer header. Returns an rmcp
    /// protocol error (surfaced to the caller roughly as a 401) on failure.
    pub(crate) fn caller(
        &self,
        parts: &axum::http::request::Parts,
    ) -> Result<TerminalId, rmcp::ErrorData> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let token = auth::bearer(header);
        let state = self.app.state::<AppState>();
        let terminals = state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        auth::resolve(token, |id| terminals.contains_key(id)).map_err(|e| match e {
            AuthError::Missing => rmcp::ErrorData::invalid_request("missing bearer token", None),
            AuthError::Unknown => rmcp::ErrorData::invalid_request("unknown session", None),
        })
    }

    /// Gate + context for worktree tools: the calling terminal must belong to
    /// a workspace created with worktree isolation on. Returns the workspace's
    /// repo folder recorded at spawn time.
    pub(crate) fn worktree_ctx(&self, terminal: &TerminalId) -> Result<String, rmcp::ErrorData> {
        let state = self.app.state::<AppState>();
        let terminals = state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let t = terminals
            .get(&terminal.0)
            .ok_or_else(|| rmcp::ErrorData::invalid_request("unknown session", None))?;
        if !t.worktree_mode {
            return Err(rmcp::ErrorData::invalid_request(
                "worktree isolation is not enabled for this workspace — enable \
                 \"Isolate features in git worktrees\" when creating the workspace",
                None,
            ));
        }
        t.repo_root.clone().ok_or_else(|| {
            rmcp::ErrorData::invalid_request(
                "no repository folder recorded for this terminal",
                None,
            )
        })
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SwarmtermMcpServer {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` (aka `InitializeResult`) is `#[non_exhaustive]`, so a
        // field literal is rejected even naming every field — use its builder
        // methods instead.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(
                Implementation::new("swarmterm", env!("CARGO_PKG_VERSION")).with_title("Swarmterm"),
            )
            // The delegation guidance below is what makes agents reach for
            // worktree.spawn unprompted — MCP clients (Claude Code et al.)
            // surface server instructions to the model at session start, so
            // this is the one place the hint lands in every repo without
            // per-project CLAUDE.md edits. Instructions are server-wide and
            // static; the tools themselves stay gated per-workspace, hence
            // the "when the workspace enables them" hedge.
            .with_instructions(
                "Swarmterm in-app tools: control the desktop terminal app from an agent \
                 running inside one of its panes. Because this server is connected, the \
                 user is working inside Swarmterm, which has a built-in web-preview column \
                 beside each terminal. Whenever you start a local dev server or otherwise \
                 produce a viewable http(s) URL, call browser.open_preview with that URL so \
                 the page opens right next to your pane — prefer this over only printing the \
                 URL for the user to copy. When the workspace enables the worktree \
                 tools: given several independent tasks, or one task worth isolating from \
                 the current checkout, prefer delegating each to a parallel agent via \
                 worktree.spawn (one branch per task) instead of editing in place — the \
                 spawned agent starts inside its own git worktree, so parallel work never \
                 collides. If your pane already runs inside a swarm/* worktree, \
                 you may rename that branch to match your actual task (git branch -m \
                 <new-name>) — but never move or rename the worktree DIRECTORY (session \
                 state is keyed by its path). Use worktree.remove to clean up after a branch \
                 is merged. When the user has dragged panes into the War Room (right panel), the \
                 war_room.* tools connect the agents in those panes: list_peers shows who is \
                 present, send carries a message (mode \"probe\") or hands a peer a prompt to \
                 run (mode \"execute\"), read_inbox fetches what peers sent you — read it and \
                 reply promptly when nudged. After handing a peer a prompt with mode \"execute\", \
                 call war_room.wait_peer (afterChange true) to block until it needs input or \
                 finishes instead of polling; war_room.read_peer shows the last lines of a \
                 peer's screen.",
            )
    }

    // `#[rmcp::tool_handler]` wires `call_tool`/`list_tools` to `self.tool_router`
    // — the field name must be `tool_router` (rmcp's macro convention).
}

/// Build the axum router that hosts the MCP server on `POST /mcp`.
///
/// Stateless-session config: each HTTP call is independent (no `Mcp-Session-Id`
/// continuity required across requests). Swarmterm's tools are one-shot
/// (open a preview, etc.) and the bearer token — not an MCP session — is what
/// scopes a call to a terminal, so `LocalSessionManager`'s in-memory session
/// bookkeeping is used purely to satisfy the transport's type, not to persist
/// caller state across calls.
pub fn axum_router(app: AppHandle) -> axum::Router {
    let session_manager = Arc::new(LocalSessionManager::default());
    let service = StreamableHttpService::new(
        {
            let app = app.clone();
            move || Ok(SwarmtermMcpServer::new(app.clone()))
        },
        session_manager,
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new()
        .route_service("/mcp", service)
        // Record every inbound MCP request's bearer BEFORE rmcp consumes the
        // body. This layer — not `SwarmtermMcpServer::caller` — is what makes
        // `initialize` count, and `initialize` is the request that proves the
        // client actually loaded our config. Peeking the JSON-RPC body would
        // mean buffering it; the header is enough.
        //
        // `layer` applies to routes registered ABOVE it only, which is why
        // `/status` is added afterwards: the status probe is Swarmterm asking
        // itself a question, and must never be able to manufacture the
        // `connected` verdict it is about to read. `/hook` sits below the
        // layer for the same reason: a hook POST is Swarmterm's own
        // `--hook` CLI talking to itself, not an MCP client, so it must
        // never stamp `connected` either.
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            record_client,
        ))
        .route("/status", get(status_handler))
        .route("/hook", post(hook_handler))
        .with_state(app)
}

/// Middleware: stamp the caller's token into `AppState.mcp_clients`.
async fn record_client(
    AxumState(app): AxumState<AppHandle>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if let Some(header) = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
    {
        let token = auth::bearer(header).to_owned();
        let state = app.state::<AppState>();
        // Only live pane ids are recorded: `seen` is pruned per PTY, so an
        // arbitrary loopback token would otherwise stay in it forever.
        let live = state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(token.trim());
        let first = live
            && state
                .mcp_clients
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .touch(&token);
        // A client reaching us (usually `initialize`) is the handshake: a
        // member dragged in earlier flips to connected without first having
        // to call a war_room tool (SWA-30). The token is only trusted as a
        // room member id, and only live panes are members.
        if first {
            crate::commands::connect_war_room_member(&app, token.trim());
        }
    }
    next.run(req).await
}

/// The bearer gate shared by the loopback side routes (`/status`, `/hook`):
/// resolve the header's token to a LIVE terminal id, or `None`. Auth goes
/// through `auth::resolve`, so a killed pane's token stops answering the
/// instant its PTY dies — the same revocation rule the MCP tools use.
fn live_caller(app: &AppHandle, headers: &HeaderMap) -> Option<String> {
    let token = auth::bearer(bearer_header(headers));
    let state = app.state::<AppState>();
    let terminals = state
        .terminals
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    auth::resolve(token, |id| terminals.contains_key(id))
        .ok()
        .map(|TerminalId(id)| id)
}

fn bearer_header(headers: &HeaderMap) -> &str {
    headers
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
}

/// Record one context-usage sample for a pane and emit `agent:context` only
/// if the ROUNDED value changed (`ContextUsage::record` is the dedupe). The
/// lock is statement-scoped on purpose: `emit` fans out to every webview and
/// must never run under a mutex that `/status` contends for every render.
fn publish_context(app: &AppHandle, terminal_id: &str, pct: Option<f64>) {
    let change = app
        .state::<AppState>()
        .context_usage
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record(terminal_id, pct);
    if let Some(pct) = change {
        use tauri::Emitter;
        let _ = app.emit(
            "agent:context",
            &AgentContextEvent {
                terminal_id: terminal_id.to_owned(),
                pct,
                at_ms: crate::warroom::now_ms(),
            },
        );
    }
}

/// Record one rate-limit sample for a pane and emit `agent:usage` on change.
/// Same lock discipline as `publish_context`.
fn publish_usage(app: &AppHandle, terminal_id: &str, limits: rate_limits::RateLimits) {
    let change = app
        .state::<AppState>()
        .rate_limit_usage
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record(terminal_id, limits);
    if let Some(limits) = change {
        use tauri::Emitter;
        let _ = app.emit(
            "agent:usage",
            &AgentUsageEvent {
                terminal_id: terminal_id.to_owned(),
                limits,
                at_ms: crate::warroom::now_ms(),
            },
        );
    }
}

/// `GET /status` — the status line's only backend call. Loopback-only (the
/// listener binds `127.0.0.1:0`); it reveals nothing beyond one boolean about
/// the caller's own pane, and records the caller's own context % when the
/// probe rides it in as `?ctx=` (the response body is unchanged — the probe's
/// parser must not care).
async fn status_handler(
    AxumState(app): AxumState<AppHandle>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let Some(terminal_id) = live_caller(&app, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    publish_context(
        &app,
        &terminal_id,
        context_usage::parse_ctx_query(query.as_deref()),
    );
    publish_usage(
        &app,
        &terminal_id,
        rate_limits::parse_query(query.as_deref()),
    );
    let token = auth::bearer(bearer_header(&headers));
    let connected = app
        .state::<AppState>()
        .mcp_clients
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .has_seen(token);
    (
        StatusCode::OK,
        // The probe reads to EOF rather than implementing keep-alive framing.
        [(axum::http::header::CONNECTION, "close")],
        Json(serde_json::json!({ "mcp": { "connected": connected } })),
    )
        .into_response()
}

/// `POST /hook` — the `swarmterm --hook` CLI reporting one Claude Code hook
/// event for its own pane. The body is a closed enum (`HookBody`), never the
/// hook's stdin: prompt text, tool input and cwd stay inside the pane. The
/// verdict is re-emitted to the renderer as `agent:hook` (payload in lockstep
/// with `src/tauri/agent-state.ts::AgentHookEvent`); Rust keeps no hook state
/// itself — precedence over screen-scrape is decided in the renderer.
async fn hook_handler(
    AxumState(app): AxumState<AppHandle>,
    headers: HeaderMap,
    Json(body): Json<crate::hook::HookBody>,
) -> Response {
    let Some(terminal_id) = live_caller(&app, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    use tauri::Emitter;
    if let Some(session) = &body.session {
        let state = app.state::<crate::pty::AppState>();
        let terminals = state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if terminals
            .get(&terminal_id)
            .is_some_and(|t| session.matches(&t.spawn_id, t.agent_id.as_deref()))
        {
            let _ = app.emit(
                "agent:session",
                &crate::hook::AgentSessionEvent {
                    terminal_id: terminal_id.clone(),
                    agent_id: session.agent_id.clone(),
                    session_id: session.session_id.clone(),
                    at_ms: crate::warroom::now_ms(),
                },
            );
        } else {
            return StatusCode::NO_CONTENT.into_response();
        }
    }
    // Codex capture carries no Claude lifecycle authority.
    if body.session.as_ref().is_some_and(|s| s.agent_id == "codex") {
        return StatusCode::NO_CONTENT.into_response();
    }
    let _ = app.emit(
        "agent:hook",
        &crate::hook::AgentHookEvent {
            terminal_id: terminal_id.clone(),
            signal: body.signal,
            at_ms: crate::warroom::now_ms(),
        },
    );
    // SessionEnd must drop the context chip NOW, not at the next launch's
    // first status-line render; and since SessionStart also maps to `Forget`,
    // a relaunched `claude` starts from "no data" even if that render is late.
    if matches!(body.signal, crate::hook::Signal::Forget) {
        publish_context(&app, &terminal_id, None);
    }
    // The CLI reads to EOF with a 300 ms budget; `close` ends it promptly.
    (
        StatusCode::NO_CONTENT,
        [(axum::http::header::CONNECTION, "close")],
    )
        .into_response()
}
