//! Which `swarmterm` MCP entry a config file holds, and whether this build
//! may (re)write it (SWA-83 1b).
//!
//! Two shapes are ours, each recognised only in the exact form Swarmterm
//! writes: the legacy HTTP entry (`${SWARMTERM_MCP_URL}` with the
//! `Bearer ${SWARMTERM_SESSION}` header, or Codex's loopback URL with that
//! bearer variable) and the stdio entry `<…\swarmterm.exe> --mcp-stdio`.
//! Anything else under the `swarmterm` name — a user's own proxy that
//! happens to reuse our variables, a wrapper script — is the user's and is
//! never touched.
//!
//! Release builds migrate legacy entries and repair a stdio entry whose exe
//! is gone or is a development build; they leave another live installed
//! Swarmterm's entry alone (any of our exes relays to the pane's own
//! address, so taking it over would only make two installs rewrite the file
//! in turn). Debug builds follow `dev_defer`: they never migrate a legacy
//! entry and never repoint a stdio entry at their `target/debug` binary
//! while it names another Swarmterm that still exists.

use serde_json::Value;

pub const STDIO_ARG: &str = "--mcp-stdio";
/// The variables Codex must pass to a stdio server (it hands them only a
/// short default environment otherwise).
pub const ENV_VARS: [&str; 2] = ["SWARMTERM_MCP_URL", "SWARMTERM_SESSION"];
/// Keys only the legacy HTTP entry has; dropped when it becomes stdio.
pub const LEGACY_JSON_KEYS: [&str; 2] = ["url", "headers"];
pub const LEGACY_TOML_KEYS: [&str; 2] = ["url", "bearer_token_env_var"];

const URL_PLACEHOLDER: &str = "${SWARMTERM_MCP_URL}";
const AUTH_PLACEHOLDER: &str = "Bearer ${SWARMTERM_SESSION}";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Absent,
    /// Our HTTP entry from before 1b.
    Legacy,
    /// Our stdio entry, naming this executable.
    Stdio {
        exe: String,
    },
    Foreign,
}

fn file_name(command: &str) -> String {
    command
        .trim()
        .trim_matches('"')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Our binary by its exact name, never a lookalike (`swarmterm-mcp.cmd`).
fn exe_is_swarmterm(command: &str) -> bool {
    matches!(file_name(command).as_str(), "swarmterm.exe" | "swarmterm")
}

/// A `target\debug` (or `target/debug`) binary of a source checkout.
fn is_debug_build_path(exe: &str) -> bool {
    exe.replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/target/debug/")
}

fn stdio_kind(command: Option<&str>, args: Option<Vec<&str>>) -> Option<Kind> {
    let command = command?;
    (exe_is_swarmterm(command) && args? == [STDIO_ARG]).then(|| Kind::Stdio {
        exe: command.to_string(),
    })
}

/// A Claude Code / Qwen `mcpServers.swarmterm` value.
pub fn classify_json(entry: Option<&Value>) -> Kind {
    let Some(v) = entry else {
        return Kind::Absent;
    };
    let args = v
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect());
    if let Some(kind) = stdio_kind(v.get("command").and_then(Value::as_str), args) {
        return kind;
    }
    let text = |key: &str| v.get(key).and_then(Value::as_str);
    // Claude's `url`, Qwen's `httpUrl`; both written only with our header.
    let url = text("url").or_else(|| text("httpUrl"));
    let auth = v
        .get("headers")
        .and_then(|h| h.get("Authorization"))
        .and_then(Value::as_str);
    if url == Some(URL_PLACEHOLDER) && auth == Some(AUTH_PLACEHOLDER) {
        Kind::Legacy
    } else {
        Kind::Foreign
    }
}

/// A Codex `[mcp_servers.swarmterm]` table.
pub fn classify_toml(entry: Option<&toml_edit::Item>) -> Kind {
    let Some(t) = entry else {
        return Kind::Absent;
    };
    let args = t
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect());
    if let Some(kind) = stdio_kind(t.get("command").and_then(|c| c.as_str()), args) {
        return kind;
    }
    let text = |key: &str| t.get(key).and_then(|v| v.as_str());
    // Pre-1b Codex entries carried the concrete loopback URL of the app.
    let ours_url =
        text("url").is_some_and(|u| crate::mcp_stdio::upstream_from(Some(u), Some("-")).is_some());
    if ours_url && text("bearer_token_env_var") == Some("SWARMTERM_SESSION") {
        Kind::Legacy
    } else {
        Kind::Foreign
    }
}

/// Should this build write its entry over `kind`? `current` = the file
/// already holds exactly what it would write. `debug` is passed in (not
/// `cfg!`) so both rules are unit-tested.
pub fn should_write(
    kind: &Kind,
    current: bool,
    own_exe: &str,
    debug: bool,
    exists: impl Fn(&str) -> bool,
) -> bool {
    if current {
        return false;
    }
    match kind {
        Kind::Foreign => false,
        Kind::Absent => true,
        Kind::Legacy => !debug,
        Kind::Stdio { exe } => {
            crate::dev_defer::same_exe(exe, own_exe)
                || !exists(exe)
                || (!debug && is_debug_build_path(exe))
        }
    }
}

/// `debug` for `should_write` in this process: a dev build, but not the
/// unit tests, whose fixtures exercise the release paths.
pub fn is_dev_build() -> bool {
    cfg!(debug_assertions) && !cfg!(test)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const INSTALLED: &str = "C:/Users/dev/AppData/Local/Swarmterm GN/swarmterm.exe";
    const CORP: &str = r"C:\Program Files\Swarmterm Corp\swarmterm.exe";
    const DEV: &str = r"D:\wt\src-tauri\target\debug\swarmterm.exe";

    #[test]
    fn tells_our_entries_from_the_users() {
        assert_eq!(classify_json(None), Kind::Absent);
        let legacy = json!({"type":"http","url":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}});
        assert_eq!(classify_json(Some(&legacy)), Kind::Legacy);
        let qwen = json!({"httpUrl":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}});
        assert_eq!(classify_json(Some(&qwen)), Kind::Legacy);
        let stdio = json!({"type":"stdio","command":INSTALLED,"args":["--mcp-stdio"]});
        assert_eq!(
            classify_json(Some(&stdio)),
            Kind::Stdio {
                exe: INSTALLED.into()
            }
        );
        for foreign in [
            json!({"command":"my-own"}),
            json!({"command":"node","args":["--mcp-stdio"]}),
            json!({"type":"http","url":"https://example.com/mcp"}),
            // The user's own proxy reusing our session variable.
            json!({"type":"http","url":"https://my-proxy/mcp","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}}),
            json!({"type":"http","url":"${SWARMTERM_MCP_URL}"}),
            // Wrappers and extra arguments are the user's.
            json!({"command":"C:/bin/swarmterm-mcp.cmd","args":["--mcp-stdio"]}),
            json!({"command":INSTALLED,"args":["--mcp-stdio","--verbose"]}),
            json!({"command":INSTALLED}),
        ] {
            assert_eq!(classify_json(Some(&foreign)), Kind::Foreign, "{foreign}");
        }
    }

    #[test]
    fn reads_codex_tables() {
        let doc: toml_edit::DocumentMut = "[mcp_servers.a]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n\n[mcp_servers.b]\ncommand = 'C:\\x\\swarmterm.exe'\nargs = [\"--mcp-stdio\"]\n\n[mcp_servers.c]\ncommand = \"gh\"\n\n[mcp_servers.d]\nurl = \"https://my-proxy/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n".parse().unwrap();
        let get = |k: &str| classify_toml(doc.get("mcp_servers").and_then(|m| m.get(k)));
        assert_eq!(get("a"), Kind::Legacy);
        assert!(matches!(get("b"), Kind::Stdio { .. }));
        assert_eq!(get("c"), Kind::Foreign);
        assert_eq!(get("d"), Kind::Foreign);
        assert_eq!(get("zzz"), Kind::Absent);
    }

    #[test]
    fn release_builds_migrate_and_repair_but_leave_the_users_entry() {
        let gone = |_: &str| false;
        assert!(should_write(&Kind::Absent, false, INSTALLED, false, gone));
        assert!(should_write(&Kind::Legacy, false, INSTALLED, false, gone));
        // A dev build's entry is taken over even while that binary exists.
        let dev = Kind::Stdio { exe: DEV.into() };
        assert!(should_write(&dev, false, INSTALLED, false, |_| true));
        // A moved install: the old path is gone.
        let old = Kind::Stdio {
            exe: "C:/old/swarmterm.exe".into(),
        };
        assert!(should_write(&old, false, INSTALLED, false, gone));
        assert!(!should_write(&Kind::Foreign, false, INSTALLED, false, gone));
        assert!(!should_write(&Kind::Absent, true, INSTALLED, false, gone));
    }

    #[test]
    fn two_live_installs_do_not_take_turns() {
        let corp = Kind::Stdio { exe: CORP.into() };
        assert!(!should_write(&corp, false, INSTALLED, false, |_| true));
        let gn = Kind::Stdio {
            exe: INSTALLED.into(),
        };
        assert!(!should_write(&gn, false, CORP, false, |_| true));
    }

    #[test]
    fn dev_builds_never_migrate_or_take_over_a_live_install() {
        let installed = Kind::Stdio {
            exe: INSTALLED.into(),
        };
        assert!(!should_write(&Kind::Legacy, false, DEV, true, |_| true));
        assert!(!should_write(&installed, false, DEV, true, |_| true));
        // The installed app is gone: a working dev entry beats a dead one.
        assert!(should_write(&installed, false, DEV, true, |_| false));
        // Its own entry (another slash direction) is kept up to date.
        let own = Kind::Stdio {
            exe: DEV.replace('\\', "/"),
        };
        assert!(should_write(&own, false, DEV, true, |_| true));
        assert!(should_write(&Kind::Absent, false, DEV, true, |_| true));
        // Another worktree's live dev build is left alone too.
        let other_dev = Kind::Stdio {
            exe: r"D:\wt2\src-tauri\target\debug\swarmterm.exe".into(),
        };
        assert!(!should_write(&other_dev, false, DEV, true, |_| true));
    }
}
