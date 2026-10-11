//! One `POST /hook` to the running Swarmterm, hand-rolled over
//! `std::net::TcpStream`.
//!
//! Same reasoning as `statusline/probe.rs`: this runs inside the `--hook` CLI,
//! a fresh sub-second process that Claude Code spawns per lifecycle event.
//! Booting a tokio runtime (or pulling reqwest) to send ~20 bytes to 127.0.0.1
//! would dwarf the request itself. The framing reuses the probe's `status_addr`
//! (URL → authority) and `parse_http_response` (status + `Content-Length`
//! accumulation) so there is exactly one loopback HTTP/1.1 client in the binary.
//!
//! The server answers `Connection: close` with a `Content-Length`, so there is
//! no chunked or keep-alive case. The result is a bare `bool` — the CLI ignores
//! it (a failed hook is never Claude's problem), it exists so the wire path can
//! be exercised against a real socket in tests.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::hook::{HookBody, Signal};
use crate::statusline::probe::{parse_http_response, status_addr};

/// The raw request bytes. Split out from `post_signal` so the framing can be
/// asserted byte-for-byte without a socket. Host carries the port for the same
/// reason as the probe: the server is on an ephemeral one, and a bare host is a
/// malformed Host header for anything but :80.
pub fn build_request(authority: &str, token: &str, body: &str) -> String {
    format!(
        "POST /hook HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// `true` iff the server answered 2xx. Every failure (refused, timeout, 401,
/// 4xx, malformed URL, unparseable response) is `false` — the CLI ignores it
/// anyway; the bool exists for tests. Deliberately `let … else` rather than `?`:
/// there is no error to propagate, only "did the signal land".
pub fn post_signal(mcp_url: &str, token: &str, signal: Signal, timeout: Duration) -> bool {
    post_body(
        mcp_url,
        token,
        &HookBody {
            signal,
            session: None,
        },
        timeout,
    )
}

pub fn post_body(mcp_url: &str, token: &str, body: &HookBody, timeout: Duration) -> bool {
    // A garbage SWARMTERM_MCP_URL is an env problem: bail before any socket work.
    let Some((_host, authority)) = status_addr(mcp_url) else {
        return false;
    };
    let Some(addr) = authority.to_socket_addrs().ok().and_then(|mut a| a.next()) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }

    // Serialising an enum cannot fail, but the contract is "never panic": a
    // panic is a non-zero exit, which Claude Code surfaces as a hook failure.
    let Ok(body) = serde_json::to_string(body) else {
        return false;
    };
    let req = build_request(&authority, token, &body);
    if stream.write_all(req.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }

    // Same accumulate loop as the probe: stop as soon as `parse_http_response`
    // has a whole message, the peer closes, or a read times out. Capped so a
    // wedged peer can't grow this unbounded — the real answer is a bare 204.
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if parse_http_response(&buf).is_some() || buf.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    matches!(parse_http_response(&buf), Some((code, _)) if (200..300).contains(&code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::Signal;
    use std::io::{Read, Write};
    use std::time::Duration;

    /// Serve one canned response on a loopback port and hand back its URL plus
    /// the raw request the client sent. Unlike the probe's helper this reads
    /// the head AND `Content-Length` bytes of body: a POST carries the signal
    /// JSON, and that body is exactly what these tests need to see.
    fn serve_once(response: &'static [u8]) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut chunk = [0u8; 256];
            loop {
                let n = sock.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&chunk[..n]);
                let Some(head_end) = req.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head_end = head_end + 4;
                let content_length = std::str::from_utf8(&req[..head_end])
                    .ok()
                    .and_then(|head| {
                        head.split("\r\n").find_map(|l| {
                            let (name, value) = l.split_once(':')?;
                            name.trim()
                                .eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                    })
                    .unwrap_or(0);
                if req.len() >= head_end + content_length {
                    break;
                }
            }
            sock.write_all(response).unwrap();
            sock.flush().unwrap();
            // Dropping the socket closes the connection, matching the
            // `Connection: close` the server promises.
            String::from_utf8_lossy(&req).into_owned()
        });
        (url, handle)
    }

    #[test]
    fn build_request_is_a_well_formed_post() {
        let req = build_request("127.0.0.1:5", "tok", "{\"signal\":\"idle\"}");
        assert!(
            req.starts_with("POST /hook HTTP/1.1\r\n"),
            "req was {req:?}"
        );
        assert!(req.contains("Host: 127.0.0.1:5\r\n"));
        assert!(req.contains("Authorization: Bearer tok\r\n"));
        assert!(req.contains("Content-Type: application/json\r\n"));
        assert!(req.contains("Content-Length: 17\r\n"));
        assert!(req.contains("Connection: close\r\n"));
        assert!(
            req.ends_with("\r\n\r\n{\"signal\":\"idle\"}"),
            "req was {req:?}"
        );
    }

    #[test]
    fn post_signal_delivers_the_body_and_reads_204() {
        let (url, server) = serve_once(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert!(post_signal(
            &url,
            "abc-123",
            Signal::Blocked,
            Duration::from_millis(500)
        ));
        let req = server.join().unwrap();
        assert!(req.contains("POST /hook HTTP/1.1\r\n"), "req was {req:?}");
        assert!(req.contains("Authorization: Bearer abc-123\r\n"));
        assert!(
            req.ends_with("\r\n\r\n{\"signal\":\"blocked\"}"),
            "req was {req:?}"
        );
    }

    #[test]
    fn post_signal_treats_401_as_failure() {
        // A dead pane's token: the server refuses, and the CLI has nothing to
        // do about it — but the wire result must not read as delivered.
        let (url, server) = serve_once(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert!(!post_signal(
            &url,
            "ghost",
            Signal::Idle,
            Duration::from_millis(500)
        ));
        server.join().unwrap();
    }

    #[test]
    fn post_signal_is_false_when_nothing_listens() {
        // Port 1 on loopback is reserved and never bound by us; the connect is
        // refused immediately rather than waiting out the timeout.
        assert!(!post_signal(
            "http://127.0.0.1:1/mcp",
            "tok",
            Signal::Idle,
            Duration::from_millis(300)
        ));
    }

    #[test]
    fn post_signal_is_false_on_a_malformed_url() {
        // Must bail before any socket work: a garbage SWARMTERM_MCP_URL is an
        // env problem, not something worth a connect attempt.
        assert!(!post_signal(
            "not a url",
            "tok",
            Signal::Working,
            Duration::from_millis(300)
        ));
    }
}
