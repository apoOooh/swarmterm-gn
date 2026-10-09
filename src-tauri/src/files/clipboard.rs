use clipboard_rs::{Clipboard, ClipboardContext};
use std::sync::{Mutex, OnceLock};

// Retain the context: X11 clipboard ownership must outlive an individual IPC call.
fn with<T>(f: impl FnOnce(&ClipboardContext) -> Result<T, String>) -> Result<T, String> {
    static CLIPBOARD: OnceLock<Mutex<Option<ClipboardContext>>> = OnceLock::new();
    let mut guard = CLIPBOARD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(
            ClipboardContext::new()
                .map_err(|e| format!("Native file clipboard is unavailable: {e}"))?,
        );
    }
    f(guard.as_ref().ok_or("Clipboard initialization failed")?)
}
pub fn read() -> Result<Vec<String>, String> {
    with(|c| {
        c.get_files()
            .map_err(|e| format!("No native files on the clipboard: {e}"))
    })
}
pub fn write(paths: Vec<String>) -> Result<(), String> {
    with(|c| {
        c.set_files(paths)
            .map_err(|e| format!("Could not copy files to the native clipboard: {e}"))
    })
}
