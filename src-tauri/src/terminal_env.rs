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
/// config directory. `OPENCODE_CONFIG_CONTENT` is not here: the app sets its
/// own value after filtering, and one inherited from the app's parent is
/// arbitrary user config (it can carry inline provider keys), so it follows
/// the mode like any other name (passes Default, dropped by Strict).
/// Never filtered, so logins and the MCP wiring keep working in every mode.
const APP_SET: &[&str] = &[
    "SWARMTERM_SESSION",
    "SWARMTERM_MCP_URL",
    "SWARMTERM_PTY_GENERATION",
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
    "CREDENTIAL",
    "CREDENTIALS",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "ACCESS_KEY_ID",
    "ACCOUNT_KEY",
    "CONNECTION_STRING",
    "PAT",
    "AUTH",
    "DSN",
    "COOKIE",
    "HEADERS",
];

/// Short suffixes that are only a secret after a `_` (`MYSQL_PWD`,
/// `SMTP_PASS`, `STRIPE_KEY`); the bare name is not (`PWD` is the shell's
/// working directory).
const SECRET_SUFFIXES_AFTER_UNDERSCORE: &[&str] = &["PASS", "PWD", "KEY"];

/// A `_`-separated segment anywhere in the name that marks a secret
/// (`AWS_BEARER_TOKEN_BEDROCK`, `GITHUB_TOKEN_FOR_CI`). Only unambiguous
/// words: `AUTH` stays suffix-only because of `SSH_AUTH_SOCK`.
const SECRET_SEGMENTS: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "APIKEY",
    "CREDENTIAL",
    "CREDENTIALS",
];

/// Names starting with these are secrets as a whole. Provider families
/// (`AWS_`, `ANTHROPIC_`, `OPENAI_`) are deliberately not here: their
/// config (`AWS_REGION`, `AWS_PROFILE`, `ANTHROPIC_BASE_URL`,
/// `OPENAI_BASE_URL`) is what Bedrock and corporate LLM gateways need, and
/// their secrets (`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
/// `ANTHROPIC_API_KEY`) are caught by the suffix and segment rules.
const SECRET_PREFIXES: &[&str] = &["SECRET_"];

/// Exact names that carry credentials without a telling suffix.
const SECRET_NAMES: &[&str] = &["DATABASE_URL", "PGPASSWORD", "MYSQL_PWD"];

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
    let after_underscore = |s: &&str| n.strip_suffix(*s).is_some_and(|head| head.ends_with('_'));
    SECRET_NAMES.contains(&n.as_str())
        || SECRET_PREFIXES.iter().any(|p| n.starts_with(p))
        || SECRET_SUFFIXES
            .iter()
            .any(|s| n == *s || after_underscore(s))
        || SECRET_SUFFIXES_AFTER_UNDERSCORE
            .iter()
            .any(after_underscore)
        || (!names_a_location(&n) && n.split('_').any(|seg| SECRET_SEGMENTS.contains(&seg)))
}

/// `AWS_SHARED_CREDENTIALS_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
/// `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`: where a secret lives is config a tool needs (EKS/IRSA), not the secret itself. Only the
/// segment rule yields to it; suffix rules never match these names anyway.
fn names_a_location(upper: &str) -> bool {
    ["_FILE", "_PATH", "_DIR", "_URI", "_URL"]
        .iter()
        .any(|s| upper.ends_with(s))
}

/// Header blobs (`ANTHROPIC_CUSTOM_HEADERS=Authorization: Bearer …`) carry
/// credentials under a harmless name, so the value is checked too.
fn has_auth_header(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    v.contains("authorization:") || v.contains("bearer ")
}

/// Whether `value` holds a URL with credentials in it
/// (`redis://:pw@host`, `http://user:pw@proxy:8080`, `https://TOKEN@host`):
/// any non-empty userinfo before the host. Every `scheme://` in the value is
/// checked, so a list of URLs counts too.
pub fn has_url_credentials(value: &str) -> bool {
    let mut rest = value;
    while let Some(i) = rest.find("://") {
        let after = &rest[i + 3..];
        let end = after
            .find(|c: char| {
                matches!(c, '/' | '?' | '#') || c.is_whitespace() || c == ';' || c == ','
            })
            .unwrap_or(after.len());
        if after[..end].rfind('@').is_some_and(|at| at > 0) {
            return true;
        }
        rest = after;
    }
    false
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

    /// Whether `name` from the app's environment reaches a child, judged by
    /// its name alone (see `passes_var` for the value check).
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

    /// Whether `name=value` reaches a child. On top of `passes`, Default mode
    /// drops any variable whose value embeds URL credentials
    /// (`HTTPS_PROXY=http://user:pw@proxy`, `REDIS_URL=redis://:pw@host`):
    /// the whole variable goes rather than a redacted copy, because a URL
    /// without its password fails anyway and a clear "not set" is easier to
    /// diagnose than a 401/407. The allow list still passes it.
    pub fn passes_var(&self, name: &str, value: &str) -> bool {
        if !self.passes(name) {
            return false;
        }
        if self.pass_secrets || self.mode != FilterMode::Default {
            return true;
        }
        let upper = name.to_ascii_uppercase();
        APP_SET.contains(&upper.as_str())
            || self.allowed_by_user(&upper)
            || !(has_url_credentials(value) || has_auth_header(value))
    }

    /// `plan` with everything this policy withholds removed.
    pub fn filter(&self, plan: EnvPlan) -> EnvPlan {
        EnvPlan {
            vars: plan
                .vars
                .into_iter()
                .filter(|(k, v)| self.passes_var(k, v))
                .collect(),
        }
    }

    /// The app's environment as this policy lets a child see it.
    pub fn inherited(&self) -> EnvPlan {
        self.filter(EnvPlan::inherited())
    }
}

/// The effective policy (user setting with the admin policy applied) for
/// child processes that have no `AppState` at hand: git, editors, MarkText,
/// probes, the buzzkey companion. Published by the app at startup and on
/// every `env_policy_set`; until then the secure default applies.
static CHILD_POLICY: std::sync::RwLock<Option<EnvPolicy>> = std::sync::RwLock::new(None);

pub fn publish_child_policy(policy: EnvPolicy) {
    *CHILD_POLICY.write().unwrap_or_else(|e| e.into_inner()) = Some(policy);
}

pub fn child_policy() -> EnvPolicy {
    CHILD_POLICY
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

/// A `std::process::Command` for any external program the app starts: the
/// environment is cleared and replaced by the current policy's view of the
/// app's own, exactly as for a pane. Every child process goes through this
/// (or `tokio_command`) so no spawn site can forget the filter.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    command_with(&child_policy(), program)
}

fn command_with(policy: &EnvPolicy, program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.env_clear();
    cmd.envs(policy.inherited().iter());
    cmd
}

/// `command` for tokio.
pub fn tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    // tokio's Command wraps std's, so it gets exactly `command`'s setup.
    tokio::process::Command::from(command(program))
}

/// Where the user's policy is kept on the Rust side, so the first spawn
/// after a restart (restored panes, boot routines) uses it before the
/// renderer's `env_policy_set` arrives.
static STORE_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Read the persisted user policy. A missing or unreadable file is `None`
/// (the caller keeps the secure default).
pub fn load_persisted(path: &std::path::Path) -> Option<EnvPolicy> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!(
                "env policy: {} unreadable ({e}); using the default",
                path.display()
            );
            None
        }
    }
}

pub fn save_persisted(path: &std::path::Path, policy: &EnvPolicy) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // One writer at a time (Tauri runs commands on a pool), and the data is
    // on disk before the rename, so a crash never leaves an empty file.
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(policy)?)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Set the file `persist` writes to; called once at startup.
pub fn set_store_path(path: std::path::PathBuf) {
    let _ = STORE_PATH.set(path);
}

/// Persist the user's policy (log-only on failure).
pub fn persist(policy: &EnvPolicy) {
    if let Some(path) = STORE_PATH.get() {
        if let Err(e) = save_persisted(path, policy) {
            eprintln!("env policy: cannot save {}: {e}", path.display());
        }
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
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "STORAGE_ACCOUNT_KEY",
            "SQL_CONNECTION_STRING",
            "DATABASE_URL",
            "TOKEN",
            "PASSWORD",
            "AZDO_PAT",
            "NPM_AUTH",
            "SENTRY_DSN",
            "SESSION_COOKIE",
            "SECRET_KEY_BASE",
            "CLAUDE_CODE_OAUTH_TOKEN",
            // Item: names the old rules missed.
            "PGPASSWORD",
            "MYSQL_PWD",
            "SMTP_PASS",
            "DB_PWD",
            "STRIPE_KEY",
            "AZURE_CREDENTIAL",
            "GCP_CREDENTIALS",
            "AWS_BEARER_TOKEN_BEDROCK",
            "ANTHROPIC_CUSTOM_HEADERS",
            // Provider secrets still caught without the family prefixes.
            "AWS_SECRET_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SESSION_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "AZURE_OPENAI_API_KEY",
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
            "PATCH_LEVEL",
            "AUTHOR",
            "PWD",
            "KEY",
            "PASS",
            // Provider config Bedrock and LLM gateways need.
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_PROFILE",
            "anthropic_base_url",
            "ANTHROPIC_MODEL",
            "OPENAI_BASE_URL",
            "OPENAI_ORG_ID",
            "AZURE_OPENAI_ENDPOINT",
            "SYSTEMROOT",
            "HTTPS_PROXY",
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
            "REQUESTS_CA_BUNDLE",
            "AWS_SHARED_CREDENTIALS_FILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
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

    #[test]
    fn inherited_opencode_config_follows_the_mode() {
        let vars = [("OPENCODE_CONFIG_CONTENT", "{}")];
        assert_eq!(EnvPolicy::default().filter(plan(&vars)).iter().count(), 1);
        let strict = EnvPolicy {
            mode: FilterMode::Strict,
            ..EnvPolicy::default()
        };
        assert_eq!(strict.filter(plan(&vars)).iter().count(), 0);
    }

    #[test]
    fn url_credentials_are_detected() {
        for v in [
            "redis://:pw@cache:6379/0",
            "mongodb+srv://user:pw@cluster.example/db",
            "amqp://guest:guest@mq:5672/",
            "http://user:pw@proxy:8080",
            "https://ghp_x@github.com/o/r.git",
            "http://a.example; http://u:p@b.example",
        ] {
            assert!(has_url_credentials(v), "{v}");
        }
        for v in [
            "http://proxy:8080",
            "https://gateway.example/v1?user=a@b",
            "postgres://db.example/app",
            r"C:\Windows",
            "localhost,.corp.example",
            "mailto:a@b.example",
        ] {
            assert!(!has_url_credentials(v), "{v}");
        }
    }

    #[test]
    fn default_mode_drops_credentialed_urls_and_keeps_config() {
        let p = EnvPolicy::default().filter(plan(&[
            ("PATH", r"C:\Windows"),
            ("SYSTEMROOT", r"C:\Windows"),
            ("HTTPS_PROXY", "http://proxy.corp:8080"),
            ("HTTP_PROXY", "http://me:pw@proxy.corp:8080"),
            ("REDIS_URL", "redis://:pw@cache"),
            ("MONGODB_URI", "mongodb://u:p@db"),
            ("AMQP_URL", "amqp://u:p@mq"),
            ("DATABASE_URL", "postgres://db/app"),
            ("SSL_CERT_FILE", "c.pem"),
            ("NODE_EXTRA_CA_CERTS", "c.pem"),
            ("REQUESTS_CA_BUNDLE", "c.pem"),
            ("AWS_REGION", "eu-central-1"),
            ("AWS_PROFILE", "corp"),
            ("ANTHROPIC_BASE_URL", "https://llm.corp/anthropic"),
            ("OPENAI_BASE_URL", "https://llm.corp/openai"),
            ("AWS_SECRET_ACCESS_KEY", "s"),
            ("AWS_SESSION_TOKEN", "t"),
        ]));
        assert_eq!(
            names(&p),
            [
                "ANTHROPIC_BASE_URL",
                "AWS_PROFILE",
                "AWS_REGION",
                "HTTPS_PROXY",
                "NODE_EXTRA_CA_CERTS",
                "OPENAI_BASE_URL",
                "PATH",
                "REQUESTS_CA_BUNDLE",
                "SSL_CERT_FILE",
                "SYSTEMROOT",
            ]
        );
        // The allow list passes a credentialed URL on purpose.
        let allow = EnvPolicy {
            allow: vec!["HTTP_PROXY".into()],
            ..EnvPolicy::default()
        };
        assert!(allow.passes_var("HTTP_PROXY", "http://me:pw@proxy"));
        // Auth headers under any name are withheld too.
        let d = EnvPolicy::default();
        assert!(!d.passes_var("MY_EXTRA", "Authorization: Bearer x"));
        assert!(!d.passes_var("X_OPTS", "--header=bearer abc"));
        assert!(d.passes_var("X_OPTS", "--verbose"));
    }

    #[test]
    fn persisted_policy_round_trips_and_bad_files_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("env-policy.json");
        assert_eq!(load_persisted(&path), None);
        let policy = EnvPolicy {
            pass_secrets: false,
            mode: FilterMode::Strict,
            allow: vec!["MY_*".into()],
        };
        save_persisted(&path, &policy).unwrap();
        assert_eq!(load_persisted(&path), Some(policy));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_persisted(&path), None);
    }

    #[test]
    fn child_commands_get_exactly_the_filtered_environment() {
        let strict = EnvPolicy {
            mode: FilterMode::Strict,
            ..EnvPolicy::default()
        };
        let cmd = command_with(&strict, "x");
        assert_eq!(
            tokio::process::Command::from(command_with(&strict, "x"))
                .as_std()
                .get_envs()
                .count(),
            cmd.get_envs().count()
        );
        let envs: Vec<_> = cmd.get_envs().collect();
        // env_clear + explicit set: nothing removed-by-omission inherits.
        assert!(envs.iter().all(|(_, v)| v.is_some()));
        let expected = strict.inherited();
        assert_eq!(envs.len(), expected.iter().count());
        assert!(envs
            .iter()
            .all(|(k, _)| strict.passes(&k.to_string_lossy())));
    }
}
