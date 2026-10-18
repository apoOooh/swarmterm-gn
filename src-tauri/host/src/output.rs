//! Output decoding and coalescing, moved from the app's `pty.rs` (ADR 0001).
//! The flusher still joins whole UTF-8 strings, so data frames and the ring
//! buffer never split a multibyte character.

/// Output coalescing (see `engine::read_loop`): a burst is batched for up to
/// OUTPUT_COALESCE or OUTPUT_BATCH_BYTES; output after OUTPUT_IDLE of silence
/// is sent immediately.
pub const OUTPUT_COALESCE: std::time::Duration = std::time::Duration::from_millis(4);
pub const OUTPUT_IDLE: std::time::Duration = std::time::Duration::from_millis(16);
pub const OUTPUT_BATCH_BYTES: usize = 64 * 1024;
pub const READ_BUF_BYTES: usize = 64 * 1024;

/// Drain the largest valid-UTF-8 prefix from `buf`, leaving any incomplete
/// trailing multibyte sequence behind for the next read. Bytes that cannot begin
/// or continue a valid sequence are genuinely invalid, so they are flushed
/// lossily immediately rather than stalling the stream waiting for a completion
/// that will never come.
pub fn take_valid_utf8(buf: &mut Vec<u8>) -> Option<String> {
    if buf.is_empty() {
        return None;
    }
    let valid_up_to = match std::str::from_utf8(buf) {
        Ok(s) => s.len(),
        Err(e) => e.valid_up_to(),
    };
    if valid_up_to == 0 {
        // Nothing decodes yet. Wait for more bytes only if the leading byte could
        // plausibly start a multibyte sequence and we haven't already buffered a
        // full char's worth (max 4 bytes). Otherwise the bytes are invalid —
        // flush lossily so the stream never stalls.
        // The three ranges are the 2-, 3- and 4-byte UTF-8 lead classes. They
        // happen to be contiguous, but they are kept split so the classes stay
        // legible next to the UTF-8 spec.
        #[allow(clippy::manual_range_patterns)]
        let leads_multibyte = matches!(buf[0], 0xC2..=0xDF | 0xE0..=0xEF | 0xF0..=0xF4);
        if leads_multibyte && buf.len() < 4 {
            return None;
        }
        let s = String::from_utf8_lossy(buf).into_owned();
        buf.clear();
        return Some(s);
    }
    let s = std::str::from_utf8(&buf[..valid_up_to])
        .expect("valid_up_to guarantees valid utf8")
        .to_owned();
    buf.drain(..valid_up_to);
    Some(s)
}

/// Join `first` with whatever follows it on `rx`: only what is already queued
/// after a quiet spell (`idle`), else up to OUTPUT_COALESCE / OUTPUT_BATCH_BYTES.
/// Order is preserved; a closed channel just ends the batch.
pub fn next_batch(rx: &std::sync::mpsc::Receiver<String>, mut text: String, idle: bool) -> String {
    let deadline = std::time::Instant::now()
        + if idle {
            std::time::Duration::ZERO
        } else {
            OUTPUT_COALESCE
        };
    while text.len() < OUTPUT_BATCH_BYTES {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(more) => text.push_str(&more),
            Err(_) => break,
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_batch_joins_queued_chunks_in_order() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("b".to_string()).unwrap();
        tx.send("c".to_string()).unwrap();
        assert_eq!(next_batch(&rx, "a".into(), false), "abc");
    }

    #[test]
    fn next_batch_idle_takes_only_what_is_queued() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("b".to_string()).unwrap();
        let start = std::time::Instant::now();
        assert_eq!(next_batch(&rx, "a".into(), true), "ab");
        assert!(start.elapsed() < OUTPUT_COALESCE * 10);
        drop(tx);
    }

    #[test]
    fn next_batch_stops_at_the_byte_cap() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("y".to_string()).unwrap();
        let big = "x".repeat(OUTPUT_BATCH_BYTES);
        assert_eq!(next_batch(&rx, big.clone(), false), big);
        assert_eq!(rx.try_recv().unwrap(), "y");
    }

    #[test]
    fn next_batch_ends_on_closed_channel() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        drop(tx);
        assert_eq!(next_batch(&rx, "a".into(), false), "a");
    }

    #[test]
    fn take_valid_utf8_returns_complete_prefix_and_holds_partial_tail() {
        // "é" is 0xC3 0xA9; feed only the first byte after an ascii char.
        let mut buf = vec![b'h', b'i', 0xC3];
        let out = take_valid_utf8(&mut buf).unwrap();
        assert_eq!(out, "hi");
        assert_eq!(buf, vec![0xC3]); // incomplete tail retained
    }

    #[test]
    fn take_valid_utf8_completes_across_chunks() {
        let mut buf = vec![0xC3, 0xA9]; // full "é"
        let out = take_valid_utf8(&mut buf).unwrap();
        assert_eq!(out, "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn take_valid_utf8_flushes_long_invalid_runs() {
        let mut buf = vec![0xFF, 0xFE, 0xFD, 0xFC, 0xFB];
        let out = take_valid_utf8(&mut buf).unwrap();
        assert!(!out.is_empty()); // lossy, but does not stall
        assert!(buf.is_empty());
    }

    #[test]
    fn take_valid_utf8_flushes_short_invalid_runs() {
        let mut buf = vec![0xFF, 0xFE, 0xFD]; // 3 invalid bytes, not a multibyte lead
        let out = take_valid_utf8(&mut buf).unwrap();
        assert!(!out.is_empty());
        assert!(buf.is_empty()); // flushed immediately, not stalled
    }
}
