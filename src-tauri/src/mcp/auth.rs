#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalId(pub String);

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// Header absent, empty, or whitespace.
    Missing,
    /// Token doesn't map to a currently-live terminal (killed, or never existed).
    Unknown,
}

/// Resolve a bearer token to a live TerminalId, or explain why not.
/// The token is the pane's secret (`mcp::session_tokens`), never its public
/// id: `live_owner(token)` returns the id of the currently-running PTY that
/// secret belongs to, or `None`.
pub fn resolve(
    token: &str,
    live_owner: impl Fn(&str) -> Option<String>,
) -> Result<TerminalId, AuthError> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(AuthError::Missing);
    }
    live_owner(trimmed)
        .map(TerminalId)
        .ok_or(AuthError::Unknown)
}

/// Pull the token out of an `Authorization` header value. Only the
/// `Bearer <token>` form is accepted: every first-party writer (MCP configs,
/// hook CLI, status probe) sends the scheme, and a bare token is treated as
/// missing (empty → `AuthError::Missing`) so the header follows RFC 6750
/// strictly rather than accepting whatever a client happens to send.
pub fn bearer(header: &str) -> &str {
    header.strip_prefix("Bearer ").unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Secret "abc-123" belongs to live pane "pane-1".
    fn is_live(token: &str) -> Option<String> {
        (token == "abc-123").then(|| "pane-1".to_owned())
    }

    #[test]
    fn resolves_live_token() {
        assert_eq!(resolve("abc-123", is_live), Ok(TerminalId("pane-1".into())));
    }

    #[test]
    fn rejects_empty_token() {
        assert_eq!(resolve("", is_live), Err(AuthError::Missing));
        assert_eq!(resolve("   ", is_live), Err(AuthError::Missing));
    }

    #[test]
    fn rejects_unknown_token() {
        assert_eq!(resolve("ghost", is_live), Err(AuthError::Unknown));
    }

    #[test]
    fn the_public_pane_id_is_not_a_token() {
        assert_eq!(resolve("pane-1", is_live), Err(AuthError::Unknown));
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(
            resolve("  abc-123  ", is_live),
            Ok(TerminalId("pane-1".into()))
        );
    }

    #[test]
    fn bearer_strips_the_scheme_prefix() {
        assert_eq!(bearer("Bearer abc-123"), "abc-123");
    }

    #[test]
    fn bearer_rejects_a_bare_token() {
        assert_eq!(bearer("abc-123"), "");
        assert_eq!(resolve(bearer("abc-123"), is_live), Err(AuthError::Missing));
    }

    #[test]
    fn bearer_rejects_other_schemes() {
        assert_eq!(bearer("Basic abc-123"), "");
        assert_eq!(bearer("bearerabc-123"), "");
    }

    #[test]
    fn bearer_handles_an_empty_header() {
        assert_eq!(bearer(""), "");
    }
}
