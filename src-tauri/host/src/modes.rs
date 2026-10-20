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

/// Private modes that change how input is encoded, what the terminal
/// reports or how output wraps. Value = whether the mode is on by default.
///
/// Deliberately absent: 2026 (synchronized output). A TUI wraps each frame
/// in `?2026h … ?2026l`; prefixing an `h` whose `l` was not replayed would
/// freeze rendering until the next frame, and the replay re-applies every
/// later pair anyway.
const TRACKED: &[(u16, bool)] = &[
    (1, false),    // DECCKM: application cursor keys
    (7, true),     // DECAWM: autowrap
    (25, true),    // DECTCEM: cursor visible
    (1000, false), // mouse: button events
    (1002, false), // mouse: button + drag
    (1003, false), // mouse: any motion
    (1004, false), // focus in/out reports
    (1005, false), // mouse: UTF-8 encoding
    (1006, false), // mouse: SGR encoding
    (1015, false), // mouse: urxvt encoding
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
        let mut i = 0;
        while i < bytes.len() {
            if self.parse == Parse::Ground {
                // Plain text dominates terminal output: jump straight to the
                // next ESC instead of matching byte by byte.
                match memchr::memchr(0x1b, &bytes[i..]) {
                    Some(n) => {
                        self.begin(at + (i + n) as u64);
                        i += n + 1;
                        continue;
                    }
                    None => return,
                }
            }
            let b = bytes[i];
            let pos = at + i as u64;
            i += 1;
            self.step(b, pos);
        }
    }

    /// One byte outside Ground.
    fn step(&mut self, b: u8, pos: u64) {
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

/// Where a ring that lost its front should start: the cut may have split
/// an escape sequence, and its remains (`1;31m`) would print as text. Start
/// at the first `ESC` or after the first LF, whichever comes first; neither
/// = the whole tail. Never skips an `ESC`, so no tracked switch is lost.
pub fn resync(bytes: &[u8]) -> usize {
    match bytes.iter().position(|&b| b == 0x1b || b == b'\n') {
        Some(i) if bytes[i] == b'\n' => i + 1,
        Some(i) => i,
        None => 0,
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
    fn focus_autowrap_and_the_other_mouse_encodings_are_restored() {
        let p = plan(&[b"\x1b[?1004h\x1b[?7l\x1b[?1005h\x1b[?1015h"], 0);
        assert_eq!(p.prefix, b"\x1b[?7l\x1b[?1004h\x1b[?1005h\x1b[?1015h");
    }

    #[test]
    fn synchronized_output_is_never_prefixed() {
        // A frame cut between its `h` and `l`.
        let p = plan(&[b"\x1b[?2026hframe"], 0);
        assert!(p.prefix.is_empty());
    }

    #[test]
    fn resync_skips_the_remains_of_a_cut_sequence() {
        // (d2) the ring starts inside `ESC[1;31m`.
        assert_eq!(resync(b"1;31mred\x1b[0m"), 8);
        assert_eq!(resync(b"31m tail\r\nnext"), 10);
        assert_eq!(resync(b"\x1b[0mclean"), 0);
        assert_eq!(resync(b"plain"), 0);
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

    /// The byte-by-byte loop `feed` replaced; the reference for its tests.
    fn feed_reference(t: &mut ModeTracker, at: u64, bytes: &[u8]) {
        for (i, &b) in bytes.iter().enumerate() {
            t.step(b, at + i as u64);
        }
    }

    fn state(t: &ModeTracker) -> String {
        format!(
            "{:?}|{}|{:?}|{:?}|{}|{:?}|{}|{}|{:?}|{:?}",
            t.parse,
            t.seq_start,
            t.params,
            t.cur,
            t.overflow,
            t.modes,
            t.alt,
            t.alt_before,
            t.switches,
            t.plan(0)
        )
    }

    /// xorshift: deterministic, no extra dev-dependency.
    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn random_input(seed: &mut u64, escape_heavy: bool) -> Vec<u8> {
        const PIECES: &[&[u8]] = &[
            b"[?1049h",
            b"[?1049l",
            b"[?47h",
            b"[?1;2004h",
            b"[?25l",
            b"[?1006;1000h",
            b"c",
            b"[31m",
            b"[?",
            b"",
            b"[",
            b"[?1049h",
            b";",
            b"12",
            b"[?1:2h",
            b"[?1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17h",
            b"hello ",
            b"
",
        ];
        let len = (rng(seed) % 400) as usize;
        let mut out = Vec::new();
        while out.len() < len {
            let r = rng(seed);
            if escape_heavy || r.is_multiple_of(4) {
                out.extend_from_slice(PIECES[(r >> 8) as usize % PIECES.len()]);
            } else {
                out.push((r >> 16) as u8);
            }
        }
        out
    }

    #[test]
    fn memchr_feed_matches_the_byte_loop() {
        let mut seed = 0x9e37_79b9_7f4a_7c15;
        for round in 0..2000u32 {
            let input = random_input(&mut seed, round.is_multiple_of(2));
            let (mut fast, mut slow) = (ModeTracker::default(), ModeTracker::default());
            // Random batch splits, so state carried across feeds is covered.
            let mut at = 0;
            while at < input.len() {
                let n = 1 + (rng(&mut seed) % 64) as usize;
                let end = (at + n).min(input.len());
                fast.feed(at as u64, &input[at..end]);
                feed_reference(&mut slow, at as u64, &input[at..end]);
                assert_eq!(state(&fast), state(&slow), "round {round} at {at}");
                at = end;
            }
        }
    }

    /// Not a timing assert (the machine is shared): runs both paths over a
    /// large mostly-plain buffer so a regression shows up in `--nocapture`.
    #[test]
    fn feed_micro_benchmark() {
        let mut buf = Vec::new();
        for i in 0..20_000 {
            buf.extend_from_slice(b"compiling crate foo v1.0.0 (path)  ");
            if i % 50 == 0 {
                buf.extend_from_slice(b"[32m[?25l[?2026h");
            }
        }
        let t = std::time::Instant::now();
        let mut fast = ModeTracker::default();
        fast.feed(0, &buf);
        let fast_time = t.elapsed();
        let t = std::time::Instant::now();
        let mut slow = ModeTracker::default();
        feed_reference(&mut slow, 0, &buf);
        let slow_time = t.elapsed();
        assert_eq!(state(&fast), state(&slow));
        println!(
            "feed {} bytes: memchr {fast_time:?}, byte loop {slow_time:?}",
            buf.len()
        );
    }
}
