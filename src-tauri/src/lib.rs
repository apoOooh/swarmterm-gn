mod account_status;
mod accounts;
mod agent_process;
mod agents;
mod analytics;
mod commands;
mod dev_defer;
mod devlog;
mod files;
mod folder_list;
mod git;
mod json_style;
mod links;
mod mcp;
mod paste_image;
mod preview;
mod pty;
mod routine_cmd;
mod sessions;
mod shell;
// Public so `main.rs` can reach `--statusline` without booting Tauri.
pub mod statusline;
// Public so `main.rs` can reach `--hook` without booting Tauri.
pub mod hook;
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
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(voice::VoiceHub::default())
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
            files::media_response(&service, request)
        })
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
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
            // Fire-and-forget usage telemetry. Keys are compiled in from
            // .env.release by the release scripts; dev/community builds have
            // none, so this is a no-op there. See analytics.rs.
            analytics::init(app.handle());
            // Register the MCP server at Claude's user scope (~/.claude.json)
            // instead of dropping a .mcp.json into every project. One-shot,
            // idempotent, log-only.
            // The Settings → MCP opt-outs must be known before the first
            // writer runs, or a switched-off profile is re-enrolled at boot.
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
            // Boot the MCP server. Any failure is logged and swallowed: browser
            // preview via MCP just won't work for this run, but Swarmterm as a
            // whole still functions.
            let handle_for_mcp = app.handle().clone();
            tauri::async_runtime::spawn(async move {
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
            commands::files_unwatch,
            commands::create_terminal,
            commands::write_terminal,
            commands::write_terminal_checked,
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
                crate::mcp::shutdown();
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

/// Built-in speech source state (SWA-38); Windows-only like the voice pipe.
#[cfg(windows)]
fn voice_speech_hub() -> voice::speech::SpeechHub {
    voice::speech::SpeechHub::default()
}

#[cfg(not(windows))]
fn voice_speech_hub() {}
