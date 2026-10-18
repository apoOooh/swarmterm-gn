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

    #[test]
    fn inherited_carries_the_process_environment() {
        // Every Windows process has SystemRoot; a host-spawned shell without
        // it starts broken, which is why the plan must be complete.
        #[cfg(windows)]
        assert!(EnvPlan::inherited().get("SystemRoot").is_some());
        #[cfg(not(windows))]
        assert!(EnvPlan::inherited().get("PATH").is_some());
    }
}
