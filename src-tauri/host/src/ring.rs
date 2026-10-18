//! Bounded per-pane output history for replay on `attach` (ADR 0001).
//!
//! The flusher only ever pushes whole UTF-8 strings, so the buffer is valid
//! UTF-8 as long as trimming the front never cuts a multibyte sequence: a
//! replay that starts with a stray continuation byte would paint U+FFFD in
//! the first row xterm shows after a restart. Escape sequences CAN still be
//! cut at the front; xterm drops a malformed prefix silently, and the next
//! full redraw of a TUI repairs the screen, which is the same trade every
//! terminal multiplexer with a byte-bounded scrollback makes.

use std::collections::VecDeque;

/// Default history per pane (ADR 0001: 1 MiB).
pub const DEFAULT_CAPACITY: usize = 1024 * 1024;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    /// Bytes ever pushed, so a client can tell how much was dropped.
    total: u64,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring {
            buf: VecDeque::new(),
            cap,
            total: 0,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        // A single push larger than the whole buffer keeps only its tail.
        let bytes = if bytes.len() > self.cap {
            &bytes[bytes.len() - self.cap..]
        } else {
            bytes
        };
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow.min(self.buf.len()));
        self.buf.extend(bytes);
        // Advance past continuation bytes (10xxxxxx) left by the cut. At most
        // three can precede the next lead byte in valid UTF-8.
        while self.buf.front().is_some_and(|b| b & 0xC0 == 0x80) {
            self.buf.pop_front();
        }
    }

    /// The retained history, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }

    /// The retained history from output-total offset `from` on (clamped to
    /// what is retained). `from` must not split a UTF-8 character: the
    /// replay plan points at the ring's start (trimmed to whole characters)
    /// or just after an alternate-screen switch.
    pub fn snapshot_from(&self, from: u64) -> Vec<u8> {
        let skip = from.saturating_sub(self.start()).min(self.buf.len() as u64) as usize;
        self.buf.range(skip..).copied().collect()
    }

    /// Output-total offset of the oldest retained byte.
    pub fn start(&self) -> u64 {
        self.total - self.buf.len() as u64
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_below_capacity() {
        let mut r = Ring::new(16);
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.snapshot(), b"hello world");
        assert_eq!(r.total(), 11);
    }

    #[test]
    fn drops_the_oldest_bytes_past_capacity() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghij");
        assert_eq!(r.snapshot(), b"cdefghij");
        assert_eq!(r.len(), 8);
        assert_eq!(r.total(), 10);
    }

    #[test]
    fn an_oversized_push_keeps_its_tail() {
        let mut r = Ring::new(4);
        r.push(b"x");
        r.push(b"0123456789");
        assert_eq!(r.snapshot(), b"6789");
    }

    #[test]
    fn trimming_never_starts_inside_a_multibyte_char() {
        // "é" is C3 A9; capacity 4 would cut right after C3.
        let mut r = Ring::new(4);
        r.push("aé".as_bytes()); // 61 C3 A9
        r.push(b"bc"); // overflow 1 -> drops 'a', fine
        assert_eq!(std::str::from_utf8(&r.snapshot()).unwrap(), "ébc");
        r.push(b"d"); // overflow 1 -> drops C3, then the orphan A9
        assert_eq!(std::str::from_utf8(&r.snapshot()).unwrap(), "bcd");
    }

    #[test]
    fn four_byte_chars_are_trimmed_whole() {
        let mut r = Ring::new(6);
        r.push("😀".as_bytes()); // F0 9F 98 80
        r.push(b"abc"); // overflow 1 -> F0 dropped, 3 orphans follow
        assert_eq!(r.snapshot(), b"abc");
    }

    #[test]
    fn snapshot_from_counts_in_output_totals() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghij"); // retains cdefghij, start 2
        assert_eq!(r.start(), 2);
        assert_eq!(r.snapshot_from(0), b"cdefghij");
        assert_eq!(r.snapshot_from(5), b"fghij");
        assert_eq!(r.snapshot_from(99), b"");
    }

    #[test]
    fn empty_ring_snapshot_is_empty() {
        let r = Ring::new(DEFAULT_CAPACITY);
        assert!(r.is_empty());
        assert!(r.snapshot().is_empty());
    }
}
