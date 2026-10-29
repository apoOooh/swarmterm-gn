mod account_status;
mod accounts;
mod agent_policy;
mod agent_process;
mod agents;
mod child_priority;
mod clipboard_media;
mod commands;
mod dev_defer;
mod devlog;
mod files;
mod folder_list;
mod git;
mod host_client;
mod json_style;
mod links;
mod marked_media;
mod mcp;
mod paste_image;
mod policy;
mod preview;
mod prof;
mod pty;
mod routine_cmd;
mod sessions;
mod shell;
// Public so `main.rs` can reach `--statusline` without booting Tauri.
pub mod statusline;
// Public so `main.rs` can reach `--hook` without booting Tauri.
pub mod hook;
mod terminal_env;
mod tray;
mod voice;
mod warroom;
mod window_fit;

use pty::AppState;
use std::sync::atomic::Ordering;
use tauri::Manager;
use tauri::WindowEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "profiling")]
    install_named_runtime();
    tauri::Builder::default()
        // Admin policy is read before anything else runs, so no boot step
        // (MCP enrollment, restore spawns) can act before the locks apply.
        .manage(AppState {
            admin_policy: policy::load(),
            ..AppState::default()
        })
        .manage(host_client::HostHub::default())
        .manage(voice::VoiceHub::default())
        .manage(clipboard_media_state())
        .manage(marked_media::MarkedMedia::default())
        .manage(voice::tts::TtsHub::default())
        .manage(voice::companion::Companion::default())
        .manage(voice_speech_hub())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("swarmterm-media", |context, request| {
            let service = context
                .app_handle()
                .state::<std::sync::Arc<files::FileService>>();
            files::media_response(&service, context.webview_label(), request)
        })
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            crate::prof::start(app.handle());
            // Before any pane, routine or other child process spawns: the
            // user's env policy from the last run (admin policy applied), not
            // the built-in default.
            match app.path().app_data_dir() {
                Ok(dir) => app
                    .state::<AppState>()
                    .load_env_policy(dir.join("env-policy.json")),
                Err(_) => {
                    let state = app.state::<AppState>();
                    crate::terminal_env::publish_child_policy(state.env_policy_snapshot());
                }
            }
            // The window title (taskbar, Alt+Tab) comes from tauri.conf.json,
            // which is shared by both editions; the edition is a compile-time
            // fact, so the binary sets it rather than a second config copy of
            // the whole `windows` array.
            if policy::EDITION == policy::Edition::Corp {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title(policy::EDITION.product_name());
                }
            }
            app.manage(child_priority::ChildPriority::default());
            app.manage(std::sync::Arc::new(files::FileService::new(
                app.path().app_data_dir()?.join("local-history"),
            )));
            // The configured 1280×820 overflows small displays (on a MacBook
            // the Dock covers the bottom edge), so clamp the window to the
            // monitor's work area and center it. The window is created with
            // `visible: false` and shown later by the renderer, so resizing
            // here never flashes.
            if let Some(win) = app.get_webview_window("main") {
                let monitor = win
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| win.primary_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    let wa = monitor.work_area();
                    let desired = win.outer_size().unwrap_or(wa.size);
                    let fit = window_fit::fit_to_work_area(
                        (wa.position.x, wa.position.y),
                        (wa.size.width, wa.size.height),
                        (desired.width, desired.height),
                    );
                    let _ = win.set_size(tauri::PhysicalSize::new(fit.width, fit.height));
                    let _ = win.set_position(tauri::PhysicalPosition::new(fit.x, fit.y));
                }
            }
            tray::setup_tray(app)?;
            // Register the MCP server at Claude's user scope (~/.claude.json)
            // instead of dropping a .mcp.json into every project. One-shot,
            // idempotent, log-only.
            // The Settings → MCP opt-outs must be known before the first
            // writer runs, or a switched-off profile is re-enrolled at boot.
            // DisableMcp turns every profile's switch off: the writers below
            // then remove our entries instead of (re)adding them.
            crate::mcp::toggle::set_policy_off(app.state::<AppState>().admin_policy.disable_mcp);
            if let Ok(dir) = app.path().app_data_dir() {
                crate::mcp::toggle::load(dir.join("swarmterm-mcp-disabled.json"));
                // Before any pane starts: a profile added while the app was
                // closed must be linked before its first `claude` writes.
                crate::sessions::share::init(dir);
                if let Ok(accounts) = crate::accounts::list(app.handle()) {
                    crate::sessions::share::repair(&accounts);
                }
            }
            crate::mcp::config::register_user_scope(app.handle());
            // Register `swarmterm --hook` under Claude Code's hook events in
            // ~/.claude/settings.json so Claude Code panes report exact
            // working/blocked/idle edges instead of relying on screen-scrape
            // alone. Additive on `hooks` (the user's own groups survive),
            // one-shot, idempotent, log-only. Must run BEFORE any pane launches
            // `claude`: hooks are snapshotted at session start.
            crate::hook::install::register(app.handle());
            crate::hook::codex::register(app.handle());
            // `codex --help` probe can take seconds on a cold start; pay it
            // here, off-thread, instead of on the first Codex pane spawn.
            crate::hook::codex::warm();
            // Voice dictation endpoint (SWA-12): named pipe + discovery file
            // for buzzkey; follows Settings → Voice. Failure is logged only.
            crate::voice::init(app.handle());
            // Terminal host switch (SWA-55); the host starts with the first
            // pane that needs it, not here.
            crate::host_client::init(app.handle());
            // Boot the MCP server. Any failure is logged and swallowed: browser
            // preview via MCP just won't work for this run, but Swarmterm as a
            // whole still functions.
            let handle_for_mcp = app.handle().clone();
            // DisableMcp: no listener at all, so panes get no SWARMTERM_MCP_URL.
            let mcp_allowed = !app.state::<AppState>().admin_policy.disable_mcp;
            tauri::async_runtime::spawn(async move {
                if !mcp_allowed {
                    eprintln!("mcp: disabled by admin policy");
                    return;
                }
                match crate::mcp::start(handle_for_mcp).await {
                    Ok(url) => eprintln!("mcp: listening on {url}"),
                    Err(e) => eprintln!("mcp: {e}"),
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            devlog::dev_log,
            commands::files_open_context,
            commands::confirm_quit,
            commands::run_routine_command,
            commands::save_clipboard_image,
            commands::files_request,
            commands::files_watch,
            commands::media_check_detected,
            commands::media_open,
            commands::clipboard_media_set_enabled,
            commands::child_priority_set,
            commands::env_policy_set,
            commands::agent_policy_set,
            commands::policy_get,
            commands::media_save_marked,
            commands::media_read_opened_image,
            commands::files_unwatch,
            commands::create_terminal,
            commands::write_terminal,
            commands::write_terminal_checked,
            commands::ack_output,
            commands::release_output,
            host_client::terminal_host_get_settings,
            host_client::terminal_host_set_settings,
            host_client::terminal_host_status,
            host_client::terminal_host_detached,
            host_client::terminal_host_keep,
            host_client::terminal_host_release,
            voice::voice_focus_response,
            voice::voice_insert_result,
            voice::voice_indicator_stop,
            voice::voice_turn_event,
            voice::voice_tts_stop,
            voice::voice_tts_test,
            voice::voice_tts_status,
            voice::voice_get_settings,
            voice::voice_set_settings,
            voice::companion::voice_companion_status,
            voice::companion::voice_companion_check,
            voice::companion::voice_companion_install,
            voice::companion::voice_companion_start,
            voice::companion::voice_companion_quit,
            voice::companion::voice_companion_set_autostart,
            voice::companion::voice_companion_probe,
            voice::voice_dictation_toggle,
            voice::voice_dictation_cancel,
            voice::voice_speech_status,
            voice::voice_model_download,
            voice::voice_model_cancel,
            voice::voice_model_delete,
            commands::resize_terminal,
            commands::kill_terminal,
            commands::war_room_join,
            commands::war_room_leave,
            commands::war_room_rooms,
            commands::war_room_create,
            commands::war_room_rename,
            commands::war_room_delete,
            commands::war_room_moderator_send,
            commands::report_agent_state,
            commands::terminal_agent_alive,
            commands::list_available_shells,
            commands::windows_build_number,
            commands::list_available_agents,
            commands::list_agent_accounts,
            commands::save_agent_account,
            commands::delete_agent_account,
            commands::get_account_status,
            commands::configure_account_mcp,
            commands::swarmterm_mcp_profiles,
            commands::set_swarmterm_mcp,
            commands::inspect_account_mcp,
            commands::list_agent_sessions,
            commands::read_agent_thread,
            commands::transfer_agent_session,
            commands::get_session_share,
            commands::set_session_share,
            commands::inspect_saved_workspace,
            commands::set_claude_statusline,
            commands::resolve_path_link,
            commands::resolve_dir_link,
            commands::list_folders,
            commands::find_available_editor,
            commands::open_in_editor,
            commands::reveal_in_file_manager,
            commands::git_list_worktrees,
            commands::git_get_changed_files,
            commands::git_get_file_diff,
            commands::git_get_commit_info,
            commands::git_create_worktree,
            commands::git_clear_worktree,
            commands::git_branch_unmerged_count,
            commands::git_merge_readiness,
            commands::ensure_repo_with_commit,
            preview::preview_open,
            preview::preview_navigate,
            preview::preview_reload,
            preview::preview_back,
            preview::preview_forward,
            preview::preview_set_bounds,
            preview::preview_set_visible,
            preview::preview_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                crate::prof::dump("exit");
                crate::mcp::shutdown();
                // Clipboard images are private: delete our PNGs on every exit.
                #[cfg(windows)]
                _app.state::<clipboard_media::ClipboardMedia>().shutdown();
                // Marked copies are temporary too (the originals stay as they were).
                _app.state::<marked_media::MarkedMedia>().shutdown();
            }
            // macOS: clicking the Dock icon while the window is hidden
            // (close-to-tray) fires Reopen — re-show like the tray's "Show".
            // Other platforms get here via the single-instance plugin instead.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                crate::tray::show_main(_app);
            }
        });
}

#[cfg(windows)]
fn clipboard_media_state() -> clipboard_media::ClipboardMedia {
    clipboard_media::ClipboardMedia::default()
}
#[cfg(not(windows))]
fn clipboard_media_state() {}

/// Built-in speech source state (SWA-38); Windows-only like the voice pipe.
#[cfg(windows)]
fn voice_speech_hub() -> voice::speech::SpeechHub {
    voice::speech::SpeechHub::default()
}

#[cfg(not(windows))]
fn voice_speech_hub() {}

/// Profiling builds only: the same multi-thread runtime Tauri would create,
/// but with named workers so samply/WPA stacks group as `tokio-rt`.
#[cfg(feature = "profiling")]
fn install_named_runtime() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("tokio-rt")
        .build()
        .expect("tokio runtime");
    let handle = rt.handle().clone();
    // Tauri only borrows a handle; the runtime must outlive the app.
    Box::leak(Box::new(rt));
    tauri::async_runtime::set(handle);
}
