use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pty::{AppState, CreateTerminalOptions, CreateTerminalResult, PtyOut};

fn files_main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Files are available only in the main application".into())
    }
}

#[tauri::command]
pub fn confirm_quit(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    files_main_only(&window)?;
    crate::tray::quit(&app);
    Ok(())
}

#[tauri::command]
pub async fn files_open_context(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    terminal_id: String,
    expected_cwd: Option<String>,
) -> Result<crate::files::FileContext, String> {
    files_main_only(&window)?;
    let cwd = state
        .terminals
        .lock()
        .map_err(|e| e.to_string())?
        .get(&terminal_id)
        .map(|t| t.cwd.clone())
        .ok_or("Terminal is not ready; try again when its shell has started")?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.open_for_terminal(&cwd, expected_cwd.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn files_request(
    window: tauri::WebviewWindow,
    app: AppHandle,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    request: crate::files::FileRequest,
) -> Result<serde_json::Value, String> {
    files_main_only(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.request(request, Some(&app)))
        .await
        .map_err(|e| e.to_string())?
}

/// Passive media detection: the renderer found image/video paths in a pane's
/// output. Relative paths resolve against that terminal's cwd; the answer has
/// one entry per input (canonical display path of an existing media file, or
/// null). Validation only, nothing is allow-listed here (see
/// `FileService::check_detected_media`). Disk work runs off the async executor.
#[tauri::command]
pub async fn media_check_detected(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    terminal_id: String,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    files_main_only(&window)?;
    let cwd = state
        .terminals
        .lock()
        .map_err(|e| e.to_string())?
        .get(&terminal_id)
        .map(|t| t.cwd.clone())
        .ok_or("unknown terminal")?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .check_detected_media(&paths, std::path::Path::new(&cwd))
            .iter()
            .map(|p| p.as_deref().map(crate::files::path::display))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The user opened a media item (gallery/overlay/badge click, Ctrl+click on a
/// printed path): allow-list that one absolute file for the unrooted route.
/// Returns the canonical display path.
#[tauri::command]
pub async fn media_open(
    window: tauri::WebviewWindow,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    path: String,
) -> Result<String, String> {
    files_main_only(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .register_user_media(&path)
            .map(|p| crate::files::path::display(&p))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Media viewer → Annotate: the opened image's bytes for the flatten canvas
/// (raw IPC response; see `files::media::read_registered_image`).
#[tauri::command]
pub async fn media_read_opened_image(
    window: tauri::WebviewWindow,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    files_main_only(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::media::read_registered_image(&service, &path).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Media viewer → Annotate → save: the renderer sends the flattened PNG as the
/// raw IPC body (no JSON number array for megabytes). We write it as a NEW
/// file in our temp store (`marked_media`) and allow-list it like a clipboard
/// image. Main webview only and no MCP counterpart: user-originated only.
#[tauri::command]
pub async fn media_save_marked(
    window: tauri::WebviewWindow,
    app: AppHandle,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    files_main_only(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the PNG as a raw body".into());
    };
    // Reject before the copy below (the body is borrowed from the request,
    // and the blocking task needs its own copy of up to MAX_PNG_BYTES).
    crate::marked_media::validate_png(bytes)?;
    let bytes = bytes.clone();
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<crate::marked_media::MarkedMedia>()
            .save(&service, &bytes)
            .map(|p| crate::files::path::display(&p))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings → Media → Clipboard images (opt-in). Idempotent; the renderer
/// calls it at startup and on every toggle. Thread start/stop; switching off
/// also deletes the saved PNGs (a few small files).
#[tauri::command]
pub fn clipboard_media_set_enabled(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    files_main_only(&window)?;
    #[cfg(windows)]
    {
        use tauri::Manager;
        app.state::<crate::clipboard_media::ClipboardMedia>()
            .set_enabled(&app, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
        Err("clipboard images are Windows-only".into())
    }
}

#[tauri::command]
pub async fn files_watch(
    window: tauri::WebviewWindow,
    app: AppHandle,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    context_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    files_main_only(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.watch(&context_id, paths, app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn files_unwatch(
    window: tauri::WebviewWindow,
    service: State<'_, std::sync::Arc<crate::files::FileService>>,
    context_id: String,
) -> Result<(), String> {
    files_main_only(&window)?;
    service.unwatch(&context_id);
    Ok(())
}

/// Ids whose `create_terminal` is in flight (see there).
static SPAWNING: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// Signalled whenever a reservation is released.
static SPAWN_DONE: std::sync::Condvar = std::sync::Condvar::new();

struct SpawnReservation(String);

/// How long a create waits for an in-flight create of the same id. A healthy
/// spawn finishes well inside the host's create request timeout; twice that
/// means the first one hung, and the later create fails instead of blocking
/// a pool thread forever.
const SPAWN_RESERVE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(2 * crate::host_client::conn::REQUEST_TIMEOUT.as_secs());

impl SpawnReservation {
    /// Reserve `id`, waiting while another create of the SAME id is in
    /// flight (the old global SPAWN_LOCK made it wait too). After the wait
    /// the caller sees the finished spawn, so a duplicate still gets the
    /// usual "already exists" from `spawn_terminal`, and a create retried
    /// after a failed one simply proceeds. Creates of different ids never
    /// wait on each other. Runs on the blocking pool, never the main thread.
    fn take(id: &str) -> Result<Self, String> {
        Self::take_within(id, SPAWN_RESERVE_TIMEOUT)
    }

    fn take_within(id: &str, timeout: std::time::Duration) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + timeout;
        let mut set = SPAWNING.lock().unwrap_or_else(|e| e.into_inner());
        while set.get_or_insert_with(Default::default).contains(id) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err(format!(
                    "Terminal {id} is still being created by an earlier request (waited {}s)",
                    timeout.as_secs()
                ));
            }
            set = SPAWN_DONE
                .wait_timeout(set, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        set.get_or_insert_with(Default::default)
            .insert(id.to_string());
        Ok(SpawnReservation(id.to_string()))
    }
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        let mut set = SPAWNING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(set) = set.as_mut() {
            set.remove(&self.0);
        }
        SPAWN_DONE.notify_all();
    }
}

#[cfg(test)]
mod spawn_reservation_tests {
    use super::SpawnReservation;
    use std::time::{Duration, Instant};

    #[test]
    fn same_id_waits_for_the_first_create() {
        let first = SpawnReservation::take("res-test-a").unwrap();
        let t = std::thread::spawn(|| {
            let t0 = Instant::now();
            let _second = SpawnReservation::take("res-test-a").unwrap();
            t0.elapsed()
        });
        std::thread::sleep(Duration::from_millis(100));
        drop(first);
        assert!(t.join().unwrap() >= Duration::from_millis(90));
    }

    #[test]
    fn different_ids_do_not_wait() {
        let _a = SpawnReservation::take("res-test-b").unwrap();
        let t0 = Instant::now();
        let _b = SpawnReservation::take("res-test-c").unwrap();
        assert!(t0.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn hung_same_id_create_times_out_with_an_error() {
        let _hung = SpawnReservation::take("res-test-d").unwrap();
        let t0 = Instant::now();
        let err = SpawnReservation::take_within("res-test-d", Duration::from_millis(100))
            .err()
            .expect("second create must give up");
        assert!(t0.elapsed() >= Duration::from_millis(90));
        assert!(err.contains("res-test-d"), "{err}");
        // The id is still reserved by the hung create, not by the loser.
        drop(_hung);
        assert!(SpawnReservation::take_within("res-test-d", Duration::from_millis(100)).is_ok());
    }
}

#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Only the id is reserved, not the whole spawn: config reads, profile
        // enrollment and the OS process start of different panes overlap, so
        // a workspace of N agents no longer starts them one after another.
        // Two creates of the SAME id still serialise: the second waits for
        // the first and then behaves exactly as it did behind SPAWN_LOCK.
        let _span = crate::prof::span("cmd.create_terminal");
        let t0 = crate::prof::now();
        let _reservation = match SpawnReservation::take(&id) {
            Ok(r) => r,
            Err(e) => return CreateTerminalResult::err(e),
        };
        crate::prof::since("spawn.reserve", t0);
        let state = app.state::<AppState>();
        crate::pty::spawn_terminal(&app, &state, id, options, on_data)
    })
    .await
    .unwrap_or_else(|_| CreateTerminalResult::err("Terminal creation interrupted"))
}

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    // Enqueue only — the blocking pty write runs on the terminal's writer
    // thread (pty::PtyInput), so a full input pipe can't freeze the UI. An
    // unknown id stays a silent no-op (a pane racing its own close); a full
    // queue is returned so the renderer can tell the user input was dropped.
    let _span = crate::prof::span("cmd.write_terminal");
    match crate::prof::lock("lock.terminals.write", &state.terminals).get(&id) {
        Some(t) => t.send(data.as_bytes()).inspect_err(|e| {
            eprintln!("[pty] write to {id} dropped: {e}");
        }),
        None => Ok(()),
    }
}

/// Write that only lands in the PTY generation the caller pinned. Voice
/// dictation resolves its target long before the bytes arrive; a same-id
/// respawn (agent/cwd switch) in between must reject, not type into the new
/// shell. The check AND the enqueue run under the `terminals` lock, and the
/// queue belongs to that generation, so no respawn can slip between check and
/// write. The `Result` ACKs the enqueue: once queued the bytes either reach
/// this generation's pty or are dropped with it as it dies. Kept synchronous
/// (an awaited write-completion ACK would need an async command, which loses
/// ordering against plain `write_terminal` keystrokes).
#[tauri::command]
pub fn write_terminal_checked(
    state: State<'_, AppState>,
    id: String,
    expected_spawn_id: String,
    data: String,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let t = terminals.get(&id).ok_or("target-gone")?;
    t.send_checked(&expected_spawn_id, data.as_bytes())
}

/// Clone the pane's I/O handle; the `terminals` lock is held only for the
/// lookup, never across the gate or the PTY call (perf step C).
fn io_handle(state: &AppState, lock_name: &'static str, id: &str) -> Option<crate::pty::IoHandle> {
    crate::prof::lock(lock_name, &state.terminals)
        .get(id)
        .map(|t| t.handle())
}

/// The renderer's xterm parsed `bytes` more of generation `spawn_id`'s
/// output (perf phase 2 flow control; batched, ACK_CHUNK per call). `async`:
/// a plain command runs on the main thread, which also serves the IPC of
/// every pane's output, so thousands of acks under a flood queued there.
/// Acks are additive and the gate saturates, so pool reordering is harmless.
#[tauri::command(async)]
pub fn ack_output(state: State<'_, AppState>, id: String, spawn_id: String, bytes: u64) {
    let _span = crate::prof::span("cmd.ack_output");
    if let Some(h) = io_handle(&state, "lock.terminals.ack", &id) {
        h.ack(&spawn_id, bytes);
    }
}

/// The renderer disposed generation `spawn_id`'s xterm: open its flow gate
/// now rather than after the no-ack timeout. Off the main thread like acks.
#[tauri::command(async)]
pub fn release_output(state: State<'_, AppState>, id: String, spawn_id: String) {
    if let Some(h) = io_handle(&state, "lock.terminals.release", &id) {
        h.release_output(&spawn_id);
    }
}

/// Stays a main-thread command on purpose: it is now O(1) (the resize worker
/// applies the size), and running resizes on the async pool could reorder
/// them, so an older size could win.
#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) {
    let _span = crate::prof::span("cmd.resize_terminal");
    if let Some(h) = io_handle(&state, "lock.terminals.resize", &id) {
        h.resize(cols, rows);
    }
}

#[tauri::command]
pub fn kill_terminal(app: AppHandle, state: State<'_, AppState>, id: String) {
    // Take the terminal OUT of the map so its master PTY handle is dropped here,
    // rather than lingering until the reader thread cleans up. This makes the
    // reader observe EOF promptly on every platform:
    //   - Windows (ConPTY): killing the child does NOT close the output pipe while
    //     the master handle lives, so the reader would park on read() forever.
    //     Dropping the master runs ClosePseudoConsole, which closes the pipe.
    //   - Unix (macOS/Linux): the child's death already closes the slave, so the
    //     reader's own dup'd fd sees EOF regardless; dropping this master fd early
    //     is harmless.
    // Either way the reader then breaks, read_loop emits Exit and frees the id —
    // which a same-id respawn (agent/cwd/shell switch) waits for before spawning.
    //
    // The `let` binding releases the map lock BEFORE the kill/drop, so the reader
    // thread can re-lock the map to clear the id without deadlocking.
    let _span = crate::prof::span("cmd.kill_terminal");
    let removed = crate::prof::lock("lock.terminals.kill", &state.terminals).remove(&id);
    if let Some(t) = removed {
        // Closes the master PTY (forcing the reader's EOF) and lets the tree
        // exit cleanly before terminating it; the deadline runs off-thread.
        let _ = t.shutdown();
    }
    // A dead pane must not linger as a War Room ghost: peers would still see
    // it in list_peers and queue messages for a terminal that can never read
    // them. leave_everywhere() is idempotent, so racing read_loop's cleanup
    // is harmless.
    let left = state
        .war_rooms
        .lock()
        .unwrap()
        .leave_everywhere(&id, crate::warroom::now_ms());
    if let Some((room_id, event)) = left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    }
    // A pinned dictation must not type into (or show its pill on) a dead or
    // respawned shell. Idempotent with read_loop, like the War Room leave.
    crate::voice::drop_terminal(&app, &id);
    // A dead pane's preview must not linger as an orphaned native webview
    // painting over nothing. Idempotent with the renderer's GC sweep and with
    // read_loop below — whoever runs second finds the label gone.
    //
    // Closing the webview here is a Rust-side event the renderer's own
    // setup/cleanup effects never see (this can fire on a same-id respawn or
    // an agent/cwd/shell switch, not just a pane close), so emit preview:closed
    // to fold it into browser-store — otherwise the address bar shows a stale
    // preview and the next preview_open recreates the webview hidden with no
    // effect re-run left to show it.
    if let Some(webview) = app.get_webview(&crate::preview::preview_label(&id)) {
        let _ = webview.close();
        let _ = app.emit(
            "preview:closed",
            &crate::preview::PreviewClosedEvent {
                terminal_id: id.clone(),
            },
        );
    }
    // A respawned pane reuses its id, so a stale `connected` verdict would
    // survive into the new shell and hide the very failure the status line
    // exists to show. Drop it here and in `read_loop`, mirroring the two
    // places the terminal leaves `AppState.terminals`.
    state.mcp_clients.lock().unwrap().forget(&id);
    state.forget_session_token(&id);
    // The context chip too: a respawned Claude must not inherit the old %.
    state.context_usage.lock().unwrap().forget(&id);
    state.rate_limit_usage.lock().unwrap().forget(&id);
    // Same for the agent-state mirror + screen tail: a respawn must start
    // from `unknown`, and a `wait_peer` sleeper on this id must wake now to
    // see the peer gone rather than run out its timeout.
    state.peer_states.lock().unwrap().forget(&id);
    state.peer_wake.notify_waiters();
}

/// Settings → Terminal "Environment" (what panes and command routines
/// inherit from the app). Takes effect for the next spawn; running panes keep
/// the environment they started with.
#[tauri::command]
pub fn env_policy_set(state: State<'_, AppState>, policy: crate::terminal_env::EnvPolicy) {
    crate::terminal_env::persist(&policy);
    state.set_env_policy(policy);
}

/// Settings → Terminal → Agent safety (War Room execute between agents). Checked per MCP call,
/// so a change applies to the next call without restarting any pane.
#[tauri::command]
pub fn agent_policy_set(state: State<'_, AppState>, policy: crate::agent_policy::AgentPolicy) {
    *state
        .agent_policy
        .write()
        .unwrap_or_else(|e| e.into_inner()) = policy;
}

/// Admin policy for the renderer: greys out locked controls. Display only —
/// every lock is enforced again at its point of action in Rust.
#[tauri::command]
pub fn policy_get(state: State<'_, AppState>) -> crate::policy::PolicyView {
    state.admin_policy.view()
}

/// Settings → Terminal "Process priority" plus the per-workspace opt-outs,
/// flattened by the renderer into the exempt panes' terminal ids (ADR 0005).
/// Applied to the in-process panes' jobs at once and forwarded to the
/// terminal host on a worker thread.
#[tauri::command]
pub fn child_priority_set(
    app: AppHandle,
    state: State<'_, crate::child_priority::ChildPriority>,
    settings: crate::child_priority::Settings,
) {
    state.set(settings);
    // Off the main thread: the host client lock may be held by a connect.
    #[cfg(windows)]
    crate::child_priority::forward_to_host(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Screen-independent proof that the pane's agent CLI is still running: a
/// process matching its agent id lives below the pane's shell. Used by the
/// handoff delivery right before paste and before Enter. Any doubt (unknown
/// pane, no pid, snapshot failure, non-Windows) answers `false`.
///
/// Async + blocking pool: the process snapshot costs tens of ms on Windows and
/// a sync command would run it on the main (UI) thread.
#[tauri::command]
pub async fn terminal_agent_alive(app: AppHandle, id: String) -> bool {
    // Copy what we need and drop the lock before the (slower) OS snapshot.
    let (pid, agent_id) = match app.state::<AppState>().terminals.lock().unwrap().get(&id) {
        Some(t) => (t.pid, t.agent_id.clone()),
        None => return false,
    };
    let Some(pid) = pid else { return false };
    tauri::async_runtime::spawn_blocking(move || match crate::agent_process::snapshot() {
        Some(procs) => crate::agent_process::agent_alive_in(
            &procs,
            pid,
            agent_id.as_deref(),
            crate::agent_process::command_line,
        ),
        None => false,
    })
    .await
    .unwrap_or(false)
}

/// Renderer → Rust mirror of a pane's agent display state (`working` /
/// `blocked` / `idle` / `done` / `unknown`), fed by `lib/agent-state-mirror`.
/// Rust cannot derive this itself (the heuristics run over xterm's buffer in
/// the renderer), and the M2 `war_room.wait_peer` / `read_peer` verbs must
/// answer without a renderer round-trip — see `mcp::peer_state`.
#[tauri::command]
pub fn report_agent_state(state: State<'_, AppState>, id: String, display: String) {
    // Only live terminals may be written. A report can race a kill (the
    // store's diff fires after `kill_terminal` already ran `forget`), and
    // accepting it would resurrect a row for a dead pty that nothing will
    // ever clean up again. The two locks are taken SEQUENTIALLY — check
    // `terminals`, drop it, then lock `peer_states` — never nested, per the
    // own-lock rule on `AppState`.
    let live = state.terminals.lock().unwrap().contains_key(&id);
    if !live {
        return;
    }
    let changed =
        state
            .peer_states
            .lock()
            .unwrap()
            .set_state(&id, &display, crate::warroom::now_ms());
    if changed {
        state.peer_wake.notify_waiters();
    }
}

/// Async: the first call probes PATH for shells; keep that off the UI thread.
#[tauri::command]
pub async fn list_available_shells() -> Vec<crate::shell::ShellEntry> {
    tauri::async_runtime::spawn_blocking(|| crate::shell::list_shells().to_vec())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn windows_build_number() -> Option<u32> {
    crate::shell::windows_build_number()
}

/// Async: walks PATH × PATHEXT per agent and, on first call, spawns `codex`
/// to probe hook support (up to 3 s) — a sync command froze the UI for that.
#[tauri::command]
pub async fn list_available_agents() -> Vec<crate::agents::AgentEntry> {
    tauri::async_runtime::spawn_blocking(crate::agents::list_agents)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_agent_sessions(
    app: AppHandle,
    folder: String,
    account_id: Option<String>,
) -> Vec<crate::sessions::SessionEntry> {
    crate::sessions::list_all(
        folder,
        accounts_blocking(app).await.unwrap_or_default(),
        account_id,
    )
    .await
}

/// Copy one session into another subscription's store so it can be resumed
/// there (a fork; the source stays). `None` is the default profile.
/// `false` when the session has no transcript yet, so nothing was copied.
#[tauri::command]
pub async fn transfer_agent_session(
    app: AppHandle,
    agent_id: String,
    session_id: String,
    from_account_id: Option<String>,
    to_account_id: Option<String>,
) -> Result<bool, String> {
    let accounts = accounts_blocking(app).await?;
    let base = |id: &Option<String>| -> Result<std::path::PathBuf, String> {
        match id {
            Some(id) => accounts
                .iter()
                .find(|a| &a.id == id && a.agent_id == agent_id)
                .map(|a| std::path::PathBuf::from(&a.config_dir))
                .ok_or_else(|| "Account profile no longer exists".into()),
            None => crate::sessions::share::default_base(&agent_id)
                .ok_or_else(|| "No default profile folder".into()),
        }
    };
    let (from, to) = (base(&from_account_id)?, base(&to_account_id)?);
    tauri::async_runtime::spawn_blocking(move || {
        crate::sessions::share::transfer(&agent_id, &session_id, &from, &to)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_session_share() -> crate::sessions::share::ShareSettings {
    crate::sessions::share::load()
}

/// Switch "share sessions between all subscriptions". Moves folders, so it
/// runs off the UI thread; errors name each profile that could not follow.
#[tauri::command]
pub async fn set_session_share(
    app: AppHandle,
    settings: crate::sessions::share::ShareSettings,
) -> Result<crate::sessions::share::ShareSettings, String> {
    let accounts = accounts_blocking(app).await?;
    tauri::async_runtime::spawn_blocking(move || crate::sessions::share::apply(&accounts, settings))
        .await
        .map_err(|e| e.to_string())?
}

/// Read-only conversation of one agent session (SWA-25). Fail-open: a missing
/// or unreadable file is `found: false`, never an error.
#[tauri::command]
pub async fn read_agent_thread(
    app: AppHandle,
    agent_id: String,
    session_id: String,
    account_id: Option<String>,
) -> crate::sessions::thread::Thread {
    crate::sessions::read_thread(
        agent_id,
        session_id,
        accounts_blocking(app).await.unwrap_or_default(),
        account_id,
    )
    .await
}

#[tauri::command]
pub async fn inspect_saved_workspace(
    app: AppHandle,
    window: tauri::WebviewWindow,
    cwd: String,
    panes: Vec<crate::sessions::SavedPane>,
) -> Result<crate::sessions::SavedInspection, String> {
    files_main_only(&window)?;
    // A broken/unreadable account store is not evidence of deleted accounts.
    // Refuse restoration instead of clearing valid profile/session references.
    crate::sessions::inspect_saved(cwd, panes, accounts_blocking(app).await?).await
}

/// `accounts::list` does file IO under a std mutex; run it on the blocking
/// pool instead of an async worker.
async fn accounts_blocking(app: AppHandle) -> Result<Vec<crate::accounts::AgentAccount>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::accounts::list(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Install or remove Claude Code's `statusLine` entry. Driven from the renderer
/// (on boot and on toggle) rather than from Rust's `setup`, because the
/// preference lives in localStorage and only the renderer can read it. That
/// ordering is fine: the status line only matters once a Claude pane exists,
/// which is strictly after the renderer has mounted.
#[tauri::command]
pub async fn set_claude_statusline(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::accounts::STATUSLINE_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        // Blocking tasks may start out of order when the preference is toggled
        // quickly. Each serialized update applies the latest requested value.
        static STATUSLINE_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = STATUSLINE_WRITE
            .lock()
            .map_err(|_| "Status line configuration update interrupted")?;
        let enabled =
            crate::accounts::STATUSLINE_ENABLED.load(std::sync::atomic::Ordering::Relaxed);
        // A custom status line in the default profile is the user's and stays;
        // it must not stop the profiles below from following the switch.
        let default = crate::statusline::install::tolerate_foreign(
            crate::statusline::install::apply(&app, enabled),
        );
        // One broken profile must not leave the others on the old setting:
        // enroll all, then report the first failure.
        let mut first_err = default.err();
        for account in crate::accounts::list(&app)? {
            if account.agent_id == "claude-code" {
                if let Err(e) = crate::accounts::enroll(&account, None) {
                    eprintln!(
                        "statusline: cannot update account profile {}: {e}",
                        account.id
                    );
                    first_err.get_or_insert(e);
                }
            }
        }
        first_err.map_or(Ok(()), Err)
    })
    .await
    .map_err(|_| "Status line configuration update interrupted")?
}

#[tauri::command]
pub async fn git_list_worktrees(
    app: AppHandle,
    cwd: String,
) -> Result<Vec<crate::git::WorktreeInfo>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::list_worktrees(std::path::Path::new(&cwd), &home)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_changed_files(
    worktree_path: String,
) -> Result<Vec<crate::git::ChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_changed_files(std::path::Path::new(&worktree_path))
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_file_diff(worktree_path: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_file_diff(std::path::Path::new(&worktree_path), &file)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_commit_info(worktree_path: String) -> Result<crate::git::CommitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_commit_info(std::path::Path::new(&worktree_path))
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_unmerged_count(repo_root: String, branch: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::branch_unmerged_count(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_merge_readiness(
    repo_root: String,
    branch: String,
) -> Result<crate::git::MergeReadiness, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::merge_readiness(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_create_worktree(
    repo_root: String,
    branch: String,
) -> Result<crate::git::CreatedWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::create_worktree(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_clear_worktree(
    repo_root: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::clear_worktree(
            std::path::Path::new(&repo_root),
            std::path::Path::new(&worktree_path),
            &branch,
        )
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

/// Ensure a directory is a git repository with at least one commit.
/// Frontend calls this during workspace creation when isolate=true and the
/// folder is not yet a git repo. `home` is resolved here (like git_list_worktrees)
/// so the backend can ignore a repo that merely contains the folder.
#[tauri::command]
pub async fn ensure_repo_with_commit(app: AppHandle, path: String) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::ensure_repo_with_commit(std::path::Path::new(&path), &home)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve a path candidate the renderer found in terminal output. Returns the
/// canonical path as a string, or `None` when it does not name an existing file
/// — in which case the renderer does not draw a link.
///
/// Async: `canonicalize` can take long on network drives / under AV hooks, and
/// it runs per link candidate the renderer finds.
#[tauri::command]
pub async fn resolve_path_link(cwd: String, candidate: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::links::resolve_candidate(std::path::Path::new(&cwd), &candidate)
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Folder counterpart of [`resolve_path_link`]: canonical path of an existing
/// directory, or `None`.
#[tauri::command]
pub async fn resolve_dir_link(cwd: String, candidate: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::links::resolve_dir_candidate(std::path::Path::new(&cwd), &candidate)
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// One level of subfolders for the in-app folder picker; `""` lists drive
/// roots. Async so a slow network drive never stalls the main thread.
#[tauri::command]
pub async fn list_folders(path: String) -> Result<crate::folder_list::FolderListing, String> {
    crate::folder_list::list_folders_blocking(path).await
}

/// First of `candidates` (an allowlisted editor id) found on PATH. The renderer
/// asks once and caches; `None` means fall back to revealing in the file manager.
#[tauri::command]
pub fn find_available_editor(candidates: Vec<String>) -> Option<String> {
    let allowed: Vec<String> = candidates
        .into_iter()
        .filter(|c| crate::links::is_allowed_editor(c))
        .collect();
    let path_var = std::env::var("PATH").unwrap_or_default();
    crate::links::find_editor(&path_var, &allowed)
}

/// Launch an editor by argv. Never goes through a shell, so nothing in `args`
/// can be reinterpreted as shell syntax, and `bin` is re-checked against the
/// allowlist because the renderer is not a trust boundary.
#[tauri::command]
pub fn open_in_editor(bin: String, args: Vec<String>) -> Result<(), String> {
    if !crate::links::is_allowed_editor(&bin) {
        return Err(format!("editor not allowed: {bin}"));
    }
    // Filtered like a pane: an editor is a GUI app, but its extensions and
    // integrated terminals inherit what we pass, and nothing it needs lives
    // only in the app's secrets (users allow-list what an editor needs).
    crate::terminal_env::command(&bin)
        .args(&args)
        .spawn()
        .map(|mut child| {
            // Reap it off-thread: an un-waited child stays a zombie on Unix.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .map_err(|e| e.to_string())
}

/// Show the file in the OS file manager. Used when no allowlisted editor is on
/// PATH. Reveal-only: the file is selected, never opened, so this can't execute
/// anything.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    crate::links::reveal_in_file_manager(&path)
}

/// Frontend drags a pane into one room's drop zone. Metadata is a frontend
/// snapshot: the leaf's explicit agentId and the registry's live cwd — the
/// Rust terminal map deliberately stores neither. Joining room X while
/// already a member of room Y moves it: `WarRooms::join` leaves Y first.
#[tauri::command]
pub fn war_room_join(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    terminal_id: String,
    agent_id: Option<String>,
    cwd: String,
    display_name: String,
) -> Result<(), String> {
    state.admin_policy.check(crate::policy::Lock::WarRoom)?;
    let joined_id = terminal_id.clone();
    // TOCTOU: this liveness check and the `war_rooms.join` insert below take
    // two separate mutexes with no lock held across both, so a pane that dies
    // in the gap between them still gets inserted as a member. Accepted: it's
    // recoverable via the chip's ✕ / leave, and the alternative (a single
    // lock spanning both maps) isn't worth the coupling for a rare, low-cost
    // race — leaves a ghost member, not a stuck or corrupted state.
    if !state.terminals.lock().unwrap().contains_key(&terminal_id) {
        return Err(format!("terminal \"{terminal_id}\" is not live"));
    }
    // Without the MCP server the room's tools are unreachable — joining would
    // look successful while nothing works. Fail loudly instead (spec §failure
    // modes); the renderer logs it and the pane simply doesn't join.
    if state.mcp_url.get().is_none() {
        return Err("MCP server failed to start this run — War Room is unavailable".into());
    }
    let outcome = join_war_room(&state, &room_id, terminal_id, agent_id, cwd, display_name)?;
    // Old room's Leave first, then the Join — the renderer's queue cleanup
    // must run before the new membership appears.
    if let Some((old_room, ev)) = outcome.left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&old_room, ev));
    }
    let _ = app.emit(
        "warroom:event",
        &crate::warroom::scoped(&room_id, outcome.joined),
    );
    // The agent's MCP client usually connected long before the drag — then the
    // pane is ready the moment it joins, no first tool call needed.
    if state.mcp_clients.lock().unwrap().has_seen(&joined_id) {
        connect_war_room_member(&app, &joined_id);
    }
    Ok(())
}

// Membership mutations wake every `wait_peer` sleeper (`peer_wake`, see
// mcp/tools/peers.rs): a peer that leaves, moves or loses its room must be
// reported as gone at once, not after the stall/deadline timer. The
// `war_rooms` lock is released before the wake. The pty death paths
// (`kill_terminal`, `read_loop`) wake on their own.
pub(crate) fn join_war_room(
    state: &AppState,
    room_id: &str,
    terminal_id: String,
    agent_id: Option<String>,
    cwd: String,
    display_name: String,
) -> Result<crate::warroom::JoinOutcome, String> {
    let outcome = state.war_rooms.lock().unwrap().join(
        room_id,
        terminal_id,
        agent_id,
        cwd,
        display_name,
        crate::warroom::now_ms(),
    )?;
    state.peer_wake.notify_waiters();
    Ok(outcome)
}

pub(crate) fn leave_war_rooms(
    state: &AppState,
    terminal_id: &str,
) -> Option<(String, crate::warroom::WarRoomEvent)> {
    let left = state
        .war_rooms
        .lock()
        .unwrap()
        .leave_everywhere(terminal_id, crate::warroom::now_ms());
    if left.is_some() {
        state.peer_wake.notify_waiters();
    }
    left
}

pub(crate) fn delete_war_room(
    state: &AppState,
    room_id: &str,
) -> Result<
    (
        Vec<crate::warroom::WarRoomEvent>,
        Vec<crate::warroom::RoomMeta>,
    ),
    String,
> {
    let (leaves, rooms) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let leaves = reg.delete(room_id, crate::warroom::now_ms())?;
        (leaves, reg.rooms_meta())
    };
    if !leaves.is_empty() {
        state.peer_wake.notify_waiters();
    }
    Ok((leaves, rooms))
}

#[cfg(test)]
mod war_room_wake_tests {
    use super::*;
    use std::time::Duration;

    // True when a waiter that started listening before `f` is woken by it.
    async fn wakes(state: &AppState, f: impl FnOnce(&AppState)) -> bool {
        let mut n = std::pin::pin!(state.peer_wake.notified());
        n.as_mut().enable();
        f(state);
        tokio::time::timeout(Duration::from_millis(50), n)
            .await
            .is_ok()
    }

    fn room(state: &AppState) -> String {
        state.war_rooms.lock().unwrap().rooms_meta()[0]
            .room_id
            .clone()
    }

    fn join(state: &AppState, room: &str, id: &str) {
        join_war_room(
            state,
            room,
            id.into(),
            Some("claude-code".into()),
            "C:/".into(),
            id.into(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn join_wakes_waiters() {
        let s = AppState::default();
        let r = room(&s);
        assert!(wakes(&s, |s| join(s, &r, "t1")).await);
    }

    #[tokio::test]
    async fn move_between_rooms_wakes_waiters() {
        let s = AppState::default();
        let r1 = room(&s);
        let r2 = s
            .war_rooms
            .lock()
            .unwrap()
            .create("Second")
            .unwrap()
            .room_id;
        join(&s, &r1, "t1");
        assert!(wakes(&s, |s| join(s, &r2, "t1")).await);
    }

    #[tokio::test]
    async fn leave_wakes_waiters_only_when_a_member_left() {
        let s = AppState::default();
        let r = room(&s);
        join(&s, &r, "t1");
        assert!(wakes(&s, |s| assert!(leave_war_rooms(s, "t1").is_some())).await);
        assert!(!wakes(&s, |s| assert!(leave_war_rooms(s, "t1").is_none())).await);
    }

    #[tokio::test]
    async fn delete_with_members_wakes_waiters() {
        let s = AppState::default();
        let r2 = s
            .war_rooms
            .lock()
            .unwrap()
            .create("Second")
            .unwrap()
            .room_id;
        join(&s, &r2, "t1");
        assert!(
            wakes(&s, |s| assert_eq!(
                delete_war_room(s, &r2).unwrap().0.len(),
                1
            ))
            .await
        );
    }
}

/// Flip a room member to connected and emit the transcript event on the
/// false→true edge. No-op for non-members and already-connected members.
/// Lock order: `war_rooms` alone, released before emitting.
pub(crate) fn connect_war_room_member(app: &AppHandle, terminal_id: &str) {
    let scoped = {
        let state = app.state::<AppState>();
        let mut rooms = state.war_rooms.lock().unwrap();
        rooms.find_room_of(terminal_id).and_then(|entry| {
            let id = entry.id.clone();
            entry
                .room
                .mark_connected(terminal_id, crate::warroom::now_ms())
                .map(|ev| crate::warroom::scoped(&id, ev))
        })
    };
    if let Some(ev) = scoped {
        let _ = app.emit("warroom:event", &ev);
    }
}

/// Full rooms snapshot for renderer hydration (boot / dev reload).
#[tauri::command]
pub fn war_room_rooms(state: State<'_, AppState>) -> Vec<crate::warroom::RoomInfo> {
    state.war_rooms.lock().unwrap().rooms_info()
}

#[tauri::command]
pub fn war_room_leave(app: AppHandle, state: State<'_, AppState>, terminal_id: String) {
    let left = leave_war_rooms(&state, &terminal_id);
    if let Some((room_id, event)) = left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    }
}

#[tauri::command]
pub fn war_room_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<crate::warroom::RoomMeta, String> {
    let (meta, rooms) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let meta = reg.create(&name)?;
        (meta, reg.rooms_meta())
    };
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(meta)
}

#[tauri::command]
pub fn war_room_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    name: String,
) -> Result<(), String> {
    let rooms = {
        let mut reg = state.war_rooms.lock().unwrap();
        reg.rename(&room_id, &name)?;
        reg.rooms_meta()
    };
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(())
}

#[tauri::command]
pub fn war_room_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
) -> Result<(), String> {
    let (leaves, rooms) = delete_war_room(&state, &room_id)?;
    // Leaves first (queue/held cleanup per member), snapshot last (tab strip).
    for ev in leaves {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, ev));
    }
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(())
}

/// The user speaking as the Moderator of ONE room, from that room's composer.
/// Same lock-then-emit discipline; error strings surface inline in the composer.
#[tauri::command]
pub fn war_room_moderator_send(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    to: Option<String>,
    content: String,
    mode: Option<String>,
) -> Result<usize, String> {
    state.admin_policy.check(crate::policy::Lock::WarRoom)?;
    let mode = crate::warroom::MessageMode::parse(mode.as_deref())?;
    let (event, deliveries) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let entry = reg
            .get(&room_id)
            .ok_or_else(|| format!("no such room \"{room_id}\""))?;
        let out = entry.room.send(
            crate::warroom::MODERATOR_ID,
            to.as_deref(),
            &content,
            mode,
            crate::warroom::now_ms(),
        )?;
        (out.event, out.deliveries)
    };
    let delivered = deliveries.len();
    let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    for d in deliveries {
        let _ = app.emit("warroom:deliver", &d);
    }
    Ok(delivered)
}

/// Save a clipboard screenshot to a temp PNG and return its path (`None` when
/// the clipboard holds no image). Off the main thread: encoding a 4K capture
/// to PNG takes long enough to stall the UI.
#[tauri::command]
pub async fn save_clipboard_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(crate::paste_image::save_clipboard_image)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_agent_accounts(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<crate::accounts::AgentAccount>, String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::accounts::list(&app))
        .await
        .map_err(|_| "Account profile listing interrupted")?
}
#[tauri::command]
pub async fn save_agent_account(
    window: tauri::WebviewWindow,
    app: AppHandle,
    account: crate::accounts::AccountInput,
) -> Result<crate::accounts::AgentAccount, String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        crate::accounts::save(&app, account, state.mcp_url.get().map(|url| url.as_ref()))
    })
    .await
    .map_err(|_| "Account profile save interrupted")?
}
#[tauri::command]
pub async fn delete_agent_account(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::accounts::delete(&app, &id))
        .await
        .map_err(|_| "Account profile deletion interrupted")?
}

/// Login state, plan and rate limits for one profile (`accountId` absent =
/// the agent's default login). Metadata only — see `account_status.rs`.
#[tauri::command]
pub async fn get_account_status(
    window: tauri::WebviewWindow,
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
) -> Result<crate::account_status::AccountStatus, String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = account_config_dir(&app, &agent_id, account_id.as_deref())?;
        Ok(crate::account_status::read_status(&agent_id, &dir))
    })
    .await
    .map_err(|_| "Account status check interrupted")?
}

/// The CLI's config folder for a profile, with the same env/home fallback the
/// CLIs themselves use for the default login.
fn account_config_dir(
    app: &AppHandle,
    agent_id: &str,
    account_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if !matches!(agent_id, "claude-code" | "codex") {
        return Err("Account status supports Claude and Codex profiles".into());
    }
    if let Some(id) = account_id {
        let account = crate::accounts::list(app)?
            .into_iter()
            .find(|a| a.id == id && a.agent_id == agent_id)
            .ok_or("Account profile no longer exists")?;
        return Ok(account.config_dir.into());
    }
    let (var, fallback) = if agent_id == "codex" {
        ("CODEX_HOME", ".codex")
    } else {
        ("CLAUDE_CONFIG_DIR", ".claude")
    };
    if let Some(dir) = std::env::var(var).ok().filter(|v| !v.trim().is_empty()) {
        return Ok(dir.into());
    }
    app.path()
        .home_dir()
        .map(|home| home.join(fallback))
        .map_err(|_| "Cannot resolve default account directory".into())
}

fn account_mcp_path(
    app: &AppHandle,
    agent_id: &str,
    account_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if !matches!(agent_id, "claude-code" | "codex") {
        return Err("MCP catalogue supports Claude and Codex profiles".into());
    }
    if let Some(id) = account_id {
        let account = crate::accounts::resolve(app, id, Some(agent_id))?;
        return Ok(
            std::path::Path::new(&account.config_dir).join(if agent_id == "codex" {
                "config.toml"
            } else {
                ".claude.json"
            }),
        );
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot resolve default account directory")?;
    if agent_id == "codex" {
        let config_dir = std::env::var("CODEX_HOME").ok();
        Ok(crate::mcp::config::resolve_codex_config_path(
            &home,
            config_dir.as_deref(),
        ))
    } else {
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        Ok(crate::mcp::config::resolve_global_config_path(
            &home,
            config_dir.as_deref(),
        ))
    }
}

#[tauri::command]
pub async fn configure_account_mcp(
    window: tauri::WebviewWindow,
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
    entry_id: String,
    directories: Vec<String>,
) -> Result<(), String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = account_mcp_path(&app, &agent_id, account_id.as_deref())?;
        crate::mcp::catalog::configure_catalog(&path, &agent_id, &entry_id, &directories)
    })
    .await
    .map_err(|_| "MCP configuration update interrupted")?
}

#[tauri::command]
pub async fn inspect_account_mcp(
    window: tauri::WebviewWindow,
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
) -> Result<crate::mcp::catalog::CatalogStatus, String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = account_mcp_path(&app, &agent_id, account_id.as_deref())?;
        crate::mcp::catalog::inspect_catalog(&path, &agent_id)
    })
    .await
    .map_err(|_| "MCP configuration inspection interrupted")?
}

/// One row of Settings → MCP's Swarmterm switch list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmtermMcpProfile {
    agent_id: String,
    account_id: Option<String>,
    account_name: Option<String>,
    enabled: bool,
    entry: crate::mcp::toggle::EntryState,
    config_path: String,
    url: Option<String>,
}

fn swarmterm_mcp_path(
    app: &AppHandle,
    agent_id: &str,
    account_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if agent_id != "qwen" {
        return account_mcp_path(app, agent_id, account_id);
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot resolve home directory")?;
    let qwen_home = std::env::var("QWEN_HOME").ok();
    Ok(crate::mcp::config::resolve_qwen_settings_path(
        &home,
        qwen_home.as_deref(),
    ))
}

#[tauri::command]
pub async fn swarmterm_mcp_profiles(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<SwarmtermMcpProfile>, String> {
    files_main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = app.state::<AppState>().mcp_url.get().map(|u| u.to_string());
        let mut rows: Vec<(String, Option<String>, Option<String>)> = vec![
            ("claude-code".into(), None, None),
            ("codex".into(), None, None),
        ];
        if crate::agents::find_agent_binary("qwen").is_some() {
            rows.push(("qwen".into(), None, None));
        }
        if crate::agents::find_agent_binary("opencode").is_some() {
            rows.push(("opencode".into(), None, None));
        }
        for a in crate::accounts::list(&app)? {
            rows.push((a.agent_id, Some(a.id), Some(a.name)));
        }
        rows.into_iter()
            .map(|(agent_id, account_id, account_name)| {
                if agent_id == "opencode" {
                    return Ok(SwarmtermMcpProfile {
                        enabled: crate::mcp::toggle::is_enabled("opencode", None),
                        entry: crate::mcp::toggle::EntryState::PerPane,
                        config_path: "OPENCODE_CONFIG_CONTENT (per pane)".into(),
                        url: url.clone(),
                        agent_id,
                        account_id,
                        account_name,
                    });
                }
                let path = swarmterm_mcp_path(&app, &agent_id, account_id.as_deref())?;
                Ok(SwarmtermMcpProfile {
                    enabled: crate::mcp::toggle::is_enabled(&agent_id, account_id.as_deref()),
                    entry: crate::mcp::toggle::entry_state_of_file(&path, agent_id == "codex"),
                    config_path: path.to_string_lossy().into_owned(),
                    url: url.clone(),
                    agent_id,
                    account_id,
                    account_name,
                })
            })
            .collect()
    })
    .await
    .map_err(|_| "MCP profile inspection interrupted")?
}

/// Switch Swarmterm's own MCP entry for one profile. Off removes only our
/// entry (a user's own `swarmterm` server survives); on writes it back now,
/// so the next pane of that profile connects without a restart.
#[tauri::command]
pub async fn set_swarmterm_mcp(
    window: tauri::WebviewWindow,
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    files_main_only(&window)?;
    // Switching on under DisableMcp is refused here with the policy message;
    // `toggle::set_enabled` refuses it again as the backstop.
    if enabled {
        app.state::<AppState>()
            .admin_policy
            .check(crate::policy::Lock::Mcp)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = account_id.as_deref() {
            crate::accounts::resolve(&app, id, Some(&agent_id))?;
        } else if agent_id == "opencode" {
            // Nothing on disk: the flag alone gates the per-pane env.
            return crate::mcp::toggle::set_enabled("opencode", None, enabled);
        } else if !matches!(agent_id.as_str(), "claude-code" | "codex" | "qwen") {
            return Err("Unsupported agent".into());
        }
        let path = swarmterm_mcp_path(&app, &agent_id, account_id.as_deref())?;
        crate::mcp::toggle::set_enabled(&agent_id, account_id.as_deref(), enabled)?;
        let _lock = crate::accounts::CONFIG_WRITE
            .lock()
            .map_err(|e| e.to_string())?;
        if !enabled {
            return crate::mcp::toggle::remove_from_file(&path, agent_id == "codex");
        }
        match agent_id.as_str() {
            "claude-code" => crate::mcp::config::write_mcp_config_to_file(&path),
            "qwen" => crate::mcp::config::write_qwen_settings_to_file(&path),
            // Dev builds pin Codex per process; only the installed app owns
            // the URL in config.toml (see mcp::start).
            _ => match app.state::<AppState>().mcp_url.get() {
                Some(url) if !cfg!(debug_assertions) => {
                    crate::mcp::config::write_codex_config_to_file(&path, url)
                }
                _ => Ok(()),
            },
        }
    })
    .await
    .map_err(|_| "MCP switch interrupted")?
}

/// Command routines (SWA-67): one shell line from the user's routine list,
/// run without a pane. Main webview only — a preview page must never reach it.
#[tauri::command]
pub async fn run_routine_command(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    command: String,
    cwd: String,
    timeout_secs: u64,
) -> Result<crate::routine_cmd::CommandOutcome, String> {
    if webview.label() != "main" {
        return Err("Routines are available only in the main application".into());
    }
    state
        .admin_policy
        .check(crate::policy::Lock::RoutineCommands)?;
    crate::routine_cmd::validate(&command, &cwd, timeout_secs)?;
    let env = state.env_policy_snapshot().inherited();
    tauri::async_runtime::spawn_blocking(move || {
        crate::routine_cmd::run(
            &command,
            &cwd,
            std::time::Duration::from_secs(timeout_secs),
            &env,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
