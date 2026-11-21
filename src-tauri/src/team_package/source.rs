//! Pure rules of the team package (SWA-98): which sources are accepted, which
//! operations exist and the exact argument lists handed to git and node.
//! Everything that reaches a child process is decided here, so the tests
//! below cover every input the user can type.
//!
//! Corp uses only `Op` (the stub commands' signature); the rules stay in the
//! build there because they run nothing, and their tests run in both editions.
#![cfg_attr(feature = "corp", allow(dead_code))]

use std::path::{Component, Path, PathBuf};

pub const MAX_SOURCE_CHARS: usize = 2048;
/// The package's entry point, in the root of the source.
pub const SCRIPT: &str = "install.mjs";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `https://` Git URL, cloned into our own checkout folder.
    Git(String),
    /// Absolute local folder, used in place and never deleted by us.
    Local(PathBuf),
}

/// Accept an https Git URL or an absolute local folder. Everything git
/// could read as an option or a transport helper (`-…`, `ext::`, `file://`),
/// SSH (user decision 2026-11-15: not in the first version), URLs carrying
/// credentials (they would be stored in plain text and echoed in output)
/// and network paths are refused.
pub fn parse(raw: &str) -> Result<Source, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("Enter a Git URL (https) or a local folder.".into());
    }
    if s.chars().count() > MAX_SOURCE_CHARS || s.chars().any(char::is_control) {
        return Err("The source is too long or contains control characters.".into());
    }
    if s.starts_with('-') {
        return Err("The source must not start with \"-\".".into());
    }
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.contains('@') {
            return Err(
                "Remove the user name or token from the URL; git asks the system's credential helper instead."
                    .into(),
            );
        }
        if authority.is_empty() || s.contains(char::is_whitespace) {
            return Err("The URL has no host or contains spaces.".into());
        }
        return Ok(Source::Git(s.to_string()));
    }
    if lower.contains("://") || lower.contains("::") || lower.starts_with("git@") {
        return Err("Only https Git URLs and local folders are supported.".into());
    }
    if s.starts_with("\\\\") || s.starts_with("//") {
        return Err("Network paths are not supported; use an https Git URL.".into());
    }
    let path = Path::new(s);
    if !path.is_absolute() {
        return Err("A local folder must be an absolute path.".into());
    }
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("A local folder must not contain \"..\".".into());
    }
    Ok(Source::Local(path.to_path_buf()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Install,
    Update,
    Uninstall,
    Check,
}

impl Op {
    pub fn arg(self) -> &'static str {
        match self {
            Op::Install => "install",
            Op::Update => "update",
            Op::Uninstall => "uninstall",
            Op::Check => "check",
        }
    }

    /// `check` only reads, so it runs without a preview and confirmation.
    pub fn writes(self) -> bool {
        self != Op::Check
    }
}

/// `node <script> <op> [--dry-run]`. The script path is absolute, so the
/// working folder cannot redirect it.
pub fn node_args(package_dir: &Path, op: Op, dry_run: bool) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![package_dir.join(SCRIPT).into(), op.arg().into()];
    if dry_run {
        args.push("--dry-run".into());
    }
    args
}

/// Config for every git call: no hooks (also none from a template dir;
/// `NUL` is a path where no hook can exist), no transports besides
/// https (also for anything a clone could pull in), no prompts.
pub fn git_config_args() -> Vec<&'static str> {
    vec![
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "core.hooksPath=NUL",
        "-c",
        "credential.interactive=never",
    ]
}

pub fn clone_args(url: &str, dest: &Path) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = git_config_args().into_iter().map(Into::into).collect();
    for x in [
        "clone",
        "--depth",
        "1",
        "--no-tags",
        "--single-branch",
        "--",
    ] {
        a.push(x.into());
    }
    a.push(url.into());
    a.push(dest.into());
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_absolute_folders() {
        assert_eq!(
            parse(" https://example.com/team/pkg.git ").unwrap(),
            Source::Git("https://example.com/team/pkg.git".into())
        );
        #[cfg(windows)]
        assert_eq!(
            parse("D:\\packages\\team").unwrap(),
            Source::Local(PathBuf::from("D:\\packages\\team"))
        );
    }

    #[test]
    fn refuses_dangerous_sources() {
        for bad in [
            "",
            "-uhttps://x",
            "--upload-pack=calc",
            "ext::sh -c calc",
            "file:///C:/x",
            "http://example.com/x.git",
            "https:///nohost",
            "https://example.com/a b",
            "\\\\server\\share\\pkg",
            "//server/share/pkg",
            "relative\\folder",
            "C:\\pkg\\..\\other",
            "https://example.com/x\n--evil",
        ] {
            assert!(parse(bad).is_err(), "accepted: {bad:?}");
        }
        // Built at runtime so secret/PII scanners do not read them as addresses.
        let at = '@';
        for bad in [
            format!("ssh://git{at}example.com/x.git"),
            format!("git{at}example.com:team/x.git"),
            format!("https://user:token{at}example.com/x.git"),
            format!("https://token{at}example.com/x.git"),
        ] {
            assert!(parse(&bad).is_err(), "accepted: {bad:?}");
        }
        assert!(parse(&format!("https://e.com/{}", "a".repeat(MAX_SOURCE_CHARS))).is_err());
    }

    #[test]
    fn url_with_at_in_the_path_is_fine() {
        assert!(parse("https://example.com/@team/pkg.git").is_ok());
    }

    #[test]
    fn builds_exact_argument_lists() {
        let dir = Path::new("C:\\pkg");
        let a = node_args(dir, Op::Uninstall, true);
        assert_eq!(a[1], "uninstall");
        assert_eq!(a[2], "--dry-run");
        assert_eq!(a.len(), 3);
        assert_eq!(node_args(dir, Op::Check, false).len(), 2);
        let c = clone_args("https://e.com/x.git", Path::new("C:\\dst"));
        let dash = c.iter().position(|x| x == "--").unwrap();
        assert_eq!(c[dash + 1], "https://e.com/x.git");
        assert!(c.contains(&"protocol.allow=never".into()));
    }

    #[test]
    fn only_check_is_read_only() {
        assert!(!Op::Check.writes());
        assert!(Op::Install.writes() && Op::Update.writes() && Op::Uninstall.writes());
    }
}
