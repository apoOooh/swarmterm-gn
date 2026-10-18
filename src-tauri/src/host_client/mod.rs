//! The app as client of the terminal host (SWA-55, ADR 0001 phase 2).
//!
//! Behind Settings → Terminal (`settings.rs`, default off). When on, new
//! panes spawn in `swarmterm-host.exe` instead of in-process; running panes
//! keep the backend they started with, so the switch is safe mid-session.
//!
//! The app's `AppState.terminals` map stays the one registry every liveness
//! check reads (MCP bearer auth, War Room, voice pins, `/hook`): a hosted
//! pane is a `ManagedTerminal` whose I/O goes to the pipe (`pty::TerminalIo`).
//! The host's events keep that mirror in step — `spawned` inserts, `removed`
//! drops the entry (the waiter's job in-process), `exit` runs the same
//! cleanup as `read_loop` (`pty::finish_generation`) — so "a token
//! authorises only while its PTY is live" holds unchanged.
//!
//! A lost connection ends every hosted pane like a PTY exit; the next create
//! reconnects (and starts a host if none runs). Phase 3 replaces that with
//! reattach.

pub mod routes;
pub mod settings;

#[cfg(windows)]
pub mod conn;
#[cfg(windows)]
pub mod launch;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use settings::HostSettings;

#[derive(Default)]
pub struct HostHub {
    settings: Mutex<HostSettings>,
    #[cfg(windows)]
    client: Mutex<Option<Client>>,
    last_error: Mutex<Option<String>>,
}

#[cfg(windows)]
#[derive(Clone)]
pub struct Client {
    pub conn: std::sync::Arc<conn::Conn>,
    pub sink: std::sync::Arc<AppSink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub enabled: bool,
    pub supported: bool,
    pub connected: bool,
    pub host_version: Option<String>,
    pub error: Option<String>,
}

impl HostHub {
    pub fn enabled(&self) -> bool {
        self.settings.lock().unwrap().enabled
    }

    /// The connection a new pane should use, connecting (and starting the
    /// host) on demand. `None` = spawn in-process: the switch is off, or the
    /// host is unavailable — then the reason is kept for Settings and the
    /// pane still opens, because a terminal app that cannot open terminals
    /// is the worse failure.
    #[cfg(windows)]
    pub fn for_spawn(&self, app: &AppHandle) -> Option<Client> {
        if !self.enabled() {
            return None;
        }
        let mut slot = self.client.lock().unwrap();
        if let Some(c) = slot.as_ref().filter(|c| c.conn.is_alive()) {
            return Some(c.clone());
        }
        match connect(app) {
            Ok(c) => {
                *slot = Some(c.clone());
                *self.last_error.lock().unwrap() = None;
                Some(c)
            }
            Err(e) => {
                eprintln!("[host] falling back to in-process terminals: {e}");
                *self.last_error.lock().unwrap() = Some(e);
                None
            }
        }
    }

    #[cfg(not(windows))]
    pub fn for_spawn(&self, _app: &AppHandle) -> Option<()> {
        None
    }

    /// Every connection still open, for quit's flush.
    #[cfg(windows)]
    pub fn current(&self) -> Option<Client> {
        self.client
            .lock()
            .unwrap()
            .clone()
            .filter(|c| c.conn.is_alive())
    }

    #[cfg(windows)]
    fn forget(&self, conn: &std::sync::Arc<conn::Conn>) {
        let mut slot = self.client.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|c| std::sync::Arc::ptr_eq(&c.conn, conn))
        {
            *slot = None;
        }
    }

    pub fn status(&self) -> HostStatus {
        #[cfg(windows)]
        let (connected, host_version) = match self.current() {
            Some(c) => (true, Some(c.conn.host_version.clone())),
            None => (false, None),
        };
        #[cfg(not(windows))]
        let (connected, host_version) = (false, None);
        HostStatus {
            enabled: self.enabled(),
            supported: cfg!(windows),
            connected,
            host_version,
            error: self.last_error.lock().unwrap().clone(),
        }
    }
}

#[cfg(windows)]
fn connect(app: &AppHandle) -> Result<Client, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let sink = std::sync::Arc::new(AppSink {
        app: app.clone(),
        routes: Mutex::default(),
        conn: std::sync::OnceLock::new(),
    });
    let try_connect = |ep: &launch::Endpoint| {
        tauri::async_runtime::block_on(conn::Conn::connect(&ep.pipe, &ep.token, sink.clone()))
    };
    let existing = launch::read_endpoint(&data_dir);
    let conn = match existing.as_ref().map(try_connect) {
        Some(Ok(c)) => c,
        // No file, or a stale one (host gone, pipe missing): start a host.
        _ => {
            let ep = launch::start(&data_dir, existing.as_ref())?;
            try_connect(&ep)?
        }
    };
    let _ = sink.conn.set(conn.clone());
    Ok(Client { conn, sink })
}

/// Mirror fields a pane needs once its generation exists; they ride along
/// from `create` to the `spawned` event.
#[cfg(windows)]
pub struct PendingTerminal {
    pub agent_id: Option<String>,
    pub cwd: std::path::PathBuf,
    pub worktree_mode: bool,
    pub repo_root: Option<String>,
    pub claude_config_dir: Option<std::path::PathBuf>,
}

/// Host traffic → app state. One per connection, so a reconnect starts with
/// an empty route table.
#[cfg(windows)]
pub struct AppSink {
    app: AppHandle,
    pub routes: Mutex<routes::Routes<PendingTerminal, tauri::ipc::Channel<crate::pty::PtyOut>>>,
    conn: std::sync::OnceLock<std::sync::Arc<conn::Conn>>,
}

#[cfg(windows)]
impl conn::Sink for AppSink {
    fn spawned(&self, terminal_id: &str, spawn_id: &str, pid: Option<u32>) {
        let pending = self
            .routes
            .lock()
            .unwrap()
            .on_spawned(terminal_id, spawn_id);
        // `spawned` can only follow our own `create`, which runs after
        // `connect` set the cell; a missing cell means a foreign pane.
        if let (Some(p), Some(conn)) = (pending, self.conn.get()) {
            crate::pty::register_hosted(&self.app, terminal_id, spawn_id, pid, p, conn.clone());
        }
    }

    fn data(&self, terminal_id: &str, spawn_id: &str, bytes: &[u8]) {
        let Some(channel) = self
            .routes
            .lock()
            .unwrap()
            .route(terminal_id, spawn_id)
            .cloned()
        else {
            return;
        };
        // The host's flusher only emits whole UTF-8 strings (SWA-54
        // `take_valid_utf8`), so this never splits a character.
        let text = String::from_utf8_lossy(bytes).into_owned();
        crate::pty::deliver_output(&self.app, terminal_id, text, &channel);
    }

    fn removed(&self, terminal_id: &str, spawn_id: &str) {
        crate::pty::drop_generation(&self.app, terminal_id, spawn_id);
    }

    fn exit(&self, terminal_id: &str, spawn_id: &str, exit_code: i32) {
        let channel = self.routes.lock().unwrap().take(terminal_id, spawn_id);
        if let Some(channel) = channel {
            crate::pty::finish_generation(&self.app, terminal_id, spawn_id, exit_code, &channel);
        }
    }

    fn input_dropped(&self, terminal_id: &str) {
        use tauri::Emitter;
        let _ = self.app.emit("pty:input-dropped", terminal_id);
    }

    fn lost(&self) {
        if let (Some(hub), Some(conn)) = (self.app.try_state::<HostHub>(), self.conn.get()) {
            hub.forget(conn);
        }
        let ended = self.routes.lock().unwrap().drain();
        for (terminal_id, spawn_id, channel) in ended {
            crate::pty::finish_generation(&self.app, &terminal_id, &spawn_id, -1, &channel);
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("terminal-host.json"))
        .map_err(|e| e.to_string())
}

/// Boot: load the switch. The host itself starts lazily with the first pane.
pub fn init(app: &AppHandle) {
    if let Ok(path) = settings_path(app) {
        *app.state::<HostHub>().settings.lock().unwrap() = settings::load(&path);
    }
}

#[tauri::command]
pub fn terminal_host_get_settings(hub: tauri::State<'_, HostHub>) -> HostSettings {
    hub.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn terminal_host_set_settings(
    app: AppHandle,
    settings: HostSettings,
) -> Result<HostSettings, String> {
    settings::save(&settings_path(&app)?, &settings)?;
    let hub = app.state::<HostHub>();
    *hub.settings.lock().unwrap() = settings.clone();
    if !settings.enabled {
        *hub.last_error.lock().unwrap() = None;
    }
    Ok(settings)
}

#[tauri::command]
pub fn terminal_host_status(hub: tauri::State<'_, HostHub>) -> HostStatus {
    hub.status()
}
