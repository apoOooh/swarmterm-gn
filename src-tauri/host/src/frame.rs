//! Wire framing between app and host.
//!
//! Every frame is `[kind: u8][len: u32 LE][payload; len]`. JSON frames carry
//! requests, answers and events; data frames carry raw PTY output as
//! `[id_len: u8][terminal id][gen_len: u8][spawn id][bytes]`. The spawn id is
//! in every data frame because a killed generation keeps flushing until its
//! reader sees EOF — after `removed`, and possibly after a same-id respawn
//! was created. In-process each generation had its own channel; over one
//! pipe the client needs the tag to drop stale bytes.
//!
//! Output is binary on purpose (ADR 0001): a 64 KB burst batch would
//! otherwise pay JSON string escaping on every flush, which is exactly the
//! cost the 4 ms coalescing avoids. Length prefixes instead of
//! newline-delimited JSON also mean a request can carry any bytes (pasted
//! text with newlines) without a second escape layer.

/// A JSON frame (request, answer or event).
pub const KIND_JSON: u8 = 1;
/// A PTY output frame.
pub const KIND_DATA: u8 = 2;

const HEADER: usize = 5;

/// Upper bound for one frame in either direction. The input queue accepts one
/// write of any size on an idle pane (`input::PtyInput::send`), but a paste
/// of more than this is not a keystroke stream; it is refused as `too-large`
/// and the connection closes, as in the voice pipe.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Json(Vec<u8>),
    Data {
        terminal_id: String,
        spawn_id: String,
        bytes: Vec<u8>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    TooLarge,
    UnknownKind(u8),
    BadData,
}

pub fn encode_json(payload: &[u8]) -> Vec<u8> {
    encode(KIND_JSON, &[payload])
}

/// Terminal and spawn ids are UUIDs; anything over 255 bytes cannot be
/// framed and is a programming error on the caller's side (`create` refuses
/// longer terminal ids).
pub fn encode_data(terminal_id: &str, spawn_id: &str, bytes: &[u8]) -> Vec<u8> {
    let id = terminal_id.as_bytes();
    let gen = spawn_id.as_bytes();
    assert!(
        id.len() <= u8::MAX as usize && gen.len() <= u8::MAX as usize,
        "id too long to frame"
    );
    encode(
        KIND_DATA,
        &[&[id.len() as u8], id, &[gen.len() as u8], gen, bytes],
    )
}

fn encode(kind: u8, parts: &[&[u8]]) -> Vec<u8> {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    let mut out = Vec::with_capacity(HEADER + len);
    out.push(kind);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// Split `[len: u8][utf-8 string]` off the front of `payload`.
fn take_str(payload: &[u8]) -> Result<(String, &[u8]), FrameError> {
    let len = *payload.first().ok_or(FrameError::BadData)? as usize;
    let s = payload.get(1..1 + len).ok_or(FrameError::BadData)?;
    let s = std::str::from_utf8(s).map_err(|_| FrameError::BadData)?;
    Ok((s.to_owned(), &payload[1 + len..]))
}

/// Incremental decoder: feed whatever the pipe returned, then pull complete
/// frames. The size limit is checked from the header, before the payload is
/// buffered, so a hostile length never grows memory past one read.
///
/// Cursor-based (perf phase 3): `next_frame` only advances `pos`; consumed
/// bytes are dropped in `feed`, once per read instead of once per frame, so a
/// read holding many small frames no longer shifts the tail per frame
/// (quadratic). Each payload is copied exactly once, out of the buffer.
pub struct Decoder {
    buf: Vec<u8>,
    /// Start of the first unconsumed byte in `buf`.
    pos: usize,
    limit: usize,
}

impl Default for Decoder {
    fn default() -> Self {
        Decoder {
            buf: Vec::new(),
            pos: 0,
            limit: MAX_FRAME,
        }
    }
}

impl Decoder {
    /// Lower the frame limit: before authentication the server accepts only
    /// a small `hello`, not 16 MiB from a peer that has no token.
    pub fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        // Compact before growing: everything before `pos` is consumed. A
        // fully drained buffer just resets (the common case: whole frames
        // per read); otherwise only the partial tail moves, once per read.
        if self.pos == self.buf.len() {
            self.buf.clear();
            self.pos = 0;
        } else if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// Bytes fed but not yet returned as frames.
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let rest = &self.buf[self.pos..];
        if rest.len() < HEADER {
            return Ok(None);
        }
        let kind = rest[0];
        if kind != KIND_JSON && kind != KIND_DATA {
            return Err(FrameError::UnknownKind(kind));
        }
        let len = u32::from_le_bytes(rest[1..HEADER].try_into().unwrap()) as usize;
        if len > self.limit {
            return Err(FrameError::TooLarge);
        }
        if rest.len() < HEADER + len {
            return Ok(None);
        }
        let payload = &rest[HEADER..HEADER + len];
        let frame = match kind {
            KIND_JSON => Frame::Json(payload.to_vec()),
            _ => {
                let (terminal_id, rest) = take_str(payload)?;
                let (spawn_id, bytes) = take_str(rest)?;
                Frame::Data {
                    terminal_id,
                    spawn_id,
                    bytes: bytes.to_vec(),
                }
            }
        };
        self.pos += HEADER + len;
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip() {
        let mut d = Decoder::default();
        d.feed(&encode_json(br#"{"op":"list"}"#));
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Json(br#"{"op":"list"}"#.to_vec()))
        );
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn data_round_trip_keeps_raw_bytes_and_generation() {
        let raw: &[u8] = &[0x1b, b'[', b'3', b'1', b'm', b'r', 13, 10, 0];
        let mut d = Decoder::default();
        d.feed(&encode_data("t-1", "g-1", raw));
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Data {
                terminal_id: "t-1".into(),
                spawn_id: "g-1".into(),
                bytes: raw.to_vec()
            })
        );
    }

    #[test]
    fn frames_split_across_reads_are_reassembled_in_order() {
        let mut wire = encode_json(b"{}");
        wire.extend(encode_data("a", "g", b"xy"));
        let mut d = Decoder::default();
        let mut got = Vec::new();
        for b in wire {
            d.feed(&[b]);
            while let Some(f) = d.next_frame().unwrap() {
                got.push(f);
            }
        }
        assert_eq!(
            got,
            vec![
                Frame::Json(b"{}".to_vec()),
                Frame::Data {
                    terminal_id: "a".into(),
                    spawn_id: "g".into(),
                    bytes: b"xy".to_vec()
                }
            ]
        );
    }

    #[test]
    fn oversized_length_is_refused_from_the_header() {
        let mut d = Decoder::default();
        let mut header = vec![KIND_JSON];
        header.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        d.feed(&header);
        assert_eq!(d.next_frame(), Err(FrameError::TooLarge));
    }

    #[test]
    fn a_lowered_limit_is_checked_from_the_header() {
        let mut d = Decoder::default();
        d.set_limit(4096);
        let mut header = vec![KIND_JSON];
        header.extend_from_slice(&4097u32.to_le_bytes());
        d.feed(&header);
        assert_eq!(d.next_frame(), Err(FrameError::TooLarge));
    }

    #[test]
    fn unknown_kind_is_an_error() {
        let mut d = Decoder::default();
        d.feed(&[9, 0, 0, 0, 0]);
        assert_eq!(d.next_frame(), Err(FrameError::UnknownKind(9)));
    }

    #[test]
    fn data_frame_with_truncated_id_is_bad() {
        let mut d = Decoder::default();
        d.feed(&encode(KIND_DATA, &[&[5], b"ab"]));
        assert_eq!(d.next_frame(), Err(FrameError::BadData));
    }

    #[test]
    fn data_frame_without_spawn_id_is_bad() {
        let mut d = Decoder::default();
        d.feed(&encode(KIND_DATA, &[&[1], b"a"]));
        assert_eq!(d.next_frame(), Err(FrameError::BadData));
    }

    #[test]
    fn empty_data_payload_is_bad() {
        let mut d = Decoder::default();
        d.feed(&encode(KIND_DATA, &[]));
        assert_eq!(d.next_frame(), Err(FrameError::BadData));
    }

    #[test]
    fn many_frames_in_one_read_come_out_in_order_and_drain_the_buffer() {
        let mut wire = Vec::new();
        for i in 0..1000u32 {
            wire.extend(encode_data("t", "g", &i.to_le_bytes()));
        }
        wire.extend(encode_json(b"{}"));
        let mut d = Decoder::default();
        d.feed(&wire);
        for i in 0..1000u32 {
            match d.next_frame().unwrap() {
                Some(Frame::Data { bytes, .. }) => assert_eq!(bytes, i.to_le_bytes()),
                other => panic!("frame {i}: {other:?}"),
            }
        }
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Json(b"{}".to_vec())));
        assert_eq!(d.next_frame().unwrap(), None);
        assert_eq!(d.buffered(), 0);
        // The next read starts from an empty buffer, not after 1000 frames.
        d.feed(&encode_json(b"[]"));
        assert_eq!(d.buffered(), HEADER + 2);
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Json(b"[]".to_vec())));
    }

    #[test]
    fn a_frame_split_across_reads_keeps_only_the_partial_tail() {
        let first = encode_json(b"{\"a\":1}");
        let second = encode_data("t", "g", b"hello");
        let mut wire = first.clone();
        wire.extend(&second);
        let cut = first.len() + 7;
        let mut d = Decoder::default();
        d.feed(&wire[..cut]);
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Json(b"{\"a\":1}".to_vec()))
        );
        assert_eq!(d.next_frame().unwrap(), None);
        assert_eq!(d.buffered(), 7);
        d.feed(&wire[cut..]);
        assert_eq!(d.buffered(), second.len());
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Data {
                terminal_id: "t".into(),
                spawn_id: "g".into(),
                bytes: b"hello".to_vec()
            })
        );
        assert_eq!(d.buffered(), 0);
    }

    #[test]
    fn a_large_frame_arrives_over_many_reads() {
        let big: Vec<u8> = (0..4 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        let wire = encode_data("t", "g", &big);
        let mut d = Decoder::default();
        let mut got = None;
        for chunk in wire.chunks(65_536) {
            d.feed(chunk);
            if let Some(f) = d.next_frame().unwrap() {
                assert!(got.is_none());
                got = Some(f);
            }
        }
        match got {
            Some(Frame::Data { bytes, .. }) => assert!(bytes == big),
            other => panic!("{other:?}"),
        }
        assert_eq!(d.buffered(), 0);
    }

    #[test]
    fn a_frame_at_the_limit_is_accepted() {
        let mut d = Decoder::default();
        d.set_limit(8);
        d.feed(&encode_json(b"12345678"));
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Json(b"12345678".to_vec()))
        );
    }
}
