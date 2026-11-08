//! Host panes a restarted app has not taken over yet (SWA-56).
//!
//! The set is fixed at the boot connection: whatever the host holds then
//! survived the previous app instance. It is never recomputed as "host list
//! minus the app's map" — a same-id respawn removes the old generation from
//! the map before the host has processed its `kill`, and a recomputed set
//! would then offer that dying generation for attach instead of letting the
//! new `create` through. An entry only leaves when it is attached, closed
//! (keep/release/expiry) or reported gone by the host.
//!
//! Who decides what to close: the renderer, once it has loaded the saved
//! workspaces (`keep` = every pane id they reference). A pane no snapshot
//! knows can never be shown again. If the renderer never reports, `expire`
//! closes everything, so detached panes cannot keep the host from idling
//! out forever.
//!
//! Several hosts can hold detached panes (SWA-82: after an update the old
//! host keeps its panes, the new one takes new panes), so every entry
//! remembers the data dir of its host.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPane {
    pub terminal_id: String,
    pub spawn_id: String,
    pub pid: Option<u32>,
    pub cwd: String,
    /// `create`'s meta: agentId, worktreeMode, repoRoot, claudeConfigDir.
    pub meta: Value,
    /// Data dir of the host that runs it (app side only).
    #[serde(skip)]
    pub host: PathBuf,
}

impl DetachedPane {
    fn from_info(v: &Value, host: &Path) -> Option<Self> {
        Some(DetachedPane {
            terminal_id: v["terminalId"].as_str()?.to_string(),
            spawn_id: v["spawnId"].as_str()?.to_string(),
            pid: v["pid"].as_u64().map(|p| p as u32),
            cwd: v["cwd"].as_str().unwrap_or("").to_string(),
            meta: v["meta"].clone(),
            host: host.to_path_buf(),
        })
    }
}

#[derive(Default)]
pub struct Detached {
    panes: HashMap<String, DetachedPane>,
    settled: bool,
}

impl Detached {
    /// From the boot connection's `list`.
    #[cfg(test)]
    pub fn from_list(list: &[Value]) -> Self {
        let mut d = Detached::default();
        d.add(list, Path::new("h"));
        d
    }

    /// Add one host's boot `list`. Returns the ids another host already
    /// holds: ids are unique per app instance, so a second copy can only be
    /// a leftover, and the caller closes it on `host`.
    pub fn add(&mut self, list: &[Value], host: &Path) -> Vec<String> {
        let mut dupes = Vec::new();
        for p in list.iter().filter_map(|v| DetachedPane::from_info(v, host)) {
            if self.panes.contains_key(&p.terminal_id) {
                dupes.push(p.terminal_id);
            } else {
                self.panes.insert(p.terminal_id.clone(), p);
            }
        }
        dupes
    }

    /// Whether any detached pane runs on the host with this data dir.
    pub fn any_on(&self, host: &Path) -> bool {
        self.panes.values().any(|p| p.host == host)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.panes.contains_key(id)
    }

    pub fn list(&self) -> Vec<DetachedPane> {
        let mut out: Vec<_> = self.panes.values().cloned().collect();
        out.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        out
    }

    /// Hand the pane to `create_terminal` for attach. Single use: a later
    /// create with the same id spawns a new generation.
    pub fn take(&mut self, id: &str) -> Option<DetachedPane> {
        self.panes.remove(id)
    }

    /// The host reported this generation removed or exited.
    pub fn gone(&mut self, id: &str, spawn_id: &str) {
        if self.panes.get(id).is_some_and(|p| p.spawn_id == spawn_id) {
            self.panes.remove(id);
        }
    }

    /// The renderer's verdict: `ids` may still be opened. Returns the panes
    /// to close.
    pub fn keep(&mut self, ids: &HashSet<String>) -> Vec<DetachedPane> {
        self.settled = true;
        let close: Vec<String> = self
            .panes
            .keys()
            .filter(|id| !ids.contains(*id))
            .cloned()
            .collect();
        close.iter().filter_map(|id| self.panes.remove(id)).collect()
    }

    /// A saved workspace was forgotten: its panes can never be opened.
    pub fn release(&mut self, ids: &[String]) -> Vec<DetachedPane> {
        ids.iter().filter_map(|id| self.panes.remove(id)).collect()
    }

    /// No verdict in time: close everything still detached.
    pub fn expire(&mut self) -> Vec<DetachedPane> {
        if self.settled {
            return Vec::new();
        }
        self.settled = true;
        self.panes.drain().map(|(_, p)| p).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(id: &str, spawn: &str) -> Value {
        json!({"terminalId": id, "spawnId": spawn, "pid": 7, "cwd": "C:\\w",
               "meta": {"agentId": "claude"}, "cols": 80, "rows": 24, "outputTotal": 0})
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn ids(panes: Vec<DetachedPane>) -> Vec<String> {
        let mut v: Vec<String> = panes.into_iter().map(|p| p.terminal_id).collect();
        v.sort();
        v
    }

    #[test]
    fn boot_list_becomes_the_detached_set() {
        let d = Detached::from_list(&[info("b", "g2"), info("a", "g1"), json!({"bad": 1})]);
        let l = d.list();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].terminal_id, "a");
        assert_eq!(l[0].meta["agentId"], "claude");
        assert_eq!(l[0].pid, Some(7));
    }

    #[test]
    fn take_is_single_use_so_a_respawn_creates_a_new_generation() {
        let mut d = Detached::from_list(&[info("a", "g1")]);
        assert_eq!(d.take("a").map(|p| p.spawn_id), Some("g1".into()));
        // Respawn of the attached pane (kill, then create with the same id):
        // the dying generation must not be offered again.
        assert!(d.take("a").is_none());
        assert!(!d.contains("a"));
    }

    #[test]
    fn only_the_listed_generation_is_removed_when_gone() {
        let mut d = Detached::from_list(&[info("a", "g1")]);
        d.gone("a", "other");
        assert!(d.contains("a"));
        d.gone("a", "g1");
        assert!(!d.contains("a"));
    }

    #[test]
    fn keep_closes_what_no_snapshot_references() {
        let mut d = Detached::from_list(&[info("a", "g1"), info("b", "g2")]);
        assert_eq!(ids(d.keep(&set(&["a", "zzz"]))), vec!["b".to_string()]);
        assert!(d.contains("a"));
        // A verdict was given: the expiry no longer closes anything.
        assert!(d.expire().is_empty());
        assert!(d.contains("a"));
    }

    #[test]
    fn release_closes_a_forgotten_workspace_s_panes() {
        let mut d = Detached::from_list(&[info("a", "g1"), info("b", "g2")]);
        assert_eq!(ids(d.release(&["b".into(), "x".into()])), vec!["b".to_string()]);
        assert_eq!(d.list().len(), 1);
    }

    #[test]
    fn without_a_verdict_everything_expires() {
        let mut d = Detached::from_list(&[info("a", "g1"), info("b", "g2")]);
        assert_eq!(ids(d.expire()), vec!["a".to_string(), "b".to_string()]);
        assert!(d.list().is_empty());
    }

    #[test]
    fn panes_of_several_hosts_remember_their_host() {
        let mut d = Detached::default();
        assert!(d.add(&[info("a", "g1")], Path::new("old")).is_empty());
        // The same id on a second host is a leftover the caller closes.
        assert_eq!(
            d.add(&[info("b", "g2"), info("a", "g9")], Path::new("new")),
            vec!["a".to_string()]
        );
        assert_eq!(d.take("a").map(|p| p.host), Some(PathBuf::from("old")));
        assert!(d.any_on(Path::new("new")));
        assert!(!d.any_on(Path::new("old")));
        let closed = d.keep(&set(&[]));
        assert_eq!(closed[0].host, PathBuf::from("new"));
        assert!(!d.any_on(Path::new("new")));
    }
}
