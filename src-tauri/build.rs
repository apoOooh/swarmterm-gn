fn main() {
    // tauri_build embeds the bundle icons into the binary (they become the
    // default window icon, and on macOS the Dock icon in `tauri dev`, which
    // runs an unbundled executable). Cargo only reruns a build script when
    // something it was told to watch changes, and tauri_build does not declare
    // the icon directory — so regenerating icons alone leaves a stale icon
    // compiled in, with nothing in the build output to say so.
    println!("cargo:rerun-if-changed=icons");
    emit_app_identifier();
    tauri_build::build()
}

/// `SWARMTERM_APP_IDENTIFIER`: the app identifier this binary is built with,
/// for entry points that run before (and without) the Tauri builder and still
/// need the app data dir — `--dump-ui` reads the Diagnostics opt-in from it
/// (SWA-85). Resolved like tauri-build does: `tauri.conf.json`, the platform
/// file, then the `TAURI_CONFIG` JSON patch the CLI sets for `--config`
/// (dev instance, Corp). A different identifier would read another
/// instance's opt-in, so this must stay in step with tauri-build.
fn emit_app_identifier() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=tauri.windows.conf.json");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let read = |path: &str| -> Option<String> {
        let text = std::fs::read_to_string(path).ok()?;
        identifier_of(&text)
    };
    let mut id = read("tauri.conf.json").expect("tauri.conf.json has an identifier");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if let Some(platform) = read("tauri.windows.conf.json") {
            id = platform;
        }
    }
    if let Some(patch) = std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|t| identifier_of(&t))
    {
        id = patch;
    }
    println!("cargo:rustc-env=SWARMTERM_APP_IDENTIFIER={id}");
}

fn identifier_of(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.get("identifier")?.as_str().map(str::to_owned)
}
