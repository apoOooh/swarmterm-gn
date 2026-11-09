// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args()
        .skip(1)
        .any(|a| a == "--codex-session-hook")
    {
        swarmterm_lib::hook::run_agent_cli("codex");
        return;
    }
    // `swarmterm --statusline` is Claude Code's status line command: read its
    // JSON from stdin, print one line, exit. Handled here, before `run()`, so
    // the Tauri builder / single-instance plugin / tray / AppKit are never
    // initialised for what is a sub-second CLI invocation.
    //
    // The `windows_subsystem = "windows"` attribute above suppresses console
    // ALLOCATION; it does not detach inherited standard handles. Claude Code
    // spawns this with piped stdio, so the pipes arrive through STARTUPINFO and
    // GetStdHandle resolves them normally. ("GUI subsystem means no stdio" is
    // the intuitive-but-wrong read of that attribute.)
    if std::env::args().skip(1).any(|a| a == "--statusline") {
        swarmterm_lib::statusline::run_cli();
        return;
    }
    // `swarmterm --hook` is Claude Code's hook command: same pre-Tauri
    // short-circuit as above, and the same Windows stdio note applies.
    if std::env::args().skip(1).any(|a| a == "--hook") {
        swarmterm_lib::hook::run_cli();
        return;
    }
    // `swarmterm --mcp-stdio`: the agent CLIs' MCP entry (SWA-83 1b). Relays
    // to the pane's HTTP endpoint, or serves no tools outside a pane. Same
    // pre-Tauri short-circuit and stdio note as `--statusline`.
    if std::env::args().skip(1).any(|a| a == "--mcp-stdio") {
        std::process::exit(swarmterm_lib::mcp_stdio::run_cli());
    }
    // `swarmterm --dump-ui <pid> <file>`: the UI-stall watchdog's dumper
    // (SWA-85). A separate process on purpose, see `dump_ui.rs`.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--dump-ui") {
        std::process::exit(swarmterm_lib::dump_ui::run_cli(&args[1..]));
    }
    swarmterm_lib::run()
}
