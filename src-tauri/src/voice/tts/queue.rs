//! Pure bookkeeping for spoken announcements: which ones are still worth
//! saying, and whether a recording forbids speaking right now. No clock, no
//! engine — the worker passes `now` in, so every rule is a unit test.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Announcements waiting at once. More than this is a backlog nobody wants
/// to sit through; the oldest go first.
pub const MAX_QUEUED: usize = 3;
/// An announcement older than this is stale: the user has likely looked at
/// the pane already, or it was overtaken by what happened since.
pub const TTL: Duration = Duration::from_secs(10);
/// Silence after the last recording ended. Covers the gap between a
/// dictation's insert and the user's next look at the screen, and keeps a
/// queued line from starting the instant a mic closes.
pub const TAIL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub terminal_id: String,
    /// The PTY generation the fact belongs to; a respawned pane is a
    /// different conversation and its old "done" is void.
    pub spawn_id: String,
    pub text: String,
    pub at: Instant,
    /// SWA-58: the closed turn this item speaks about (`completionId`). A
    /// status with a token marks "last announced" when it starts playing.
    pub token: Option<String>,
    /// An excerpt, not a status: re-checked against the ledger and the
    /// opt-in right before it is spoken.
    pub excerpt: bool,
}

#[derive(Debug, Default)]
pub struct Queue {
    items: VecDeque<Item>,
}

impl Queue {
    /// A newer fact about the same pane replaces the older one: "done"
    /// after "needs input" means the question is already answered.
    pub fn push(&mut self, item: Item) {
        self.items.retain(|i| i.terminal_id != item.terminal_id);
        self.items.push_back(item);
        while self.items.len() > MAX_QUEUED {
            self.items.pop_front();
        }
    }

    /// The oldest announcement that is still fresh; stale ones are dropped
    /// on the way.
    pub fn pop_fresh(&mut self, now: Instant) -> Option<Item> {
        while let Some(item) = self.items.pop_front() {
            if now.saturating_duration_since(item.at) < TTL {
                return Some(item);
            }
        }
        None
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn clear_terminal(&mut self, terminal_id: &str) {
        self.items.retain(|i| i.terminal_id != terminal_id);
    }

    pub fn retain(&mut self, keep: impl FnMut(&Item) -> bool) {
        self.items.retain(keep);
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// Half-duplex gate. The worker polls whether anything records (a begin in
/// flight, a live pin, the built-in transcription) and asks this whether it
/// may speak. Polling instead of release timers means no stale timer can
/// ever reopen the gate for a newer recording: the tail always counts from
/// the last time a recording was SEEN.
#[derive(Debug, Default)]
pub struct Quiet {
    until: Option<Instant>,
}

impl Quiet {
    pub fn may_speak(&mut self, recording: bool, now: Instant) -> bool {
        if recording {
            self.until = Some(now + TAIL);
            return false;
        }
        self.until.is_none_or(|u| now >= u)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(t: &str, at: Instant) -> Item {
        Item {
            terminal_id: t.into(),
            spawn_id: "g1".into(),
            text: format!("{t} done"),
            at,
            token: None,
            excerpt: false,
        }
    }

    #[test]
    fn a_newer_fact_replaces_the_older_one_for_the_same_pane() {
        let now = Instant::now();
        let mut q = Queue::default();
        q.push(item("a", now));
        q.push(item("b", now));
        q.push(Item {
            text: "a again".into(),
            ..item("a", now)
        });
        assert_eq!(q.pop_fresh(now).unwrap().terminal_id, "b");
        assert_eq!(q.pop_fresh(now).unwrap().text, "a again");
        assert!(q.pop_fresh(now).is_none());
    }

    #[test]
    fn keeps_at_most_three_dropping_the_oldest() {
        let now = Instant::now();
        let mut q = Queue::default();
        for t in ["a", "b", "c", "d"] {
            q.push(item(t, now));
        }
        let order: Vec<_> = std::iter::from_fn(|| q.pop_fresh(now))
            .map(|i| i.terminal_id)
            .collect();
        assert_eq!(order, ["b", "c", "d"]);
    }

    #[test]
    fn stale_announcements_are_skipped() {
        let now = Instant::now();
        let mut q = Queue::default();
        q.push(item("old", now));
        q.push(item("new", now + TTL));
        let got = q.pop_fresh(now + TTL).unwrap();
        assert_eq!(got.terminal_id, "new");
        assert!(q.is_empty());
    }

    #[test]
    fn clear_terminal_only_drops_that_pane() {
        let now = Instant::now();
        let mut q = Queue::default();
        q.push(item("a", now));
        q.push(item("b", now));
        q.clear_terminal("a");
        assert_eq!(q.pop_fresh(now).unwrap().terminal_id, "b");
        assert!(q.is_empty());
    }

    #[test]
    fn recording_closes_the_gate_until_the_tail_has_passed() {
        let t0 = Instant::now();
        let mut quiet = Quiet::default();
        assert!(quiet.may_speak(false, t0));
        assert!(!quiet.may_speak(true, t0));
        assert!(!quiet.may_speak(false, t0 + TAIL / 2));
        assert!(quiet.may_speak(false, t0 + TAIL));
    }

    #[test]
    fn a_new_recording_during_the_tail_extends_it() {
        // The rule an old release timer would break: the earlier recording's
        // tail must not reopen the gate under a newer one.
        let t0 = Instant::now();
        let mut quiet = Quiet::default();
        quiet.may_speak(true, t0);
        quiet.may_speak(true, t0 + TAIL / 2);
        assert!(!quiet.may_speak(false, t0 + TAIL));
        assert!(quiet.may_speak(false, t0 + TAIL / 2 + TAIL));
    }
}
