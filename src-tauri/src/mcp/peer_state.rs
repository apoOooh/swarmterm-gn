//! Per-terminal *agent display state* and a bounded raw screen tail, kept on
//! the Rust side so MCP verbs can answer "what is that peer doing" without a
//! round-trip to the renderer.
//!
//! Rust has neither of these natively. The PTY reader forwards bytes to xterm
//! and keeps nothing (no screen buffer lives in this process), and agent state
//! (working / blocked / idle / done) is derived entirely in the renderer from
//! xterm output heuristics (`src/lib/agent-state`). The M2 orchestrator verbs
//! (`war_room.wait_peer`, `war_room.read_peer`) need both, and an MCP tool
//! call must not block on a renderer IPC that may never answer (window hidden
//! to tray, webview mid-reload). So the renderer *mirrors* its display state
//! down via `report_agent_state`, and `read_loop` tees a bounded tail of the
//! raw output into the same table.
//!
//! The tail is stored RAW and ANSI-stripped on read, on purpose: a CSI split
//! across two pty chunks (`"\x1b[3" + "1mred"`) only resolves when the whole
//! buffer is scanned at once, and a bare-`\r` progress overwrite (`"50%\r100%"`)
//! needs the preceding text present to know what it replaces. Stripping per
//! chunk would leak half-sequences into what an agent reads. Reads are rare
//! (one per tool call) and the buffer is small (`SCREEN_TAIL_BYTES`), so the
//! strip-on-read cost is irrelevant.
//!
//! Entries are dropped on both PTY death paths (`kill_terminal` and
//! `read_loop` exit), mirroring the War Room auto-leave — a same-id respawn
//! starts from `unknown` and an empty tail.

/// Raw bytes retained per terminal. 64 KiB is a few screens of dense TUI
/// output — enough for `read_peer` to show the last prompt and its answer,
/// small enough that a hundred panes cost nothing noticeable.
pub const SCREEN_TAIL_BYTES: usize = 64 * 1024;

/// Reduce a raw pty stream to the text a human would see on the screen.
///
/// This is deliberately NOT a terminal emulator: no cursor addressing, no
/// scroll regions, no alternate screen. It handles exactly the sequences that
/// dominate agent-CLI output (SGR colour, cursor hide/show, OSC titles,
/// charset designations) plus the one cursor motion that changes visible text
/// without an escape — a bare `\r` progress-bar overwrite. Anything fancier
/// (a full-screen TUI repaint) degrades to "some stale lines remain", which
/// is acceptable for a peer *reading* a pane, not rendering it.
pub fn strip_ansi(raw: &str) -> String {
    #[derive(Clone, Copy)]
    enum St {
        Text,
        Esc,
        /// ESC followed by an intermediate byte (0x20–0x2F): one final byte
        /// still follows (`ESC ( B` charset designation is the common one).
        EscInt,
        Csi,
        Osc,
        /// Saw ESC inside an OSC body — the string terminator is `ESC \`.
        OscEsc,
    }

    let mut out = String::with_capacity(raw.len());
    // Byte offset in `out` where the current line began. A pending `\r` only
    // truncates back to it when the next *visible* char arrives, so
    // `50%\r100%` resolves to `100%` while `\r\n` stays a plain newline.
    let mut line_start = 0usize;
    let mut pending_cr = false;
    let mut st = St::Text;

    for c in raw.chars() {
        // A sequence aborted by an unexpected char re-dispatches that char as
        // text, hence the loop: one char may need two passes.
        loop {
            match st {
                St::Text => {
                    match c {
                        '\x1b' => st = St::Esc,
                        '\r' => pending_cr = true,
                        '\n' => {
                            pending_cr = false;
                            out.push('\n');
                            line_start = out.len();
                        }
                        // Other C0 controls (BEL, BS, …) and DEL move nothing
                        // visible that we model; tab is kept as layout.
                        c if (c < ' ' && c != '\t') || c == '\x7f' => {}
                        c => {
                            if pending_cr {
                                out.truncate(line_start);
                                pending_cr = false;
                            }
                            out.push(c);
                        }
                    }
                    break;
                }
                St::Esc => {
                    st = match c {
                        '[' => St::Csi,
                        ']' => St::Osc,
                        // ESC ESC: the first was stray, keep waiting for the
                        // real introducer.
                        '\x1b' => St::Esc,
                        c if (0x20..=0x2f).contains(&(c as u32)) => St::EscInt,
                        // ESC + one byte (`ESC =`, `ESC 7`, `ESC M` …) has no
                        // visible text of its own.
                        _ => St::Text,
                    };
                    break;
                }
                St::EscInt => {
                    let b = c as u32;
                    if (0x30..=0x7e).contains(&b) {
                        st = St::Text; // final byte
                        break;
                    }
                    if (0x20..=0x2f).contains(&b) {
                        break; // further intermediate byte
                    }
                    // Cut sequence, same recovery as CSI.
                    st = St::Text;
                }
                St::Csi => {
                    let b = c as u32;
                    if (0x40..=0x7e).contains(&b) {
                        st = St::Text; // final byte
                        break;
                    }
                    if (0x20..=0x3f).contains(&b) {
                        break; // parameter / intermediate byte
                    }
                    // Not a CSI byte: the sequence was cut (e.g. the ring
                    // drained through it, or a C0 landed mid-sequence). Drop
                    // what we have and treat this char as text.
                    st = St::Text;
                }
                St::Osc => {
                    match c {
                        '\x07' => st = St::Text,
                        '\x1b' => st = St::OscEsc,
                        _ => {}
                    }
                    break;
                }
                St::OscEsc => {
                    if c == '\\' {
                        st = St::Text;
                        break;
                    }
                    // ESC inside an OSC that is not ST: the OSC was left
                    // unterminated; re-dispatch as a fresh escape.
                    st = St::Esc;
                }
            }
        }
    }
    out
}

/// Last `n` lines of `text` and whether anything was cut. A trailing newline
/// terminates the last line rather than opening an empty one, so `"a\nb\n"`
/// is two lines, not three — matching what a screen shows.
pub fn tail_lines(text: &str, n: usize) -> (String, bool) {
    if text.is_empty() {
        return (String::new(), false);
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<&str> = body.split('\n').collect();
    if lines.len() <= n {
        return (body.to_string(), false);
    }
    (lines[lines.len() - n..].join("\n"), true)
}

/// Smallest index `>= at` that is a char boundary (`at` itself when it is).
/// `str::ceil_char_boundary` is still unstable, hence the hand-rolled walk.
fn ceil_char_boundary(s: &str, mut at: usize) -> usize {
    while at < s.len() && !s.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// Bounded ring of the most recent raw pty bytes for one terminal.
///
/// A `String` drained from the front rather than a `VecDeque<u8>`: pushes are
/// pty-chunk sized and the cap is reached once, after which each push drains
/// roughly its own length — cheap at 64 KiB — and keeping it a `String` makes
/// `as_str()` free for the strip-on-read path. The drain always lands on a
/// char boundary: `take_valid_utf8` guarantees every chunk is whole UTF-8,
/// and cutting a multibyte char in half here would panic on the slice.
pub struct ScreenTail {
    buf: String,
    cap: usize,
}

impl ScreenTail {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: String::new(),
            cap,
        }
    }

    pub fn push(&mut self, s: &str) {
        if s.len() >= self.cap {
            // One chunk alone overflows the ring: nothing older can survive.
            self.buf.clear();
            let start = ceil_char_boundary(s, s.len() - self.cap);
            self.buf.push_str(&s[start..]);
            return;
        }
        self.buf.push_str(s);
        // Trim only past 2× cap: draining down to `cap` on every push memmoved
        // the whole tail per output chunk once it was full. Readers still see
        // at most `cap` bytes via `as_str`.
        if self.buf.len() > 2 * self.cap {
            let cut = ceil_char_boundary(&self.buf, self.buf.len() - self.cap);
            self.buf.drain(..cut);
        }
    }

    pub fn as_str(&self) -> &str {
        let start = ceil_char_boundary(&self.buf, self.buf.len().saturating_sub(self.cap));
        &self.buf[start..]
    }
}

/// One terminal's row in the table. `since_ms` is "how long has it been in
/// this state" for `wait_peer`'s stall detection, so it only moves on a real
/// state change — a renderer re-report of the same state is not news.
struct Peer {
    state: String,
    since_ms: u64,
    last_output_ms: u64,
    tail: ScreenTail,
}

/// What an MCP verb reads back about a peer. Plain `String`/`u64` so T3.2's
/// tool layer can serialise it without reaching into `Peer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSnapshot {
    pub state: String,
    pub since_ms: u64,
    pub last_output_ms: u64,
}

/// The per-terminal table behind `AppState.peer_states`. Pure and lock-free
/// itself: the caller holds the mutex, and the wake-up (`peer_wake`) is the
/// caller's job too, keyed off `set_state`'s return value.
#[derive(Default)]
pub struct PeerStates {
    peers: std::collections::HashMap<String, Peer>,
}

impl PeerStates {
    /// Record the display state the renderer shows for `id`. Returns `true`
    /// iff the entry was inserted or the state actually differs — the only
    /// two cases worth waking a `wait_peer` sleeper for. `since_ms` moves
    /// only on that `true`.
    pub fn set_state(&mut self, id: &str, state: &str, now_ms: u64) -> bool {
        match self.peers.get_mut(id) {
            Some(p) => {
                if p.state == state {
                    return false;
                }
                p.state = state.to_string();
                p.since_ms = now_ms;
                true
            }
            None => {
                self.peers.insert(
                    id.to_string(),
                    Peer {
                        state: state.to_string(),
                        since_ms: now_ms,
                        last_output_ms: now_ms,
                        tail: ScreenTail::new(SCREEN_TAIL_BYTES),
                    },
                );
                true
            }
        }
    }

    /// Tee one pty chunk into `id`'s tail. Creates the row as `"unknown"` when
    /// absent: a plain shell never reports a display state, yet its screen
    /// must still be readable by `read_peer`. Never touches `state`/`since_ms`
    /// — output is not a state change; the renderer decides what output means.
    pub fn push_output(&mut self, id: &str, raw: &str, now_ms: u64) {
        // Hot path (every output batch): look up by `&str` first so the
        // common case allocates nothing; only a first chunk pays for the key.
        if let Some(p) = self.peers.get_mut(id) {
            p.tail.push(raw);
            p.last_output_ms = now_ms;
            return;
        }
        let mut tail = ScreenTail::new(SCREEN_TAIL_BYTES);
        tail.push(raw);
        self.peers.insert(
            id.to_string(),
            Peer {
                state: "unknown".to_string(),
                since_ms: now_ms,
                last_output_ms: now_ms,
                tail,
            },
        );
    }

    /// Drop `id` entirely (pty death). Idempotent — both death paths call it
    /// and whichever runs second finds nothing.
    pub fn forget(&mut self, id: &str) {
        self.peers.remove(id);
    }

    pub fn snapshot(&self, id: &str) -> Option<PeerSnapshot> {
        self.peers.get(id).map(|p| PeerSnapshot {
            state: p.state.clone(),
            since_ms: p.since_ms,
            last_output_ms: p.last_output_ms,
        })
    }

    /// ANSI-stripped view of the raw tail, computed on read — see the module
    /// doc for why the strip runs over the whole buffer rather than per chunk.
    pub fn screen(&self, id: &str) -> Option<String> {
        self.peers.get(id).map(|p| strip_ansi(p.tail.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_ansi ────────────────────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_sgr_colour_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
    }

    #[test]
    fn strip_ansi_removes_private_csi_sequences() {
        // DECTCEM hide-cursor: `?` is a private parameter byte, `l` the final.
        assert_eq!(strip_ansi("\x1b[?25l"), "");
    }

    #[test]
    fn strip_ansi_removes_two_byte_escapes() {
        // ESC ( B — designate G0 charset; no CSI/OSC introducer.
        assert_eq!(strip_ansi("\x1b(B"), "");
    }

    #[test]
    fn strip_ansi_removes_osc_terminated_by_bel() {
        assert_eq!(strip_ansi("\x1b]0;t\x07body"), "body");
    }

    #[test]
    fn strip_ansi_removes_osc_terminated_by_st() {
        assert_eq!(strip_ansi("\x1b]0;t\x1b\\body"), "body");
    }

    #[test]
    fn strip_ansi_drops_c0_controls_except_newline_and_tab() {
        assert_eq!(strip_ansi("a\tb\x07c"), "a\tbc");
    }

    #[test]
    fn strip_ansi_bare_cr_overwrites_the_current_line() {
        assert_eq!(strip_ansi("50%\r100%\n"), "100%\n");
    }

    #[test]
    fn strip_ansi_crlf_is_a_plain_newline() {
        assert_eq!(strip_ansi("line\r\nnext"), "line\nnext");
    }

    #[test]
    fn strip_ansi_is_utf8_safe() {
        assert_eq!(strip_ansi("é\x1b[Kñ"), "éñ");
    }

    // ── tail_lines ────────────────────────────────────────────────────────

    #[test]
    fn tail_lines_returns_last_n_lines_and_flags_truncation() {
        // A trailing newline does not count as an extra empty line.
        assert_eq!(tail_lines("a\nb\nc\n", 2), ("b\nc".to_string(), true));
    }

    #[test]
    fn tail_lines_returns_everything_when_short() {
        assert_eq!(tail_lines("a\nb", 5), ("a\nb".to_string(), false));
    }

    #[test]
    fn tail_lines_of_empty_text_is_empty() {
        assert_eq!(tail_lines("", 3), (String::new(), false));
    }

    // ── ScreenTail ────────────────────────────────────────────────────────

    #[test]
    fn screen_tail_keeps_only_the_last_cap_bytes() {
        let mut t = ScreenTail::new(4);
        t.push("abc");
        t.push("def");
        assert_eq!(t.as_str(), "cdef");
    }

    #[test]
    fn screen_tail_never_splits_a_multibyte_char() {
        // Each 'é' is 2 bytes; a cap of 5 cannot hold an exact number of them,
        // so the front drain must land on a char boundary rather than panic.
        let mut t = ScreenTail::new(5);
        t.push("ééé");
        t.push("éé");
        let s = t.as_str();
        assert!(s.len() <= 5, "len {} exceeds cap", s.len());
        assert!(s.chars().count() > 0);
        assert!(s.is_char_boundary(0));
    }

    #[test]
    fn screen_tail_stays_bounded_across_many_pushes() {
        let mut t = ScreenTail::new(4);
        for c in ["ab", "cd", "ef", "gh", "ij", "kl"] {
            t.push(c);
            assert!(t.as_str().len() <= 4);
            assert!(t.buf.len() <= 2 * 4 + 2);
        }
        assert_eq!(t.as_str(), "ijkl");
    }

    #[test]
    fn screen_tail_single_push_larger_than_cap_keeps_its_tail() {
        let mut t = ScreenTail::new(3);
        t.push("abcdef");
        assert_eq!(t.as_str(), "def");
    }

    // ── PeerStates ────────────────────────────────────────────────────────

    #[test]
    fn set_state_inserts_new_id_and_stamps_since() {
        let mut p = PeerStates::default();
        assert!(p.set_state("t1", "working", 100));
        let snap = p.snapshot("t1").expect("entry exists after set_state");
        assert_eq!(snap.state, "working");
        assert_eq!(snap.since_ms, 100);
    }

    #[test]
    fn set_state_same_state_is_not_a_change_and_keeps_since() {
        // `wait_peer` (T3.2) wakes on `true` only; a renderer re-report of the
        // same display state must neither wake waiters nor reset the clock.
        let mut p = PeerStates::default();
        p.set_state("t1", "working", 100);
        assert!(!p.set_state("t1", "working", 200));
        assert_eq!(p.snapshot("t1").unwrap().since_ms, 100);
    }

    #[test]
    fn set_state_different_state_moves_since() {
        let mut p = PeerStates::default();
        p.set_state("t1", "working", 100);
        assert!(p.set_state("t1", "blocked", 250));
        let snap = p.snapshot("t1").unwrap();
        assert_eq!(snap.state, "blocked");
        assert_eq!(snap.since_ms, 250);
    }

    #[test]
    fn push_output_on_unseen_id_creates_unknown_entry() {
        // Plain shells never report a display state, but their screen must
        // still be readable — the first output chunk creates the row.
        let mut p = PeerStates::default();
        p.push_output("sh", "$ ls\n", 500);
        let snap = p.snapshot("sh").expect("push_output creates the entry");
        assert_eq!(snap.state, "unknown");
        assert_eq!(snap.since_ms, 500);
        assert_eq!(snap.last_output_ms, 500);
        assert_eq!(p.screen("sh").unwrap(), "$ ls\n");
    }

    #[test]
    fn push_output_on_existing_entry_only_touches_last_output() {
        let mut p = PeerStates::default();
        p.set_state("t1", "working", 100);
        p.push_output("t1", "hello", 300);
        let snap = p.snapshot("t1").unwrap();
        assert_eq!(snap.state, "working");
        assert_eq!(snap.since_ms, 100);
        assert_eq!(snap.last_output_ms, 300);
    }

    #[test]
    fn forget_drops_snapshot_and_screen() {
        let mut p = PeerStates::default();
        p.set_state("t1", "working", 100);
        p.push_output("t1", "out", 150);
        p.forget("t1");
        assert!(p.snapshot("t1").is_none());
        assert!(p.screen("t1").is_none());
    }

    #[test]
    fn set_state_after_forget_is_a_fresh_insert() {
        // A same-id respawn must start from scratch: the old `since_ms` and
        // tail belong to a dead pty.
        let mut p = PeerStates::default();
        p.set_state("t1", "working", 100);
        p.push_output("t1", "stale", 150);
        p.forget("t1");
        assert!(p.set_state("t1", "working", 900));
        let snap = p.snapshot("t1").unwrap();
        assert_eq!(snap.since_ms, 900);
        assert_eq!(p.screen("t1").unwrap(), "");
    }

    #[test]
    fn forget_of_unknown_id_is_a_no_op() {
        let mut p = PeerStates::default();
        p.forget("ghost");
        assert!(p.snapshot("ghost").is_none());
    }

    #[test]
    fn snapshot_and_screen_of_unknown_id_are_none() {
        let p = PeerStates::default();
        assert!(p.snapshot("nope").is_none());
        assert!(p.screen("nope").is_none());
    }

    #[test]
    fn screen_strips_ansi_across_chunk_boundaries() {
        // The raw ring is stripped on read, so a CSI cut by a pty chunk
        // boundary resolves once both halves are present.
        let mut p = PeerStates::default();
        p.push_output("t1", "\x1b[3", 1);
        p.push_output("t1", "1mred", 2);
        assert_eq!(p.screen("t1").unwrap(), "red");
    }

    #[test]
    fn screen_is_bounded_by_screen_tail_bytes() {
        let mut p = PeerStates::default();
        let chunk = "x".repeat(SCREEN_TAIL_BYTES);
        p.push_output("t1", &chunk, 1);
        p.push_output("t1", "tail", 2);
        let s = p.screen("t1").unwrap();
        assert!(s.len() <= SCREEN_TAIL_BYTES, "len {} exceeds cap", s.len());
        assert!(s.ends_with("tail"));
    }
}
