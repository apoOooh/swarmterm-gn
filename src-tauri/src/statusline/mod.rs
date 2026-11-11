//! The `swarmterm --statusline` command: Claude Code runs it and renders the
//! rows it prints below the input box. Template, scheme and vibrance come from
//! `statusline.json` (SWA-92, `settings.rs`), the width from `COLUMNS`.

pub mod install;
pub mod layout;
pub mod preset;
pub mod probe;
pub mod render;
pub mod settings;
pub mod style;

use std::io::Read;
use std::time::Duration;

pub use render::McpState;

/// How long the whole probe gets. Claude Code re-runs this command on every
/// render, so a slow answer is worse than no answer.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Decide the `mcp` segment. `run` is injected so the mapping is testable
/// without a listening socket.
pub fn mcp_state(
    url: Option<&str>,
    token: Option<&str>,
    run: impl Fn(&str, &str) -> Option<bool>,
) -> McpState {
    let (Some(url), Some(token)) = (url, token) else {
        return McpState::Absent;
    };
    let (url, token) = (url.trim(), token.trim());
    if url.is_empty() || token.is_empty() {
        return McpState::Absent;
    }
    match run(url, token) {
        Some(true) => McpState::Connected,
        Some(false) => McpState::NoClient,
        None => McpState::Unreachable,
    }
}

/// The context-window numbers in a raw stdin payload, or `None` when there are
/// none to show: unparseable input, an empty read, or a payload from before the
/// first API turn (no `used_percentage`). `None` is a distinct "no data" that
/// the probe sends as the bare path and the line renders as `ctx —` — it is
/// never collapsed to 0 %.
pub fn ctx_of(stdin: &str) -> Option<render::CtxInfo> {
    let input: render::StatusInput = serde_json::from_str(stdin).unwrap_or_default();
    input.context_window.as_ref().and_then(render::ctx_info)
}

/// The account's rate-limit windows in a raw stdin payload; empty when Claude
/// Code sent none (API-key login, no turn yet) or the payload is unparseable.
pub fn limits_of(stdin: &str) -> crate::mcp::rate_limits::RateLimits {
    let input: render::StatusInput = serde_json::from_str(stdin).unwrap_or_default();
    crate::mcp::rate_limits::from_raw(input.rate_limits.as_ref())
}

/// Render the line for a raw stdin payload. Unparseable input yields the
/// no-context line rather than an error.
pub fn line_for(stdin: &str, mcp: McpState, color: bool) -> String {
    render::render(mcp, ctx_of(stdin), color)
}

/// The `--statusline` entry point. Reached from `main.rs` BEFORE the Tauri
/// builder runs, so no window, tray, single-instance IPC, or (on macOS) AppKit
/// is ever touched — this process is a plain CLI that prints one line and exits.
pub fn run_cli() {
    let mut stdin = String::new();
    // A read error is treated like empty input: still print the ctx placeholder.
    let _ = std::io::stdin().read_to_string(&mut stdin);

    // stdin is parsed ONCE, and BEFORE the probe, so the context percentage can
    // ride the same `/status` request the `mcp` segment already pays for (see
    // `probe::build_status_request`). A garbage payload is not an error here:
    // `ctx_of` yields `None`, the probe sends the bare path, and the line still
    // prints `ctx —` — exactly what `line_for` did before the probe carried it.
    let ctx = ctx_of(&stdin);
    let pct = ctx.map(|c| c.pct);
    let limits = limits_of(&stdin);

    let url = std::env::var("SWARMTERM_MCP_URL").ok();
    let token = std::env::var("SWARMTERM_SESSION").ok();
    let mcp = mcp_state(url.as_deref(), token.as_deref(), |u, t| {
        probe::probe(u, t, pct, &limits, PROBE_TIMEOUT)
    });

    let input: render::StatusInput = serde_json::from_str(&stdin).unwrap_or_default();
    let cfg = settings::path()
        .map(|p| settings::load(&p))
        .unwrap_or_default();
    let dir = input
        .workspace
        .as_ref()
        .and_then(|w| w.current_dir.clone())
        .or_else(|| input.cwd.clone());
    let branch = dir
        .as_deref()
        .and_then(|d| git_branch(std::path::Path::new(d)));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let frame = preset::Frame {
        input: &input,
        mcp,
        branch: branch.as_deref(),
        now,
        width: layout::term_width(std::env::var("COLUMNS").ok().as_deref()),
        color: true,
    };
    println!("{}", preset::render(&frame, &cfg).join("\n"));
}

/// The checked-out branch of the repo containing `dir`, read from `HEAD`
/// directly: Claude Code re-runs the status line on every render, and a `git`
/// process per render and pane is noticeable. Follows a worktree's `.git`
/// file to its gitdir. Detached HEAD = short hash; anything odd = `None`.
pub fn git_branch(dir: &std::path::Path) -> Option<String> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        let dot = d.join(".git");
        let head = if dot.is_dir() {
            dot.join("HEAD")
        } else if dot.is_file() {
            let link = std::fs::read_to_string(&dot).ok()?;
            let gd = link.trim().strip_prefix("gitdir:")?.trim();
            let gd = std::path::Path::new(gd);
            let gd = if gd.is_absolute() {
                gd.to_path_buf()
            } else {
                d.join(gd)
            };
            gd.join("HEAD")
        } else {
            cur = d.parent();
            continue;
        };
        let text = std::fs::read_to_string(head).ok()?;
        let text = text.trim();
        return match text.strip_prefix("ref: refs/heads/") {
            Some(b) => Some(b.to_string()),
            None if text.len() >= 7 && text.chars().all(|c| c.is_ascii_hexdigit()) => {
                Some(text[..7].to_string())
            }
            None => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_branch_reads_head_and_worktree_links() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src/deep")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        assert_eq!(git_branch(&repo.join("src/deep")).as_deref(), Some("dev"));

        let wt_git = repo.join(".git/worktrees/wt");
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(wt_git.join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        assert_eq!(git_branch(&wt).as_deref(), Some("feat/x"));

        std::fs::write(repo.join(".git/HEAD"), "0123456789abcdef0123\n").unwrap();
        assert_eq!(git_branch(&repo).as_deref(), Some("0123456"));
        assert_eq!(git_branch(&dir.path().join("nowhere")), None);
    }

    #[test]
    fn absent_env_means_no_mcp_segment() {
        assert_eq!(mcp_state(None, None, |_, _| Some(true)), McpState::Absent);
        assert_eq!(
            mcp_state(Some("http://x"), None, |_, _| Some(true)),
            McpState::Absent
        );
        assert_eq!(
            mcp_state(None, Some("tok"), |_, _| Some(true)),
            McpState::Absent
        );
    }

    #[test]
    fn blank_env_counts_as_absent() {
        assert_eq!(
            mcp_state(Some(""), Some("tok"), |_, _| Some(true)),
            McpState::Absent
        );
        assert_eq!(
            mcp_state(Some("http://x"), Some("  "), |_, _| Some(true)),
            McpState::Absent
        );
    }

    #[test]
    fn probe_verdict_maps_to_the_three_live_states() {
        let env = (Some("http://127.0.0.1:1/mcp"), Some("tok"));
        assert_eq!(
            mcp_state(env.0, env.1, |_, _| Some(true)),
            McpState::Connected
        );
        assert_eq!(
            mcp_state(env.0, env.1, |_, _| Some(false)),
            McpState::NoClient
        );
        assert_eq!(mcp_state(env.0, env.1, |_, _| None), McpState::Unreachable);
    }

    #[test]
    fn line_for_reads_context_from_the_payload() {
        let raw = r#"{"context_window":{"total_input_tokens":84213,
                     "context_window_size":200000,"used_percentage":42.1}}"#;
        assert_eq!(
            line_for(raw, McpState::Connected, false),
            "mcp ✓  ·  ctx 84k/200k 42%"
        );
    }

    #[test]
    fn line_for_survives_garbage_stdin() {
        // Malformed input must still produce a line rather than an error: an
        // empty status line is invisible, a panic is a visible Claude Code error.
        assert_eq!(line_for("not json", McpState::Absent, false), "ctx —");
        assert_eq!(line_for("", McpState::Connected, false), "mcp ✓  ·  ctx —");
    }

    #[test]
    fn ctx_of_reads_the_percentage() {
        let raw = r#"{"context_window":{"total_input_tokens":84213,
                     "context_window_size":200000,"used_percentage":42.1}}"#;
        assert_eq!(
            ctx_of(raw),
            Some(render::CtxInfo {
                used: 84213,
                size: 200000,
                pct: 42.1
            })
        );
    }

    #[test]
    fn ctx_of_is_none_without_a_first_turn() {
        // Before the first API turn Claude Code sends no `used_percentage`;
        // that, garbage, and empty stdin are all "no data" — never 0 %.
        assert_eq!(ctx_of("not json"), None);
        assert_eq!(ctx_of(""), None);
        assert_eq!(
            ctx_of(r#"{"context_window":{"context_window_size":200000}}"#),
            None
        );
    }
}
