//! SWA-83 1c-ii review: `setup` runs on the UI thread, and the first Claude
//! ensure may run `claude --version` (up to 3 s), Codex's `codex --help`
//! likewise. `setup::boot` must hand every ensure to a blocking worker.
//! A source check, like `ui_thread_commands.rs`: the boot path is not a
//! command, so that test does not see it.

fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src.find(signature).expect("function not found");
    let open = start + src[start..].find('{').unwrap();
    let mut depth = 0usize;
    for (i, ch) in src[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..open + i + 1];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces")
}

#[test]
fn boot_runs_every_ensure_on_a_worker() {
    let src =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/setup.rs")).unwrap();
    let body = body_of(&src, "pub fn boot(");
    // Everything before the first worker is plain cloning.
    let first_worker = body.find("spawn_blocking").expect("boot uses no worker");
    let head = &body[..first_worker];
    for blocking in [
        "ensure_claude",
        "ensure_codex",
        "refresh_prerequisites",
        "exec_hooks",
        "recheck",
    ] {
        assert!(
            !head.contains(blocking),
            "setup::boot calls {blocking} on the UI thread"
        );
    }
    // And every call sits inside a spawn_blocking closure.
    for call in ["ensure_claude(", "ensure_codex("] {
        for (at, _) in body.match_indices(call) {
            assert!(
                body[..at].rfind("spawn_blocking").is_some(),
                "{call} outside a worker in setup::boot"
            );
        }
    }
}

#[test]
fn the_setup_hook_reaches_no_probe_directly() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    for probe in [
        "claude_version::",
        "ensure_claude(",
        "ensure_codex(",
        "setup::recheck(",
    ] {
        assert!(
            !src.contains(probe),
            "lib.rs calls {probe} directly (setup runs on the UI thread)"
        );
    }
}
