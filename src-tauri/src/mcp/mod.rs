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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;

use crate::pty::AppState;

/// Bind a random loopback port, spawn the server, and return the resulting URL.
/// The URL is also stored in `AppState.mcp_url` so `spawn_terminal` can inject
/// it into shell env.
pub async fn start(app: AppHandle) -> Result<Arc<str>, String> {
    // Panes that survived in the terminal host (SWA-56) carry the previous
    // instance's URL in their environment, which cannot be changed from
    // outside; binding its port again keeps them connected. Still taken
    // after `PREFERRED_PORT_WAIT`: a fresh port, and those panes show `mcp
    // offline` until their agent restarts. Panes created during the wait
    // start without `SWARMTERM_MCP_URL`, as on a failed bind.
    let preferred = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || crate::host_client::preferred_mcp_port(&app))
            .await
            .ok()
            .flatten()
    };
    let listener = match preferred {
        // The usual holder is the previous instance still shutting down (an
        // installer restarting the app, say), so wait for it in this task —
        // nothing else in startup waits on the MCP server.
        Some(port) => match bind_with_retry(port, PREFERRED_PORT_WAIT, PREFERRED_PORT_STEP).await {
            Ok(l) => l,
            Err((e, waited)) => {
                let l = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("mcp: bind failed: {e}"))?;
                let new_port = l.local_addr().map(|a| a.port()).unwrap_or(0);
                eprintln!(
                    "[mcp] previous port {port} unavailable after {} ms ({e}); using port {new_port}",
                    waited.as_millis()
                );
                l
            }
        },
        None => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("mcp: bind failed: {e}"))?,
    };
    // Any child that inherits the listener (a long-lived process started from
    // a command routine, say) keeps the port bound after the app is gone, and
    // a restarted app then cannot take it back for its surviving panes.
    // Sockets are created non-inheritable, except under layered service
    // providers, which some security software installs; mark it explicitly.
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        // SAFETY: a live socket handle owned by `listener`.
        unsafe { SetHandleInformation(listener.as_raw_socket() as _, HANDLE_FLAG_INHERIT, 0) };
    }
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    crate::host_client::publish_mcp_port(&app, addr.port());
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

/// How long to wait for the previous instance's port before taking a new one.
const PREFERRED_PORT_WAIT: Duration = Duration::from_secs(10);
const PREFERRED_PORT_STEP: Duration = Duration::from_millis(200);

/// Bind `127.0.0.1:port`, retrying while it is in use until `window` has
/// passed. No SO_REUSEADDR: on Windows it would let us share the port with a
/// live listener rather than wait for it. Other errors (an excluded port
/// range, say) never clear by waiting and fail at once. The error carries
/// how long it waited.
async fn bind_with_retry(
    port: u16,
    window: Duration,
    step: Duration,
) -> Result<TcpListener, (std::io::Error, Duration)> {
    let started = Instant::now();
    loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                if started.elapsed() >= step {
                    eprintln!(
                        "[mcp] previous port {port} free after {} ms",
                        started.elapsed().as_millis()
                    );
                }
                return Ok(l);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && started.elapsed() < window => {
                tokio::time::sleep(step).await;
            }
            Err(e) => return Err((e, started.elapsed())),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: Duration = Duration::from_millis(20);

    #[tokio::test]
    async fn waits_for_a_held_port_to_free() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let l = bind_with_retry(port, Duration::from_secs(5), STEP)
            .await
            .expect("port freed within the window");
        assert_eq!(l.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn gives_up_after_the_window() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        let window = Duration::from_millis(200);
        let (e, waited) = bind_with_retry(port, window, STEP).await.unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AddrInUse);
        assert!(waited >= window, "waited {waited:?}");
        assert!(waited < Duration::from_secs(2), "waited {waited:?}");
        drop(held);
    }
}
