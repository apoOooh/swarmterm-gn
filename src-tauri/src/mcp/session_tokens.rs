//! Per-pane MCP bearer secrets, kept apart from the public pane id.
//!
//! A pane's terminal id is shown to other panes (`war_room.list_peers`), so it
//! must never authorise anything. Each spawn instead mints a random secret
//! that only that shell's environment sees (`SWARMTERM_SESSION`); this table
//! maps the secret back to the pane id. Minting for an id replaces its old
//! secret, so a respawn rotates the token. Lookups still require the pane to
//! be live (`auth::resolve` callers check `AppState.terminals`), so a stale
//! entry can never authorise a dead pane.
//!
//! A minted secret is *pending* until its generation enters `terminals`
//! (`settle`). A predecessor generation's late cleanup only drops settled
//! secrets (`forget_settled`), so it can never revoke the secret of a same-id
//! respawn that is still starting; a failed spawn drops its own pending
//! secret with `forget`.

use std::collections::HashMap;

#[derive(Debug)]
struct Entry {
    id: String,
    pending: bool,
}

#[derive(Debug, Default)]
pub struct SessionTokens {
    /// secret -> owning terminal id
    by_token: HashMap<String, Entry>,
}

/// A fresh unguessable secret from the OS RNG: two v4 UUIDs, ~244 random
/// bits (the fixed version bits are padding).
pub fn new_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

impl SessionTokens {
    /// Mint a new pending secret for `id`, revoking any earlier one.
    pub fn mint(&mut self, id: &str) -> String {
        let token = new_secret();
        self.insert(id, &token, true);
        token
    }

    /// The generation holding `id`'s secret is now in `terminals`.
    pub fn settle(&mut self, id: &str) {
        for e in self.by_token.values_mut().filter(|e| e.id == id) {
            e.pending = false;
        }
    }

    /// Register a known secret for `id` (a pane that survived in the terminal
    /// host carries its secret in its environment), revoking any other.
    /// Settled at once: the generation already exists. Blank is ignored.
    pub fn adopt(&mut self, id: &str, token: &str) {
        self.insert(id, token, false);
    }

    fn insert(&mut self, id: &str, token: &str, pending: bool) {
        let token = token.trim();
        if token.is_empty() {
            return;
        }
        self.forget(id);
        self.by_token.insert(
            token.to_owned(),
            Entry {
                id: id.to_owned(),
                pending,
            },
        );
    }

    /// The pane id a secret belongs to, if any.
    pub fn owner(&self, token: &str) -> Option<String> {
        self.by_token.get(token.trim()).map(|e| e.id.clone())
    }

    /// Drop every secret of `id` (pane closed, or its own spawn failed).
    pub fn forget(&mut self, id: &str) {
        self.by_token.retain(|_, e| e.id != id);
    }

    /// Drop `id`'s settled secret only: a pending one belongs to a same-id
    /// respawn that has not reached `terminals` yet.
    pub fn forget_settled(&mut self, id: &str) {
        self.by_token.retain(|_, e| e.id != id || e.pending);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_secret_maps_to_its_pane_and_is_not_the_id() {
        let mut t = SessionTokens::default();
        let s = t.mint("pane-1");
        assert_ne!(s, "pane-1");
        assert_eq!(s.len(), 64);
        assert_eq!(t.owner(&s).as_deref(), Some("pane-1"));
        assert_eq!(t.owner("pane-1"), None);
    }

    #[test]
    fn remint_rotates_the_secret() {
        let mut t = SessionTokens::default();
        let old = t.mint("p");
        let new = t.mint("p");
        assert_ne!(old, new);
        assert_eq!(t.owner(&old), None);
        assert_eq!(t.owner(&new).as_deref(), Some("p"));
    }

    #[test]
    fn forget_only_drops_that_pane() {
        let mut t = SessionTokens::default();
        let a = t.mint("a");
        let b = t.mint("b");
        t.forget("a");
        assert_eq!(t.owner(&a), None);
        assert_eq!(t.owner(&b).as_deref(), Some("b"));
    }

    #[test]
    fn late_cleanup_spares_a_pending_respawn_secret() {
        let mut t = SessionTokens::default();
        t.mint("p");
        t.settle("p");
        // Same-id respawn mints before the old generation's cleanup runs.
        let fresh = t.mint("p");
        t.forget_settled("p");
        assert_eq!(t.owner(&fresh).as_deref(), Some("p"));
        t.settle("p");
        t.forget_settled("p");
        assert_eq!(t.owner(&fresh), None);
    }

    #[test]
    fn forget_drops_a_pending_secret() {
        let mut t = SessionTokens::default();
        let s = t.mint("p");
        t.forget("p");
        assert_eq!(t.owner(&s), None);
    }

    #[test]
    fn adopt_ignores_blank_and_trims() {
        let mut t = SessionTokens::default();
        t.adopt("a", "  ");
        assert_eq!(t.owner(""), None);
        t.adopt("a", " sec ");
        assert_eq!(t.owner("sec").as_deref(), Some("a"));
        assert_eq!(t.owner(" sec ").as_deref(), Some("a"));
    }
}
