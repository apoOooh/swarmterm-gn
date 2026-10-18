//! Wire framing between app and host.
//!
//! Every frame is `[kind: u8][len: u32 LE][payload; len]`. JSON frames carry
//! requests, answers and events; data frames carry raw PTY output as
//! `[id_len: u8][terminal id; id_len][bytes]`. Output is binary on purpose
//! (ADR 0001): a 64 KB burst batch would otherwise pay JSON string escaping
//! on every flush, which is exactly the cost the 4 ms coalescing avoids.
//! Length prefixes instead of newline-delimited JSON also mean a request can
//! carry any bytes (pasted text with newlines) without a second escape layer.

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
    Data { terminal_id: String, bytes: Vec<u8> },
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

/// Terminal ids are UUIDs from the renderer; anything over 255 bytes cannot
/// be framed and is a programming error on the caller's side.
pub fn encode_data(terminal_id: &str, bytes: &[u8]) -> Vec<u8> {
    let id = terminal_id.as_bytes();
    assert!(
        id.len() <= u8::MAX as usize,
        "terminal id too long to frame"
    );
    encode(KIND_DATA, &[&[id.len() as u8], id, bytes])
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

/// Incremental decoder: feed whatever the pipe returned, then pull complete
/// frames. The size limit is checked from the header, before the payload is
/// buffered, so a hostile length never grows memory past one read.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buf.len() < HEADER {
            return Ok(None);
        }
        let kind = self.buf[0];
        if kind != KIND_JSON && kind != KIND_DATA {
            return Err(FrameError::UnknownKind(kind));
        }
        let len = u32::from_le_bytes(self.buf[1..HEADER].try_into().unwrap()) as usize;
        if len > MAX_FRAME {
            return Err(FrameError::TooLarge);
        }
        if self.buf.len() < HEADER + len {
            return Ok(None);
        }
        let payload: Vec<u8> = self.buf[HEADER..HEADER + len].to_vec();
        self.buf.drain(..HEADER + len);
        match kind {
            KIND_JSON => Ok(Some(Frame::Json(payload))),
            _ => {
                let id_len = *payload.first().ok_or(FrameError::BadData)? as usize;
                let id = payload.get(1..1 + id_len).ok_or(FrameError::BadData)?;
                let terminal_id =
                    String::from_utf8(id.to_vec()).map_err(|_| FrameError::BadData)?;
                Ok(Some(Frame::Data {
                    terminal_id,
                    bytes: payload[1 + id_len..].to_vec(),
                }))
            }
        }
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
    fn data_round_trip_keeps_raw_bytes() {
        let mut d = Decoder::default();
        d.feed(&encode_data("t-1", b"\x1b[31mred\r\n\x00"));
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Data {
                terminal_id: "t-1".into(),
                bytes: b"\x1b[31mred\r\n\x00".to_vec()
            })
        );
    }

    #[test]
    fn frames_split_across_reads_are_reassembled_in_order() {
        let mut wire = encode_json(b"{}");
        wire.extend(encode_data("a", b"xy"));
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
    fn empty_data_payload_is_bad() {
        let mut d = Decoder::default();
        d.feed(&encode(KIND_DATA, &[]));
        assert_eq!(d.next_frame(), Err(FrameError::BadData));
    }
}
