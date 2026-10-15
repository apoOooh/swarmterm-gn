//! MCP server: an in-process HTTP endpoint that in-terminal AI agents call to
//! drive Swarmterm (open a browser preview today; more tools later).

pub mod auth;
pub mod catalog;
pub mod clients;
pub mod config;
pub mod context_usage;
pub mod peer_state;
pub mod rate_limits;
pub mod server;
pub mod toggle;
pub mod tools;

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;

use crate::pty::AppState;

/// Bind a random loopback port, spawn the server, and return the resulting URL.
/// The URL is also stored in `AppState.mcp_url` so `spawn_terminal` can inject
/// it into shell env.
pub async fn start(app: AppHandle) -> Result<Arc<str>, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("mcp: bind failed: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let url: Arc<str> = Arc::from(format!("http://{addr}/mcp"));

    // Store before spawning so any race with early PTY creation still sees it.
    let state = app.state::<AppState>();
    state
        .mcp_url
        .set(url.clone())
        .map_err(|_| "mcp: mcp_url already set (start called twice?)".to_string())?;

    // Codex reads MCP servers from config.toml at session start and cannot
    // expand env vars in `url`, so the concrete URL is (re)written every boot.
    // Dev builds skip it: two apps sharing one config.toml would overwrite
    // each other's port, and pane-started Codex is pinned per process anyway.
    if !cfg!(debug_assertions) && toggle::is_enabled("codex", None) {
        config::register_codex(&app, &url);
    }
    // Qwen expands env vars in settings.json, so its placeholder entry is
    // written once (Claude-style); it just rides along at the same call site.
    if toggle::is_enabled("qwen", None) {
        config::register_qwen(&app);
    }

    let router = server::axum_router(app.clone());
    let mut stop = shutdown_signal().subscribe();
    let handle = tokio::spawn(async move {
        let res = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stop.wait_for(|s| *s).await;
            })
            .await;
        // Anything but a requested shutdown leaves every pane's MCP config
        // pointing at a dead port — tell the renderer instead of only logging.
        if !*shutdown_signal().borrow() {
            let reason = match res {
                Ok(()) => "server stopped".to_string(),
                Err(e) => e.to_string(),
            };
            eprintln!("mcp: server exited: {reason}");
            use tauri::Emitter;
            let _ = app.emit("mcp:server-exited", &reason);
        }
    });
    // Kept so a panic inside the server task is reported rather than lost.
    tokio::spawn(async move {
        if let Err(e) = handle.await {
            if e.is_panic() {
                eprintln!("mcp: server task panicked: {e}");
            }
        }
    });

    Ok(url)
}

fn shutdown_signal() -> &'static tokio::sync::watch::Sender<bool> {
    static SIGNAL: std::sync::OnceLock<tokio::sync::watch::Sender<bool>> =
        std::sync::OnceLock::new();
    SIGNAL.get_or_init(|| tokio::sync::watch::channel(false).0)
}

/// Ask the MCP server to stop accepting and close open streams cleanly.
/// Called on app exit; a no-op if the server never started.
pub fn shutdown() {
    shutdown_signal().send_replace(true);
}
