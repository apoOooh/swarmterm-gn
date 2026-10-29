//! Admin policy (corporate lock-down): values an administrator sets under
//! `HKLM\Software\Policies\SwarmtermGN` (GPO/Intune) or, weaker,
//! `HKCU\Software\Policies\SwarmtermGN`. Read ONCE at startup and immutable
//! afterwards, so nothing the renderer or an agent does can loosen it while
//! the app runs. Every lock is enforced in Rust at the point of action; the
//! renderer only greys controls out (`policy_get`).
//!
//! The parse step is a pure function over a value map so it is testable
//! without touching the registry. The `corp` build (Cargo feature `corp`,
//! `docs/editions.md`) ORs its compiled-in locks with the registry ones via
//! `combine`, so a registry value can add locks but never lift one.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::terminal_env::{EnvPolicy, FilterMode};

/// Policy key below HKLM / HKCU (the standard `Software\Policies` hive that
/// ordinary users cannot write under HKLM).
pub const KEY: &str = "Software\\Policies\\SwarmtermGN";

/// One registry value as read; types we do not use become `Other` so they
/// are reported instead of misread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegValue {
    Dword(u32),
    Sz(String),
    MultiSz(Vec<String>),
    Other,
}

/// Field names are in lockstep with `src/lib/policy.ts` (camelCase).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminPolicy {
    pub disable_bypass_modes: bool,
    pub disable_war_room_execute: bool,
    pub disable_war_room: bool,
    pub disable_worktree_spawn: bool,
    pub disable_mcp: bool,
    pub disable_companion: bool,
    pub disable_model_download: bool,
    pub disable_routine_commands: bool,
    pub disable_preview_browser: bool,
    /// `Some` = the environment filter is forced on with at least this mode.
    pub env_policy: Option<FilterMode>,
    /// Extra names that always pass the filter (admin's allow list).
    pub env_allow: Vec<String>,
}

/// The boolean locks, by registry value name. One table drives parsing,
/// the "active policies" list and the refusal messages.
type FlagField = fn(&mut AdminPolicy) -> &mut bool;

const FLAGS: &[(&str, FlagField)] = &[
    ("DisableBypassModes", |p| &mut p.disable_bypass_modes),
    ("DisableWarRoomExecute", |p| &mut p.disable_war_room_execute),
    ("DisableWarRoom", |p| &mut p.disable_war_room),
    ("DisableWorktreeSpawn", |p| &mut p.disable_worktree_spawn),
    ("DisableMcp", |p| &mut p.disable_mcp),
    ("DisableCompanion", |p| &mut p.disable_companion),
    ("DisableModelDownload", |p| &mut p.disable_model_download),
    ("DisableRoutineCommands", |p| {
        &mut p.disable_routine_commands
    }),
    ("DisablePreviewBrowser", |p| &mut p.disable_preview_browser),
];

/// What `policy_get` returns: the policy plus the active value names, so the
/// renderer can list them without knowing the registry table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    #[serde(flatten)]
    pub policy: AdminPolicy,
    /// True when any value is set (Settings shows the "managed" section).
    pub locked: bool,
    pub active: Vec<&'static str>,
    /// `"standard"` or `"corp"`: which edition this binary was built as.
    pub edition: &'static str,
    /// Value names locked by the edition itself (compiled in), so Settings
    /// can tell "built into this edition" from "set by your administrator".
    pub built_in: Vec<&'static str>,
}

/// The edition this binary was built as. Fixed at compile time so no
/// registry value, setting or file can turn a corp build back into the
/// standard one.
pub const EDITION: Edition = if cfg!(feature = "corp") {
    Edition::Corp
} else {
    Edition::Standard
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edition {
    Standard,
    Corp,
}

impl Edition {
    pub fn id(self) -> &'static str {
        match self {
            Edition::Standard => "standard",
            Edition::Corp => "corp",
        }
    }

    /// Product name shown in the window title and in refusals.
    pub fn product_name(self) -> &'static str {
        match self {
            Edition::Standard => "Swarmterm GN",
            Edition::Corp => "Swarmterm GN Corp",
        }
    }

    /// Locks an edition carries without any registry key. Corp locks what
    /// infosec rejected: agents switching their own safety net off or
    /// driving other panes, third-party binaries fetched at runtime
    /// (buzzkey, whisper models), and an unfiltered environment. Routines,
    /// worktree spawn, the preview and MCP stay available but lockable by
    /// policy: they are core workflow and run only what the user starts.
    pub fn locks(self) -> AdminPolicy {
        match self {
            Edition::Standard => AdminPolicy::default(),
            Edition::Corp => AdminPolicy {
                disable_bypass_modes: true,
                disable_war_room_execute: true,
                disable_companion: true,
                disable_model_download: true,
                env_policy: Some(FilterMode::Default),
                ..Default::default()
            },
        }
    }
}

/// Lock names for `AdminPolicy::check`; the string is the registry value
/// name so the refusal tells the admin exactly which value caused it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lock {
    BypassModes,
    WarRoomExecute,
    WarRoom,
    WorktreeSpawn,
    Mcp,
    Companion,
    ModelDownload,
    RoutineCommands,
    PreviewBrowser,
}

impl Lock {
    fn value_name(self) -> &'static str {
        match self {
            Lock::BypassModes => "DisableBypassModes",
            Lock::WarRoomExecute => "DisableWarRoomExecute",
            Lock::WarRoom => "DisableWarRoom",
            Lock::WorktreeSpawn => "DisableWorktreeSpawn",
            Lock::Mcp => "DisableMcp",
            Lock::Companion => "DisableCompanion",
            Lock::ModelDownload => "DisableModelDownload",
            Lock::RoutineCommands => "DisableRoutineCommands",
            Lock::PreviewBrowser => "DisablePreviewBrowser",
        }
    }

    fn what(self) -> &'static str {
        match self {
            Lock::BypassModes => "Bypass/YOLO launch modes are",
            Lock::WarRoomExecute => "War Room execute is",
            Lock::WarRoom => "The War Room is",
            Lock::WorktreeSpawn => "worktree.spawn is",
            Lock::Mcp => "The Swarmterm MCP server is",
            Lock::Companion => "The voice companion (buzzkey) install and update are",
            Lock::ModelDownload => "Speech model downloads are",
            Lock::RoutineCommands => "Command routines are",
            Lock::PreviewBrowser => "The web preview is",
        }
    }
}

/// Parse a merged value map. Names are matched case-insensitively (the
/// registry is case-insensitive too). Returns the policy plus one line per
/// ignored value, which the caller logs.
pub fn parse(values: &BTreeMap<String, RegValue>) -> (AdminPolicy, Vec<String>) {
    let mut p = AdminPolicy::default();
    let mut warnings = Vec::new();
    for (name, value) in values {
        if let Some((canon, field)) = FLAGS.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            match value {
                RegValue::Dword(1) => *field(&mut p) = true,
                RegValue::Dword(0) => {}
                // Fail closed: an admin who set this name meant to lock it,
                // so a wrong type or unreadable value must not unlock it.
                other => {
                    *field(&mut p) = true;
                    warnings.push(format!(
                        "{canon}: expected REG_DWORD 0 or 1, got {other:?}; treated as 1"
                    ));
                }
            }
        } else if name.eq_ignore_ascii_case("EnvPolicy") {
            match value {
                RegValue::Sz(s) if s.trim().eq_ignore_ascii_case("default") => {
                    p.env_policy = Some(FilterMode::Default)
                }
                RegValue::Sz(s) if s.trim().eq_ignore_ascii_case("strict") => {
                    p.env_policy = Some(FilterMode::Strict)
                }
                // Fail closed: an admin who set this name meant to lock the
                // filter, and a value we cannot read (wrong type, typo)
                // gets the strictest mode rather than the lenient one.
                other => {
                    p.env_policy = Some(FilterMode::Strict);
                    warnings.push(format!(
                        "EnvPolicy: expected REG_SZ \"default\" or \"strict\", got {other:?}; treated as \"strict\""
                    ));
                }
            }
        } else if name.eq_ignore_ascii_case("EnvAllow") {
            match value {
                RegValue::MultiSz(list) => p.env_allow.extend(
                    list.iter()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                ),
                // A single name typed as REG_SZ is the common admin slip;
                // read it as a one-item list.
                RegValue::Sz(s) if !s.trim().is_empty() => p.env_allow.push(s.trim().to_string()),
                other => warnings.push(format!("EnvAllow: expected REG_MULTI_SZ, got {other:?}")),
            }
        } else {
            warnings.push(format!("{name}: unknown policy value, ignored"));
        }
    }
    (p, warnings)
}

/// HKLM wins per value: HKCU may be user-writable, so it may only add values
/// the machine policy does not set. `EnvAllow` is the one value that widens
/// rather than locks, so HKCU's is dropped whenever the filter is locked:
/// HKLM sets `EnvPolicy`, or the edition locks it (`edition_env_lock`, Corp);
/// otherwise a user could widen the filter past the lock.
pub fn merge_hives(
    hklm: BTreeMap<String, RegValue>,
    hkcu: BTreeMap<String, RegValue>,
    edition_env_lock: bool,
) -> BTreeMap<String, RegValue> {
    let env_lock = edition_env_lock || hklm.keys().any(|k| k.eq_ignore_ascii_case("EnvPolicy"));
    let mut out: BTreeMap<String, RegValue> = BTreeMap::new();
    for (k, v) in hkcu {
        if env_lock && k.eq_ignore_ascii_case("EnvAllow") {
            eprintln!("policy: HKCU EnvAllow ignored, the env filter is locked");
            continue;
        }
        out.insert(k.to_ascii_lowercase(), v);
    }
    for (k, v) in hklm {
        out.insert(k.to_ascii_lowercase(), v);
    }
    out
}

impl AdminPolicy {
    /// Locks from two sources (e.g. compiled-in corp defaults + registry):
    /// a lock set by either stays set; the stricter env mode wins.
    pub fn combine(&self, other: &AdminPolicy) -> AdminPolicy {
        let mut out = self.clone();
        // FLAGS hands out `&mut` accessors, so read `other` through one copy.
        let mut theirs = other.clone();
        for (_, field) in FLAGS {
            let on = *field(&mut theirs);
            *field(&mut out) |= on;
        }
        out.env_policy = match (self.env_policy, other.env_policy) {
            (Some(FilterMode::Strict), _) | (_, Some(FilterMode::Strict)) => {
                Some(FilterMode::Strict)
            }
            (a, b) => a.or(b),
        };
        for name in &other.env_allow {
            if !out.env_allow.contains(name) {
                out.env_allow.push(name.clone());
            }
        }
        out
    }

    /// Registry value names of the active policies, for logs and Settings.
    pub fn active(&self) -> Vec<&'static str> {
        let mut copy = self.clone();
        let mut out: Vec<&'static str> = FLAGS
            .iter()
            .filter(|(_, field)| *field(&mut copy))
            .map(|(n, _)| *n)
            .collect();
        if self.env_policy.is_some() {
            out.push("EnvPolicy");
        }
        if !self.env_allow.is_empty() {
            out.push("EnvAllow");
        }
        out
    }

    pub fn view(&self) -> PolicyView {
        self.view_for(EDITION)
    }

    /// `view` for a given edition (pure, so both editions are testable from
    /// one build).
    pub fn view_for(&self, edition: Edition) -> PolicyView {
        let active = self.active();
        PolicyView {
            policy: self.clone(),
            locked: !active.is_empty(),
            active,
            edition: edition.id(),
            built_in: edition.locks().active(),
        }
    }

    pub fn is_locked(&self, lock: Lock) -> bool {
        match lock {
            Lock::BypassModes => self.disable_bypass_modes,
            Lock::WarRoomExecute => self.disable_war_room_execute,
            Lock::WarRoom => self.disable_war_room,
            Lock::WorktreeSpawn => self.disable_worktree_spawn,
            Lock::Mcp => self.disable_mcp,
            Lock::Companion => self.disable_companion,
            Lock::ModelDownload => self.disable_model_download,
            Lock::RoutineCommands => self.disable_routine_commands,
            Lock::PreviewBrowser => self.disable_preview_browser,
        }
    }

    /// `Err` with a message naming the registry value when `lock` is set.
    pub fn check(&self, lock: Lock) -> Result<(), String> {
        self.check_for(EDITION, lock)
    }

    /// `check` for a given edition. A lock the edition carries is reported
    /// as such: telling a corp user to ask their administrator about
    /// something no registry value can lift would send them in circles.
    pub fn check_for(&self, edition: Edition, lock: Lock) -> Result<(), String> {
        if !self.is_locked(lock) {
            Ok(())
        } else if edition.locks().is_locked(lock) {
            Err(format!(
                "{} not available in {} (built-in policy {}).",
                lock.what(),
                edition.product_name(),
                lock.value_name()
            ))
        } else {
            Err(format!(
                "{} disabled by your administrator (policy {}).",
                lock.what(),
                lock.value_name()
            ))
        }
    }

    /// The effective env filter: the user's choice, tightened by the policy.
    /// With `EnvPolicy` set the filter cannot be switched off, the mode is at
    /// least the admin's, and the user's own allow list is dropped (a user
    /// `*` entry would otherwise pass every secret). `EnvAllow` is always
    /// merged in.
    pub fn apply_env(&self, user: EnvPolicy) -> EnvPolicy {
        let mut out = user;
        if let Some(mode) = self.env_policy {
            out.pass_secrets = false;
            if mode == FilterMode::Strict {
                out.mode = FilterMode::Strict;
            }
            out.allow.clear();
        }
        for name in &self.env_allow {
            if !out.allow.iter().any(|a| a.eq_ignore_ascii_case(name)) {
                out.allow.push(name.clone());
            }
        }
        out
    }

    /// The effective agent policy: a lock can only switch permissions off.
    pub fn apply_agent(
        &self,
        user: crate::agent_policy::AgentPolicy,
    ) -> crate::agent_policy::AgentPolicy {
        let mut out = user;
        if self.disable_war_room_execute || self.disable_war_room {
            out.allow_war_room_execute = false;
        }
        if self.disable_bypass_modes {
            out.workers_inherit_bypass = false;
        }
        out
    }

    /// Refuses a pane launch line that switches an agent's own safety net
    /// off. `line` is the agent command plus its launch-mode args (the
    /// renderer passes it apart from a worker's task brief, see
    /// `pty::launch_line_to_check`), so prose in a brief is never parsed as
    /// flags. A guard against mistakes and stale settings, not a sandbox: a
    /// hand-edited or obfuscated template can still evade it.
    pub fn check_launch_line(&self, line: &str) -> Result<(), String> {
        if !self.disable_bypass_modes {
            return Ok(());
        }
        match bypass_flag(line) {
            // Same wording as `check`, so a corp build names the edition
            // instead of an administrator.
            Some(flag) => Err(format!(
                "Launch refused: \"{flag}\" — {}",
                self.check(Lock::BypassModes).unwrap_err()
            )),
            None => Ok(()),
        }
    }
}

/// The quoting family of a pane's shell; mirrors `shellFlavor` in
/// `src/lib/agent-spawn-command.ts` (the renderer quotes a worker's brief
/// for it, `pty::launch_line_to_check` re-derives that quoting).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellFlavor {
    Posix,
    PowerShell,
    Cmd,
}

impl ShellFlavor {
    pub const ALL: [ShellFlavor; 3] = [Self::Posix, Self::PowerShell, Self::Cmd];

    /// `shell_id` as `pty` resolves it: `None` (default or unavailable
    /// shell) is the platform default, PowerShell on Windows.
    pub fn from_shell_id(shell_id: Option<&str>) -> Self {
        match shell_id {
            Some("git-bash" | "wsl" | "zsh" | "bash" | "fish") => Self::Posix,
            Some("powershell" | "pwsh") => Self::PowerShell,
            Some("cmd") => Self::Cmd,
            _ if cfg!(windows) => Self::PowerShell,
            _ => Self::Posix,
        }
    }
}

/// PowerShell's tokenizer accepts all of these as single / double quotes.
const PS_SINGLE: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];
const PS_DOUBLE: [char; 4] = ['"', '\u{201C}', '\u{201D}', '\u{201E}'];

/// Splits a typed command line into words the way `flavor`'s shell does:
/// - POSIX: `'...'` literal, `"..."` with `\` escaping `"`, `\`, `$` and a
///   backtick, `\x` outside quotes is `x`.
/// - PowerShell: every single-quote character (doubling escapes), the
///   double-quote characters (doubling or a backtick escapes), backtick
///   escapes outside quotes too.
/// - cmd: only `"` groups, `^x` outside quotes is `x`.
///
/// Adjacent parts join into one word. Variable expansion, globbing and
/// PowerShell's `--%` are not modelled: this feeds a mistake guard, which
/// also checks a plain whitespace split (`plain_words`).
pub(crate) fn shell_words_in(line: &str, flavor: ShellFlavor) -> Vec<String> {
    #[derive(PartialEq)]
    enum Q {
        None,
        Single,
        Double,
    }
    let is_single = |c: char| match flavor {
        ShellFlavor::Posix => c == '\'',
        ShellFlavor::PowerShell => PS_SINGLE.contains(&c),
        ShellFlavor::Cmd => false,
    };
    let is_double = |c: char| match flavor {
        ShellFlavor::PowerShell => PS_DOUBLE.contains(&c),
        _ => c == '"',
    };
    let escape = match flavor {
        ShellFlavor::Posix => '\\',
        ShellFlavor::PowerShell => '`',
        ShellFlavor::Cmd => '^',
    };
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut q = Q::None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match q {
            Q::None if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            Q::None => {
                in_word = true;
                if c == escape {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                } else if is_single(c) {
                    q = Q::Single;
                } else if is_double(c) {
                    q = Q::Double;
                } else {
                    cur.push(c);
                }
            }
            // PowerShell: two quote characters in a row are one literal.
            Q::Single if is_single(c) => match chars.peek() {
                Some(&n) if flavor == ShellFlavor::PowerShell && is_single(n) => {
                    cur.push(n);
                    chars.next();
                }
                _ => q = Q::None,
            },
            Q::Single => cur.push(c),
            Q::Double if is_double(c) => match chars.peek() {
                Some(&n) if flavor == ShellFlavor::PowerShell && is_double(n) => {
                    cur.push(n);
                    chars.next();
                }
                _ => q = Q::None,
            },
            Q::Double if c == escape && flavor != ShellFlavor::Cmd => match chars.peek() {
                Some(&n) if flavor == ShellFlavor::PowerShell || "\"\\$`".contains(n) => {
                    cur.push(n);
                    chars.next();
                }
                _ => cur.push(c),
            },
            Q::Double => cur.push(c),
        }
    }
    if in_word {
        words.push(cur);
    }
    words
}

/// Whitespace-separated tokens with every quote, backtick and caret removed:
/// whatever a shell's quoting does, a flag it passes on as its own argument
/// sits between whitespace here too. Catches lines where `shell_words_in`
/// and the real shell disagree, at the price of false positives in prose.
fn plain_words(line: &str) -> Vec<String> {
    line.split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| !PS_SINGLE.contains(c) && !PS_DOUBLE.contains(c) && !"`^".contains(*c))
                .collect::<String>()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// The renderer's quoting of a worker brief, `quoteForShell` in
/// `src/lib/agent-spawn-command.ts`, byte for byte.
pub(crate) fn quote_for_shell(text: &str, flavor: ShellFlavor) -> String {
    match flavor {
        ShellFlavor::Posix => {
            let mut out = String::from("'");
            for c in text.chars() {
                if c == '\\' || c == '\'' {
                    out.push_str("'\\");
                    out.push(c);
                    out.push('\'');
                } else {
                    out.push(c);
                }
            }
            out.push('\'');
            out
        }
        ShellFlavor::PowerShell => {
            let mut out = String::from("'");
            for c in text.chars() {
                out.push(c);
                if PS_SINGLE.contains(&c) {
                    out.push(c);
                }
            }
            out.push('\'');
            out
        }
        ShellFlavor::Cmd => text
            .replace('"', "'")
            .split('%')
            .map(|part| {
                let body = part.trim_end_matches('\\');
                let quoted = if body.is_empty() {
                    String::new()
                } else {
                    format!("\"{body}\"")
                };
                quoted + &part[body.len()..]
            })
            .collect::<Vec<_>>()
            .join("^%"),
    }
}

/// Program name of a command word: file name, lower case, no `.exe`/`.cmd`
/// and no npm `@version` (`@google/gemini-cli@latest` is `gemini-cli`).
fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let base = base.split('@').next().unwrap_or(base).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base
}

/// First word of `line` that starts an agent without its approval prompts
/// or sandbox (or, for Claude's Auto mode, with per-action prompts handed to
/// its classifier). Mirrors the `dangerous` modes in `src/lib/templates.ts`
/// plus the known equivalents of the supported CLIs. The line is split the
/// way each shell family would and as plain whitespace tokens; any split
/// that shows a flag counts, since the guard cannot know which one the real
/// shell matches. A denylist and a guard against mistakes, not a sandbox: a
/// flag a CLI adds later, a settings file passed by path, an alias or an
/// obfuscated line are not covered.
pub fn bypass_flag(line: &str) -> Option<String> {
    ShellFlavor::ALL
        .iter()
        .map(|f| shell_words_in(line, *f))
        .chain(std::iter::once(plain_words(line)))
        .find_map(|words| bypass_in_words(&words))
}

fn bypass_in_words(words: &[String]) -> Option<String> {
    let words: Vec<String> = words.iter().map(|w| w.to_ascii_lowercase()).collect();
    // The agent may sit behind a launcher (`npx gemini`, `& 'C:\..\gemini.exe'`,
    // `cmd /c gemini`, `npx --yes --package=@google/gemini-cli gemini`), so look at
    // the first few
    // words, not only the first.
    let program = words
        .iter()
        .take(6)
        .map(|w| program_name(w))
        .find_map(|p| match p.as_str() {
            "gemini" | "gemini-cli" => Some("gemini"),
            "qwen" | "qwen-code" => Some("qwen"),
            "cursor-agent" => Some("cursor-agent"),
            _ => None,
        })
        .unwrap_or_default();
    for (i, t) in words.iter().enumerate() {
        let (flag, inline) = match t.split_once('=') {
            // Codex `-ckey=value`: the value attached to the short flag.
            // Codex `-anever`, `-sdanger-full-access` likewise.
            _ if t.len() > 2 && ["-c", "-a", "-s"].iter().any(|f| t.starts_with(f)) => {
                (&t[..2], Some(t[2..].trim_start_matches('=')))
            }
            Some((f, v)) if f.starts_with('-') => (f, Some(v)),
            _ => (t.as_str(), None),
        };
        if flag.starts_with("--dangerously-")
            || flag.starts_with("--allow-dangerously-")
            || flag == "--yolo"
            // Copilot CLI: approve every tool without asking.
            || flag == "--allow-all-tools"
            || flag == "--allow-all"
        {
            return Some(flag.to_string());
        }
        // Short/generic flags only mean bypass for specific agents; `-y` is
        // also npx's "yes" and `-f` is everyone's "force".
        let agent_flag = match program {
            "gemini" | "qwen" => flag == "-y",
            "cursor-agent" => flag == "-f" || flag == "--force",
            _ => false,
        };
        if agent_flag {
            return Some(flag.to_string());
        }
        // Option + value pairs, as `--opt value` or `--opt=value`.
        let value = inline
            .map(str::to_string)
            .or_else(|| words.get(i + 1).cloned())
            .unwrap_or_default();
        let bad = match flag {
            "--permission-mode" => matches!(value.as_str(), "bypasspermissions" | "auto"),
            "-s" | "--sandbox" => value == "danger-full-access",
            "-a" | "--ask-for-approval" => value == "never",
            "--approval-mode" => value == "yolo",
            // Codex config overrides: `-c key=value`, value maybe quoted.
            "-c" | "--config" => {
                let kv: String = value
                    .chars()
                    .filter(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
                    .collect();
                kv == "approval_policy=never" || kv == "sandbox_mode=danger-full-access"
            }
            // Claude: inline settings JSON that switches the default mode.
            "--settings" => {
                let json: String = value.chars().filter(|c| !c.is_whitespace()).collect();
                json.contains("\"defaultmode\":\"bypasspermissions\"")
                    || json.contains("\"defaultmode\":\"auto\"")
            }
            _ => false,
        };
        if bad {
            return Some(format!("{flag} {value}"));
        }
    }
    None
}

/// Locks compiled into the binary. Empty for the standard build; the `corp`
/// build fills it so its defaults hold even without any registry key.
fn compiled_in() -> AdminPolicy {
    EDITION.locks()
}

/// Read both hives once (HKLM wins per value), add the compiled-in locks and
/// log what is active and what was ignored. A missing key is the normal,
/// unmanaged case.
pub fn load() -> AdminPolicy {
    #[cfg(windows)]
    let values = merge_hives(
        registry::read(registry::Hive::LocalMachine, KEY),
        registry::read(registry::Hive::CurrentUser, KEY),
        compiled_in().env_policy.is_some(),
    );
    #[cfg(not(windows))]
    let values = BTreeMap::new();
    let (registry, warnings) = parse(&values);
    let policy = compiled_in().combine(&registry);
    for w in &warnings {
        eprintln!("policy: {w}");
    }
    let active = policy.active();
    if !active.is_empty() {
        eprintln!(
            "policy: {} edition, active {}",
            EDITION.id(),
            active.join(", ")
        );
    }
    policy
}

#[cfg(windows)]
pub mod registry {
    //! Raw value enumeration under one key. Kept separate from `parse` so
    //! tests never need the real registry.

    use std::collections::BTreeMap;

    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
    };

    use super::RegValue;

    #[derive(Debug, Clone, Copy)]
    pub enum Hive {
        LocalMachine,
        CurrentUser,
    }

    /// Policy values are short; larger data is not ours and reads as `Other`.
    const MAX_DATA: usize = 64 * 1024;

    fn utf16(buf: &[u8]) -> Vec<u16> {
        buf.as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect()
    }

    pub fn decode(kind: u32, data: &[u8]) -> RegValue {
        match kind {
            REG_DWORD if data.len() == 4 => {
                RegValue::Dword(u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
            }
            // EXPAND_SZ is read verbatim (no expansion): policy values never
            // contain `%VAR%`, and an admin tool may write either type.
            REG_SZ | REG_EXPAND_SZ => {
                let w = utf16(data);
                let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
                RegValue::Sz(String::from_utf16_lossy(&w[..end]))
            }
            REG_MULTI_SZ => RegValue::MultiSz(
                utf16(data)
                    .split(|&c| c == 0)
                    .filter(|s| !s.is_empty())
                    .map(String::from_utf16_lossy)
                    .collect(),
            ),
            _ => RegValue::Other,
        }
    }

    /// One `RegEnumValueW` result, so `scan` can be tested with a fake.
    pub enum Entry {
        Value(String, RegValue),
        /// ERROR_MORE_DATA: the value (> 64 KiB) or its name (> 255 chars)
        /// is not one of ours; recorded as unusable, so a policy name fails
        /// closed, and the scan goes on.
        TooLarge(String),
        End,
        /// Any other error: stop, never retry the same or the next index
        /// blindly (that looped forever on a persistent error).
        Failed(u32),
    }

    /// Upper bound on values read under the policy key; ours has about a
    /// dozen.
    pub const MAX_VALUES: u32 = 1024;

    /// Enumerate indices from 0 until the end, an error, or `MAX_VALUES`.
    pub fn scan(mut at: impl FnMut(u32) -> Entry) -> BTreeMap<String, RegValue> {
        let mut out = BTreeMap::new();
        for index in 0..MAX_VALUES {
            match at(index) {
                Entry::Value(name, value) => {
                    out.insert(name, value);
                }
                Entry::TooLarge(name) => {
                    out.insert(name, RegValue::Other);
                }
                Entry::End => break,
                Entry::Failed(rc) => {
                    eprintln!("policy: registry enumeration stopped at {index} (error {rc})");
                    // The unread rest may hold EnvPolicy: fail closed (an
                    // unreadable EnvPolicy parses as strict).
                    if !out.keys().any(|k| k.eq_ignore_ascii_case("EnvPolicy")) {
                        out.insert("EnvPolicy".into(), RegValue::Other);
                    }
                    break;
                }
            }
        }
        out
    }

    pub fn read(hive: Hive, key: &str) -> BTreeMap<String, RegValue> {
        let root = match hive {
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
            Hive::CurrentUser => HKEY_CURRENT_USER,
        };
        let mut out = BTreeMap::new();
        let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: plain Win32 registry calls with buffers we own and sizes we
        // pass; the handle is closed on every path below.
        unsafe {
            let mut hkey: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS {
                return out;
            }
            let mut name = vec![0u16; 256];
            let mut data = vec![0u8; MAX_DATA];
            out = scan(|index| {
                // In/out lengths: reset to the buffer sizes on every call.
                let mut name_len = name.len() as u32;
                let mut kind = 0u32;
                let mut data_len = data.len() as u32;
                let rc = RegEnumValueW(
                    hkey,
                    index,
                    name.as_mut_ptr(),
                    &mut name_len,
                    std::ptr::null(),
                    &mut kind,
                    data.as_mut_ptr(),
                    &mut data_len,
                );
                let text =
                    || String::from_utf16_lossy(&name[..(name_len as usize).min(name.len())]);
                match rc {
                    ERROR_SUCCESS => {
                        let len = (data_len as usize).min(data.len());
                        Entry::Value(text(), decode(kind, &data[..len]))
                    }
                    ERROR_MORE_DATA => Entry::TooLarge(text()),
                    ERROR_NO_MORE_ITEMS => Entry::End,
                    other => Entry::Failed(other),
                }
            });
            RegCloseKey(hkey);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, RegValue)]) -> BTreeMap<String, RegValue> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn empty_map_is_unmanaged() {
        let (p, w) = parse(&BTreeMap::new());
        assert_eq!(p, AdminPolicy::default());
        assert!(w.is_empty());
        assert!(p.active().is_empty());
    }

    #[test]
    fn every_flag_parses_from_dword_one_case_insensitively() {
        let entries: Vec<(&str, RegValue)> = FLAGS
            .iter()
            .map(|(n, _)| (*n, RegValue::Dword(1)))
            .collect();
        let (p, w) = parse(&map(&entries));
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(p.active().len(), FLAGS.len());
        let (p, _) = parse(&map(&[("disablemcp", RegValue::Dword(1))]));
        assert!(p.disable_mcp);
    }

    #[test]
    fn invalid_lock_values_fail_closed_and_others_are_ignored() {
        let (p, w) = parse(&map(&[
            ("DisableMcp", RegValue::Dword(2)),
            ("DisableCompanion", RegValue::Sz("1".into())),
            ("DisableRoutineCommands", RegValue::Other),
            ("EnvPolicy", RegValue::Sz("off".into())),
            ("EnvAllow", RegValue::Dword(1)),
            ("Whatever", RegValue::Dword(1)),
        ]));
        assert!(p.disable_mcp && p.disable_companion && p.disable_routine_commands);
        assert_eq!(p.env_policy, Some(FilterMode::Strict));
        assert!(p.env_allow.is_empty());
        assert_eq!(w.len(), 6, "{w:?}");
    }

    #[test]
    fn hkcu_env_allow_cannot_widen_an_hklm_env_lock() {
        let merged = merge_hives(
            map(&[("EnvPolicy", RegValue::Sz("strict".into()))]),
            map(&[("EnvAllow", RegValue::MultiSz(vec!["*".into()]))]),
            false,
        );
        let (p, _) = parse(&merged);
        assert!(p.env_allow.is_empty());
        // Without an HKLM lock, HKCU may still add names.
        let merged = merge_hives(
            BTreeMap::new(),
            map(&[("EnvAllow", RegValue::MultiSz(vec!["X".into()]))]),
            false,
        );
        assert_eq!(parse(&merged).0.env_allow, vec!["X"]);
    }

    #[test]
    fn hkcu_env_allow_cannot_widen_an_edition_env_lock() {
        // Corp locks the filter without any HKLM value.
        let hkcu = || map(&[("EnvAllow", RegValue::MultiSz(vec!["MY_KEY".into()]))]);
        let merged = merge_hives(
            BTreeMap::new(),
            hkcu(),
            Edition::Corp.locks().env_policy.is_some(),
        );
        assert!(parse(&merged).0.env_allow.is_empty());
        // HKLM's own EnvAllow still applies under the edition lock.
        let merged = merge_hives(
            map(&[("EnvAllow", RegValue::MultiSz(vec!["CORP_PROXY".into()]))]),
            hkcu(),
            true,
        );
        assert_eq!(parse(&merged).0.env_allow, vec!["CORP_PROXY"]);
    }

    #[test]
    fn env_policy_type_slips_fail_closed_and_env_allow_accepts_one_sz() {
        for bad in [
            RegValue::MultiSz(vec!["default".into()]),
            RegValue::Dword(0),
            RegValue::Other,
            RegValue::Sz("lenient".into()),
        ] {
            let (p, w) = parse(&map(&[("EnvPolicy", bad.clone())]));
            assert_eq!(p.env_policy, Some(FilterMode::Strict), "{bad:?}");
            assert_eq!(w.len(), 1);
        }
        let (p, w) = parse(&map(&[("EnvAllow", RegValue::Sz(" CORP_PROXY ".into()))]));
        assert_eq!(p.env_allow, vec!["CORP_PROXY"]);
        assert!(w.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn registry_scan_stops_on_errors_and_at_the_cap() {
        use registry::{scan, Entry, MAX_VALUES};
        // A persistent non-MORE_DATA error used to loop forever.
        let mut calls = 0;
        let out = scan(|i| {
            calls += 1;
            if i == 0 {
                Entry::Value("EnvPolicy".into(), RegValue::Sz("strict".into()))
            } else {
                Entry::Failed(5)
            }
        });
        assert_eq!(calls, 2);
        assert_eq!(out.len(), 1);
        // An error before EnvPolicy was read locks the filter (strict).
        let out = scan(|_| Entry::Failed(5));
        assert_eq!(out.get("EnvPolicy"), Some(&RegValue::Other));
        assert_eq!(parse(&out).0.env_policy, Some(FilterMode::Strict));
        // MORE_DATA records the name as unusable and goes on.
        let out = scan(|i| match i {
            0 => Entry::TooLarge("DisableMcp".into()),
            1 => Entry::Value("X".into(), RegValue::Dword(1)),
            _ => Entry::End,
        });
        assert_eq!(out.get("DisableMcp"), Some(&RegValue::Other));
        assert_eq!(out.len(), 2);
        // An enumerator that never ends is cut off.
        let mut calls = 0;
        scan(|i| {
            calls += 1;
            Entry::TooLarge(format!("v{i}"))
        });
        assert_eq!(calls, MAX_VALUES);
    }

    #[test]
    fn dword_zero_is_off_without_warning() {
        let (p, w) = parse(&map(&[("DisableMcp", RegValue::Dword(0))]));
        assert!(!p.disable_mcp);
        assert!(w.is_empty());
    }

    #[test]
    fn env_values_parse() {
        let (p, _) = parse(&map(&[
            ("EnvPolicy", RegValue::Sz(" Strict ".into())),
            (
                "EnvAllow",
                RegValue::MultiSz(vec!["CORP_PROXY".into(), " ".into(), "MY_*".into()]),
            ),
        ]));
        assert_eq!(p.env_policy, Some(FilterMode::Strict));
        assert_eq!(p.env_allow, vec!["CORP_PROXY", "MY_*"]);
        assert_eq!(p.active(), vec!["EnvPolicy", "EnvAllow"]);
    }

    #[test]
    fn hklm_wins_per_value_and_hkcu_fills_gaps() {
        let merged = merge_hives(
            map(&[("DisableMcp", RegValue::Dword(0))]),
            map(&[
                ("DISABLEMCP", RegValue::Dword(1)),
                ("DisableCompanion", RegValue::Dword(1)),
            ]),
            false,
        );
        let (p, _) = parse(&merged);
        assert!(!p.disable_mcp);
        assert!(p.disable_companion);
    }

    #[test]
    fn env_lock_cannot_be_loosened_by_the_user() {
        let admin = AdminPolicy {
            env_policy: Some(FilterMode::Default),
            env_allow: vec!["CORP_PROXY".into()],
            ..Default::default()
        };
        let user = EnvPolicy {
            pass_secrets: true,
            mode: FilterMode::Strict,
            allow: vec!["*".into()],
        };
        let eff = admin.apply_env(user);
        assert!(!eff.pass_secrets);
        // A stricter user choice survives a `default` lock.
        assert_eq!(eff.mode, FilterMode::Strict);
        assert_eq!(eff.allow, vec!["CORP_PROXY"]);

        let strict = AdminPolicy {
            env_policy: Some(FilterMode::Strict),
            ..Default::default()
        };
        assert_eq!(
            strict.apply_env(EnvPolicy::default()).mode,
            FilterMode::Strict
        );
    }

    #[test]
    fn env_allow_without_env_lock_merges_into_the_user_list() {
        let admin = AdminPolicy {
            env_allow: vec!["CORP_PROXY".into()],
            ..Default::default()
        };
        let user = EnvPolicy {
            pass_secrets: true,
            allow: vec!["corp_proxy".into(), "MINE".into()],
            ..Default::default()
        };
        let eff = admin.apply_env(user);
        assert!(eff.pass_secrets);
        assert_eq!(eff.allow, vec!["corp_proxy", "MINE"]);
    }

    #[test]
    fn unmanaged_policy_leaves_user_choices_alone() {
        let user = EnvPolicy {
            pass_secrets: true,
            ..Default::default()
        };
        assert_eq!(AdminPolicy::default().apply_env(user.clone()), user);
        let agent = crate::agent_policy::AgentPolicy {
            allow_war_room_execute: true,
            workers_inherit_bypass: true,
        };
        assert!(
            AdminPolicy::default()
                .apply_agent(agent)
                .allow_war_room_execute
        );
    }

    #[test]
    fn war_room_lock_overrides_the_user_allow() {
        let admin = AdminPolicy {
            disable_war_room_execute: true,
            ..Default::default()
        };
        let agent = crate::agent_policy::AgentPolicy {
            allow_war_room_execute: true,
            workers_inherit_bypass: true,
        };
        let eff = admin.apply_agent(agent.clone());
        assert!(!eff.allow_war_room_execute);
        assert!(eff.workers_inherit_bypass);
        let room_off = AdminPolicy {
            disable_war_room: true,
            ..Default::default()
        };
        assert!(!room_off.apply_agent(agent.clone()).allow_war_room_execute);
        let bypass = AdminPolicy {
            disable_bypass_modes: true,
            ..Default::default()
        };
        assert!(!bypass.apply_agent(agent).workers_inherit_bypass);
    }

    #[test]
    fn bypass_flags_are_detected() {
        for line in [
            "claude --dangerously-skip-permissions",
            "codex --dangerously-bypass-approvals-and-sandbox resume --last",
            "claude --allow-dangerously-skip-permissions",
            "claude --permission-mode bypassPermissions",
            "claude --permission-mode=bypassPermissions",
            "gemini --yolo",
            "claude \"--DANGEROUSLY-skip-permissions\"",
            "codex -s danger-full-access",
            "codex --sandbox=danger-full-access",
            "codex -a never",
            "codex --ask-for-approval never",
            "gemini -y",
            "qwen --approval-mode yolo",
            "claude --permission-mode=\"bypassPermissions\"",
            "claude --permission-mode auto",
            "copilot --allow-all-tools",
            "copilot --allow-all",
            "cursor-agent --force",
            "cursor-agent -f",
            r"C:/tools/cursor-agent.exe -f",
            "npx gemini -y",
            r"& 'C:\bin\qwen.exe' -y",
            "codex -c approval_policy=never",
            "codex -c 'approval_policy=\"never\"'",
            "codex --config sandbox_mode=danger-full-access",
            r#"claude --settings '{"permissions": {"defaultMode": "bypassPermissions"}}'"#,
            r#"claude --settings='{"permissions":{"defaultMode":"auto"}}'"#,
            "npx @google/gemini-cli -y",
            "npx @google/gemini-cli@latest -y",
            "npx @qwen-code/qwen-code -y",
            "codex -capproval_policy=never",
            "codex --config=approval_policy=never",
            "codex -anever",
            "codex -sdanger-full-access",
            "npx --yes --package=@google/gemini-cli gemini -y",
            // Lines a naive split reads as one quoted word (review 2026-10-29):
            // PowerShell closes on the curly quote, cmd has no single quotes,
            // bash escapes the inner double quote.
            "claude 'x\u{2019} --dangerously-skip-permissions \u{2019}'",
            "claude 'a --dangerously-skip-permissions",
            r#"claude "\"'" --dangerously-skip-permissions"#,
            "claude --dan'gerously-skip-permissions'",
        ] {
            assert!(bypass_flag(line).is_some(), "{line}");
        }
        for line in [
            "claude --permission-mode default",
            "codex -s workspace-write -a on-request",
            "codex -s read-only -a on-request",
            "gemini --approval-mode default",
            "claude",
            "echo dangerously",
            "npx -y create-vite",
            "rm -f build.log",
            "claude -y",
            "codex -c model=o3",
            r#"claude --settings '{"permissions":{"defaultMode":"plan"}}'"#,
        ] {
            assert!(bypass_flag(line).is_none(), "{line}");
        }
    }

    #[test]
    fn shell_words_follow_each_shell() {
        use ShellFlavor::*;
        let w = shell_words_in;
        // PowerShell: a curly quote closes a straight one; doubling escapes.
        assert_eq!(
            w("claude 'x\u{2019} --yolo \u{2019}'", PowerShell),
            ["claude", "x", "--yolo", ""]
        );
        assert_eq!(w("a 'it''s' \"q`\"x\"", PowerShell), ["a", "it's", "q\"x"]);
        // cmd: ' is a plain character, ^ escapes outside quotes.
        assert_eq!(w("claude 'a --yolo", Cmd), ["claude", "'a", "--yolo"]);
        assert_eq!(w("a \"b c\"^%\"d\"", Cmd), ["a", "b c%d"]);
        // POSIX: \" inside double quotes, '\'' escape.
        assert_eq!(
            w(r#"claude "\"'" --yolo"#, Posix),
            ["claude", "\"'", "--yolo"]
        );
        assert_eq!(w(r"x 'it'\''s'", Posix), ["x", "it's"]);
    }

    #[test]
    fn quoting_round_trips_through_each_split() {
        for text in [
            "plain",
            "it's ‘a’ ‚b‛ \\ end\\",
            "50% of %PATH% done",
            " --yolo leading",
        ] {
            for f in ShellFlavor::ALL {
                let q = quote_for_shell(text, f);
                let want = if f == ShellFlavor::Cmd {
                    text.replace('"', "'")
                } else {
                    text.to_string()
                };
                assert_eq!(shell_words_in(&q, f), [want], "{f:?} {q}");
            }
        }
    }

    #[test]
    fn launch_line_check_only_applies_when_locked() {
        let line = "claude --dangerously-skip-permissions";
        assert!(AdminPolicy::default().check_launch_line(line).is_ok());
        let admin = AdminPolicy {
            disable_bypass_modes: true,
            ..Default::default()
        };
        let err = admin.check_launch_line(line).unwrap_err();
        assert!(err.contains("DisableBypassModes"), "{err}");
        assert!(admin
            .check_launch_line("claude --permission-mode plan")
            .is_ok());
    }

    #[test]
    fn check_names_the_registry_value() {
        let admin = AdminPolicy {
            disable_preview_browser: true,
            ..Default::default()
        };
        assert!(admin.check(Lock::Mcp).is_ok());
        let view = admin.view();
        assert!(view.locked);
        assert_eq!(view.active, vec!["DisablePreviewBrowser"]);
        assert!(!AdminPolicy::default().view().locked);
        let err = admin.check(Lock::PreviewBrowser).unwrap_err();
        assert!(err.contains("DisablePreviewBrowser") && err.contains("administrator"));
    }

    #[test]
    fn disable_war_room_parses_and_locks_only_the_war_room() {
        let values: BTreeMap<String, RegValue> =
            [("DisableWarRoom".to_string(), RegValue::Dword(1))].into();
        let (p, _) = parse(&values);
        assert!(p.disable_war_room && !p.disable_war_room_execute);
        assert_eq!(p.active(), vec!["DisableWarRoom"]);
        let err = p.check(Lock::WarRoom).unwrap_err();
        assert!(err.contains("DisableWarRoom") && err.contains("War Room"));
        assert!(p.check(Lock::Mcp).is_ok());
    }

    #[test]
    fn corp_edition_locks_what_infosec_rejected() {
        let corp = Edition::Corp.locks();
        for lock in [
            Lock::BypassModes,
            Lock::WarRoomExecute,
            Lock::Companion,
            Lock::ModelDownload,
        ] {
            assert!(corp.is_locked(lock), "{lock:?}");
        }
        assert_eq!(corp.env_policy, Some(FilterMode::Default));
        // Core workflow stays available, lockable by the registry.
        for lock in [
            Lock::RoutineCommands,
            Lock::WorktreeSpawn,
            Lock::PreviewBrowser,
            Lock::Mcp,
            // Lockable by policy only (decision 2026-10-29).
            Lock::WarRoom,
        ] {
            assert!(!corp.is_locked(lock), "{lock:?}");
        }
        assert_eq!(Edition::Standard.locks(), AdminPolicy::default());
    }

    #[test]
    fn registry_can_tighten_but_never_loosen_corp_locks() {
        let registry = AdminPolicy {
            disable_preview_browser: true,
            env_policy: Some(FilterMode::Strict),
            ..Default::default()
        };
        let p = Edition::Corp.locks().combine(&registry);
        assert!(p.disable_preview_browser && p.disable_companion);
        assert_eq!(p.env_policy, Some(FilterMode::Strict));
        // An explicit 0 in the registry parses to "not set", which combine
        // cannot use to clear a compiled-in lock.
        let zero: BTreeMap<String, RegValue> =
            [("DisableCompanion".to_string(), RegValue::Dword(0))].into();
        let (unlocked, _) = parse(&zero);
        assert!(Edition::Corp.locks().combine(&unlocked).disable_companion);
    }

    #[test]
    fn corp_refusal_names_the_edition_not_the_administrator() {
        let p = Edition::Corp.locks().combine(&AdminPolicy {
            disable_mcp: true,
            ..Default::default()
        });
        let built_in = p.check_for(Edition::Corp, Lock::Companion).unwrap_err();
        assert!(built_in.contains("Swarmterm GN Corp") && built_in.contains("DisableCompanion"));
        assert!(!built_in.contains("administrator"));
        let admin = p.check_for(Edition::Corp, Lock::Mcp).unwrap_err();
        assert!(admin.contains("administrator"));
    }

    #[test]
    fn view_reports_edition_and_built_in_locks() {
        let corp = Edition::Corp.locks().view_for(Edition::Corp);
        assert_eq!(corp.edition, "corp");
        assert!(corp.locked);
        assert_eq!(
            corp.built_in,
            vec![
                "DisableBypassModes",
                "DisableWarRoomExecute",
                "DisableCompanion",
                "DisableModelDownload",
                "EnvPolicy"
            ]
        );
        let standard = AdminPolicy::default().view_for(Edition::Standard);
        assert_eq!(standard.edition, "standard");
        assert!(standard.built_in.is_empty() && !standard.locked);
        assert_eq!(compiled_in(), EDITION.locks());
    }

    #[test]
    fn combine_ors_locks_and_keeps_the_stricter_env_mode() {
        let a = AdminPolicy {
            disable_mcp: true,
            env_policy: Some(FilterMode::Default),
            env_allow: vec!["A".into()],
            ..Default::default()
        };
        let b = AdminPolicy {
            disable_companion: true,
            env_policy: Some(FilterMode::Strict),
            env_allow: vec!["A".into(), "B".into()],
            ..Default::default()
        };
        let c = a.combine(&b);
        assert!(c.disable_mcp && c.disable_companion);
        assert_eq!(c.env_policy, Some(FilterMode::Strict));
        assert_eq!(c.env_allow, vec!["A", "B"]);
    }

    #[cfg(windows)]
    #[test]
    fn decode_handles_registry_encodings() {
        use windows_sys::Win32::System::Registry::{
            REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
        };
        let enc = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect() };
        assert_eq!(
            registry::decode(REG_DWORD, &1u32.to_le_bytes()),
            RegValue::Dword(1)
        );
        assert_eq!(
            registry::decode(REG_SZ, &enc("strict\0")),
            RegValue::Sz("strict".into())
        );
        assert_eq!(
            registry::decode(REG_MULTI_SZ, &enc("A\0B\0\0")),
            RegValue::MultiSz(vec!["A".into(), "B".into()])
        );
        assert_eq!(
            registry::decode(REG_EXPAND_SZ, &enc("Strict ")),
            RegValue::Sz("Strict".into())
        );
        assert_eq!(registry::decode(REG_BINARY, &[1]), RegValue::Other);
        assert_eq!(registry::decode(REG_DWORD, &[1]), RegValue::Other);
    }
}
