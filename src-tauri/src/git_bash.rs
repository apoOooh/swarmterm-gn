//! Where Git Bash lives, found the way Claude Code needs it (SWA-83 1c).
//!
//! Claude Code on Windows runs hook and status-line commands through Git
//! Bash. Without it, it falls back to PowerShell, where our hook command line
//! fails on every event (V1), also in Claude sessions outside Swarmterm. So
//! the setup only writes those entries once this search finds a Bash, and a
//! Claude pane gets `CLAUDE_CODE_GIT_BASH_PATH` whenever Claude Code's own,
//! narrower search would miss it.
//!
//! Never the bare `bash.exe` from PATH: on most machines that is the WSL
//! launcher in System32, which runs a Linux shell that cannot start a
//! Windows `.exe` by its `C:/…` path.

use std::path::{Path, PathBuf};

/// Which rule found Bash. Only `GitInPath` (and the user's own override) is
/// something Claude Code finds by itself; the others need the variable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// `CLAUDE_CODE_GIT_BASH_PATH`, set by the user.
    Override,
    /// `HKLM`/`HKCU\SOFTWARE\GitForWindows`, value `InstallPath`.
    Registry,
    /// `<git.exe in PATH>\..\..\bin\bash.exe`.
    GitInPath,
    /// `%ProgramFiles%\Git` or `%LOCALAPPDATA%\Programs\Git`.
    Standard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub source: Source,
}

impl Found {
    /// Whether a Claude pane must be told where Bash is.
    pub fn needs_env(&self) -> bool {
        matches!(self.source, Source::Registry | Source::Standard)
    }
}

/// Everything the search reads, so the rules are testable without a
/// registry or a real disk.
pub struct Inputs<'a> {
    /// `CLAUDE_CODE_GIT_BASH_PATH` values in precedence order (the app's
    /// environment, then the `env` block of Claude's `settings.json`).
    pub overrides: Vec<String>,
    /// Git for Windows install roots from the registry, HKLM first.
    pub install_roots: Vec<PathBuf>,
    /// The PATH to look for `git.exe` in.
    pub path_var: &'a str,
    /// `%ProgramFiles%` and `%LOCALAPPDATA%`, when set.
    pub program_files: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub exists: &'a dyn Fn(&Path) -> bool,
}

fn bash_in(root: &Path) -> PathBuf {
    root.join("bin").join("bash.exe")
}

pub fn locate(i: &Inputs) -> Option<Found> {
    let found = |path: PathBuf, source| Found { path, source };
    for value in &i.overrides {
        let path = PathBuf::from(value.trim().trim_matches('"'));
        if !value.trim().is_empty() && (i.exists)(&path) {
            return Some(found(path, Source::Override));
        }
    }
    if let Some(path) = i
        .install_roots
        .iter()
        .map(|r| bash_in(r))
        .find(|p| (i.exists)(p))
    {
        return Some(found(path, Source::Registry));
    }
    if let Some(path) = crate::shell::find_in_path_with(i.path_var, "git.exe", i.exists)
        .and_then(|git| crate::shell::git_bash_from_git_exe(&git))
        .filter(|p| (i.exists)(p))
    {
        return Some(found(path, Source::GitInPath));
    }
    let standard = [
        i.program_files.as_ref().map(|d| d.join("Git")),
        i.local_app_data
            .as_ref()
            .map(|d| d.join("Programs").join("Git")),
    ];
    standard
        .into_iter()
        .flatten()
        .map(|root| bash_in(&root))
        .find(|p| (i.exists)(p))
        .map(|p| found(p, Source::Standard))
}

/// Whether hooks depend on Git Bash at all: only Claude Code on Windows runs
/// them through it.
pub const REQUIRED: bool = cfg!(windows);

/// The `CLAUDE_CODE_GIT_BASH_PATH` a Claude pane gets: only when Claude
/// Code's own search would miss Bash, and never over a value the user set.
pub fn pane_value(found: Option<&Found>, user_value: Option<&str>) -> Option<String> {
    if user_value.is_some_and(|v| !v.trim().is_empty()) {
        return None;
    }
    found
        .filter(|f| f.needs_env())
        .map(|f| f.path.to_string_lossy().into_owned())
}

/// The `CLAUDE_CODE_GIT_BASH_PATH` value from a Claude `settings.json` text.
pub fn override_from_settings(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value
        .get("env")?
        .get("CLAUDE_CODE_GIT_BASH_PATH")?
        .as_str()
        .map(str::to_string)
}

/// The live search: app environment, the default Claude profile's
/// `settings.json`, registry, refreshed PATH, standard folders. `None` off
/// Windows.
#[cfg(windows)]
pub fn find(claude_config_dir: Option<&Path>) -> Option<Found> {
    let mut overrides: Vec<String> = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
        .ok()
        .into_iter()
        .collect();
    if let Some(text) =
        claude_config_dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
    {
        overrides.extend(override_from_settings(&text));
    }
    let path_var = crate::runtime_path::current();
    locate(&Inputs {
        overrides,
        install_roots: registry_install_roots(),
        path_var: &path_var,
        program_files: std::env::var_os("ProgramFiles").map(PathBuf::from),
        local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        exists: &|p| p.is_file(),
    })
}

#[cfg(not(windows))]
pub fn find(_claude_config_dir: Option<&Path>) -> Option<Found> {
    None
}

/// `InstallPath` is a *named* value of `SOFTWARE\GitForWindows` (the old
/// probe read it as a subkey and never found it, V2).
#[cfg(windows)]
fn registry_install_roots() -> Vec<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .filter_map(|root| {
            crate::runtime_path::registry::string(root, r"SOFTWARE\GitForWindows", "InstallPath")
        })
        .map(|(value, _)| PathBuf::from(value))
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs(present: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| {
            let p = p.to_string_lossy().replace('\\', "/");
            present.iter().any(|q| *q == p)
        }
    }

    fn inputs<'a>(path_var: &'a str, exists: &'a dyn Fn(&Path) -> bool) -> Inputs<'a> {
        Inputs {
            overrides: vec![],
            install_roots: vec![],
            path_var,
            program_files: Some(PathBuf::from("C:/Program Files")),
            local_app_data: Some(PathBuf::from("C:/Users/dev/AppData/Local")),
            exists,
        }
    }

    #[test]
    fn the_registry_install_path_wins_over_path_and_needs_the_variable() {
        let exists = fs(&[
            "D:/Tools/Git/bin/bash.exe",
            "C:/Program Files/Git/bin/bash.exe",
        ]);
        let mut i = inputs("", &exists);
        i.install_roots = vec![PathBuf::from("D:/Tools/Git")];
        let found = locate(&i).unwrap();
        assert_eq!(found.source, Source::Registry);
        assert!(found.path.ends_with("bin/bash.exe"));
        assert!(found.path.starts_with("D:/Tools/Git"));
        assert!(found.needs_env());
    }

    #[test]
    fn git_in_path_is_found_and_needs_nothing() {
        let exists = fs(&["E:/Git/cmd/git.exe", "E:/Git/bin/bash.exe"]);
        let found = locate(&inputs("E:/Git/cmd", &exists)).unwrap();
        assert_eq!(found.source, Source::GitInPath);
        assert!(!found.needs_env());
    }

    #[test]
    fn standard_folders_are_the_last_resort() {
        let exists = fs(&["C:/Users/dev/AppData/Local/Programs/Git/bin/bash.exe"]);
        let found = locate(&inputs("", &exists)).unwrap();
        assert_eq!(found.source, Source::Standard);
        assert!(found.needs_env());
    }

    #[test]
    fn the_wsl_bash_in_system32_is_never_taken() {
        let exists = fs(&["C:/Windows/System32/bash.exe"]);
        assert_eq!(locate(&inputs("C:/Windows/System32", &exists)), None);
    }

    #[test]
    fn a_user_override_counts_only_when_the_file_exists() {
        let exists = fs(&["F:/my/bash.exe", "C:/Program Files/Git/bin/bash.exe"]);
        let mut i = inputs("", &exists);
        i.overrides = vec!["F:/gone/bash.exe".into(), "\"F:/my/bash.exe\"".into()];
        let found = locate(&i).unwrap();
        assert_eq!(found.source, Source::Override);
        assert!(!found.needs_env());
        i.overrides = vec!["F:/gone/bash.exe".into()];
        assert_eq!(locate(&i).unwrap().source, Source::Standard);
    }

    #[test]
    fn a_registry_root_without_bash_falls_through() {
        let exists = fs(&["C:/Program Files/Git/bin/bash.exe"]);
        let mut i = inputs("", &exists);
        i.install_roots = vec![PathBuf::from("D:/Removed/Git")];
        assert_eq!(locate(&i).unwrap().source, Source::Standard);
    }

    #[test]
    fn panes_get_the_variable_only_when_claude_would_miss_bash() {
        let at = |source| Found {
            path: PathBuf::from("D:/Git/bin/bash.exe"),
            source,
        };
        assert_eq!(
            pane_value(Some(&at(Source::Registry)), None).as_deref(),
            Some("D:/Git/bin/bash.exe")
        );
        assert_eq!(
            pane_value(Some(&at(Source::Standard)), Some("  ")).as_deref(),
            Some("D:/Git/bin/bash.exe")
        );
        assert_eq!(pane_value(Some(&at(Source::GitInPath)), None), None);
        assert_eq!(pane_value(Some(&at(Source::Override)), None), None);
        assert_eq!(
            pane_value(Some(&at(Source::Registry)), Some("E:/mine/bash.exe")),
            None
        );
        assert_eq!(pane_value(None, None), None);
    }

    #[test]
    fn reads_the_override_from_settings_env() {
        let text = r#"{"env":{"CLAUDE_CODE_GIT_BASH_PATH":"D:/Git/bin/bash.exe"}}"#;
        assert_eq!(
            override_from_settings(text).as_deref(),
            Some("D:/Git/bin/bash.exe")
        );
        assert_eq!(override_from_settings("{}"), None);
        assert_eq!(override_from_settings("not json"), None);
    }
}
