//! Where host output goes (SWA-55). Pure, generic over the sink type so the
//! rules are testable without a Tauri `Channel`.
//!
//! In-process every generation owned its own channel, so a killed shell's
//! last bytes could never reach its same-id successor. Over the one host
//! pipe the data frames carry the spawn id instead (SWA-54), and this table
//! keys live routes by `(terminal id, spawn id)`: a frame of a generation
//! the app does not track is dropped, and an old generation that is still
//! flushing after a respawn keeps its own channel until its `exit`.
//!
//! A `create` registers a *pending* route by terminal id. The host announces
//! `spawned` before the pane's reader starts and on the same ordered pipe, so
//! binding the spawn id on `spawned` catches every byte the pane produces,
//! including output that overtakes the `create` answer.

use std::collections::HashMap;

pub struct Routes<P, C> {
    pending: HashMap<String, (P, C)>,
    live: HashMap<(String, String), C>,
}

impl<P, C> Default for Routes<P, C> {
    fn default() -> Self {
        Routes {
            pending: HashMap::new(),
            live: HashMap::new(),
        }
    }
}

impl<P, C> Routes<P, C> {
    /// Register a create in flight. `payload` travels to `spawned` (the app
    /// keeps the mirror fields there).
    pub fn add_pending(&mut self, terminal_id: &str, payload: P, sink: C) {
        self.pending
            .insert(terminal_id.to_string(), (payload, sink));
    }

    /// The create failed: forget the pending route, handing its sink back
    /// (an attach that found the pane gone falls back to a create with it).
    pub fn cancel_pending(&mut self, terminal_id: &str) -> Option<(P, C)> {
        self.pending.remove(terminal_id)
    }

    /// Bind a pending route to the generation the host just started. `None`
    /// for a `spawned` nobody here asked for (another client's pane).
    pub fn on_spawned(&mut self, terminal_id: &str, spawn_id: &str) -> Option<P>
    where
        C: Clone,
    {
        let (payload, sink) = self.pending.remove(terminal_id)?;
        self.live
            .insert((terminal_id.to_string(), spawn_id.to_string()), sink);
        Some(payload)
    }

    /// Sink for a data frame, `None` = drop it (stale or unknown generation).
    pub fn route(&self, terminal_id: &str, spawn_id: &str) -> Option<&C> {
        self.live
            .get(&(terminal_id.to_string(), spawn_id.to_string()))
    }

    /// `exit`: the generation is done, hand its sink over for the final
    /// message.
    pub fn take(&mut self, terminal_id: &str, spawn_id: &str) -> Option<C> {
        self.live
            .remove(&(terminal_id.to_string(), spawn_id.to_string()))
    }

    /// Connection lost: every live generation ends, pending creates fail.
    pub fn drain(&mut self) -> Vec<(String, String, C)> {
        self.pending.clear();
        self.live
            .drain()
            .map(|((id, spawn), sink)| (id, spawn, sink))
            .collect()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.live.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type R = Routes<&'static str, u32>;

    #[test]
    fn spawned_binds_the_pending_route() {
        let mut r = R::default();
        r.add_pending("t", "meta", 1);
        assert_eq!(r.route("t", "g1"), None, "nothing before spawned");
        assert_eq!(r.on_spawned("t", "g1"), Some("meta"));
        assert_eq!(r.route("t", "g1"), Some(&1));
        assert_eq!(r.route("t", "g0"), None, "other generations are dropped");
    }

    #[test]
    fn an_unrequested_spawn_is_ignored() {
        let mut r = R::default();
        assert_eq!(r.on_spawned("t", "g1"), None);
        assert_eq!(r.route("t", "g1"), None);
    }

    #[test]
    fn old_and_new_generation_of_one_id_stay_apart() {
        let mut r = R::default();
        r.add_pending("t", "a", 1);
        r.on_spawned("t", "old");
        // Same-id respawn while the old one still flushes.
        r.add_pending("t", "b", 2);
        r.on_spawned("t", "new");
        assert_eq!(r.route("t", "old"), Some(&1));
        assert_eq!(r.route("t", "new"), Some(&2));
        assert_eq!(r.take("t", "old"), Some(1));
        assert_eq!(r.route("t", "old"), None);
        assert_eq!(r.route("t", "new"), Some(&2));
    }

    #[test]
    fn cancel_and_drain() {
        let mut r = R::default();
        r.add_pending("p", "m", 9);
        assert!(r.cancel_pending("p").is_some());
        assert!(r.cancel_pending("p").is_none());
        r.add_pending("a", "m", 1);
        r.on_spawned("a", "g");
        r.add_pending("b", "m", 2);
        let drained = r.drain();
        assert_eq!(drained, vec![("a".to_string(), "g".to_string(), 1)]);
        assert!(r.is_empty());
    }
}
