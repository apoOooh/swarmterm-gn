//! SWA-86: the request gate in front of every loopback route.
//!
//! Loopback is not a trust boundary: any local process can connect, and a web
//! page can too — directly (`fetch` to 127.0.0.1) or by DNS rebinding its own
//! name onto 127.0.0.1. So:
//!
//! - `Host` must name loopback with OUR port. A rebound page sends its own
//!   hostname, which is the one thing it cannot fake. Exactly one header:
//!   two would let a parser difference decide which one counts.
//! - `/mcp` additionally refuses browser requests (Origin / Fetch Metadata,
//!   which no MCP client we write configs for sends) and needs a bearer that
//!   maps to a LIVE pane — before rmcp sees the body, so `initialize` and
//!   `tools/list` are covered, not only tool calls.
//!
//! Pure over `HeaderMap` so the rules are unit-tested without a server.
//! Nothing here logs: the header carries the pane's secret.

use axum::http::{header, HeaderMap, StatusCode};

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    /// Missing, repeated or non-loopback `Host`, or a foreign port.
    Host,
    /// Origin or Fetch Metadata present: a browser made this request.
    Browser,
    /// No bearer, an unknown one, or one whose pane is gone.
    Auth,
}

impl Reject {
    pub fn status(&self) -> StatusCode {
        match self {
            Reject::Host | Reject::Browser => StatusCode::FORBIDDEN,
            Reject::Auth => StatusCode::UNAUTHORIZED,
        }
    }
}

/// `Host` names loopback on `port`. Compared as whole strings against a fixed
/// list, so `127.0.0.1.evil.example`, userinfo or a missing port never pass.
pub fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    let mut values = headers.get_all(header::HOST).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return false;
    };
    let Ok(host) = value.to_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|name| host == format!("{name}:{port}"))
}

/// A browser can reach loopback too. Every browser request carries Origin or
/// Fetch Metadata; our CLIs, the stdio relay and data-shield's guard send
/// neither.
pub fn from_browser(headers: &HeaderMap) -> bool {
    ["origin", "sec-fetch-site", "sec-fetch-mode"]
        .iter()
        .any(|h| headers.contains_key(*h))
}

/// The `/mcp` decision: Host, then browser, then bearer → live pane id.
/// Order matters only for the answer code; every branch denies.
pub fn check_mcp(
    headers: &HeaderMap,
    port: u16,
    live_owner: impl FnOnce(&str) -> Option<String>,
) -> Result<String, Reject> {
    if !host_ok(headers, port) {
        return Err(Reject::Host);
    }
    if from_browser(headers) {
        return Err(Reject::Browser);
    }
    let header = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or(Reject::Auth)?;
    let token = super::auth::bearer(header);
    if token.is_empty() {
        return Err(Reject::Auth);
    }
    live_owner(token).ok_or(Reject::Auth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const PORT: u16 = 52431;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn owner(t: &str) -> Option<String> {
        (t == "good").then(|| "pane-1".to_string())
    }

    #[test]
    fn loopback_hosts_with_our_port_pass() {
        for host in [
            "127.0.0.1:52431",
            "localhost:52431",
            "LOCALHOST:52431",
            "[::1]:52431",
        ] {
            assert!(host_ok(&headers(&[("host", host)]), PORT), "{host}");
        }
    }

    #[test]
    fn foreign_hosts_fail() {
        for host in [
            "evil.example:52431",
            "127.0.0.1.evil.example:52431",
            "127.0.0.1:1",
            "127.0.0.1",
            "localhost",
            "user@127.0.0.1:52431",
            "127.0.0.1:52431@evil",
            "",
        ] {
            assert!(!host_ok(&headers(&[("host", host)]), PORT), "{host}");
        }
        assert!(!host_ok(&HeaderMap::new(), PORT));
    }

    #[test]
    fn a_repeated_host_header_fails() {
        let h = headers(&[("host", "127.0.0.1:52431"), ("host", "127.0.0.1:52431")]);
        assert!(!host_ok(&h, PORT));
    }

    #[test]
    fn non_ascii_host_fails_without_panic() {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_bytes(b"\xff:52431").unwrap());
        assert!(!host_ok(&h, PORT));
    }

    #[test]
    fn mcp_needs_a_live_bearer() {
        let host = ("host", "127.0.0.1:52431");
        assert_eq!(check_mcp(&headers(&[host]), PORT, owner), Err(Reject::Auth));
        assert_eq!(
            check_mcp(
                &headers(&[host, ("authorization", "Bearer nope")]),
                PORT,
                owner
            ),
            Err(Reject::Auth)
        );
        assert_eq!(
            check_mcp(&headers(&[host, ("authorization", "Bearer ")]), PORT, owner),
            Err(Reject::Auth)
        );
        assert_eq!(
            check_mcp(
                &headers(&[host, ("authorization", "Bearer good")]),
                PORT,
                owner
            ),
            Ok("pane-1".into())
        );
    }

    #[test]
    fn mcp_refuses_browsers_even_with_a_good_bearer() {
        for h in ["origin", "sec-fetch-site", "sec-fetch-mode"] {
            let hm = headers(&[
                ("host", "127.0.0.1:52431"),
                ("authorization", "Bearer good"),
                (h, "x"),
            ]);
            assert_eq!(check_mcp(&hm, PORT, owner), Err(Reject::Browser), "{h}");
        }
    }

    #[test]
    fn mcp_refuses_a_rebound_host_before_looking_at_the_token() {
        let hm = headers(&[
            ("host", "evil.example:52431"),
            ("authorization", "Bearer good"),
        ]);
        let mut looked = false;
        let r = check_mcp(&hm, PORT, |t| {
            looked = true;
            owner(t)
        });
        assert_eq!(r, Err(Reject::Host));
        assert!(!looked);
    }

    #[test]
    fn status_codes() {
        assert_eq!(Reject::Host.status(), StatusCode::FORBIDDEN);
        assert_eq!(Reject::Browser.status(), StatusCode::FORBIDDEN);
        assert_eq!(Reject::Auth.status(), StatusCode::UNAUTHORIZED);
    }
}
