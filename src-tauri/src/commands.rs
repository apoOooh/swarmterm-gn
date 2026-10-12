use portable_pty::PtySize;
use std::io::Write;
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

#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Preserve serialized creation/duplicate-id checks while keeping config
        // reads, profile enrollment and OS process startup off the UI thread.
        static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let Ok(_guard) = SPAWN_LOCK.lock() else {
            return CreateTerminalResult::err("Terminal creation interrupted");
        };
        let state = app.state::<AppState>();
        crate::pty::spawn_terminal(&app, &state, id, options, on_data)
    })
    .await
    .unwrap_or_else(|_| CreateTerminalResult::err("Terminal creation interrupted"))
}

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, id: String, data: String) {
    if let Some(t) = state.terminals.lock().unwrap().get_mut(&id) {
        let _ = t.writer.write_all(data.as_bytes());
        let _ = t.writer.flush();
    }
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) {
    if let Some(t) = state.terminals.lock().unwrap().get(&id) {
        let _ = t.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
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
    let removed = state.terminals.lock().unwrap().remove(&id);
    if let Some(mut t) = removed {
        t.kill();
        // Dropping `t` (and its master PTY) at end of scope forces the reader's EOF.
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
    // The context chip too: a respawned Claude must not inherit the old %.
    state.context_usage.lock().unwrap().forget(&id);
    state.rate_limit_usage.lock().unwrap().forget(&id);
    // Same for the agent-state mirror + screen tail: a respawn must start
    // from `unknown`, and a `wait_peer` sleeper on this id must wake now to
    // see the peer gone rather than run out its timeout.
    state.peer_states.lock().unwrap().forget(&id);
    state.peer_wake.notify_waiters();
}

/// Screen-independent proof that the pane's agent CLI is still running: a
/// process matching its agent id lives below the pane's shell. Used by the
/// handoff delivery right before paste and before Enter. Any doubt (unknown
/// pane, no pid, snapshot failure, non-Windows) answers `false`.
#[tauri::command]
pub fn terminal_agent_alive(state: State<'_, AppState>, id: String) -> bool {
    // Copy what we need and drop the lock before the (slower) OS snapshot.
    let (pid, agent_id) = match state.terminals.lock().unwrap().get(&id) {
        Some(t) => (t.pid, t.agent_id.clone()),
        None => return false,
    };
    let Some(pid) = pid else { return false };
    match crate::agent_process::snapshot() {
        Some(procs) => crate::agent_process::agent_alive_in(
            &procs,
            pid,
            agent_id.as_deref(),
            crate::agent_process::command_line,
        ),
        None => false,
    }
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

#[tauri::command]
pub fn list_available_shells() -> Vec<crate::shell::ShellEntry> {
    crate::shell::list_shells().to_vec()
}

#[tauri::command]
pub fn windows_build_number() -> Option<u32> {
    crate::shell::windows_build_number()
}

#[tauri::command]
pub fn list_available_agents() -> Vec<crate::agents::AgentEntry> {
    crate::agents::list_agents()
}

#[tauri::command]
pub async fn list_agent_sessions(
    app: AppHandle,
    folder: String,
    account_id: Option<String>,
) -> Vec<crate::sessions::SessionEntry> {
    crate::sessions::list_all(
        folder,
        crate::accounts::list(&app).unwrap_or_default(),
        account_id,
    )
    .await
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
        crate::accounts::list(&app).unwrap_or_default(),
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
    crate::sessions::inspect_saved(cwd, panes, crate::accounts::list(&app)?).await
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
        crate::statusline::install::apply(&app, enabled)?;
        for account in crate::accounts::list(&app)? {
            if account.agent_id == "claude-code" {
                crate::accounts::enroll(&account, None)?;
            }
        }
        Ok(())
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
#[tauri::command]
pub fn resolve_path_link(cwd: String, candidate: String) -> Option<String> {
    crate::links::resolve_candidate(std::path::Path::new(&cwd), &candidate)
        .map(|p| p.to_string_lossy().into_owned())
}

/// Folder counterpart of [`resolve_path_link`]: canonical path of an existing
/// directory, or `None`.
#[tauri::command]
pub fn resolve_dir_link(cwd: String, candidate: String) -> Option<String> {
    crate::links::resolve_dir_candidate(std::path::Path::new(&cwd), &candidate)
        .map(|p| p.to_string_lossy().into_owned())
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
    std::process::Command::new(&bin)
        .args(&args)
        .spawn()
        .map(|_| ())
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
    let outcome = state.war_rooms.lock().unwrap().join(
        &room_id,
        terminal_id,
        agent_id,
        cwd,
        display_name,
        crate::warroom::now_ms(),
    )?;
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
    let left = state
        .war_rooms
        .lock()
        .unwrap()
        .leave_everywhere(&terminal_id, crate::warroom::now_ms());
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
    let (leaves, rooms) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let leaves = reg.delete(&room_id, crate::warroom::now_ms())?;
        (leaves, reg.rooms_meta())
    };
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
