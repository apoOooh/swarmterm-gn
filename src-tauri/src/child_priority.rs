//! Settings → Terminal → "Process priority" (ADR 0005).
//!
//! Enforcement lives in the panes' Job Objects (`swarmterm_host::priority`,
//! `swarmterm_host::job`): a priority-class limit the processes inside
//! cannot raise, a nested build job below the agent, and an optional CPU
//! cap. This module only holds the app's copy of the settings and forwards
//! them: to the in-process panes' registry here, and to the terminal host
//! (`set_priority`) for hosted panes, now and on every new connection.
//! There is no app-side poller any more: the old `SetPriorityClass` loop
//! raced fast starters and could be undone by the process itself.

#[cfg(windows)]
pub use swarmterm_host::priority::Settings;

/// Stand-in so the unsupported non-Windows build still compiles.
#[cfg(not(windows))]
pub type Settings = serde_json::Value;

/// Managed state. Starts at the defaults (strict) so panes spawned before the
/// renderer's first push are already limited.
pub struct ChildPriority {
    #[cfg(windows)]
    registry: std::sync::Arc<swarmterm_host::priority::Registry>,
    /// Serialises host forwards (`forward_to_host`): each one sends the
    /// latest settings under it, so the host always ends on the newest.
    forward: std::sync::Mutex<()>,
    /// A forward thread is queued and has not read the settings yet: a burst
    /// of changes then starts one thread, which sends the latest.
    forward_pending: std::sync::atomic::AtomicBool,
}

impl Default for ChildPriority {
    fn default() -> Self {
        Self {
            #[cfg(windows)]
            registry: swarmterm_host::priority::Registry::new(),
            forward: std::sync::Mutex::new(()),
            forward_pending: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl ChildPriority {
    /// Registry of the in-process panes' jobs.
    #[cfg(windows)]
    pub fn registry(&self) -> &std::sync::Arc<swarmterm_host::priority::Registry> {
        &self.registry
    }

    /// Current settings, sent to every new host connection.
    #[cfg(windows)]
    pub fn settings(&self) -> Settings {
        self.registry.settings()
    }

    #[cfg(windows)]
    pub fn set(&self, settings: Settings) {
        self.registry.set(settings);
    }

    #[cfg(not(windows))]
    pub fn set(&self, _settings: Settings) {}
}

/// Send the current settings to the terminal host on a worker thread: the
/// hub's client lock is held by a connect for up to several seconds (host
/// start, retries), and `child_priority_set` is a sync command on the main
/// thread, which must never wait for it.
#[cfg(windows)]
pub fn forward_to_host(app: tauri::AppHandle) {
    use tauri::Manager;
    if !app.state::<ChildPriority>().begin_forward() {
        return;
    }
    let pending_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("child-priority-forward".into())
        .spawn(move || {
            app.state::<ChildPriority>().run_forward(
                || app.state::<crate::host_client::HostHub>().current(),
                |c, s| c.conn.set_priority(s),
            );
        });
    if let Err(e) = spawned {
        eprintln!("[child-priority] forward thread failed to start: {e}");
        pending_app.state::<ChildPriority>().cancel_forward();
    }
}

#[cfg(windows)]
impl ChildPriority {
    /// True if a forward thread must be started; false while one is queued
    /// and has not read the settings yet (it will send the newest).
    fn begin_forward(&self) -> bool {
        !self
            .forward_pending
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }

    fn cancel_forward(&self) {
        self.forward_pending
            .store(false, std::sync::atomic::Ordering::Release);
    }

    /// Body of a forward thread: under the serialising lock, get the client
    /// (may wait for a connect), clear the pending flag, then send the
    /// settings current at that moment.
    fn run_forward<C>(&self, client: impl FnOnce() -> Option<C>, send: impl FnOnce(&C, &Settings)) {
        let _serial = self.forward.lock().unwrap_or_else(|e| e.into_inner());
        let client = client();
        // Cleared before reading: a change after this starts a new
        // forward, which sends after this one (`forward` serialises).
        self.cancel_forward();
        if let Some(c) = client {
            send(&c, &self.settings());
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::ChildPriority;
    use swarmterm_host::priority::{is_agent, Level, Mode, Settings, AGENT_EXES, AGENT_MARKERS};

    /// A burst of changes starts one forward, and it sends the newest
    /// settings; a change after it read them starts the next forward.
    #[test]
    fn forwards_coalesce_and_the_newest_settings_win() {
        let cp = ChildPriority::default();
        let s = |mode, cap| Settings {
            mode,
            pane_level: Level::BelowNormal,
            build_level: Level::Idle,
            cpu_cap: cap,
            exempt: Vec::new(),
        };
        cp.set(s(Mode::Strict, Some(50)));
        assert!(cp.begin_forward());
        cp.set(s(Mode::AgentNormal, Some(40)));
        assert!(!cp.begin_forward(), "queued forward must absorb the burst");
        cp.set(s(Mode::Off, Some(30)));
        assert!(!cp.begin_forward());
        let mut sent = Vec::new();
        cp.run_forward(|| Some(()), |_, st| sent.push(st.clone()));
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].mode, Mode::Off);
        assert_eq!(sent[0].cpu_cap, Some(30));
        // Read done: the next change needs (and gets) a new forward.
        assert!(cp.begin_forward());
        // No client (host off): nothing sent, flag still cleared.
        cp.run_forward(|| None::<()>, |_, _| panic!("no client"));
        assert!(cp.begin_forward());
    }

    /// The host cannot see the app's agent catalog; its copy must cover it.
    #[test]
    fn host_agent_list_covers_the_catalog() {
        for (id, exe) in crate::agents::AGENTS {
            assert!(AGENT_EXES.contains(exe), "{exe} missing in AGENT_EXES");
            for m in crate::agent_process::script_markers(id) {
                assert!(AGENT_MARKERS.contains(m), "{m} missing in AGENT_MARKERS");
                assert!(is_agent("node.exe", Some(&format!("node C:/npm/{m}/x.js"))));
            }
        }
    }
}
