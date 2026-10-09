use super::path::{canonical, display, within};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Serialize)]
pub struct Status {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
}
fn command(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("--no-optional-locks").arg("-C").arg(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
pub fn status(root: &Path) -> Result<Vec<Status>, String> {
    let top = command(root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| e.to_string())?;
    if !top.status.success() {
        return Ok(vec![]);
    }
    let git_root = canonical(Path::new(String::from_utf8_lossy(&top.stdout).trim()))?;
    let out = command(root)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(parse(&out.stdout, root, &git_root))
}
fn parse(bytes: &[u8], root: &Path, git_root: &Path) -> Vec<Status> {
    let mut records = bytes.split(|b| *b == 0);
    let mut statuses = vec![];
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let xy = &record[..2];
        let name = String::from_utf8_lossy(&record[3..]);
        let path = git_root.join(PathBuf::from(name.as_ref()));
        if xy.contains(&b'R') || xy.contains(&b'C') {
            let _ = records.next();
        }
        if !within(root, &path) {
            continue;
        }
        let status = if xy.contains(&b'U') || xy == b"AA" || xy == b"DD" {
            "U"
        } else if xy == b"??" {
            "?"
        } else if xy.contains(&b'D') {
            "D"
        } else if xy.contains(&b'R') {
            "R"
        } else if xy.contains(&b'A') {
            "A"
        } else {
            "M"
        };
        if let Ok(relative) = path.strip_prefix(root) {
            statuses.push(Status {
                path: display(relative),
                status: status.into(),
                added: 0,
                removed: 0,
            });
        }
    }
    statuses
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_nul_names_renames_conflicts_and_root_scope() {
        let t = tempfile::tempdir().unwrap();
        let git = canonical(t.path()).unwrap();
        let root = git.join("src");
        let bytes = b" M src/a space.txt\0R  src/new.txt\0src/old.txt\0UU src/conflict.txt\0?? src/new folder/file.txt\0 M outside.txt\0";
        let statuses = parse(bytes, &root, &git);
        assert_eq!(statuses.len(), 4);
        assert_eq!(statuses[0].path, "a space.txt");
        assert_eq!(statuses[1].status, "R");
        assert_eq!(statuses[2].status, "U");
        assert_eq!(statuses[3].status, "?");
    }
}
