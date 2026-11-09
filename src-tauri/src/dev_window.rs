//! How the main window first appears (SWA-84).
//!
//! Debug builds are started by scripts, the testlab and agents in panes
//! (`tauri:dev:isolated`) while the user works in another window. A plain
//! `show()` there is `SW_SHOW`: the new 1280×920 window takes the foreground
//! and lands on top of whatever the user was typing into. So a debug build
//! builds its window with `focused(false)` (tao then shows with
//! `SW_SHOWNOACTIVATE` and wry skips `MoveFocus`) and sinks it behind the
//! active window. `SWARMTERM_DEV_HIDDEN=1` goes further for unattended runs:
//! the window is never shown by the app itself; CDP drives the webview.
//!
//! Release builds never read the variable and keep today's behaviour. Tray
//! "Show" and a second launch still call `set_focus`, so an explicit request
//! always brings the window to the front, in every mode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Debug-only switch for unattended runs (testlab, agent instances).
pub const HIDDEN_ENV: &str = "SWARMTERM_DEV_HIDDEN";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartMode {
    /// Release: shown, focused, on top.
    Foreground,
    /// Debug default: shown without focus, behind the active window.
    Background,
    /// Debug with `SWARMTERM_DEV_HIDDEN=1`: never shown by the renderer.
    Hidden,
}

impl StartMode {
    /// Whether the window may take focus when it is built.
    pub fn focused(self) -> bool {
        self == StartMode::Foreground
    }
}

/// Pure decision: `debug` is `cfg!(debug_assertions)`, `hidden` the raw
/// variable. Only the exact value `1` hides, so a stray `0`/`false` keeps the
/// window visible.
pub fn plan(debug: bool, hidden: Option<&str>) -> StartMode {
    if !debug {
        return StartMode::Foreground;
    }
    match hidden {
        Some("1") => StartMode::Hidden,
        _ => StartMode::Background,
    }
}

static MODE: OnceLock<StartMode> = OnceLock::new();

/// The mode of this process, decided once. The variable is removed after
/// reading so panes of a hidden lab instance (and a dev build an agent starts
/// from one of them) do not inherit it.
pub fn current() -> StartMode {
    *MODE.get_or_init(|| {
        #[cfg(debug_assertions)]
        {
            let raw = std::env::var(HIDDEN_ENV).ok();
            std::env::remove_var(HIDDEN_ENV);
            plan(true, raw.as_deref())
        }
        #[cfg(not(debug_assertions))]
        {
            plan(false, None)
        }
    })
}

/// What one `window_reveal` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reveal {
    Show,
    ShowBehind,
    Nothing,
}

/// Pure decision. `first` is false once this process has revealed: App's
/// mount effect runs again on every page reload and Fast Refresh of
/// `App.tsx`, and sinking again would push the window the user is working in
/// to the bottom. Release keeps calling `show()` every time, as before.
pub fn reveal_action(mode: StartMode, first: bool) -> Reveal {
    match mode {
        StartMode::Foreground => Reveal::Show,
        StartMode::Background if first => Reveal::ShowBehind,
        StartMode::Background | StartMode::Hidden => Reveal::Nothing,
    }
}

static REVEALED: AtomicBool = AtomicBool::new(false);

/// The renderer's "boot finished, show me" (`window_reveal`). Background runs
/// on the main thread so tao's `show()` executes inline between the two
/// z-order calls: sinking the still-hidden window first keeps it from
/// flashing on top, sinking again after the show covers a show that
/// re-inserted it. `HWND_BOTTOM` = behind every window, not just the active
/// one: inserting after the foreground window would make ours topmost
/// whenever that one is.
pub fn reveal(win: &tauri::WebviewWindow) -> Result<(), String> {
    let first = !REVEALED.swap(true, Ordering::SeqCst);
    match reveal_action(current(), first) {
        Reveal::Nothing => Ok(()),
        Reveal::Show => win.show().map_err(|e| e.to_string()),
        Reveal::ShowBehind => {
            let w = win.clone();
            win.run_on_main_thread(move || {
                sink(&w);
                let _ = w.show();
                sink(&w);
            })
            .map_err(|e| e.to_string())
        }
    }
}

/// Moves the window to the bottom of the z-order without activating it.
/// Not tao's `always_on_bottom`: switching that off again uses
/// `HWND_NOTOPMOST`, which raises the window above every other one.
#[cfg(windows)]
fn sink(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if let Ok(hwnd) = win.hwnd() {
        // SAFETY: a live top-level window handle owned by this process, used
        // on the thread that created it.
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_BOTTOM),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(not(windows))]
fn sink(_win: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_is_always_foreground() {
        assert_eq!(plan(false, None), StartMode::Foreground);
        assert_eq!(plan(false, Some("1")), StartMode::Foreground);
        assert!(StartMode::Foreground.focused());
    }

    #[test]
    fn debug_defaults_to_background_without_focus() {
        assert_eq!(plan(true, None), StartMode::Background);
        assert!(!StartMode::Background.focused());
        assert!(!StartMode::Hidden.focused());
    }

    #[test]
    fn only_exact_one_hides() {
        assert_eq!(plan(true, Some("1")), StartMode::Hidden);
        for v in ["", "0", "true", "yes", " 1"] {
            assert_eq!(plan(true, Some(v)), StartMode::Background, "{v:?}");
        }
    }

    #[test]
    fn background_sinks_only_on_the_first_reveal() {
        assert_eq!(
            reveal_action(StartMode::Background, true),
            Reveal::ShowBehind
        );
        assert_eq!(reveal_action(StartMode::Background, false), Reveal::Nothing);
    }

    #[test]
    fn release_shows_on_every_reveal_and_hidden_never() {
        assert_eq!(reveal_action(StartMode::Foreground, true), Reveal::Show);
        assert_eq!(reveal_action(StartMode::Foreground, false), Reveal::Show);
        assert_eq!(reveal_action(StartMode::Hidden, true), Reveal::Nothing);
    }
}
