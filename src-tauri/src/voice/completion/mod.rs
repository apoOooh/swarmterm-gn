//! Completion adapters (SWA-58, docs/adr/0004): which agent turn finished,
//! and — only with Settings → Voice "Allow excerpts" — a short excerpt of
//! its final answer, spoken on request.
//!
//! - `excerpt`: final text → one or two speakable sentences (pure).
//! - `claude`: Claude Code transcript tail → final text of one turn (pure).
//! - `reader`: finds and reads the transcript under the pane's own config
//!   dir, with the open contract and budget from the ADR.
//! - this file: `Fingerprint` and the `Ledger`, the one place that decides
//!   which turn is open, which one a Stop closes, and what may be read out.
//!
//! The text never leaves this process: not over the pipe, MCP, War Room, a
//! Tauri event or a log. The hook CLI sends a fingerprint, the app reads
//! the file itself, the ledger keeps only the excerpt (≤ 300 chars) in RAM.

pub mod claude;
pub mod excerpt;
pub mod reader;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// An excerpt older than this is gone: nobody asks for the gist of an
/// answer they have long since read.
pub const EXCERPT_TTL: Duration = Duration::from_secs(10 * 60);
/// Longest `last_assistant_message` a fingerprint may describe. Longer than
/// any answer worth an excerpt; a bogus length is rejected at the boundary.
const MAX_FINGERPRINT_LEN: u64 = 16 * 1024 * 1024;

/// Length + SHA-256 of the exact string Claude Code passed its Stop hook.
/// Proves that the row read from the file is the one the hook saw, without
/// the text crossing the loopback port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fingerprint {
    pub len: u64,
    pub sha256: String,
}

impl Fingerprint {
    pub fn of(text: &str) -> Self {
        let digest = Sha256::digest(text.as_bytes());
        Self {
            len: text.len() as u64,
            sha256: digest.iter().map(|b| format!("{b:02x}")).collect(),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.len <= MAX_FINGERPRINT_LEN
            && self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Error,
}

/// One closed turn. `token` is the opaque `completionId` on the wire; it
/// stands for the whole tuple (terminal, PTY generation, session, prompt),
/// so a request for it can never reach a newer turn or a respawned pane.
#[derive(Debug, Clone)]
struct Closed {
    token: String,
    prompt_id: String,
    outcome: Outcome,
    /// `Some` once the reader committed a non-empty excerpt.
    excerpt: Option<String>,
    /// The reader is still at work for this turn.
    pending: bool,
    at: Instant,
    /// Set when the status for this turn went out (seq, pane name, agent).
    published: Option<Published>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub seq: u64,
    pub pane_name: String,
    pub agent: String,
}

#[derive(Debug, Default)]
struct Pane {
    spawn_id: String,
    session_id: String,
    /// The prompt whose answer is being written right now.
    open: Option<String>,
    closed: Option<Closed>,
}

/// What a Stop asks the caller to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadJob {
    pub token: String,
    pub terminal_id: String,
    pub session_id: String,
    pub prompt_id: String,
}

/// The ledger's view of a turn, for the status push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnView {
    pub token: String,
    pub outcome: Outcome,
    pub has_excerpt: bool,
}

/// `read_excerpt` outcomes, named like the wire reasons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Excerpt {
        terminal_id: String,
        spawn_id: String,
        text: String,
    },
    NoExcerpt,
    Stale,
}

#[derive(Debug, Default)]
pub struct Ledger {
    panes: HashMap<String, Pane>,
    /// The pane whose status announcement last actually STARTED playing,
    /// with that turn's token (Ctrl+Shift+R's first choice).
    last_announced: Option<(String, String)>,
}

impl Ledger {
    /// The pane entry for this generation and session; a different one
    /// starts over, so nothing of an earlier conversation survives.
    fn pane(&mut self, terminal_id: &str, spawn_id: &str, session_id: &str) -> &mut Pane {
        let pane = self.panes.entry(terminal_id.to_owned()).or_default();
        if pane.spawn_id != spawn_id || pane.session_id != session_id {
            *pane = Pane {
                spawn_id: spawn_id.to_owned(),
                session_id: session_id.to_owned(),
                ..Pane::default()
            };
        }
        pane
    }

    /// UserPromptSubmit: a new turn opens and the previous excerpt is void
    /// at once (the user moved on; the TTL is only a backstop).
    pub fn prompt(&mut self, terminal_id: &str, spawn_id: &str, session_id: &str, prompt_id: &str) {
        let pane = self.pane(terminal_id, spawn_id, session_id);
        pane.open = Some(prompt_id.to_owned());
        pane.closed = None;
        self.forget_announced(terminal_id);
    }

    /// Stop / StopFailure. Closes the turn only if it is the OPEN one of the
    /// same generation and session — a late or foreign Stop changes nothing.
    /// `continued` (stop_hook_active) means a Stop hook sent Claude back to
    /// work: what it said so far is not the final answer, so the turn keeps
    /// no excerpt. Returns the read to run, if one is wanted.
    #[allow(clippy::too_many_arguments)]
    pub fn stop(
        &mut self,
        terminal_id: &str,
        spawn_id: &str,
        session_id: &str,
        prompt_id: &str,
        outcome: Outcome,
        continued: bool,
        read: bool,
        now: Instant,
    ) -> Option<ReadJob> {
        let pane = self.panes.get_mut(terminal_id)?;
        if pane.spawn_id != spawn_id || pane.session_id != session_id {
            return None;
        }
        if continued {
            if let Some(c) = pane.closed.as_mut().filter(|c| c.prompt_id == prompt_id) {
                c.excerpt = None;
                c.pending = false;
            }
            if pane.open.is_none()
                && pane
                    .closed
                    .as_ref()
                    .is_some_and(|c| c.prompt_id == prompt_id)
            {
                pane.open = Some(prompt_id.to_owned());
            }
            return None;
        }
        if pane.open.as_deref() != Some(prompt_id) {
            // A StopFailure after the Stop of the same turn: the turn failed.
            if let Some(c) = pane.closed.as_mut().filter(|c| c.prompt_id == prompt_id) {
                if outcome == Outcome::Error {
                    c.outcome = Outcome::Error;
                    c.excerpt = None;
                    c.pending = false;
                }
            }
            return None;
        }
        pane.open = None;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let read = read && outcome == Outcome::Done;
        pane.closed = Some(Closed {
            token: token.clone(),
            prompt_id: prompt_id.to_owned(),
            outcome,
            excerpt: None,
            pending: read,
            at: now,
            published: None,
        });
        read.then(|| ReadJob {
            token,
            terminal_id: terminal_id.to_owned(),
            session_id: session_id.to_owned(),
            prompt_id: prompt_id.to_owned(),
        })
    }

    fn closed_by_token(&mut self, token: &str) -> Option<(&String, &mut Closed)> {
        self.panes.iter_mut().find_map(|(t, p)| {
            p.closed
                .as_mut()
                .filter(|c| c.token == token)
                .map(|c| (t, c))
        })
    }

    /// The reader finished. Only the turn it was started for, and only while
    /// that turn still waits for it; anything else is dropped unseen. Returns
    /// the published status if the excerpt arrived after it (→ `turn_update`).
    pub fn commit(&mut self, token: &str, excerpt: Option<String>) -> Option<Published> {
        let (_, c) = self.closed_by_token(token)?;
        if !c.pending {
            return None;
        }
        c.pending = false;
        c.excerpt = excerpt.filter(|e| !e.is_empty());
        c.excerpt.as_ref()?;
        c.published.clone()
    }

    /// The renderer's status for a pane is going out. Annotated only when the
    /// latest thing in this pane is a closed turn of this generation — a
    /// status that arrives after a newer prompt opened belongs to nobody and
    /// goes out plain (it never closes or claims anything here).
    pub fn publish(&mut self, terminal_id: &str, spawn_id: &str, p: Published) -> Option<TurnView> {
        let pane = self.panes.get_mut(terminal_id)?;
        if pane.spawn_id != spawn_id || pane.open.is_some() {
            return None;
        }
        let c = pane.closed.as_mut()?;
        if c.published.is_none() {
            c.published = Some(p);
        }
        Some(TurnView {
            token: c.token.clone(),
            outcome: c.outcome,
            has_excerpt: c.excerpt.is_some(),
        })
    }

    /// A StopFailure flipped a turn whose "done" already went out: the one
    /// correction to announce.
    pub fn failed_after_publish(&self, terminal_id: &str) -> Option<(String, Published)> {
        let c = self.panes.get(terminal_id)?.closed.as_ref()?;
        (c.outcome == Outcome::Error)
            .then(|| c.published.clone().map(|p| (c.token.clone(), p)))
            .flatten()
    }

    pub fn lookup(&self, token: &str, now: Instant) -> Lookup {
        for (terminal_id, pane) in &self.panes {
            let Some(c) = pane.closed.as_ref().filter(|c| c.token == token) else {
                continue;
            };
            if now.saturating_duration_since(c.at) >= EXCERPT_TTL {
                return Lookup::Stale;
            }
            return match &c.excerpt {
                Some(text) => Lookup::Excerpt {
                    terminal_id: terminal_id.clone(),
                    spawn_id: pane.spawn_id.clone(),
                    text: text.clone(),
                },
                None => Lookup::NoExcerpt,
            };
        }
        Lookup::Stale
    }

    /// Whether `token` still names the closed turn holding an excerpt —
    /// re-checked right before an excerpt is spoken.
    pub fn holds(&self, token: &str, now: Instant) -> bool {
        matches!(self.lookup(token, now), Lookup::Excerpt { .. })
    }

    /// Ctrl+Shift+R: the last pane whose announcement actually played, else
    /// the focused one — but only a turn that is still the latest there.
    pub fn hotkey_target(&self, focused: Option<&str>) -> Option<String> {
        let current = |t: &str| {
            self.panes
                .get(t)
                .filter(|p| p.open.is_none())
                .and_then(|p| p.closed.as_ref())
                .map(|c| c.token.clone())
        };
        if let Some((t, token)) = &self.last_announced {
            if current(t).as_deref() == Some(token.as_str()) {
                return Some(token.clone());
            }
        }
        focused.and_then(current)
    }

    /// The worker started playing the status of this turn.
    pub fn announced(&mut self, terminal_id: &str, token: &str) {
        self.last_announced = Some((terminal_id.to_owned(), token.to_owned()));
    }

    fn forget_announced(&mut self, terminal_id: &str) {
        if self
            .last_announced
            .as_ref()
            .is_some_and(|(t, _)| t == terminal_id)
        {
            self.last_announced = None;
        }
    }

    /// SessionStart/SessionEnd, kill, respawn: the conversation is over.
    pub fn forget(&mut self, terminal_id: &str) {
        self.panes.remove(terminal_id);
        self.forget_announced(terminal_id);
    }

    /// "Allow excerpts" switched off: every excerpt and pending read goes,
    /// turn bookkeeping stays (statuses keep working).
    pub fn clear_excerpts(&mut self) {
        for pane in self.panes.values_mut() {
            if let Some(c) = pane.closed.as_mut() {
                c.excerpt = None;
                c.pending = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "t1";
    const G: &str = "gen1";
    const S: &str = "3f4fe5b8-6a2f-4bbf-a2a2-18d3fa4951e0";

    fn stop(l: &mut Ledger, prompt: &str, now: Instant) -> Option<ReadJob> {
        l.stop(T, G, S, prompt, Outcome::Done, false, true, now)
    }
    fn published() -> Published {
        Published {
            seq: 1,
            pane_name: "Backend".into(),
            agent: "claude-code".into(),
        }
    }

    #[test]
    fn fingerprint_is_length_and_lowercase_sha256() {
        let f = Fingerprint::of("abc");
        assert_eq!(f.len, 3);
        assert_eq!(
            f.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(f.is_valid());
        assert!(!Fingerprint {
            sha256: "AB".into(),
            ..f.clone()
        }
        .is_valid());
        assert!(!Fingerprint { len: u64::MAX, ..f }.is_valid());
    }

    #[test]
    fn a_stop_closes_only_the_open_prompt() {
        let now = Instant::now();
        let mut l = Ledger::default();
        // No prompt seen (adopted pane): nothing to close, nothing to read.
        assert_eq!(stop(&mut l, "p1", now), None);
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1", now).unwrap();
        assert_eq!(job.prompt_id, "p1");
        // The same Stop again, or a late one, closes nothing.
        assert_eq!(stop(&mut l, "p1", now), None);
        assert_eq!(stop(&mut l, "p0", now), None);
    }

    #[test]
    fn a_late_stop_of_turn_one_never_touches_turn_two() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let j1 = stop(&mut l, "p1", now).unwrap();
        l.prompt(T, G, S, "p2");
        assert_eq!(stop(&mut l, "p1", now), None);
        // The old read finishing late commits nothing.
        assert_eq!(l.commit(&j1.token, Some("Alt.".into())), None);
        assert_eq!(l.lookup(&j1.token, now), Lookup::Stale);
        let j2 = stop(&mut l, "p2", now).unwrap();
        l.commit(&j2.token, Some("Neu.".into()));
        assert!(matches!(l.lookup(&j2.token, now), Lookup::Excerpt { text, .. } if text == "Neu."));
    }

    #[test]
    fn another_generation_or_session_starts_over() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(
            l.stop(T, "gen2", S, "p1", Outcome::Done, false, true, now),
            None
        );
        let other = "11111111-2222-3333-4444-555555555555";
        assert_eq!(
            l.stop(T, G, other, "p1", Outcome::Done, false, true, now),
            None
        );
        // /clear: a new session's prompt drops the old turn completely.
        let job = stop(&mut l, "p1", now).unwrap();
        l.commit(&job.token, Some("Text.".into()));
        l.prompt(T, G, other, "q1");
        assert_eq!(l.lookup(&job.token, now), Lookup::Stale);
    }

    #[test]
    fn a_continued_stop_voids_the_excerpt_and_reopens_the_turn() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1", now).unwrap();
        assert_eq!(l.stop(T, G, S, "p1", Outcome::Done, true, true, now), None);
        assert_eq!(l.commit(&job.token, Some("Zwischenstand.".into())), None);
        assert_eq!(l.lookup(&job.token, now), Lookup::NoExcerpt);
        // The real end of that turn closes it again.
        assert!(stop(&mut l, "p1", now).is_some());
    }

    #[test]
    fn without_opt_in_a_stop_closes_but_never_asks_for_a_read() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(
            l.stop(T, G, S, "p1", Outcome::Done, false, false, now),
            None
        );
        let view = l.publish(T, G, published()).unwrap();
        assert_eq!((view.outcome, view.has_excerpt), (Outcome::Done, false));
    }

    #[test]
    fn a_status_after_a_newer_prompt_goes_out_plain() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        stop(&mut l, "p1", now);
        l.prompt(T, G, S, "p2");
        assert_eq!(l.publish(T, G, published()), None);
        assert_eq!(l.publish("other", G, published()), None);
    }

    #[test]
    fn an_excerpt_after_the_status_asks_for_an_update_once() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1", now).unwrap();
        let view = l.publish(T, G, published()).unwrap();
        assert!(!view.has_excerpt);
        assert_eq!(
            l.commit(&job.token, Some("Fertig.".into())),
            Some(published())
        );
        assert_eq!(l.commit(&job.token, Some("Nochmal.".into())), None);
        // An empty excerpt is no excerpt and asks for nothing.
        l.prompt(T, G, S, "p2");
        let job = stop(&mut l, "p2", now).unwrap();
        l.publish(T, G, published());
        assert_eq!(l.commit(&job.token, None), None);
    }

    #[test]
    fn stop_failure_marks_the_turn_failed_even_after_done() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(
            l.stop(T, G, S, "p1", Outcome::Error, false, true, now),
            None
        );
        assert_eq!(
            l.publish(T, G, published()).unwrap().outcome,
            Outcome::Error
        );
        l.prompt(T, G, S, "p2");
        let job = stop(&mut l, "p2", now).unwrap();
        l.publish(T, G, published());
        l.stop(T, G, S, "p2", Outcome::Error, false, true, now);
        assert_eq!(l.commit(&job.token, Some("x".into())), None);
        assert_eq!(l.failed_after_publish(T).unwrap().1, published());
    }

    #[test]
    fn excerpts_expire_and_opt_out_clears_them() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1", now).unwrap();
        l.commit(&job.token, Some("Text.".into()));
        assert!(l.holds(&job.token, now));
        assert_eq!(l.lookup(&job.token, now + EXCERPT_TTL), Lookup::Stale);
        l.clear_excerpts();
        assert_eq!(l.lookup(&job.token, now), Lookup::NoExcerpt);
        assert_eq!(l.lookup("unknown", now), Lookup::Stale);
    }

    #[test]
    fn hotkey_prefers_the_last_announced_turn_then_the_focused_pane() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let a = stop(&mut l, "p1", now).unwrap();
        l.prompt("t2", G, S, "q1");
        let b = l
            .stop("t2", G, S, "q1", Outcome::Done, false, true, now)
            .unwrap();
        assert_eq!(l.hotkey_target(Some("t2")), Some(b.token.clone()));
        l.announced(T, &a.token);
        assert_eq!(l.hotkey_target(Some("t2")), Some(a.token.clone()));
        // A new prompt there makes the announced turn stale → focused pane.
        l.prompt(T, G, S, "p2");
        assert_eq!(l.hotkey_target(Some("t2")), Some(b.token));
        assert_eq!(l.hotkey_target(None), None);
        l.forget("t2");
        assert_eq!(l.hotkey_target(Some("t2")), None);
    }
}
