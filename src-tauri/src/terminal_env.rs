//! The complete environment a pane is spawned with, resolved in the app.
//!
//! Both backends consume the same plan: the in-process PTY clears its
//! `CommandBuilder` and applies it, the terminal host (SWA-55, ADR 0001)
//! receives it whole in `CreateSpec.env` and clears its own environment
//! first. One resolution path means a pane behaves the same whichever
//! backend runs it, and the host never needs to know about accounts, MCP
//! URLs or locale fallbacks.
//!
//! Windows compares variable names case-insensitively (`Path` and `PATH` are
//! one variable), so a set or remove replaces any spelling of the name;
//! sending both spellings to `CreateProcess` would leave which one wins to
//! the order in the block.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvPlan {
    vars: BTreeMap<String, String>,
}

impl EnvPlan {
    pub fn from_vars(vars: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut plan = EnvPlan::default();
        for (k, v) in vars {
            plan.set(&k, v);
        }
        plan
    }

    /// The app's own environment: what an in-process pane inherited before.
    pub fn inherited() -> Self {
        Self::from_vars(std::env::vars())
    }

    fn existing_key(&self, key: &str) -> Option<String> {
        if cfg!(windows) {
            self.vars
                .keys()
                .find(|k| k.eq_ignore_ascii_case(key))
                .cloned()
        } else {
            self.vars.contains_key(key).then(|| key.to_string())
        }
    }

    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        if let Some(old) = self.existing_key(key) {
            self.vars.remove(&old);
        }
        self.vars.insert(key.to_string(), value.into());
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(old) = self.existing_key(key) {
            self.vars.remove(&old);
        }
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.existing_key(key)
            .and_then(|k| self.vars.get(&k))
            .map(String::as_str)
    }

    pub fn into_map(self) -> BTreeMap<String, String> {
        self.vars
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.vars.iter()
    }
}

/// How much of the app's own environment a child may see (Settings →
/// Terminal "Environment"). Corporate review: panes run agents that act on
/// their own, so API keys the app happened to be started with must not leak
/// into them by default. Agents keep working: they log in through their own
/// config directories, not through the app's environment.
///
/// One struct so a later admin policy can replace or clamp it without
/// touching the spawners.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvPolicy {
    /// true = no filtering at all (the behaviour before this setting).
    pub pass_secrets: bool,
    pub mode: FilterMode,
    /// Names that always pass, case-insensitive; a trailing `*` matches a
    /// prefix (`MY_TOOL_*`).
    pub allow: Vec<String>,
}

impl Default for EnvPolicy {
    fn default() -> Self {
        // Secure by default: panes created before the renderer pushes the
        // setting (restore at boot) are filtered too.
        Self {
            pass_secrets: false,
            mode: FilterMode::Default,
            allow: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilterMode {
    /// Drop secret-looking names, keep everything else.
    #[default]
    Default,
    /// Keep only the Windows system/user variables a shell needs.
    Strict,
}

/// Set by the app after filtering, or the user's own pointer to an agent's
/// config directory. Never filtered, so logins and the MCP wiring keep
/// working in every mode.
const APP_SET: &[&str] = &[
    "SWARMTERM_SESSION",
    "SWARMTERM_MCP_URL",
    "SWARMTERM_PTY_GENERATION",
    "OPENCODE_CONFIG_CONTENT",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

/// A name equal to one of these, or ending in `_` + one, is a secret.
/// The `_` boundary keeps `TOKENIZER_PATH` or `MYTOKEN` out.
const SECRET_SUFFIXES: &[&str] = &[
    "API_KEY",
    "APIKEY",
    "TOKEN",
    "SECRET",
    "SECRET_KEY",
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "CREDENTIALS",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "ACCESS_KEY_ID",
    "ACCOUNT_KEY",
    "CONNECTION_STRING",
];

/// Whole provider families (`AWS_PROFILE`, `ANTHROPIC_BASE_URL` too: users
/// who need one add it to the allowlist).
const SECRET_PREFIXES: &[&str] = &["AWS_", "ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_"];

/// Exact names that carry credentials without a telling suffix.
const SECRET_NAMES: &[&str] = &["DATABASE_URL"];

/// Strict mode: what Windows programs and shells expect to exist.
const STRICT_NAMES: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "OS",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "COMPUTERNAME",
    "LOGONSERVER",
    "SESSIONNAME",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "PROGRAMDATA",
    "DRIVERDATA",
    "NUMBER_OF_PROCESSORS",
    "PSMODULEPATH",
    "LANG",
    "TERM",
    "COLORTERM",
    "SHELL",
];
const STRICT_PREFIXES: &[&str] = &[
    "PROGRAMFILES",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMW6432",
    "PROCESSOR_",
    "LC_",
];

pub fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    SECRET_NAMES.contains(&n.as_str())
        || SECRET_PREFIXES.iter().any(|p| n.starts_with(p))
        || SECRET_SUFFIXES
            .iter()
            .any(|s| n == *s || n.strip_suffix(s).is_some_and(|head| head.ends_with('_')))
}

fn is_strict_name(upper: &str) -> bool {
    STRICT_NAMES.contains(&upper) || STRICT_PREFIXES.iter().any(|p| upper.starts_with(p))
}

impl EnvPolicy {
    fn allowed_by_user(&self, upper: &str) -> bool {
        self.allow.iter().any(|a| {
            let a = a.trim().to_ascii_uppercase();
            match a.strip_suffix('*') {
                // A bare `*` would silently switch the filter off.
                Some(prefix) => !prefix.is_empty() && upper.starts_with(prefix),
                None => !a.is_empty() && a == upper,
            }
        })
    }

    /// Whether `name` from the app's environment reaches a child.
    pub fn passes(&self, name: &str) -> bool {
        if self.pass_secrets {
            return true;
        }
        let upper = name.to_ascii_uppercase();
        if APP_SET.contains(&upper.as_str()) || self.allowed_by_user(&upper) {
            return true;
        }
        match self.mode {
            FilterMode::Default => !is_secret_name(&upper),
            FilterMode::Strict => is_strict_name(&upper),
        }
    }

    /// `plan` with everything this policy withholds removed.
    pub fn filter(&self, plan: EnvPlan) -> EnvPlan {
        EnvPlan {
            vars: plan
                .vars
                .into_iter()
                .filter(|(k, _)| self.passes(k))
                .collect(),
        }
    }

    /// The app's environment as this policy lets a child see it.
    pub fn inherited(&self) -> EnvPlan {
        self.filter(EnvPlan::inherited())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(pairs: &[(&str, &str)]) -> EnvPlan {
        EnvPlan::from_vars(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
    }

    #[test]
    fn set_overrides_and_remove_drops() {
        let mut p = plan(&[("TERM", "dumb"), ("KEEP", "1")]);
        p.set("TERM", "xterm-256color");
        p.remove("MISSING");
        assert_eq!(p.get("TERM"), Some("xterm-256color"));
        assert_eq!(p.get("KEEP"), Some("1"));
        p.remove("KEEP");
        assert_eq!(p.get("KEEP"), None);
    }

    #[cfg(windows)]
    #[test]
    fn names_are_case_insensitive_on_windows() {
        let mut p = plan(&[("Path", r"C:\a")]);
        p.set("PATH", r"C:\b");
        let map = p.clone().into_map();
        assert_eq!(map.len(), 1, "one variable, not two spellings: {map:?}");
        assert_eq!(p.get("path"), Some(r"C:\b"));
        p.remove("pAtH");
        assert!(p.into_map().is_empty());
    }

    /// The in-process backend now spawns from the plan after `env_clear`
    /// (SWA-55), so the plan must hold exactly what a pane inherited before.
    #[test]
    fn inherited_is_the_whole_process_environment() {
        let plan = EnvPlan::inherited();
        let mut names: Vec<String> = Vec::new();
        for (k, v) in std::env::vars() {
            assert_eq!(plan.get(&k), Some(v.as_str()), "{k}");
            let norm = if cfg!(windows) {
                k.to_ascii_lowercase()
            } else {
                k
            };
            if !names.contains(&norm) {
                names.push(norm);
            }
        }
        assert_eq!(
            plan.into_map().len(),
            names.len(),
            "no extra or doubled names"
        );
    }

    #[test]
    fn inherited_carries_the_process_environment() {
        // Every Windows process has SystemRoot; a host-spawned shell without
        // it starts broken, which is why the plan must be complete.
        #[cfg(windows)]
        assert!(EnvPlan::inherited().get("SystemRoot").is_some());
        #[cfg(not(windows))]
        assert!(EnvPlan::inherited().get("PATH").is_some());
    }

    fn names(p: &EnvPlan) -> Vec<String> {
        p.iter().map(|(k, _)| k.clone()).collect()
    }

    #[test]
    fn secret_names_are_recognised_case_insensitively() {
        for n in [
            "FOO_API_KEY",
            "foo_apikey",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "NPM_TOKEN",
            "HF_TOKEN",
            "Azure_Client_Secret",
            "MY_SECRET_KEY",
            "DB_PASSWORD",
            "DB_PASSWD",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "SSH_PRIVATE_KEY",
            "AWS_REGION",
            "anthropic_base_url",
            "OPENAI_ORG_ID",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "STORAGE_ACCOUNT_KEY",
            "SQL_CONNECTION_STRING",
            "DATABASE_URL",
            "TOKEN",
            "PASSWORD",
        ] {
            assert!(is_secret_name(n), "{n}");
        }
        for n in [
            "PATH",
            "TOKENIZER_PATH",
            "MYTOKEN",
            "KEYBOARD",
            "SSH_AUTH_SOCK",
            "SECRETARY",
            "PASSWORDLESS",
            "OLDPWD",
        ] {
            assert!(!is_secret_name(n), "{n}");
        }
    }

    #[test]
    fn default_mode_drops_secrets_and_keeps_the_rest() {
        let p = EnvPolicy::default().filter(plan(&[
            ("PATH", "x"),
            ("FOO_API_KEY", "k"),
            ("EDITOR", "vim"),
            ("GITHUB_TOKEN", "t"),
        ]));
        assert_eq!(names(&p), ["EDITOR", "PATH"]);
    }

    #[test]
    fn app_set_variables_are_never_filtered() {
        let vars = [
            ("SWARMTERM_SESSION", "s"),
            ("SWARMTERM_MCP_URL", "u"),
            ("SWARMTERM_PTY_GENERATION", "1"),
            ("OPENCODE_CONFIG_CONTENT", "{}"),
            ("CLAUDE_CONFIG_DIR", "c"),
            ("CODEX_HOME", "h"),
        ];
        for mode in [FilterMode::Default, FilterMode::Strict] {
            let policy = EnvPolicy {
                mode,
                ..EnvPolicy::default()
            };
            assert_eq!(policy.filter(plan(&vars)).iter().count(), vars.len());
        }
    }

    #[test]
    fn strict_mode_keeps_only_system_variables() {
        let policy = EnvPolicy {
            mode: FilterMode::Strict,
            ..EnvPolicy::default()
        };
        let p = policy.filter(plan(&[
            ("Path", "x"),
            ("SystemRoot", r"C:\Windows"),
            ("ProgramFiles(x86)", "p"),
            ("PROCESSOR_ARCHITECTURE", "AMD64"),
            ("LC_ALL", "C"),
            ("PSModulePath", "m"),
            ("EDITOR", "vim"),
            ("HTTP_PROXY", "h"),
            ("FOO_API_KEY", "k"),
        ]));
        assert_eq!(
            names(&p),
            [
                "LC_ALL",
                "PROCESSOR_ARCHITECTURE",
                "PSModulePath",
                "Path",
                "ProgramFiles(x86)",
                "SystemRoot"
            ]
        );
    }

    #[test]
    fn user_allowlist_always_passes_with_prefix_wildcard() {
        for mode in [FilterMode::Default, FilterMode::Strict] {
            let policy = EnvPolicy {
                mode,
                allow: vec![" foo_api_key ".into(), "MY_*".into(), "*".into(), "".into()],
                ..EnvPolicy::default()
            };
            assert!(policy.passes("FOO_API_KEY"), "{mode:?}");
            assert!(policy.passes("my_tool_token"), "{mode:?}");
            // A bare `*` or an empty entry must not switch the filter off.
            assert!(!policy.passes("BAR_API_KEY"), "{mode:?}");
        }
    }

    #[test]
    fn pass_secrets_disables_filtering() {
        let policy = EnvPolicy {
            pass_secrets: true,
            mode: FilterMode::Strict,
            allow: vec![],
        };
        let p = policy.filter(plan(&[("FOO_API_KEY", "k"), ("EDITOR", "vim")]));
        assert_eq!(p.iter().count(), 2);
    }

    #[test]
    fn policy_deserialises_from_the_renderer_shape_with_defaults() {
        let p: EnvPolicy =
            serde_json::from_str(r#"{"passSecrets":false,"mode":"strict","allow":["X"]}"#).unwrap();
        assert_eq!(p.mode, FilterMode::Strict);
        assert_eq!(p.allow, ["X"]);
        let empty: EnvPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, EnvPolicy::default());
    }
}
