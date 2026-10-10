//! Dev-only diagnostics sink. `SWARMTERM_DEV_LOG` (set by the private dev
//! launcher, never by a release) names a JSON-lines file; the renderer's
//! warnings, errors and explicit debug events are appended there so a
//! failure seen in the dev app can be read back afterwards. Release builds
//! compile the body out, and without the variable it is a no-op.

/// Append renderer log lines. Each line is one already-serialized JSON object.
#[tauri::command]
pub fn dev_log(lines: Vec<String>) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let Some(path) = std::env::var_os("SWARMTERM_DEV_LOG") else {
            return;
        };
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        else {
            return;
        };
        for line in lines {
            // One record per line: a stray newline would split it in two.
            let _ = writeln!(file, "{}", line.replace(['\r', '\n'], " "));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = lines;
}
