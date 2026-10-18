use std::sync::atomic::Ordering;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, Emitter, Manager};

use crate::pty::AppState;

/// Tray marks are rendered by `scripts/gen-logo.mjs` (`npm run logo`) as raw
/// straight-alpha RGBA: this crate is built without tauri's `image-png`
/// feature, so a PNG asset would need a decoder the runtime doesn't have —
/// raw bytes feed `Image::new` directly.
const TRAY_PX: u32 = 32;
/// macOS shows the icon as a template image (alpha only, black ink), so the
/// mark follows the menu bar's light/dark appearance like the system icons.
#[cfg(target_os = "macos")]
const TRAY_MARK: &[u8] = include_bytes!("../icons/tray-template-32.rgba");
/// Windows/Linux trays keep color: the same compact tile as the app icon.
#[cfg(not(target_os = "macos"))]
const TRAY_MARK: &[u8] = include_bytes!("../icons/tray-color-32.rgba");

fn tray_image() -> Image<'static> {
    Image::new(TRAY_MARK, TRAY_PX, TRAY_PX)
}

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Kill every pty, then exit the process for good.
///
/// Returns immediately: the graceful close waits up to `KILL_GRACE` for the
/// pane trees, and doing that on the caller (the main thread, via the sync
/// `confirm_quit` command) froze the UI for that long. A second request while
/// one is in flight is a no-op.
pub fn quit(app: &tauri::AppHandle) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Set synchronously so a window close racing the quit is not turned into
    // hide-to-tray.
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || quit_blocking(&app));
}

fn quit_blocking(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    // Remove the voice discovery file so buzzkey never dials a dead pipe.
    crate::voice::shutdown(app);
    // Use `if let Ok` rather than `unwrap` so the process still exits even if the
    // terminals lock was somehow poisoned.
    // Close every pane gracefully (see ManagedTerminal::shutdown) and wait for
    // the bounded grace period, so agents exit cleanly instead of being torn
    // down by kill-on-close when the job handles drop at process exit.
    let terminals: Vec<_> = match state.terminals.lock() {
        Ok(mut map) => map.drain().map(|(_, t)| t).collect(),
        Err(_) => Vec::new(),
    };
    let waiters: Vec<_> = terminals.into_iter().filter_map(|t| t.shutdown()).collect();
    // Hosted panes were only asked to close (`kill` is enqueued); wait until
    // the host has read those requests, or they die with our pipe at exit
    // and the panes keep running without a client. The host does the
    // graceful close and KILL_GRACE itself, then idles out (ADR 0001).
    #[cfg(windows)]
    if let Some(client) = app
        .try_state::<crate::host_client::HostHub>()
        .and_then(|hub| hub.current())
    {
        let _ = client.conn.flush(std::time::Duration::from_secs(2));
    }
    for w in waiters {
        let _ = w.join();
    }
    app.exit(0);
}

pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "Show Swarmterm GN").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit_item]).build()?;

    TrayIconBuilder::with_id("main")
        .icon(tray_image())
        // No-op off macOS, so `cfg!` beats a second attribute-gated builder
        // statement for readability.
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Swarmterm GN")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                show_main(app);
                let _ = app.emit_to("main", "app:quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Image::new` trusts the declared dimensions — a regenerated blob of
    /// the wrong size would render as sheared garbage rather than fail, so
    /// pin the byte count to the declared 32×32 RGBA.
    #[test]
    fn tray_blob_matches_declared_size() {
        assert_eq!(TRAY_MARK.len(), (TRAY_PX * TRAY_PX * 4) as usize);
    }
}
