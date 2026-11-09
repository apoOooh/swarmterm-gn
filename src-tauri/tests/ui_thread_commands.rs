//! SWA-85: a synchronous `#[tauri::command]` runs on the UI thread (inside
//! WebView2's WebResourceRequested callback), and so does a handler
//! registered with `register_uri_scheme_protocol`. Anything slow there makes
//! Windows report the window as not responding. This test parses `src/` and
//! fails for every synchronous command that is not on the allowlist below,
//! each entry with the reason it is cheap, and for a stale entry (a command
//! that became async or was removed). A new command is async unless it is
//! provably short: add it here with a reason, not to make the test pass.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use syn::visit::Visit;

const ALLOWED_SYNC: &[(&str, &str)] = &[
    ("agent_policy_set", "short lock, in-memory policy"),
    ("child_priority_set", "short lock; host forward runs on its own thread"),
    ("clipboard_media_set_enabled", "thread start/stop, toggles must stay ordered"),
    ("confirm_quit", "sets a flag; quit work runs off-thread"),
    ("debug_ui_stall", "deliberate stall for the testlab, debug builds only"),
    ("dev_log", "debug-build log line append"),
    ("env_policy_set", "short lock plus a small JSON write, pushes stay ordered"),
    ("files_unwatch", "channel send to the watcher thread"),
    ("get_session_share", "short lock"),
    ("kill_terminal", "map removal; graceful close and kill run off-thread"),
    ("policy_get", "immutable snapshot"),
    ("preview_back", "WebView2 call, must run on the UI thread"),
    ("preview_close", "WebView2 call, must run on the UI thread"),
    ("preview_forward", "WebView2 call, must run on the UI thread"),
    ("preview_navigate", "WebView2 call, must run on the UI thread"),
    ("preview_open", "WebView2 creation pumps messages while it waits"),
    ("preview_reload", "WebView2 call, must run on the UI thread"),
    ("preview_set_bounds", "WebView2 call, must run on the UI thread"),
    ("preview_set_visible", "WebView2 call, must run on the UI thread"),
    ("quit_hosted_count", "short lock"),
    ("report_agent_state", "two short locks"),
    ("resize_terminal", "O(1) resize call, enqueued for hosted panes"),
    ("terminal_host_get_settings", "short lock"),
    ("terminal_host_keep", "detached-set update inline, close on its own thread"),
    ("terminal_host_release", "detached-set update inline, close on its own thread"),
    ("terminal_host_set_settings", "small JSON write, switch must stay ordered"),
    ("voice_companion_quit", "one push on an open pipe connection"),
    ("voice_companion_set_autostart", "one HKCU Run value"),
    ("voice_dictation_cancel", "flag plus channel send"),
    ("voice_focus_response", "oneshot send"),
    ("voice_get_settings", "short lock"),
    ("voice_indicator_stop", "short lock plus event"),
    ("voice_insert_result", "oneshot send"),
    ("voice_model_cancel", "flag"),
    ("voice_model_delete", "one file removal"),
    ("voice_model_download", "spawns the download task and returns"),
    ("voice_set_settings", "small JSON write, settings must stay ordered"),
    ("voice_speech_status", "short lock"),
    ("voice_tts_status", "short lock"),
    ("voice_tts_stop", "generation bump under a short lock"),
    ("voice_tts_test", "enqueues one utterance"),
    ("voice_turn_event", "short locks; file reads go to spawn_blocking"),
    ("war_room_create", "short lock plus event"),
    ("war_room_delete", "short lock plus event"),
    ("war_room_join", "short lock plus event"),
    ("war_room_leave", "short lock plus event"),
    ("war_room_moderator_send", "inbox push under a short lock"),
    ("war_room_rename", "short lock plus event"),
    ("war_room_rooms", "short lock"),
    ("windows_build_number", "one registry read"),
    ("write_terminal", "enqueue only (pty::PtyInput)"),
    ("write_terminal_checked", "enqueue only under the terminals lock"),
];

#[derive(Default)]
struct Commands {
    sync: BTreeMap<String, String>,
    all: BTreeSet<String>,
    file: String,
}

fn command_attr(attr: &syn::Attribute) -> Option<bool> {
    let path = attr.path();
    let is_command = path.segments.last().is_some_and(|s| s.ident == "command")
        && path.segments.iter().any(|s| s.ident == "tauri");
    if !is_command {
        return None;
    }
    // `#[tauri::command(async)]` runs on the async runtime like `async fn`.
    let declared_async = match &attr.meta {
        syn::Meta::List(list) => list.tokens.to_string().split(',').any(|t| t.trim() == "async"),
        _ => false,
    };
    Some(declared_async)
}

impl<'ast> Visit<'ast> for Commands {
    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        for attr in &f.attrs {
            if let Some(declared_async) = command_attr(attr) {
                let name = f.sig.ident.to_string();
                self.all.insert(name.clone());
                if f.sig.asyncness.is_none() && !declared_async {
                    self.sync.insert(name, self.file.clone());
                }
            }
        }
        syn::visit::visit_item_fn(self, f);
    }
}

fn scan(dir: &Path, out: &mut Commands, sources: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            scan(&path, out, sources);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let text = std::fs::read_to_string(&path).unwrap();
            let file = syn::parse_file(&text)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            out.file = path.display().to_string();
            out.visit_file(&file);
            sources.push((out.file.clone(), text));
        }
    }
}

fn collect() -> (Commands, Vec<(String, String)>) {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut commands = Commands::default();
    let mut sources = Vec::new();
    scan(&src, &mut commands, &mut sources);
    (commands, sources)
}

#[test]
fn synchronous_commands_are_on_the_allowlist() {
    let (commands, _) = collect();
    assert!(commands.all.len() > 50, "parser found too few commands: {:?}", commands.all);
    let allowed: BTreeMap<&str, &str> = ALLOWED_SYNC.iter().copied().collect();
    let unlisted: Vec<String> = commands
        .sync
        .iter()
        .filter(|(name, _)| !allowed.contains_key(name.as_str()))
        .map(|(name, file)| format!("{name} ({file})"))
        .collect();
    assert!(
        unlisted.is_empty(),
        "synchronous #[tauri::command]s run on the UI thread; make these async \
         (spawn_blocking for blocking work) or add them to ALLOWED_SYNC with a reason: {unlisted:#?}"
    );
    let stale: Vec<&str> = allowed
        .keys()
        .copied()
        .filter(|name| !commands.sync.contains_key(*name))
        .collect();
    assert!(stale.is_empty(), "ALLOWED_SYNC lists commands that are no longer synchronous: {stale:?}");
}

#[test]
fn no_synchronous_uri_scheme_protocol() {
    let (_, sources) = collect();
    let hits: Vec<&str> = sources
        .iter()
        .filter(|(_, text)| text.contains(".register_uri_scheme_protocol("))
        .map(|(file, _)| file.as_str())
        .collect();
    assert!(
        hits.is_empty(),
        "register_uri_scheme_protocol runs its handler on the UI thread; use \
         register_asynchronous_uri_scheme_protocol: {hits:?}"
    );
}

#[test]
fn every_registered_command_is_parsed() {
    // The generate_handler! list is what the renderer can call; a command the
    // parser misses (macro-generated, unusual attribute) would escape the
    // allowlist check.
    let (commands, sources) = collect();
    let lib = sources
        .iter()
        .find(|(file, _)| file.ends_with("lib.rs") && !file.contains("host"))
        .map(|(_, text)| text.as_str())
        .expect("src/lib.rs");
    let start = lib.find("generate_handler![").expect("handler list");
    let end = start + lib[start..].find("])").expect("end of handler list");
    let registered: BTreeSet<String> = lib[start + "generate_handler![".len()..end]
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && !s.starts_with("//"))
        .filter_map(|s| s.rsplit("::").next())
        .map(|s| s.trim().to_string())
        .collect();
    let missing: Vec<&String> = registered.difference(&commands.all).collect();
    assert!(missing.is_empty(), "registered but not found by the parser: {missing:?}");
}
