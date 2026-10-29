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
                // Fail closed: the filter is forced on in its default mode.
                other => {
                    p.env_policy = Some(FilterMode::Default);
                    warnings.push(format!(
                        "EnvPolicy: expected REG_SZ \"default\" or \"strict\", got {other:?}; treated as \"default\""
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
/// rather than locks, so HKCU's is dropped whenever HKLM forces the filter
/// (`EnvPolicy`); otherwise a user could pass `*` past the machine lock.
pub fn merge_hives(
    hklm: BTreeMap<String, RegValue>,
    hkcu: BTreeMap<String, RegValue>,
) -> BTreeMap<String, RegValue> {
    let hklm_env_lock = hklm.keys().any(|k| k.eq_ignore_ascii_case("EnvPolicy"));
    let mut out: BTreeMap<String, RegValue> = BTreeMap::new();
    for (k, v) in hkcu {
        if hklm_env_lock && k.eq_ignore_ascii_case("EnvAllow") {
            eprintln!("policy: HKCU EnvAllow ignored, HKLM sets EnvPolicy");
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
    /// off. The renderer appends launch-mode args to the template command,
    /// so checking the final line here also covers `worktree.spawn` workers,
    /// restores and hand-edited templates.
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

/// First token of `line` that starts an agent without its approval prompts
/// or sandbox. Mirrors the `dangerous` modes in `src/lib/templates.ts` plus
/// the known equivalents of Claude Code, Codex and Gemini-style CLIs. A
/// denylist: a flag a CLI adds later is not covered until it is listed here.
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
        if flag == "-y" {
            return Some(flag.to_string());
        }
        // Option + value pairs, as `--opt value` or `--opt=value`.
        let value = || match t.split_once('=') {
            Some((_, v)) => Some(v.to_string()),
            None => tokens.get(i + 1).cloned(),
        };
        let bad = match flag {
            "--permission-mode" => value().as_deref() == Some("bypasspermissions"),
            "-s" | "--sandbox" => value().as_deref() == Some("danger-full-access"),
            "-a" | "--ask-for-approval" => value().as_deref() == Some("never"),
            "--approval-mode" => value().as_deref() == Some("yolo"),
            _ => false,
        };
        if bad {
            return Some(format!("{flag} {}", value().unwrap_or_default()));
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
            let mut name = vec![0u16; 256];
            let mut data = vec![0u8; MAX_DATA];
            loop {
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
        assert_eq!(p.env_policy, Some(FilterMode::Default));
        assert!(p.env_allow.is_empty());
        assert_eq!(w.len(), 6, "{w:?}");
    }

    #[test]
    fn hkcu_env_allow_cannot_widen_an_hklm_env_lock() {
        let merged = merge_hives(
            map(&[("EnvPolicy", RegValue::Sz("strict".into()))]),
            map(&[("EnvAllow", RegValue::MultiSz(vec!["*".into()]))]),
        );
        let (p, _) = parse(&merged);
        assert!(p.env_allow.is_empty());
        // Without an HKLM lock, HKCU may still add names.
        let merged = merge_hives(
            BTreeMap::new(),
            map(&[("EnvAllow", RegValue::MultiSz(vec!["X".into()]))]),
        );
        assert_eq!(parse(&merged).0.env_allow, vec!["X"]);
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
