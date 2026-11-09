//! The tools around the agent CLIs that a first run depends on (SWA-83),
//! for Settings → Setup and the setup assistant. Names and found locations
//! only; nothing is run, nothing is installed (decision 2026-11-09).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// `git`, `gitBash`, `winget`, `node`, `npm`, `python`.
    pub id: &'static str,
    /// Where it was found; `None` = not found.
    pub path: Option<String>,
}

/// Executables looked up on PATH, in display order. Git Bash is not one of
/// them: it has its own search (`git_bash`) and is passed in.
const ON_PATH: &[&str] = &["git", "winget", "node", "npm", "python"];

/// Windows ships `python.exe` as an App Execution Alias in `WindowsApps`
/// that only opens the Microsoft Store. That is "not installed".
fn is_store_stub(id: &str, path: &Path) -> bool {
    id == "python"
        && path
            .to_string_lossy()
            .to_lowercase()
            .replace('/', "\\")
            .contains("\\microsoft\\windowsapps\\")
}

pub fn scan(
    dirs: &[PathBuf],
    candidates: &dyn Fn(&str) -> Vec<String>,
    git_bash: Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<Tool> {
    let find = |id: &str| {
        let names = candidates(id);
        dirs.iter()
            .flat_map(|d| names.iter().map(move |n| d.join(n)))
            .find(|p| exists(p) && !is_store_stub(id, p))
            .map(|p| p.to_string_lossy().into_owned())
    };
    let mut out = Vec::with_capacity(ON_PATH.len() + 1);
    for id in ON_PATH {
        out.push(Tool { id, path: find(id) });
        if *id == "git" {
            out.push(Tool {
                id: "gitBash",
                path: git_bash.clone(),
            });
        }
    }
    out
}

/// The live scan over the refreshed PATH.
pub fn current(git_bash: Option<String>) -> Vec<Tool> {
    let path_var = crate::runtime_path::current();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    let pathext = std::env::var("PATHEXT").unwrap_or_default();
    scan(
        &dirs,
        &|id| crate::agents::candidates(id, &pathext, cfg!(windows)),
        git_bash,
        // `winget.exe` is an App Execution Alias (a reparse point that
        // `metadata` cannot follow), so a link that exists counts too.
        &|p| p.is_file() || p.symlink_metadata().is_ok(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe(id: &str) -> Vec<String> {
        vec![format!("{id}.exe"), format!("{id}.cmd")]
    }

    #[test]
    fn lists_every_tool_in_order_with_git_bash_after_git() {
        let dirs = vec![PathBuf::from("C:/Git/cmd"), PathBuf::from("C:/node")];
        let present = ["C:/Git/cmd/git.exe", "C:/node/node.exe", "C:/node/npm.cmd"];
        let tools = scan(&dirs, &exe, Some("C:/Git/bin/bash.exe".into()), &|p| {
            present.contains(&p.to_string_lossy().replace('\\', "/").as_str())
        });
        let ids: Vec<_> = tools.iter().map(|t| t.id).collect();
        assert_eq!(ids, ["git", "gitBash", "winget", "node", "npm", "python"]);
        let found: Vec<_> = tools.iter().map(|t| t.path.is_some()).collect();
        assert_eq!(found, [true, true, false, true, true, false]);
        assert!(tools[4].path.as_deref().unwrap().ends_with("npm.cmd"));
    }

    #[test]
    fn the_store_python_stub_is_not_python() {
        let dirs = vec![
            PathBuf::from(r"C:\Users\dev\AppData\Local\Microsoft\WindowsApps"),
            PathBuf::from(r"C:\Python313"),
        ];
        let stub_only = scan(&dirs, &exe, None, &|p| {
            p.to_string_lossy().contains("WindowsApps")
        });
        assert_eq!(stub_only.last().unwrap().path, None);
        let real = scan(&dirs, &exe, None, &|_| true);
        assert!(real
            .last()
            .unwrap()
            .path
            .as_deref()
            .unwrap()
            .starts_with(r"C:\Python313"));
        // winget lives there for real and is found.
        assert!(real[2].path.as_deref().unwrap().contains("WindowsApps"));
    }
}
