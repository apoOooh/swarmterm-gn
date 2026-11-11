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

/// `src` with `//` and `/* */` comments blanked out (same length, so byte
/// offsets stay valid): a commented-out `spawn_blocking(` must not count as
/// a worker. Good enough for the boot function, which has no string
/// literals containing comment markers.
fn strip_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
        } else if bytes[i..].starts_with(b"/*") {
            let end = src[i + 2..]
                .find("*/")
                .map_or(bytes.len(), |e| i + 2 + e + 2);
            for b in &mut out[i..end] {
                if *b != b'\n' {
                    *b = b' ';
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("comments blanked on ASCII bytes only")
}

/// Byte ranges of the closure BODY in every `spawn_blocking(...)` argument
/// list of `body`: from the first `||` inside the parentheses to the closing
/// one. A call is on a worker only if it lies there — not merely after a
/// `spawn_blocking`, and not in an argument block that runs before the
/// closure is built (`spawn_blocking({ probe(); move || {} })`).
fn worker_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for (at, m) in body.match_indices("spawn_blocking(") {
        let open = at + m.len() - 1;
        let mut depth = 0usize;
        for (i, ch) in body[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        let close = open + i;
                        if let Some(bar) = body[open..close].find("||") {
                            spans.push((open + bar, close));
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    spans
}

/// The calls in `body` that would block the UI thread: any probe-reaching
/// call outside every worker closure body.
fn calls_off_worker(body: &str) -> Vec<String> {
    let body = strip_comments(body);
    let body = body.as_str();
    let spans = worker_spans(body);
    let mut bad = Vec::new();
    for call in [
        "ensure_claude(",
        "ensure_codex(",
        "refresh_prerequisites(",
        "exec_hooks(",
        "recheck(",
    ] {
        for (at, _) in body.match_indices(call) {
            if !spans.iter().any(|&(s, e)| s < at && at < e) {
                bad.push(call.to_owned());
            }
        }
    }
    bad
}

#[test]
fn boot_runs_every_ensure_on_a_worker() {
    let src =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/setup.rs")).unwrap();
    let body = body_of(&src, "pub fn boot(");
    for call in ["ensure_claude(", "ensure_codex(", "refresh_prerequisites("] {
        assert!(body.contains(call), "setup::boot no longer calls {call}");
    }
    let bad = calls_off_worker(body);
    assert!(bad.is_empty(), "setup::boot calls {bad:?} on the UI thread");
}

#[test]
fn the_checker_catches_calls_after_a_worker() {
    // Found in review: a direct call after a worker closure must fail.
    let body = "{ let a = app.clone(); tauri::async_runtime::spawn_blocking(move || ensure_claude(&a)); ensure_codex(app); refresh_prerequisites(app); }";
    assert_eq!(
        calls_off_worker(body),
        vec![
            "ensure_codex(".to_owned(),
            "refresh_prerequisites(".to_owned()
        ]
    );
    let good = "{ let a = app.clone(); spawn_blocking(move || { ensure_claude(&a); refresh_prerequisites(&a); }); let c = app.clone(); spawn_blocking(move || ensure_codex(&c)); }";
    assert!(calls_off_worker(good).is_empty());
    let before = "{ ensure_claude(app); spawn_blocking(move || ensure_codex(&c)); }";
    assert_eq!(calls_off_worker(before), vec!["ensure_claude(".to_owned()]);
}

#[test]
fn the_checker_ignores_comments_and_eager_argument_blocks() {
    // Found in review: a worker that exists only in comments.
    let commented = "{ /* spawn_blocking( */ ensure_codex(app); /* ) */ }";
    assert_eq!(
        calls_off_worker(commented),
        vec!["ensure_codex(".to_owned()]
    );
    let line = "{ // spawn_blocking(move ||\n ensure_codex(app);\n // )\n }";
    assert_eq!(calls_off_worker(line), vec!["ensure_codex(".to_owned()]);
    // An argument block runs on the caller's thread, before the closure.
    let eager = "{ spawn_blocking({ ensure_codex(app); move || {} }); }";
    assert_eq!(calls_off_worker(eager), vec!["ensure_codex(".to_owned()]);
    // A comment inside a real closure does not hide it.
    let real = "{ spawn_blocking(move || { /* ) */ ensure_codex(&c); }); }";
    assert!(calls_off_worker(real).is_empty());
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
