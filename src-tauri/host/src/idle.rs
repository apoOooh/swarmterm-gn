//! Idle exit (ADR 0001, lifecycle): a host with no client and no PTY exits
//! after `IDLE_EXIT`. Without it every app quit would leave a host process
//! behind for good, because the app only ever starts hosts.

use std::time::{Duration, Instant};

pub const IDLE_EXIT: Duration = Duration::from_secs(10 * 60);
/// How often `main` samples the host; the exit happens at most this late.
pub const IDLE_POLL: Duration = Duration::from_secs(15);

/// Tracks since when the host has been idle. Pure so the rule is testable
/// without waiting ten minutes.
#[derive(Debug, Default)]
pub struct IdleTracker {
    since: Option<Instant>,
}

impl IdleTracker {
    /// Feed one sample; true once the host has been idle for `limit`.
    /// Any activity (a client or a PTY) resets the clock.
    pub fn observe(&mut self, now: Instant, idle: bool, limit: Duration) -> bool {
        if !idle {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        now.duration_since(since) >= limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exits_only_after_a_full_idle_stretch() {
        let t0 = Instant::now();
        let limit = Duration::from_secs(60);
        let mut t = IdleTracker::default();
        assert!(!t.observe(t0, true, limit));
        assert!(!t.observe(t0 + Duration::from_secs(59), true, limit));
        assert!(t.observe(t0 + Duration::from_secs(60), true, limit));
    }

    #[test]
    fn activity_resets_the_clock() {
        let t0 = Instant::now();
        let limit = Duration::from_secs(60);
        let mut t = IdleTracker::default();
        t.observe(t0, true, limit);
        assert!(!t.observe(t0 + Duration::from_secs(50), false, limit));
        assert!(!t.observe(t0 + Duration::from_secs(70), true, limit));
        assert!(t.observe(t0 + Duration::from_secs(130), true, limit));
    }
}
