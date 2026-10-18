//! Terminal modes a replay must restore (SWA-56, ADR 0001 phase 3).
//!
//! The ring cuts bytes at the front, so the `DECSET` that switched a TUI to
//! the alternate screen, turned on mouse reporting or bracketed paste may be
//! gone by the time a client attaches. Replayed as-is, Claude Code's
//! fullscreen UI would land in the normal buffer and the mouse wheel or a
//! paste would reach it in the wrong encoding. So the flusher feeds every
//! batch through this tracker (under the pane's `Output` lock, like the
//! ring), and `attach` asks it how to start the replay:
//!
//! - modes that are not at their default are put in front of the replay
//!   (their final state: the replay itself re-applies every later change);
//! - the alternate screen is not a flag but a buffer switch, so its toggles
//!   are kept with their position. If the ring starts inside an alternate
//!   segment (its `h` was cut off) and that segment ended, the replay starts
//!   after the `l` — otherwise the TUI's frames would paint over the shell's
//!   history in the normal buffer. If it is still active, the switch is put
//!   in front instead. Complete segments replay unchanged, so the shell's
//!   output before a TUI is still there when it exits.
//!
//! The parser keeps its state across batches: a sequence split by a flush
//! is still recognised.

use std::collections::VecDeque;

/// Private modes that change how input is encoded or the cursor is shown.
/// Value = whether the mode is on by default.
const TRACKED: &[(u16, bool)] = &[
    (1, false),    // DECCKM: application cursor keys
    (25, true),    // DECTCEM: cursor visible
    (1000, false), // mouse: button events
    (1002, false), // mouse: button + drag
    (1003, false), // mouse: any motion
    (1006, false), // mouse: SGR encoding
    (2004, false), // bracketed paste
];

/// Alternate screen variants; all three switch buffers.
const ALT: &[u16] = &[1049, 1047, 47];

const MAX_PARAMS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Parse {
    Ground,
    Esc,
    /// After `ESC [`; `private` once a `?` came first.
    Csi {
        private: bool,
    },
}

/// One alternate-screen switch, in output-total coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
struct AltSwitch {
    /// Offset of the sequence's `ESC`.
    start: u64,
    /// Offset just after its final byte.
    end: u64,
    on: bool,
}

#[derive(Debug, PartialEq)]
pub struct ReplayPlan {
    /// Output-total offset the replay starts at (≥ the ring's start).
    pub start: u64,
    /// Sequences to send before the replayed bytes.
    pub prefix: Vec<u8>,
}

pub struct ModeTracker {
    parse: Parse,
    seq_start: u64,
    params: Vec<u32>,
    cur: Option<u32>,
    overflow: bool,
    modes: Vec<bool>,
    alt: bool,
    /// Whether the alternate screen was on before the oldest retained switch.
    alt_before: bool,
    switches: VecDeque<AltSwitch>,
}

impl Default for ModeTracker {
    fn default() -> Self {
        ModeTracker {
            parse: Parse::Ground,
            seq_start: 0,
            params: Vec::new(),
            cur: None,
            overflow: false,
            modes: TRACKED.iter().map(|&(_, d)| d).collect(),
            alt: false,
            alt_before: false,
            switches: VecDeque::new(),
        }
    }
}

impl ModeTracker {
    /// Feed one batch; `at` is the output total before it.
    pub fn feed(&mut self, at: u64, bytes: &[u8]) {
        for (i, &b) in bytes.iter().enumerate() {
            let pos = at + i as u64;
            match self.parse {
                Parse::Ground => {
                    if b == 0x1b {
                        self.begin(pos);
                    }
                }
                Parse::Esc => match b {
                    b'[' => self.parse = Parse::Csi { private: false },
                    // RIS: full reset, back to the defaults and the normal screen.
                    b'c' => {
                        self.reset(pos + 1);
                        self.parse = Parse::Ground;
                    }
                    0x1b => self.begin(pos),
                    _ => self.parse = Parse::Ground,
                },
                Parse::Csi { private } => match b {
                    b'?' if self.params.is_empty() && self.cur.is_none() && !private => {
                        self.parse = Parse::Csi { private: true }
                    }
                    b'0'..=b'9' => {
                        let d = u32::from(b - b'0');
                        self.cur = Some(self.cur.unwrap_or(0).saturating_mul(10).saturating_add(d));
                    }
                    b';' => self.push_param(),
                    0x40..=0x7e => {
                        self.push_param();
                        if private && !self.overflow && (b == b'h' || b == b'l') {
                            self.apply(b == b'h', pos + 1);
                        }
                        self.parse = Parse::Ground;
                    }
                    0x1b => self.begin(pos),
                    // Intermediates, ':' sub-parameters, controls: not a
                    // DECSET we track.
                    _ => self.parse = Parse::Ground,
                },
            }
        }
    }

    fn begin(&mut self, pos: u64) {
        self.parse = Parse::Esc;
        self.seq_start = pos;
        self.params.clear();
        self.cur = None;
        self.overflow = false;
    }

    fn push_param(&mut self) {
        if self.params.len() >= MAX_PARAMS {
            self.overflow = true;
        } else {
            self.params.push(self.cur.unwrap_or(0));
        }
        self.cur = None;
    }

    fn apply(&mut self, on: bool, end: u64) {
        let params = std::mem::take(&mut self.params);
        for &p in &params {
            if let Some(i) = TRACKED.iter().position(|&(m, _)| u32::from(m) == p) {
                self.modes[i] = on;
            } else if ALT.iter().any(|&m| u32::from(m) == p) && self.alt != on {
                self.alt = on;
                self.switches.push_back(AltSwitch {
                    start: self.seq_start,
                    end,
                    on,
                });
            }
        }
        self.params = params;
    }

    fn reset(&mut self, end: u64) {
        for (m, &(_, d)) in self.modes.iter_mut().zip(TRACKED) {
            *m = d;
        }
        if self.alt {
            self.alt = false;
            self.switches.push_back(AltSwitch {
                start: self.seq_start,
                end,
                on: false,
            });
        }
    }

    /// Forget switches that start before the ring's first retained byte.
    pub fn prune(&mut self, ring_start: u64) {
        while self.switches.front().is_some_and(|s| s.start < ring_start) {
            let s = self.switches.pop_front().expect("checked");
            self.alt_before = s.on;
        }
    }

    /// How to replay a ring that starts at `ring_start` (call `prune` first).
    pub fn plan(&self, ring_start: u64) -> ReplayPlan {
        let mut prefix = Vec::new();
        let mut start = ring_start;
        if self.alt_before {
            match self.switches.iter().find(|s| !s.on) {
                // The segment whose `h` was cut ended: skip its frames.
                Some(off) => start = off.end,
                // Still in it: switch first, then the frames.
                None => prefix.extend_from_slice(b"\x1b[?1049h"),
            }
        }
        for (&on, &(mode, default)) in self.modes.iter().zip(TRACKED) {
            if on != default {
                let f = if on { 'h' } else { 'l' };
                prefix.extend_from_slice(format!("\x1b[?{mode}{f}").as_bytes());
            }
        }
        ReplayPlan { start, prefix }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `chunks` back to back from offset 0, then plan for `ring_start`.
    fn plan(chunks: &[&[u8]], ring_start: u64) -> ReplayPlan {
        let mut t = ModeTracker::default();
        let mut at = 0u64;
        for c in chunks {
            t.feed(at, c);
            at += c.len() as u64;
        }
        t.prune(ring_start);
        t.plan(ring_start)
    }

    #[test]
    fn plain_output_replays_unchanged() {
        assert_eq!(
            plan(&[b"hello\r\n"], 0),
            ReplayPlan {
                start: 0,
                prefix: vec![]
            }
        );
    }

    #[test]
    fn a_complete_alt_segment_replays_unchanged() {
        // (a) h…l entirely inside the ring.
        let p = plan(&[b"$ claude\r\n\x1b[?1049hUI\x1b[?1049l$ "], 0);
        assert_eq!(p.start, 0);
        assert!(p.prefix.is_empty());
    }

    #[test]
    fn a_ring_starting_inside_an_ended_alt_segment_skips_it() {
        // (b) the `h` at 0 is cut off, the `l` is retained.
        let out = b"\x1b[?1049hUI-frames\x1b[?1049l$ ";
        let l_end = out.len() as u64 - 2;
        let p = plan(&[out], 3);
        assert_eq!(p.start, l_end);
        assert!(p.prefix.is_empty());
    }

    #[test]
    fn an_alt_segment_active_at_the_end_is_replayed_with_its_history() {
        // (c) the `h` is in the ring: replay from the start, the shell
        // history lands in the normal buffer and the UI in the alternate.
        let p = plan(&[b"history\r\n\x1b[?1049hUI"], 0);
        assert_eq!(p.start, 0);
        assert!(p.prefix.is_empty());
    }

    #[test]
    fn an_alt_segment_whose_switch_was_cut_off_is_switched_first() {
        // (c) with the `h` before the ring: put the switch in front.
        let p = plan(&[b"\x1b[?1049hUI frames"], 4);
        assert_eq!(p.start, 4);
        assert_eq!(p.prefix, b"\x1b[?1049h");
    }

    #[test]
    fn a_switch_split_across_batches_is_recognised() {
        // (d)
        let p = plan(&[b"x\x1b[?10", b"49hUI\x1b[", b"?1049l$"], 2);
        assert_eq!(p.start, 19);
        assert!(p.prefix.is_empty());
        let p = plan(&[b"x\x1b[?10", b"49hUI"], 3);
        assert_eq!(p.prefix, b"\x1b[?1049h");
    }

    #[test]
    fn the_older_alt_variants_count_too() {
        // (e)
        let p = plan(&[b"\x1b[?1047hUI\x1b[?1047l$"], 2);
        assert_eq!(p.start, 18);
        let p = plan(&[b"\x1b[?47hUI"], 2);
        assert_eq!(p.prefix, b"\x1b[?1049h");
    }

    #[test]
    fn input_modes_are_restored_in_their_final_state() {
        let p = plan(
            &[b"\x1b[?1h\x1b[?2004h\x1b[?1000;1006h\x1b[?25l\x1b[?1l"],
            0,
        );
        assert_eq!(p.prefix, b"\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    }

    #[test]
    fn a_full_reset_returns_to_the_defaults() {
        let p = plan(&[b"\x1b[?1049h\x1b[?2004h", b"\x1bc$ "], 0);
        assert!(p.prefix.is_empty());
        assert_eq!(p.start, 0);
    }

    #[test]
    fn other_sequences_are_ignored() {
        // Non-private DECSET, SGR, an OSC and a CSI with intermediates.
        let p = plan(
            &[b"\x1b[4h\x1b[1;31m\x1b]0;title\x07\x1b[?1049$p\x1b[?2004h"],
            0,
        );
        assert_eq!(p.prefix, b"\x1b[?2004h");
        assert_eq!(p.start, 0);
    }

    #[test]
    fn repeated_switches_in_one_state_are_not_doubled() {
        let mut t = ModeTracker::default();
        t.feed(0, b"\x1b[?1049h\x1b[?1049h");
        assert_eq!(t.switches.len(), 1);
    }

    #[test]
    fn too_many_parameters_are_ignored_whole() {
        let mut seq = String::from("\x1b[?");
        for _ in 0..MAX_PARAMS {
            seq.push_str("1;");
        }
        seq.push_str("2004h");
        let p = plan(&[seq.as_bytes()], 0);
        assert!(p.prefix.is_empty());
    }
}
