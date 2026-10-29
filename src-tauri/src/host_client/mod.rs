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
//! reconnects (and starts a host if none runs).
//!
//! Reattach (SWA-56, phase 3): at boot the app connects to a host that is
//! already running and takes its panes as `detached` (fixed set, see
//! `detached.rs`). `create_terminal` for such an id attaches instead of
//! spawning; the renderer's `keep` decides what can never be shown again.
//! The MCP port rides along in the host's app state, so surviving panes'
//! `SWARMTERM_MCP_URL` keeps working when the port is free again.

pub mod detached;
pub mod routes;
pub mod settings;

#[cfg(windows)]
pub mod conn;
#[cfg(windows)]
pub mod launch;

use std::sync::{Condvar, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use settings::HostSettings;

/// Lock order: `client` → `terminals` (`reap` checks the map while
/// `for_spawn` or `reconnect_for_cleanup` hold the slot). Nothing takes
/// `client` while holding `terminals`: `tray::quit_blocking` drains the map
/// first, `kill_terminal` never touches the hub.
#[derive(Default)]
pub struct HostHub {
    settings: Mutex<HostSettings>,
    #[cfg(windows)]
    client: Mutex<Option<Client>>,
    last_error: Mutex<Option<String>>,
    detached: Mutex<detached::Detached>,
    /// Set once the boot connection attempt finished (either way).
    booted: Mutex<bool>,
    booted_cv: Condvar,
    /// Port this app's MCP server bound; every connection stores it.
    mcp_port: Mutex<Option<u16>>,
}

/// How long the renderer has to report `keep` after the boot connection.
#[cfg(windows)]
const KEEP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);
/// How long boot-dependent calls wait for the boot connection.
const BOOT_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

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
    /// Why new panes run in-process although the host is on: the running
    /// host predates process priority (ADR 0005) and would run them
    /// unlimited. Shown under Settings → Terminal → Process priority.
    pub priority_unsupported: Option<String>,
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
        let mut slot = crate::prof::lock("lock.host_hub.client", &self.client);
        if let Some(c) = slot.as_ref().filter(|c| c.conn.is_alive()) {
            return Self::enforced(c.clone());
        }
        match connect(app, true, false) {
            Ok(c) => {
                *slot = Some(c.clone());
                *self.last_error.lock().unwrap() = None;
                Self::enforced(c)
            }
            Err(e) => {
                eprintln!("[host] falling back to in-process terminals: {e}");
                *self.last_error.lock().unwrap() = Some(e);
                None
            }
        }
    }

    /// A host adopted after an update may predate ADR 0005: it ignores
    /// `set_priority` and its new panes would run unlimited. Those spawn
    /// in-process, where the job limits are enforced; the host keeps its
    /// own panes until it idles out, and the next host is current.
    #[cfg(windows)]
    fn enforced(c: Client) -> Option<Client> {
        spawn_on_host(c.conn.priority, &c.conn.host_version).then_some(c)
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

    /// Clear the slot if it still holds `conn`. `false` = an older,
    /// already replaced connection: the slot's owner took over its cleanup.
    #[cfg(windows)]
    fn forget(&self, conn: &std::sync::Arc<conn::Conn>) -> bool {
        let mut slot = self.client.lock().unwrap();
        let current = slot
            .as_ref()
            .is_some_and(|c| std::sync::Arc::ptr_eq(&c.conn, conn));
        if current {
            *slot = None;
        }
        current
    }

    /// Cleanup-only reconnect after `lost`. Runs under the slot lock like
    /// `for_spawn`, and gives up if the slot already holds a live
    /// connection: a hello replaces the host's client, so connecting next to
    /// a live one would kick it, its `lost` would kick us back, and so on.
    /// Serialised, the two paths never race, and `reap` cannot see a pane
    /// whose `create` is still pending.
    #[cfg(windows)]
    fn reconnect_for_cleanup(&self, app: &AppHandle) {
        let mut slot = self.client.lock().unwrap();
        if slot.as_ref().is_some_and(|c| c.conn.is_alive()) {
            return;
        }
        if let Ok(c) = connect(app, false, false) {
            *slot = Some(c);
        }
    }

    fn mark_booted(&self) {
        *self.booted.lock().unwrap() = true;
        self.booted_cv.notify_all();
    }

    fn wait_booted(&self) {
        let guard = self.booted.lock().unwrap();
        let _ = self
            .booted_cv
            .wait_timeout_while(guard, BOOT_WAIT, |done| !*done);
    }

    /// Close host panes by id over the current connection.
    #[cfg(windows)]
    fn close(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        if let Some(c) = self.current() {
            for id in ids {
                c.conn.kill(id);
            }
        }
    }

    /// A detached pane `create_terminal` may attach to, with the connection
    /// that can. Single use (`Detached::take`).
    #[cfg(windows)]
    pub fn take_detached(&self, id: &str) -> Option<(detached::DetachedPane, Client)> {
        let client = self.current()?;
        let pane = self.detached.lock().unwrap().take(id)?;
        Some((pane, client))
    }

    pub fn status(&self) -> HostStatus {
        #[cfg(windows)]
        let (connected, host_version, priority_unsupported) = match self.current() {
            Some(c) => (
                true,
                Some(c.conn.host_version.clone()),
                (!c.conn.priority).then(|| {
                    format!(
                        "The running terminal host ({}) predates process priority: panes already \
                         running on it stay unlimited until that host exits, and new panes run \
                         in-process (limited) meanwhile.",
                        c.conn.host_version
                    )
                }),
            ),
            None => (false, None, None),
        };
        #[cfg(not(windows))]
        let (connected, host_version, priority_unsupported) = (false, None, None);
        HostStatus {
            enabled: self.enabled(),
            supported: cfg!(windows),
            connected,
            host_version,
            error: self.last_error.lock().unwrap().clone(),
            priority_unsupported,
        }
    }
}

/// Attempts per connect: covers a host that decided to idle out while we
/// connected (its pipe name lingers, a new host exits with code 3, and the
/// next attempt finds the file gone or the successor running).
#[cfg(windows)]
const CONNECT_ATTEMPTS: u32 = 3;
#[cfg(windows)]
const CONNECT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

/// Connect to the running host, starting one when `start` is set. `adopt`
/// (boot only): the host's panes become the detached set instead of being
/// reaped. Blocking: runs on `create_terminal`'s blocking thread or a plain
/// thread.
#[cfg(windows)]
fn connect(app: &AppHandle, start: bool, adopt: bool) -> Result<Client, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let mut last = String::from("terminal host unavailable");
    for attempt in 0..CONNECT_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(CONNECT_RETRY_DELAY);
        }
        match connect_once(app, &data_dir, start) {
            Ok(c) => {
                if adopt {
                    self::adopt(app, &c);
                } else {
                    reap(app, &c);
                }
                // Before any create on this connection (requests are FIFO),
                // so new hosted panes are born with the user's settings.
                c.conn.set_priority(
                    &app.state::<crate::child_priority::ChildPriority>()
                        .settings(),
                );
                if let Some(port) = *app.state::<HostHub>().mcp_port.lock().unwrap() {
                    c.conn.set_app_state(serde_json::json!({ "mcpPort": port }));
                }
                return Ok(c);
            }
            Err(e) if start => last = e,
            // Cleanup-only reconnect: no host, nothing to clean.
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

#[cfg(windows)]
fn connect_once(
    app: &AppHandle,
    data_dir: &std::path::Path,
    start: bool,
) -> Result<Client, String> {
    let sink = std::sync::Arc::new(AppSink {
        app: app.clone(),
        routes: Mutex::default(),
        conn: std::sync::OnceLock::new(),
        replays: PendingReplays::default(),
    });
    let try_connect = |ep: &launch::Endpoint| {
        tauri::async_runtime::block_on(conn::Conn::connect(&ep.pipe, &ep.token, sink.clone()))
    };
    let existing = launch::read_endpoint(data_dir);
    let conn = match existing.as_ref().map(try_connect) {
        Some(Ok(c)) => c,
        // No file, or a stale one (host gone, pipe missing): start a host.
        Some(Err(e)) if !start => return Err(e),
        _ if !start => return Err("no terminal host running".into()),
        _ => {
            let ep = launch::start(data_dir, existing.as_ref())?;
            try_connect(&ep)?
        }
    };
    let _ = sink.conn.set(conn.clone());
    Ok(Client { conn, sink })
}

/// A fresh connection tracks no pane yet, so every host pane neither the
/// app's map nor the detached set holds is an orphan (see
/// `Conn::reap_orphans`): a create whose answer timed out, or the panes of
/// a lost connection.
#[cfg(windows)]
fn reap(app: &AppHandle, client: &Client) {
    let Some(state) = app.try_state::<crate::pty::AppState>() else {
        return;
    };
    let hub = app.state::<HostHub>();
    let keep = |id: &str| {
        state.terminals.lock().unwrap().contains_key(id)
            || hub.detached.lock().unwrap().contains(id)
    };
    match client.conn.reap_orphans(keep, conn::REQUEST_TIMEOUT) {
        Ok(0) => {}
        Ok(n) => eprintln!("[host] closed {n} pane(s) no window shows"),
        Err(e) => eprintln!("[host] orphan check failed: {e}"),
    }
}

/// Boot: everything the host runs survived the previous app instance (this
/// one has created nothing yet), so it all becomes the detached set.
#[cfg(windows)]
fn adopt(app: &AppHandle, client: &Client) {
    match client.conn.list(conn::REQUEST_TIMEOUT) {
        Ok(list) => {
            let d = detached::Detached::from_list(&list);
            let n = d.list().len();
            *app.state::<HostHub>().detached.lock().unwrap() = d;
            if n > 0 {
                eprintln!("[host] {n} pane(s) survived the last app instance");
            }
        }
        Err(e) => eprintln!("[host] could not list surviving panes: {e}"),
    }
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
    /// Attached generations whose replay frame has not arrived yet: the
    /// first frame becomes `PtyOut::Replay` with these facts.
    replays: PendingReplays<ReplayFacts>,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct ReplayFacts {
    cols: u16,
    rows: u16,
    truncated: bool,
}

#[cfg(windows)]
impl ReplayFacts {
    fn into_out(self, data: String) -> crate::pty::PtyOut {
        crate::pty::PtyOut::Replay {
            data,
            cols: self.cols,
            rows: self.rows,
            truncated: self.truncated,
        }
    }
}

/// Replay facts awaiting each attached generation's first data frame. The
/// flag mirrors "map non-empty" so every live data frame skips the lock and
/// the two key allocations (perf phase 3). Both writers run on the
/// connection's reader task, and the flag is written under the lock, so it
/// cannot miss an insert that precedes the frame it belongs to.
#[cfg_attr(not(windows), allow(dead_code))]
struct PendingReplays<T> {
    map: Mutex<std::collections::HashMap<(String, String), T>>,
    has_pending_replay: std::sync::atomic::AtomicBool,
}

impl<T> Default for PendingReplays<T> {
    fn default() -> Self {
        PendingReplays {
            map: Mutex::default(),
            has_pending_replay: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
impl<T> PendingReplays<T> {
    fn insert(&self, terminal_id: &str, spawn_id: &str, facts: T) {
        let mut map = self.map.lock().unwrap();
        map.insert((terminal_id.to_string(), spawn_id.to_string()), facts);
        self.has_pending_replay
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn take(&self, terminal_id: &str, spawn_id: &str) -> Option<T> {
        use std::sync::atomic::Ordering;
        if !self.has_pending_replay.load(Ordering::Acquire) {
            return None;
        }
        let mut map = self.map.lock().unwrap();
        let facts = map.remove(&(terminal_id.to_string(), spawn_id.to_string()));
        if map.is_empty() {
            self.has_pending_replay.store(false, Ordering::Release);
        }
        facts
    }

    #[cfg(test)]
    fn flagged(&self) -> bool {
        self.has_pending_replay
            .load(std::sync::atomic::Ordering::Acquire)
    }
}

#[cfg(windows)]
impl conn::Sink for AppSink {
    fn spawned(&self, terminal_id: &str, spawn_id: &str, pid: Option<u32>) {
        let pending = self
            .routes
            .lock()
            .unwrap()
            .on_spawned(terminal_id, spawn_id);
        let Some(conn) = self.conn.get() else {
            return;
        };
        match pending {
            Some(p) => {
                crate::pty::register_hosted(&self.app, terminal_id, spawn_id, pid, p, conn.clone())
            }
            // Nobody waits for it any more (its `create` timed out): until
            // phase 3 can attach, it would run invisibly in the host.
            None => {
                eprintln!("[host] closing unrequested pane {terminal_id}");
                conn.kill(terminal_id);
            }
        }
    }

    fn attached(&self, terminal_id: &str, facts: &serde_json::Value) {
        let spawn_id = facts["spawnId"].as_str().unwrap_or("");
        let pending = self
            .routes
            .lock()
            .unwrap()
            .on_spawned(terminal_id, spawn_id);
        let Some(conn) = self.conn.get() else {
            return;
        };
        let Some(p) = pending else {
            // Its `create_terminal` gave up (timeout). The pane already left
            // the detached set (`take`), so nothing could attach it again,
            // and a live connection never reaps: it would run unseen and
            // keep the host from idling out. Same rule as `spawned`.
            eprintln!("[host] closing unclaimed attach {terminal_id}");
            conn.kill(terminal_id);
            return;
        };
        let pid = facts["pid"].as_u64().map(|p| p as u32);
        crate::pty::register_hosted(&self.app, terminal_id, spawn_id, pid, p, conn.clone());
        let replay = ReplayFacts {
            cols: facts["cols"].as_u64().unwrap_or(80) as u16,
            rows: facts["rows"].as_u64().unwrap_or(24) as u16,
            truncated: facts["truncated"].as_bool().unwrap_or(false),
        };
        if facts["replayBytes"].as_u64().unwrap_or(0) > 0 {
            self.replays.insert(terminal_id, spawn_id, replay);
        } else if let Some(channel) = self.routes.lock().unwrap().route(terminal_id, spawn_id) {
            // Nothing to replay; the renderer still learns the size.
            let _ = channel.send(replay.into_out(String::new()));
        }
    }

    fn data(&self, terminal_id: &str, spawn_id: &str, bytes: Vec<u8>) {
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
        // `take_valid_utf8`), so this never splits a character and takes
        // the frame's buffer as is. The fallback is practically
        // unreachable; it keeps the byte length, so the renderer (which
        // acks the UTF-8 length it received) acks exactly what the host's
        // gate counted. Logged.
        let text = String::from_utf8(bytes).unwrap_or_else(|e| {
            eprintln!("[host] non-UTF-8 output frame for {terminal_id}, decoded lossily");
            decode_same_len(e.as_bytes())
        });
        let replay = self.replays.take(terminal_id, spawn_id);
        match replay {
            Some(r) => {
                crate::pty::deliver_replay(&self.app, terminal_id, r.into_out(text), &channel)
            }
            None => crate::pty::deliver_output(&self.app, terminal_id, text, &channel),
        }
    }

    fn removed(&self, terminal_id: &str, spawn_id: &str) {
        if let Some(hub) = self.app.try_state::<HostHub>() {
            hub.detached.lock().unwrap().gone(terminal_id, spawn_id);
        }
        crate::pty::drop_generation(&self.app, terminal_id, spawn_id);
    }

    fn exit(&self, terminal_id: &str, spawn_id: &str, exit_code: i32) {
        if let Some(hub) = self.app.try_state::<HostHub>() {
            hub.detached.lock().unwrap().gone(terminal_id, spawn_id);
        }
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
        let current = match (self.app.try_state::<HostHub>(), self.conn.get()) {
            (Some(hub), Some(conn)) => hub.forget(conn),
            _ => false,
        };
        let ended = self.routes.lock().unwrap().drain();
        for (terminal_id, spawn_id, channel) in ended {
            crate::pty::finish_generation(&self.app, &terminal_id, &spawn_id, -1, &channel);
        }
        // The host may live on (a write deadline, a kick): its PTYs for the
        // panes just ended would keep running and keep it from idling out.
        // Reconnect to clean up, without starting a host; off the reader
        // task, because connecting blocks. Only for the slot's connection: a
        // replaced one was kicked by its successor, which reaped on connect.
        if !current {
            return;
        }
        let app = self.app.clone();
        std::thread::spawn(move || {
            if let Some(hub) = app.try_state::<HostHub>() {
                hub.reconnect_for_cleanup(&app);
            }
        });
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("terminal-host.json"))
        .map_err(|e| e.to_string())
}

/// Boot: load the switch. A host that is already running (it outlived the
/// previous app instance) is connected right away, in the background, so
/// its panes can be reattached; otherwise the host starts lazily with the
/// first pane. With the switch off, a surviving host is swept instead.
pub fn init(app: &AppHandle) {
    let hub = app.state::<HostHub>();
    if let Ok(path) = settings_path(app) {
        *hub.settings.lock().unwrap() = settings::load(&path);
    }
    #[cfg(windows)]
    {
        let app = app.clone();
        if hub.enabled() {
            crate::prof::spawn_named("host-boot", move || boot(&app));
        } else {
            crate::prof::spawn_named("host-sweep", move || sweep(&app));
        }
    }
    #[cfg(not(windows))]
    hub.mark_booted();
}

/// The switch is off, but the previous instance may have crashed with it
/// on: its host then still runs those panes, and with nothing to attach
/// them it would never idle out, so the shells would live until logout.
/// Close them all and hang up (never start a host for this). Under the
/// slot lock like `reconnect_for_cleanup`, so a pane created right after
/// the user turns the switch on cannot be reaped.
#[cfg(windows)]
fn sweep(app: &AppHandle) {
    let hub = app.state::<HostHub>();
    {
        let _slot = hub.client.lock().unwrap();
        if let Ok(c) = connect(app, false, false) {
            let _ = c.conn.flush(conn::REQUEST_TIMEOUT);
            c.conn.close();
        }
    }
    hub.mark_booted();
}

#[cfg(windows)]
fn boot(app: &AppHandle) {
    let hub = app.state::<HostHub>();
    {
        let mut slot = hub.client.lock().unwrap();
        if let Ok(c) = connect(app, false, true) {
            *slot = Some(c);
        }
    }
    hub.mark_booted();
    // The renderer reports `keep` once it loaded the saved workspaces; if
    // it never does, detached panes would run unseen and keep the host
    // from idling out.
    if !hub.detached.lock().unwrap().list().is_empty() {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(KEEP_DEADLINE);
            let hub = app.state::<HostHub>();
            let expired = hub.detached.lock().unwrap().expire();
            if !expired.is_empty() {
                eprintln!(
                    "[host] no keep report; closing {} detached pane(s)",
                    expired.len()
                );
                hub.close(&expired);
            }
        });
    }
}

/// The MCP port the previous app instance used, if the host remembers one:
/// binding it again keeps the surviving panes' `SWARMTERM_MCP_URL` valid.
pub fn preferred_mcp_port(app: &AppHandle) -> Option<u16> {
    #[cfg(windows)]
    {
        let hub = app.state::<HostHub>();
        hub.wait_booted();
        let c = hub.current()?;
        c.conn.app_state["mcpPort"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

/// Remember the bound MCP port and store it in the host (now and on every
/// later connection).
pub fn publish_mcp_port(app: &AppHandle, port: u16) {
    let hub = app.state::<HostHub>();
    *hub.mcp_port.lock().unwrap() = Some(port);
    #[cfg(windows)]
    if let Some(c) = hub.current() {
        c.conn.set_app_state(serde_json::json!({ "mcpPort": port }));
    }
}

/// Panes that survived the last app instance and wait for their workspace.
#[tauri::command]
pub async fn terminal_host_detached(app: AppHandle) -> Vec<detached::DetachedPane> {
    tauri::async_runtime::spawn_blocking(move || {
        let hub = app.state::<HostHub>();
        hub.wait_booted();
        let list = hub.detached.lock().unwrap().list();
        list
    })
    .await
    .unwrap_or_default()
}

/// The renderer loaded the saved workspaces: `ids` are every pane id they
/// reference. Detached panes outside it can never be shown and are closed.
#[tauri::command]
pub fn terminal_host_keep(hub: tauri::State<'_, HostHub>, ids: Vec<String>) {
    let ids: std::collections::HashSet<String> = ids.into_iter().collect();
    let close = hub.detached.lock().unwrap().keep(&ids);
    #[cfg(windows)]
    hub.close(&close);
    #[cfg(not(windows))]
    drop(close);
}

/// A saved workspace was forgotten: close its detached panes.
#[tauri::command]
pub fn terminal_host_release(hub: tauri::State<'_, HostHub>, ids: Vec<String>) {
    let close = hub.detached.lock().unwrap().release(&ids);
    #[cfg(windows)]
    hub.close(&close);
    #[cfg(not(windows))]
    drop(close);
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

/// Async, so it runs off the main thread: Settings polls it while open,
/// and `status` waits on the client lock, which a connect can hold for
/// seconds (host start, retries).
#[tauri::command]
pub async fn terminal_host_status(app: AppHandle) -> Result<HostStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<HostHub>().status())
        .await
        .map_err(|e| e.to_string())
}

/// Whether new panes may go to a host that announced (or not) the
/// `priority` capability: an older host would run them unlimited.
#[cfg(windows)]
fn spawn_on_host(priority: bool, host_version: &str) -> bool {
    if !priority {
        eprintln!("[host] host {host_version} lacks process priority: new panes run in-process");
    }
    priority
}

#[cfg(all(test, windows))]
mod capability_tests {
    use super::{conn::has_cap, spawn_on_host};
    use serde_json::json;

    /// A host from before ADR 0005: `for_spawn` falls back to in-process.
    #[test]
    fn old_host_without_priority_is_not_used_for_new_panes() {
        let old = json!({"ok": true, "hostVersion": "1.24.2", "capabilities": ["flow-control"]});
        let p = has_cap(&old, swarmterm_host::protocol::PRIORITY);
        assert!(!p);
        assert!(!spawn_on_host(p, "1.24.2"));
        let none = json!({"ok": true, "hostVersion": "1.0.0"});
        assert!(!spawn_on_host(
            has_cap(&none, swarmterm_host::protocol::PRIORITY),
            "1.0.0"
        ));
        let new = json!({"ok": true, "capabilities": ["flow-control", swarmterm_host::protocol::PRIORITY]});
        assert!(spawn_on_host(
            has_cap(&new, swarmterm_host::protocol::PRIORITY),
            "x"
        ));
    }
}

/// Decodes `bytes` replacing every invalid byte with one `?`, so the result
/// has exactly `bytes.len()` UTF-8 bytes. `from_utf8_lossy` would put a
/// 3-byte U+FFFD per invalid sequence and the renderer would ack more than
/// the host's flow gate counted.
fn decode_same_len(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        out.extend(std::iter::repeat_n('?', chunk.invalid().len()));
    }
    out
}

#[cfg(test)]
mod decode_tests {
    use super::decode_same_len;

    #[test]
    fn invalid_bytes_keep_the_byte_count() {
        let cases: [&[u8]; 4] = [
            b"plain",
            b"a\xffb",
            b"\xe2\x82 cut \xf0\x9f\x98",
            "ok \u{1F600}".as_bytes(),
        ];
        for bytes in cases {
            assert_eq!(decode_same_len(bytes).len(), bytes.len(), "{bytes:?}");
        }
        assert_eq!(decode_same_len(b"a\xffb"), "a?b");
        assert_eq!(decode_same_len(b"\xe2\x82x"), "??x");
    }
}

#[cfg(test)]
mod pending_replay_tests {
    use super::PendingReplays;

    #[test]
    fn the_flag_follows_the_map_through_insert_and_take() {
        let p = PendingReplays::<u8>::default();
        assert!(!p.flagged());
        assert_eq!(p.take("t", "g"), None);
        p.insert("t", "g1", 1);
        p.insert("u", "g2", 2);
        assert!(p.flagged());
        // Another generation's frame takes nothing and keeps the flag.
        assert_eq!(p.take("t", "other"), None);
        assert!(p.flagged());
        assert_eq!(p.take("t", "g1"), Some(1));
        assert!(p.flagged());
        assert_eq!(p.take("u", "g2"), Some(2));
        assert!(!p.flagged());
        assert_eq!(p.take("u", "g2"), None);
    }
}
