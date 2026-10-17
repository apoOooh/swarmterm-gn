//! Completion adapters (SWA-58, docs/adr/0004): which Claude turn finished
//! and — only with Settings → Voice "Allow excerpts" — what to say about it.
//!
//! - `speech_text`: final answer → the agent's `<voice>` line, else quoted
//!   prose (pure).
//! - `excerpt`: the filter both go through (pure).
//! - `claude`: Claude Code transcript tail → final text / Esc marker of ONE
//!   turn (pure).
//! - `reader`: finds and reads the transcript under the pane's own config
//!   dir, with the open contract and budget from the ADR.
//! - this file: `Fingerprint` and the `Ledger`, the one place that decides
//!   which turn is open, which one a Stop closes, and what may be said.
//!
//! The text never leaves this process: not over the pipe, MCP, War Room, a
//! Tauri event or a log. The hook CLI sends a fingerprint, the app reads
//! the file itself, the ledger keeps only the reply (≤ 300 chars) in RAM
//! until it is handed to the voice.

pub mod claude;
pub mod excerpt;
pub mod reader;
pub mod speech_text;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use speech_text::Reply;

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
    Interrupted,
}

/// One closed turn. `token` stands for the whole tuple (terminal, PTY
/// generation, session, prompt), so a queued line can be re-checked against
/// "is this still the latest turn here" right before it is spoken.
#[derive(Debug, Clone)]
struct Closed {
    token: String,
    prompt_id: String,
    outcome: Outcome,
    /// Set once the reader committed; taken when handed to the voice.
    reply: Option<Reply>,
    /// The reader is still at work for this turn.
    pending: bool,
    /// Set when the renderer's status for this turn arrived.
    published: Option<Published>,
}

/// The renderer's status for a pane: how to name it, and whether the user
/// is looking at it (a watched pane gets a reply, never a bare "fertig").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub pane_name: String,
    pub agent: String,
    pub watched: bool,
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

/// The ledger's answer to a status from the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum View {
    /// No closed turn of this generation is the latest thing here (no hook
    /// seen, adopted pane, newer prompt open, already answered): the plain
    /// status goes out.
    Plain,
    /// The read is still running; its commit says what to speak.
    Pending,
    /// Closed: the outcome and, for a done turn, the reply if there is one
    /// (taken out of the ledger — it is spoken once).
    Closed {
        token: String,
        outcome: Outcome,
        reply: Option<Reply>,
    },
}

/// What a commit asks the caller to speak: the status had already arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Late {
    pub token: String,
    pub published: Published,
    pub reply: Option<Reply>,
}

#[derive(Debug, Default)]
pub struct Ledger {
    panes: HashMap<String, Pane>,
    next: u64,
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

    fn token(&mut self, terminal_id: &str) -> String {
        self.next += 1;
        format!("{terminal_id}#{}", self.next)
    }

    /// UserPromptSubmit: a new turn opens and whatever was left of the
    /// previous one is void at once (the user moved on).
    pub fn prompt(&mut self, terminal_id: &str, spawn_id: &str, session_id: &str, prompt_id: &str) {
        let pane = self.pane(terminal_id, spawn_id, session_id);
        pane.open = Some(prompt_id.to_owned());
        pane.closed = None;
    }

    /// Stop / StopFailure. Closes the turn only if it is the OPEN one of the
    /// same generation and session — a late or foreign Stop changes nothing.
    /// `continued` (stop_hook_active) means a Stop hook sent Claude back to
    /// work: what it said so far is not the final answer, so the turn is
    /// open again. Returns the read to run, if one is wanted.
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
    ) -> Option<ReadJob> {
        let pane = self.panes.get(terminal_id)?;
        if pane.spawn_id != spawn_id || pane.session_id != session_id {
            return None;
        }
        let token = self.token(terminal_id);
        let pane = self.panes.get_mut(terminal_id)?;
        if continued {
            let ours = pane.open.as_deref() == Some(prompt_id)
                || pane
                    .closed
                    .as_ref()
                    .is_some_and(|c| c.prompt_id == prompt_id);
            if ours {
                pane.open = Some(prompt_id.to_owned());
                pane.closed = None;
            }
            return None;
        }
        if pane.open.as_deref() != Some(prompt_id) {
            // A StopFailure after the Stop of the same turn: the turn failed.
            if let Some(c) = pane.closed.as_mut().filter(|c| c.prompt_id == prompt_id) {
                if outcome == Outcome::Error {
                    c.outcome = Outcome::Error;
                    c.reply = None;
                    c.pending = false;
                }
            }
            return None;
        }
        pane.open = None;
        let read = read && outcome == Outcome::Done;
        pane.closed = Some(Closed {
            token: token.clone(),
            prompt_id: prompt_id.to_owned(),
            outcome,
            reply: None,
            pending: read,
            published: None,
        });
        read.then(|| ReadJob {
            token,
            terminal_id: terminal_id.to_owned(),
            session_id: session_id.to_owned(),
            prompt_id: prompt_id.to_owned(),
        })
    }

    fn closed_by_token(&mut self, token: &str) -> Option<&mut Closed> {
        self.panes
            .values_mut()
            .find_map(|p| p.closed.as_mut().filter(|c| c.token == token))
    }

    /// The reader finished. Only the turn it was started for, and only while
    /// that turn still waits for it; anything else is dropped unseen. If the
    /// status already arrived, the caller speaks now (reply or fallback).
    pub fn commit(&mut self, token: &str, reply: Option<Reply>) -> Option<Late> {
        let c = self.closed_by_token(token)?;
        if !c.pending {
            return None;
        }
        c.pending = false;
        match c.published.clone() {
            Some(published) => Some(Late {
                token: token.to_owned(),
                published,
                reply,
            }),
            None => {
                c.reply = reply;
                None
            }
        }
    }

    /// The renderer's status for a pane arrived. Tied to a turn only when the
    /// latest thing in this pane is a closed turn of this generation — a
    /// status after a newer prompt belongs to nobody and goes out plain (it
    /// never closes or claims anything here). Answered once per turn.
    pub fn publish(&mut self, terminal_id: &str, spawn_id: &str, p: Published) -> View {
        let Some(pane) = self
            .panes
            .get_mut(terminal_id)
            .filter(|pane| pane.spawn_id == spawn_id && pane.open.is_none())
        else {
            return View::Plain;
        };
        let Some(c) = pane.closed.as_mut() else {
            return View::Plain;
        };
        if c.published.is_some() {
            return View::Plain;
        }
        c.published = Some(p);
        if c.pending {
            return View::Pending;
        }
        View::Closed {
            token: c.token.clone(),
            outcome: c.outcome,
            reply: c.reply.take(),
        }
    }

    /// A StopFailure flipped a turn whose status already went out: the one
    /// correction to announce.
    pub fn failed_after_publish(&self, terminal_id: &str) -> Option<Published> {
        let c = self.panes.get(terminal_id)?.closed.as_ref()?;
        (c.outcome == Outcome::Error)
            .then(|| c.published.clone())
            .flatten()
    }

    /// The prompt still open in this generation (no Stop came): a candidate
    /// for an Esc interruption. Returns (session, prompt).
    pub fn open_turn(&self, terminal_id: &str, spawn_id: &str) -> Option<(String, String)> {
        let pane = self.panes.get(terminal_id)?;
        (pane.spawn_id == spawn_id)
            .then(|| pane.open.clone().map(|p| (pane.session_id.clone(), p)))
            .flatten()
    }

    /// The transcript proved that `prompt_id` ended with Esc. Closes it as
    /// interrupted if it is still the open turn; returns its token.
    pub fn interrupt(
        &mut self,
        terminal_id: &str,
        spawn_id: &str,
        prompt_id: &str,
        p: Published,
    ) -> Option<String> {
        let pane = self.panes.get(terminal_id)?;
        if pane.spawn_id != spawn_id || pane.open.as_deref() != Some(prompt_id) {
            return None;
        }
        let token = self.token(terminal_id);
        let pane = self.panes.get_mut(terminal_id)?;
        pane.open = None;
        pane.closed = Some(Closed {
            token: token.clone(),
            prompt_id: prompt_id.to_owned(),
            outcome: Outcome::Interrupted,
            reply: None,
            pending: false,
            published: Some(p),
        });
        Some(token)
    }

    /// Whether `token` still names the latest turn of its pane — re-checked
    /// by the voice right before a reply is spoken.
    pub fn holds(&self, token: &str) -> bool {
        self.panes
            .values()
            .any(|p| p.open.is_none() && p.closed.as_ref().is_some_and(|c| c.token == token))
    }

    /// SessionStart/SessionEnd, kill, respawn: the conversation is over.
    pub fn forget(&mut self, terminal_id: &str) {
        self.panes.remove(terminal_id);
    }

    /// "Allow excerpts" switched off: every reply and pending read goes,
    /// turn bookkeeping stays (statuses keep working).
    pub fn clear_replies(&mut self) {
        for pane in self.panes.values_mut() {
            if let Some(c) = pane.closed.as_mut() {
                c.reply = None;
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

    fn stop(l: &mut Ledger, prompt: &str) -> Option<ReadJob> {
        l.stop(T, G, S, prompt, Outcome::Done, false, true)
    }
    fn published(watched: bool) -> Published {
        Published {
            pane_name: "Backend".into(),
            agent: "claude-code".into(),
            watched,
        }
    }
    fn voice(t: &str) -> Option<Reply> {
        Some(Reply::Voice(t.into()))
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
        let mut l = Ledger::default();
        // No prompt seen (adopted pane): nothing to close, nothing to read.
        assert_eq!(stop(&mut l, "p1"), None);
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1").unwrap();
        assert_eq!(job.prompt_id, "p1");
        // The same Stop again, or a late one, closes nothing.
        assert_eq!(stop(&mut l, "p1"), None);
        assert_eq!(stop(&mut l, "p0"), None);
    }

    #[test]
    fn reply_before_status_is_handed_out_once_with_the_status() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1").unwrap();
        assert_eq!(l.commit(&job.token, voice("Alles grün.")), None);
        assert!(l.holds(&job.token));
        assert_eq!(
            l.publish(T, G, published(true)),
            View::Closed {
                token: job.token.clone(),
                outcome: Outcome::Done,
                reply: voice("Alles grün.")
            }
        );
        // A second status for the same turn claims nothing.
        assert_eq!(l.publish(T, G, published(true)), View::Plain);
    }

    #[test]
    fn status_before_reply_lets_the_commit_speak() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1").unwrap();
        assert_eq!(l.publish(T, G, published(false)), View::Pending);
        assert_eq!(
            l.commit(&job.token, None),
            Some(Late {
                token: job.token.clone(),
                published: published(false),
                reply: None
            })
        );
        assert_eq!(l.commit(&job.token, voice("Nochmal.")), None);
    }

    #[test]
    fn a_late_stop_or_read_of_turn_one_never_touches_turn_two() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let j1 = stop(&mut l, "p1").unwrap();
        l.prompt(T, G, S, "p2");
        assert_eq!(stop(&mut l, "p1"), None);
        assert_eq!(l.commit(&j1.token, voice("Alt.")), None);
        assert!(!l.holds(&j1.token));
        let j2 = stop(&mut l, "p2").unwrap();
        l.commit(&j2.token, voice("Neu."));
        assert!(matches!(l.publish(T, G, published(false)),
            View::Closed { reply, .. } if reply == voice("Neu.")));
    }

    #[test]
    fn another_generation_or_session_starts_over() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(l.stop(T, "gen2", S, "p1", Outcome::Done, false, true), None);
        let other = "11111111-2222-3333-4444-555555555555";
        assert_eq!(l.stop(T, G, other, "p1", Outcome::Done, false, true), None);
        let job = stop(&mut l, "p1").unwrap();
        l.commit(&job.token, voice("Text."));
        // A respawn (other generation) gets no answer for the old one.
        assert_eq!(l.publish(T, "gen2", published(false)), View::Plain);
        // /clear: a new session's prompt drops the old turn completely.
        l.prompt(T, G, other, "q1");
        assert!(!l.holds(&job.token));
    }

    #[test]
    fn a_continued_stop_voids_the_reply_and_reopens_the_turn() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1").unwrap();
        assert_eq!(l.stop(T, G, S, "p1", Outcome::Done, true, true), None);
        assert_eq!(l.commit(&job.token, voice("Zwischenstand.")), None);
        assert_eq!(l.publish(T, G, published(false)), View::Plain);
        // The real end of that turn closes it again.
        assert!(stop(&mut l, "p1").is_some());
    }

    #[test]
    fn without_opt_in_a_stop_closes_but_never_asks_for_a_read() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(l.stop(T, G, S, "p1", Outcome::Done, false, false), None);
        assert!(matches!(
            l.publish(T, G, published(false)),
            View::Closed {
                outcome: Outcome::Done,
                reply: None,
                ..
            }
        ));
    }

    #[test]
    fn a_status_after_a_newer_prompt_goes_out_plain() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        stop(&mut l, "p1");
        l.prompt(T, G, S, "p2");
        assert_eq!(l.publish(T, G, published(false)), View::Plain);
        assert_eq!(l.publish("other", G, published(false)), View::Plain);
    }

    #[test]
    fn stop_failure_marks_the_turn_failed_even_after_the_status() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        assert_eq!(l.stop(T, G, S, "p1", Outcome::Error, false, true), None);
        assert!(matches!(
            l.publish(T, G, published(false)),
            View::Closed {
                outcome: Outcome::Error,
                ..
            }
        ));
        l.prompt(T, G, S, "p2");
        let job = stop(&mut l, "p2").unwrap();
        l.publish(T, G, published(true));
        l.stop(T, G, S, "p2", Outcome::Error, false, true);
        assert_eq!(l.commit(&job.token, voice("x")), None);
        assert_eq!(l.failed_after_publish(T), Some(published(true)));
    }

    #[test]
    fn an_open_turn_can_be_closed_as_interrupted_only_once() {
        let mut l = Ledger::default();
        assert_eq!(l.open_turn(T, G), None);
        l.prompt(T, G, S, "p1");
        assert_eq!(l.open_turn(T, G), Some((S.to_owned(), "p1".to_owned())));
        assert_eq!(l.open_turn(T, "gen2"), None);
        assert_eq!(l.interrupt(T, G, "p0", published(true)), None);
        let token = l.interrupt(T, G, "p1", published(true)).unwrap();
        assert!(l.holds(&token));
        assert_eq!(l.interrupt(T, G, "p1", published(true)), None);
        // Its status already went out with the interruption.
        assert_eq!(l.publish(T, G, published(true)), View::Plain);
    }

    #[test]
    fn opt_out_and_forget_drop_replies() {
        let mut l = Ledger::default();
        l.prompt(T, G, S, "p1");
        let job = stop(&mut l, "p1").unwrap();
        l.clear_replies();
        assert_eq!(l.commit(&job.token, voice("Text.")), None);
        assert!(matches!(
            l.publish(T, G, published(false)),
            View::Closed { reply: None, .. }
        ));
        l.forget(T);
        assert!(!l.holds(&job.token));
    }
}
