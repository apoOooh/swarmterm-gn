//! SWA-88: a prompt that a UserPromptSubmit hook (data-shield) blocked is put
//! back into the same pane in its masked form. `/resubmit` is the one place
//! where prompt text crosses the loopback server, so this gate decides
//! whether a POST may cause input at all. Pure: no locks, no clock.
//!
//! The threat is self-injection: anything in the pane holds the bearer
//! (`SWARMTERM_SESSION`), including the agent's own tool calls. So a
//! resubmit is accepted only as the answer to the prompt edge it names —
//! the newest UserPromptSubmit of this generation and session, carrying the
//! fingerprint of the blocked prompt (our own `--hook` sends it with the
//! edge; a blocked prompt never reaches the transcript, so nothing else in
//! the pane can know it), at most
//! `WINDOW` old, used once, and refused once a PostToolUse came after it
//! (a blocked prompt never ran, so a tool call proves it was not blocked).
//! The text must carry at least one mask placeholder: a resubmit that masks
//! nothing is not a masked prompt.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::voice::completion::Fingerprint;

/// How old the prompt edge may be. The guard answers within ~1–5 s of the
/// edge (its first prompt in a session is the slow one).
pub const WINDOW: Duration = Duration::from_secs(10);
/// How long `/resubmit` waits for an edge the guard overtook (both hooks run
/// in parallel; ours is usually first by seconds).
pub const EDGE_WAIT: Duration = Duration::from_millis(400);
/// Upper bound for the text. A prompt is typed or pasted; larger is not one.
pub const MAX_TEXT: usize = 256 * 1024;
/// Blocked prompt ids remembered per pane, for an edge arriving late.
const BLOCKED_KEEP: usize = 8;
/// As short as the window: the ids carry a fingerprint of a plaintext prompt.
const BLOCKED_TTL: Duration = WINDOW;

/// Settings → Terminal → Agent safety, enforced here (renderer applies the
/// same choice again before it writes). Field values in lockstep with
/// `src/lib/agent-policy.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResubmitMode {
    /// Insert the masked prompt and press Enter (user decision 2026-11-09).
    #[default]
    Send,
    /// Insert only; the user presses Enter.
    Insert,
    Off,
}

impl ResubmitMode {
    /// The stricter of two modes (admin locks only ever tighten).
    pub fn min(self, other: Self) -> Self {
        use ResubmitMode::*;
        match (self, other) {
            (Off, _) | (_, Off) => Off,
            (Insert, _) | (_, Insert) => Insert,
            _ => Send,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No prompt edge for this pane (yet): the caller may wait `EDGE_WAIT`.
    NoEdge,
    /// The newest edge is another prompt, generation or session.
    NotTheEdge,
    /// The fingerprint is not the blocked prompt's (or the edge had none).
    NotTheText,
    TooOld,
    AlreadyUsed,
    /// A tool ran after the edge: the prompt was not blocked.
    ToolRan,
}

/// No `Debug`: the fingerprint is of a plaintext prompt (PII) and must never
/// reach a log, not even by accident.
#[derive(Clone)]
struct Edge {
    spawn_id: String,
    session_id: String,
    prompt_id: String,
    /// `None` for an edge from an older hook CLI: then nothing is accepted.
    asked: Option<Fingerprint>,
    at: Instant,
    tool_ran: bool,
    used: bool,
}

#[derive(Default)]
struct Pane {
    edge: Option<Edge>,
    blocked: VecDeque<(String, Fingerprint, Instant)>,
}

#[derive(Default)]
pub struct Gate {
    panes: HashMap<String, Pane>,
}

impl Gate {
    /// Fingerprints live only as long as they can be used: an edge past
    /// the window and expired block reports drop theirs.
    fn sweep(&mut self, now: Instant) {
        for pane in self.panes.values_mut() {
            prune(&mut pane.blocked, now);
            if let Some(e) = pane.edge.as_mut() {
                if now.saturating_duration_since(e.at) > WINDOW {
                    e.asked = None;
                }
            }
        }
    }

    /// A Claude UserPromptSubmit edge reached `/hook`. Returns true when the
    /// guard already reported this prompt as blocked: the caller then keeps
    /// the edge out of the turn ledger and the renderer (no "working").
    pub fn prompt(
        &mut self,
        terminal_id: &str,
        spawn_id: &str,
        session_id: &str,
        prompt_id: &str,
        asked: Option<&Fingerprint>,
        now: Instant,
    ) -> bool {
        self.sweep(now);
        let pane = self.panes.entry(terminal_id.to_owned()).or_default();
        pane.edge = Some(Edge {
            spawn_id: spawn_id.to_owned(),
            session_id: session_id.to_owned(),
            prompt_id: prompt_id.to_owned(),
            asked: asked.cloned(),
            at: now,
            tool_ran: false,
            used: false,
        });
        prune(&mut pane.blocked, now);
        asked.is_some_and(|a| {
            pane.blocked
                .iter()
                .any(|(p, f, _)| p == prompt_id && same(f, a))
        })
    }

    /// A PostToolUse reached `/hook` for this pane.
    pub fn tool_ran(&mut self, terminal_id: &str) {
        if let Some(edge) = self
            .panes
            .get_mut(terminal_id)
            .and_then(|p| p.edge.as_mut())
        {
            edge.tool_ran = true;
        }
    }

    /// The guard reports `prompt_id` as blocked. Remembered for a late edge;
    /// returns true when the edge is already here (the caller then closes
    /// the turn it opened). Reported even with resubmitting switched off.
    /// Bound to the fingerprint too, so nothing but the guard can silence a
    /// turn that really runs.
    pub fn block(
        &mut self,
        terminal_id: &str,
        spawn_id: &str,
        prompt_id: &str,
        asked: &Fingerprint,
        now: Instant,
    ) -> bool {
        self.sweep(now);
        let pane = self.panes.entry(terminal_id.to_owned()).or_default();
        if !pane
            .blocked
            .iter()
            .any(|(p, f, _)| p == prompt_id && same(f, asked))
        {
            if pane.blocked.len() == BLOCKED_KEEP {
                pane.blocked.pop_front();
            }
            pane.blocked
                .push_back((prompt_id.to_owned(), asked.clone(), now));
        }
        pane.edge.as_ref().is_some_and(|e| {
            e.spawn_id == spawn_id
                && e.prompt_id == prompt_id
                && e.asked.as_ref().is_some_and(|a| same(a, asked))
        })
    }

    /// May this POST put text into the pane? Consumes the edge on success,
    /// so the same prompt is resubmitted at most once.
    pub fn check(
        &mut self,
        terminal_id: &str,
        spawn_id: &str,
        session_id: &str,
        prompt_id: &str,
        asked: &Fingerprint,
        now: Instant,
    ) -> Result<(), Refusal> {
        self.sweep(now);
        let edge = self
            .panes
            .get_mut(terminal_id)
            .and_then(|p| p.edge.as_mut())
            .ok_or(Refusal::NoEdge)?;
        if edge.spawn_id != spawn_id || edge.session_id != session_id || edge.prompt_id != prompt_id
        {
            return Err(Refusal::NotTheEdge);
        }
        if edge.used {
            return Err(Refusal::AlreadyUsed);
        }
        if edge.tool_ran {
            return Err(Refusal::ToolRan);
        }
        if now.saturating_duration_since(edge.at) > WINDOW {
            return Err(Refusal::TooOld);
        }
        if !edge.asked.as_ref().is_some_and(|a| same(a, asked)) {
            return Err(Refusal::NotTheText);
        }
        edge.used = true;
        // Matched: the fingerprint has done its job and goes.
        edge.asked = None;
        Ok(())
    }

    /// Kill, respawn, SessionStart/End.
    pub fn forget(&mut self, terminal_id: &str) {
        self.panes.remove(terminal_id);
    }
}

/// Constant-time over the hash, so a probing process learns nothing from
/// how long a wrong guess takes.
fn same(a: &Fingerprint, b: &Fingerprint) -> bool {
    let (x, y) = (a.sha256.as_bytes(), b.sha256.as_bytes());
    let diff = x.iter().zip(y).fold(
        (x.len() ^ y.len()) as u8 | (a.len != b.len) as u8,
        |d, (p, q)| d | (p ^ q),
    );
    diff == 0 && x.len() == y.len()
}

fn prune(blocked: &mut VecDeque<(String, Fingerprint, Instant)>, now: Instant) {
    blocked.retain(|(_, _, at)| now.saturating_duration_since(*at) <= BLOCKED_TTL);
}

/// The text is a masked prompt: within `MAX_TEXT`, not blank, and carrying
/// at least one data-shield placeholder `[TYPE_xxxxxxxx]` (TYPE upper case,
/// eight lower-case hex digits).
pub fn is_masked_prompt(text: &str) -> bool {
    text.len() <= MAX_TEXT && !text.trim().is_empty() && has_placeholder(text)
}

fn has_placeholder(text: &str) -> bool {
    text.match_indices('[').any(|(i, _)| {
        let rest = &text[i + 1..];
        let Some(end) = rest.find(']') else {
            return false;
        };
        let inner = &rest[..end];
        let Some((typ, hash)) = inner.rsplit_once('_') else {
            return false;
        };
        typ.starts_with(|c: char| c.is_ascii_uppercase())
            && typ
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && hash.len() == 8
            && hash.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "t1";
    const G: &str = "gen1";
    const S: &str = "3f4fe5b8-6a2f-4bbf-a2a2-18d3fa4951e0";
    const P: &str = "9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

    fn fp() -> Fingerprint {
        Fingerprint::of("the blocked prompt")
    }

    #[test]
    fn fingerprints_go_after_the_match_and_after_the_window() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        g.prompt(T, G, S, P, Some(&fp()), t0);
        assert_eq!(g.check(T, G, S, P, &fp(), t0), Ok(()));
        assert!(
            g.panes[T].edge.as_ref().unwrap().asked.is_none(),
            "dropped on match"
        );
        g.prompt(T, G, S, "p2", Some(&fp()), t0);
        g.block(T, G, "p3", &fp(), t0);
        // Any later access past the window sweeps every pane.
        g.tool_ran("other");
        g.check(
            "other",
            G,
            S,
            P,
            &fp(),
            t0 + WINDOW + Duration::from_millis(1),
        )
        .ok();
        assert!(
            g.panes[T].edge.as_ref().unwrap().asked.is_none(),
            "dropped after the window"
        );
        assert!(g.panes[T].blocked.is_empty());
    }

    #[test]
    fn same_compares_length_and_hash() {
        assert!(same(&fp(), &fp()));
        assert!(!same(&fp(), &Fingerprint::of("other")));
        let mut f = fp();
        f.len += 1;
        assert!(!same(&fp(), &f));
        f = fp();
        f.sha256.pop();
        assert!(!same(&fp(), &f));
    }

    #[test]
    fn only_the_blocked_prompts_fingerprint_is_accepted() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        g.prompt(T, G, S, P, Some(&fp()), t0);
        let other = Fingerprint::of("something a tool made up");
        assert_eq!(g.check(T, G, S, P, &other, t0), Err(Refusal::NotTheText));
        // A wrong guess does not use up the edge.
        assert_eq!(g.check(T, G, S, P, &fp(), t0), Ok(()));
        // An edge from an older hook CLI carries none: nothing is accepted.
        g.prompt(T, G, S, "p2", None, t0);
        assert_eq!(g.check(T, G, S, "p2", &fp(), t0), Err(Refusal::NotTheText));
    }

    #[test]
    fn a_resubmit_answers_only_the_newest_edge_once() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        assert_eq!(g.check(T, G, S, P, &fp(), t0), Err(Refusal::NoEdge));
        assert!(!g.prompt(T, G, S, P, Some(&fp()), t0));
        assert_eq!(
            g.check(T, "gen2", S, P, &fp(), t0),
            Err(Refusal::NotTheEdge)
        );
        assert_eq!(
            g.check(T, G, "other", P, &fp(), t0),
            Err(Refusal::NotTheEdge)
        );
        assert_eq!(
            g.check(T, G, S, "older", &fp(), t0),
            Err(Refusal::NotTheEdge)
        );
        assert_eq!(g.check("t2", G, S, P, &fp(), t0), Err(Refusal::NoEdge));
        assert_eq!(
            g.check(T, G, S, P, &fp(), t0 + Duration::from_secs(2)),
            Ok(())
        );
        assert_eq!(g.check(T, G, S, P, &fp(), t0), Err(Refusal::AlreadyUsed));
    }

    #[test]
    fn the_window_is_ten_seconds() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        g.prompt(T, G, S, P, Some(&fp()), t0);
        assert_eq!(
            g.check(T, G, S, P, &fp(), t0 + WINDOW + Duration::from_millis(1)),
            Err(Refusal::TooOld)
        );
        g.prompt(T, G, S, P, Some(&fp()), t0);
        assert_eq!(g.check(T, G, S, P, &fp(), t0 + WINDOW), Ok(()));
    }

    #[test]
    fn a_tool_call_after_the_edge_proves_the_prompt_ran() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        g.tool_ran(T); // no edge: nothing to mark
        g.prompt(T, G, S, P, Some(&fp()), t0);
        g.tool_ran(T);
        assert_eq!(g.check(T, G, S, P, &fp(), t0), Err(Refusal::ToolRan));
        // The next prompt starts clean.
        g.prompt(T, G, S, "p2", Some(&fp()), t0);
        assert_eq!(g.check(T, G, S, "p2", &fp(), t0), Ok(()));
    }

    #[test]
    fn a_block_report_closes_an_edge_that_is_here_and_mutes_a_late_one() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        // Edge first: the caller has to close the turn it opened.
        g.prompt(T, G, S, P, Some(&fp()), t0);
        assert!(g.block(T, G, P, &fp(), t0));
        assert!(!g.block(T, "gen2", P, &fp(), t0), "other generation");
        assert!(
            !g.block(T, G, P, &Fingerprint::of("guess"), t0),
            "other text"
        );
        // Report first: the late edge is muted.
        assert!(!g.block(T, G, "late", &fp(), t0));
        assert!(g.prompt(T, G, S, "late", Some(&fp()), t0 + Duration::from_secs(1)));
        // ... but only while the report is fresh.
        assert!(!g.block(T, G, "stale", &fp(), t0));
        assert!(!g.prompt(
            T,
            G,
            S,
            "stale",
            Some(&fp()),
            t0 + BLOCKED_TTL + Duration::from_secs(1)
        ));
        // A muted edge still answers its own resubmit.
        assert_eq!(
            g.check(
                T,
                G,
                S,
                "stale",
                &fp(),
                t0 + BLOCKED_TTL + Duration::from_secs(1)
            ),
            Ok(())
        );
    }

    #[test]
    fn blocked_ids_are_bounded_and_forget_drops_everything() {
        let mut g = Gate::default();
        let t0 = Instant::now();
        for i in 0..20 {
            g.block(T, G, &format!("p{i}"), &fp(), t0);
        }
        assert_eq!(g.panes[T].blocked.len(), BLOCKED_KEEP);
        assert!(g.prompt(T, G, S, "p19", Some(&fp()), t0));
        assert!(!g.prompt(T, G, S, "p0", Some(&fp()), t0));
        g.forget(T);
        assert_eq!(g.check(T, G, S, "p0", &fp(), t0), Err(Refusal::NoEdge));
    }

    #[test]
    fn only_masked_text_passes() {
        // Built at runtime: a literal placeholder in source would be one the
        // workspace's own masking might resolve.
        let ph = |typ: &str, hash: &str| format!("[{typ}_{hash}]");
        let ok = ph("IBAN", "0a1b2c3d");
        assert!(is_masked_prompt(&format!("Check account {ok} please")));
        assert!(is_masked_prompt(&ph("MAIL", "00ff00ff")));
        assert!(is_masked_prompt(&format!(
            "{} and more",
            ph("API_KEY2", "0a1b2c3d")
        )));
        assert!(!is_masked_prompt("no placeholder at all"));
        assert!(!is_masked_prompt("   "));
        assert!(
            !is_masked_prompt(&ph("iban", "0a1b2c3d")),
            "lower-case type"
        );
        assert!(!is_masked_prompt(&ph("IBAN", "0A1B2C3D")), "upper-case hex");
        assert!(!is_masked_prompt(&ph("IBAN", "0a1b2c3")), "seven digits");
        assert!(!is_masked_prompt(&ph("", "0a1b2c3d")), "no type");
        assert!(!is_masked_prompt(ok.trim_end_matches(']')), "unclosed");
        let big = format!("{ok}{}", "x".repeat(MAX_TEXT));
        assert!(!is_masked_prompt(&big));
    }

    #[test]
    fn modes_only_tighten() {
        use ResubmitMode::*;
        assert_eq!(Send.min(Insert), Insert);
        assert_eq!(Insert.min(Send), Insert);
        assert_eq!(Send.min(Off), Off);
        assert_eq!(Send.min(Send), Send);
        let m: ResubmitMode = serde_json::from_str("\"insert\"").unwrap();
        assert_eq!(m, Insert);
    }
}
