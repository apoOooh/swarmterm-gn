//! Which `swarmterm` MCP entry a config file holds, and whether this build
//! may (re)write it (SWA-83 1b).
//!
//! Two shapes are ours: the legacy HTTP entry (`${SWARMTERM_MCP_URL}` /
//! `SWARMTERM_SESSION` bearer, or Codex's concrete URL with that bearer) and
//! the stdio entry `<swarmterm.exe> --mcp-stdio`. Anything else under the
//! `swarmterm` name is the user's and is never touched.
//!
//! Release builds migrate legacy entries and repair the exe path. Debug
//! builds follow `dev_defer`: they never migrate a legacy entry and never
//! repoint a stdio entry at their `target/debug` binary while it names
//! another Swarmterm that still exists.

use serde_json::Value;

pub const STDIO_ARG: &str = "--mcp-stdio";
/// The variables Codex must pass to a stdio server (it hands them only a
/// short default environment otherwise).
pub const ENV_VARS: [&str; 2] = ["SWARMTERM_MCP_URL", "SWARMTERM_SESSION"];
/// Keys only the legacy HTTP entry has; dropped when it becomes stdio.
pub const LEGACY_JSON_KEYS: [&str; 2] = ["url", "headers"];
pub const LEGACY_TOML_KEYS: [&str; 2] = ["url", "bearer_token_env_var"];

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

fn exe_is_swarmterm(command: &str) -> bool {
    let name = command
        .trim()
        .trim_matches('"')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.starts_with("swarmterm")
}

fn stdio_kind(command: Option<&str>, args: Vec<&str>) -> Option<Kind> {
    let command = command?;
    (exe_is_swarmterm(command) && args.contains(&STDIO_ARG)).then(|| Kind::Stdio {
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
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(kind) = stdio_kind(v.get("command").and_then(Value::as_str), args) {
        return kind;
    }
    let url = v
        .get("url")
        .or_else(|| v.get("httpUrl"))
        .and_then(Value::as_str);
    let auth = v
        .get("headers")
        .and_then(|h| h.get("Authorization"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if url == Some("${SWARMTERM_MCP_URL}") || auth.contains("SWARMTERM_SESSION") {
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
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if let Some(kind) = stdio_kind(t.get("command").and_then(|c| c.as_str()), args) {
        return kind;
    }
    if t.get("bearer_token_env_var").and_then(|v| v.as_str()) == Some("SWARMTERM_SESSION") {
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
        Kind::Stdio { exe } => !debug || crate::dev_defer::same_exe(exe, own_exe) || !exists(exe),
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
    const DEV: &str = r"D:\wt\src-tauri\target\debug\swarmterm.exe";

    #[test]
    fn tells_our_entries_from_the_users() {
        assert_eq!(classify_json(None), Kind::Absent);
        let legacy = json!({"type":"http","url":"${SWARMTERM_MCP_URL}","headers":{"Authorization":"Bearer ${SWARMTERM_SESSION}"}});
        assert_eq!(classify_json(Some(&legacy)), Kind::Legacy);
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
        ] {
            assert_eq!(classify_json(Some(&foreign)), Kind::Foreign, "{foreign}");
        }
    }

    #[test]
    fn reads_codex_tables() {
        let doc: toml_edit::DocumentMut = "[mcp_servers.a]\nurl = \"http://127.0.0.1:9/mcp\"\nbearer_token_env_var = \"SWARMTERM_SESSION\"\n\n[mcp_servers.b]\ncommand = 'C:\\x\\swarmterm.exe'\nargs = [\"--mcp-stdio\"]\n\n[mcp_servers.c]\ncommand = \"gh\"\n".parse().unwrap();
        let get = |k: &str| classify_toml(doc.get("mcp_servers").and_then(|m| m.get(k)));
        assert_eq!(get("a"), Kind::Legacy);
        assert!(matches!(get("b"), Kind::Stdio { .. }));
        assert_eq!(get("c"), Kind::Foreign);
        assert_eq!(get("zzz"), Kind::Absent);
    }

    #[test]
    fn release_builds_migrate_and_repair_but_leave_the_users_entry() {
        let gone = |_: &str| false;
        assert!(should_write(&Kind::Absent, false, INSTALLED, false, gone));
        assert!(should_write(&Kind::Legacy, false, INSTALLED, false, gone));
        let other = Kind::Stdio { exe: DEV.into() };
        assert!(should_write(&other, false, INSTALLED, false, |_| true));
        assert!(!should_write(&Kind::Foreign, false, INSTALLED, false, gone));
        assert!(!should_write(&Kind::Absent, true, INSTALLED, false, gone));
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
    }
}
