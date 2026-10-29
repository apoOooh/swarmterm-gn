//! Admin policy (corporate lock-down): values an administrator sets under
//! `HKLM\Software\Policies\SwarmtermGN` (GPO/Intune) or, weaker,
//! `HKCU\Software\Policies\SwarmtermGN`. Read ONCE at startup and immutable
//! afterwards, so nothing the renderer or an agent does can loosen it while
//! the app runs. Every lock is enforced in Rust at the point of action; the
//! renderer only greys controls out (`policy_get`).
//!
//! The parse step is a pure function over a value map so it is testable
//! without touching the registry. A later `corp` build reuses `combine` to
//! OR compiled-in locks with the registry ones.

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
const FLAGS: &[(&str, fn(&mut AdminPolicy) -> &mut bool)] = &[
    ("DisableBypassModes", |p| &mut p.disable_bypass_modes),
    ("DisableWarRoomExecute", |p| &mut p.disable_war_room_execute),
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
}

/// Lock names for `AdminPolicy::check`; the string is the registry value
/// name so the refusal tells the admin exactly which value caused it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lock {
    BypassModes,
    WarRoomExecute,
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
                other => {
                    warnings.push(format!("{canon}: expected REG_DWORD 0 or 1, got {other:?}"))
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
                other => warnings.push(format!(
                    "EnvPolicy: expected REG_SZ \"default\" or \"strict\", got {other:?}"
                )),
            }
        } else if name.eq_ignore_ascii_case("EnvAllow") {
            match value {
                RegValue::MultiSz(list) => p.env_allow.extend(
                    list.iter()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                ),
                other => warnings.push(format!("EnvAllow: expected REG_MULTI_SZ, got {other:?}")),
            }
        } else {
            warnings.push(format!("{name}: unknown policy value, ignored"));
        }
    }
    (p, warnings)
}

/// HKLM wins per value: HKCU is user-writable, so it may only add values
/// the machine policy does not set.
pub fn merge_hives(
    hklm: BTreeMap<String, RegValue>,
    hkcu: BTreeMap<String, RegValue>,
) -> BTreeMap<String, RegValue> {
    let mut out: BTreeMap<String, RegValue> = BTreeMap::new();
    for (k, v) in hkcu {
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
        for (_, field) in FLAGS {
            let theirs = *field(&mut other.clone());
            *field(&mut out) |= theirs;
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
        let mut out: Vec<&'static str> = FLAGS
            .iter()
            .filter(|(_, field)| *field(&mut self.clone()))
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
        let active = self.active();
        PolicyView {
            policy: self.clone(),
            locked: !active.is_empty(),
            active,
        }
    }

    pub fn is_locked(&self, lock: Lock) -> bool {
        match lock {
            Lock::BypassModes => self.disable_bypass_modes,
            Lock::WarRoomExecute => self.disable_war_room_execute,
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
        if self.is_locked(lock) {
            Err(format!(
                "{} disabled by your administrator (policy {}).",
                lock.what(),
                lock.value_name()
            ))
        } else {
            Ok(())
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
        if self.disable_war_room_execute {
            out.allow_war_room_execute = false;
        }
        if self.disable_bypass_modes {
            out.workers_inherit_bypass = false;
        }
        out
    }

    /// Refuses a pane launch line that switches an agent's own safety net
    /// off. The renderer appends launch-mode args to the template command,
    /// so checking the final line here also covers `worktree.spawn` workers,
    /// restores and hand-edited templates.
    pub fn check_launch_line(&self, line: &str) -> Result<(), String> {
        if !self.disable_bypass_modes {
            return Ok(());
        }
        match bypass_flag(line) {
            Some(flag) => Err(format!(
                "Launch refused: \"{flag}\" — {} (policy {}).",
                "bypass/YOLO launch modes are disabled by your administrator",
                Lock::BypassModes.value_name()
            )),
            None => Ok(()),
        }
    }
}

/// First token of `line` that starts an agent without its approval prompts
/// or sandbox. Mirrors the `dangerous` modes in `src/lib/templates.ts` plus
/// the CLIs' known aliases, so a hand-typed template cannot slip past.
pub fn bypass_flag(line: &str) -> Option<String> {
    let tokens: Vec<String> = line
        .split_whitespace()
        .map(|t| {
            t.trim_matches(|c| c == '"' || c == '\'')
                .to_ascii_lowercase()
        })
        .collect();
    for (i, t) in tokens.iter().enumerate() {
        let flag = t.split('=').next().unwrap_or(t);
        if flag.starts_with("--dangerously-")
            || flag.starts_with("--allow-dangerously-")
            || flag == "--yolo"
        {
            return Some(flag.to_string());
        }
        if flag == "--permission-mode" {
            let mode = match t.split_once('=') {
                Some((_, m)) => Some(m.to_string()),
                None => tokens.get(i + 1).cloned(),
            };
            if mode.as_deref() == Some("bypasspermissions") {
                return Some("--permission-mode bypassPermissions".into());
            }
        }
    }
    None
}

/// Read both hives once (HKLM wins per value) and log what is active and
/// what was ignored. A missing key is the normal, unmanaged case.
pub fn load() -> AdminPolicy {
    #[cfg(windows)]
    let values = merge_hives(
        registry::read(registry::Hive::LocalMachine, KEY),
        registry::read(registry::Hive::CurrentUser, KEY),
    );
    #[cfg(not(windows))]
    let values = BTreeMap::new();
    let (policy, warnings) = parse(&values);
    for w in &warnings {
        eprintln!("policy: {w}");
    }
    let active = policy.active();
    if !active.is_empty() {
        eprintln!("policy: active {}", active.join(", "));
    }
    policy
}

#[cfg(windows)]
pub mod registry {
    //! Raw value enumeration under one key. Kept separate from `parse` so
    //! tests never need the real registry.

    use std::collections::BTreeMap;

    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_DWORD, REG_MULTI_SZ, REG_SZ,
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
        buf.chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    pub fn decode(kind: u32, data: &[u8]) -> RegValue {
        match kind {
            REG_DWORD if data.len() == 4 => {
                RegValue::Dword(u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
            }
            REG_SZ => {
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
            let mut index = 0u32;
            loop {
                let mut name = vec![0u16; 256];
                let mut name_len = name.len() as u32;
                let mut kind = 0u32;
                let mut data = vec![0u8; MAX_DATA];
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
                index += 1;
                if rc == ERROR_NO_MORE_ITEMS {
                    break;
                }
                let name = String::from_utf16_lossy(&name[..(name_len as usize).min(name.len())]);
                if rc != ERROR_SUCCESS {
                    // ERROR_MORE_DATA (oversized value, or name > 255 chars):
                    // reported as unusable rather than aborting the scan.
                    out.insert(name, RegValue::Other);
                    continue;
                }
                let len = (data_len as usize).min(data.len());
                out.insert(name, decode(kind, &data[..len]));
            }
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
    fn invalid_and_unknown_values_are_ignored_with_a_warning() {
        let (p, w) = parse(&map(&[
            ("DisableMcp", RegValue::Dword(2)),
            ("DisableCompanion", RegValue::Sz("1".into())),
            ("EnvPolicy", RegValue::Sz("off".into())),
            ("EnvAllow", RegValue::Dword(1)),
            ("Whatever", RegValue::Dword(1)),
        ]));
        assert_eq!(p, AdminPolicy::default());
        assert_eq!(w.len(), 5, "{w:?}");
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
        ] {
            assert!(bypass_flag(line).is_some(), "{line}");
        }
        for line in [
            "claude --permission-mode default",
            "codex -s workspace-write -a on-request",
            "claude",
            "echo dangerously",
        ] {
            assert!(bypass_flag(line).is_none(), "{line}");
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
        use windows_sys::Win32::System::Registry::{REG_BINARY, REG_DWORD, REG_MULTI_SZ, REG_SZ};
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
        assert_eq!(registry::decode(REG_BINARY, &[1]), RegValue::Other);
        assert_eq!(registry::decode(REG_DWORD, &[1]), RegValue::Other);
    }
}
