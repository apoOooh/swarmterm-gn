// The host has no window and must not flash a console when the app starts
// it; debug builds keep the console for `eprintln!` diagnostics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! `swarmterm-host --data-dir <app local data dir> [--ring-bytes <n>]`
//!
//! Started by the app (phase 2). Exits with code 3 when another host already
//! serves this data dir, so the app can connect to that one instead.

#[cfg(windows)]
fn main() {
    use std::path::PathBuf;

    let mut data_dir: Option<PathBuf> = None;
    let mut ring = swarmterm_host::ring::DEFAULT_CAPACITY;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--ring-bytes" => {
                ring = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage("--ring-bytes needs a number"))
            }
            other => usage(&format!("unknown argument {other}")),
        }
    }
    let data_dir = data_dir.unwrap_or_else(|| usage("--data-dir is required"));
    let sid = swarmterm_host::security::current_user_sid().unwrap_or_else(|e| {
        eprintln!("[host] {e}");
        std::process::exit(1)
    });
    let pipe = swarmterm_host::server::pipe_name(&sid, &data_dir);

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let host = swarmterm_host::engine::Host::new(ring);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let result = rt.block_on(async {
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = stop_tx.send(true);
        });
        swarmterm_host::server::run(host.clone(), &data_dir, pipe, None, stop_rx).await
    });
    host.shutdown_all();
    match result {
        Ok(()) => {}
        Err(e) if e == "already-running" => std::process::exit(3),
        Err(e) => {
            eprintln!("[host] {e}");
            std::process::exit(1)
        }
    }
}

#[cfg(windows)]
fn usage(msg: &str) -> ! {
    eprintln!("swarmterm-host: {msg}\nusage: swarmterm-host --data-dir <dir> [--ring-bytes <n>]");
    std::process::exit(2)
}

#[cfg(not(windows))]
fn main() {
    eprintln!("swarmterm-host supports Windows only");
    std::process::exit(2)
}
