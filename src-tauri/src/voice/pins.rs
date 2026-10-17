//! Pins: the pane that owned the keyboard when recording began, bound to its
//! PTY generation. Opaque to the client, single-use, short-lived — a pin
//! that outlives its dictation could later type into a pane the user has
//! long forgotten about. Pure apart from the id generator, clock injected.
//!
//! Indicator pins (SWA-40) also belong to a pipe connection and drive the
//! "listening" pill. Every way a pin can disappear returns it, so the hub
//! turns the pill off and pushes the reason in exactly one place — a removal
//! that went unreported would leave a pill standing forever.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::protocol::CancelReason;

pub const PIN_TTL: Duration = Duration::from_secs(120);
/// Bounds the map even if a client begins and never inserts.
const MAX_PINS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub id: String,
    pub terminal_id: String,
    pub spawn_id: String,
    pub created: Instant,
    /// The connection that holds the dictation. `Some` = indicator pin.
    pub conn: Option<u64>,
}

impl Pin {
    pub fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.created) >= PIN_TTL
    }
}

#[derive(Default)]
pub struct PinStore {
    pins: HashMap<String, Pin>,
}

impl PinStore {
    /// Issues a fresh pin and returns what had to go to make room for it:
    /// expired pins, the oldest one over the bound, and — for an indicator
    /// pin — an earlier indicator pin on the same pane (one pill per pane).
    /// Legacy pins are never superseded, proto-1 clients behave as before.
    /// Runs under the store's lock, so two racing begins resolve atomically.
    pub fn issue(
        &mut self,
        terminal_id: String,
        spawn_id: String,
        conn: Option<u64>,
        now: Instant,
    ) -> (String, Vec<(Pin, CancelReason)>) {
        let mut removed = self.take_where(|p| p.expired(now), CancelReason::Expired);
        if conn.is_some() {
            removed.extend(self.take_where(
                |p| p.conn.is_some() && p.terminal_id == terminal_id,
                CancelReason::Superseded,
            ));
        }
        if self.pins.len() >= MAX_PINS {
            if let Some(oldest) = self
                .pins
                .values()
                .min_by_key(|p| p.created)
                .map(|p| p.id.clone())
            {
                let p = self.pins.remove(&oldest).expect("present");
                removed.push((p, CancelReason::Superseded));
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.pins.insert(
            id.clone(),
            Pin {
                id: id.clone(),
                terminal_id,
                spawn_id,
                created: now,
                conn,
            },
        );
        (id, removed)
    }

    /// Consumes the pin: a second insert with it fails, so a client retry
    /// after an unclear outcome can never paste twice. An expired pin is
    /// removed too and comes back as `Err(Some(_))` so its pill goes off.
    pub fn redeem(&mut self, pin: &str, now: Instant) -> Result<Pin, Option<Pin>> {
        let p = self.pins.remove(pin).ok_or(None)?;
        if p.expired(now) {
            Err(Some(p))
        } else {
            Ok(p)
        }
    }

    pub fn remove(&mut self, pin: &str) -> Option<Pin> {
        self.pins.remove(pin)
    }

    /// Everything the closed connection held. No reason: nobody is left to
    /// tell.
    pub fn remove_conn(&mut self, conn: u64) -> Vec<Pin> {
        self.take(|p| p.conn == Some(conn))
    }

    pub fn is_indicator(&self, pin: &str) -> bool {
        self.pins.get(pin).is_some_and(|p| p.conn.is_some())
    }

    /// The pane died or respawned; its indicator pins point at a shell that
    /// is gone. Legacy pins stay: their insert reports `target-gone` from
    /// the generation check, exactly as proto 1 always did.
    pub fn remove_terminal(&mut self, terminal_id: &str) -> Vec<(Pin, CancelReason)> {
        self.take_where(
            |p| p.conn.is_some() && p.terminal_id == terminal_id,
            CancelReason::TargetGone,
        )
    }

    pub fn remove_expired(&mut self, now: Instant) -> Vec<(Pin, CancelReason)> {
        self.take_where(|p| p.expired(now), CancelReason::Expired)
    }

    pub fn revoke_all(&mut self) -> Vec<(Pin, CancelReason)> {
        self.take_where(|_| true, CancelReason::Disabled)
    }

    /// The pane a live pin points at (the built-in source labels its state).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn terminal_of(&self, pin: &str) -> Option<String> {
        self.pins.get(pin).map(|p| p.terminal_id.clone())
    }

    /// Whether the connection still holds an open dictation (it then gets
    /// the pin's lifetime as idle timeout instead of the short default).
    /// Some dictation is recording right now (half-duplex gate, SWA-66).
    /// Expired pins are dead even before a sweep removes them.
    pub fn any_live(&self, now: Instant) -> bool {
        self.pins.values().any(|p| !p.expired(now))
    }

    pub fn conn_has_pin(&self, conn: u64) -> bool {
        self.pins.values().any(|p| p.conn == Some(conn))
    }

    fn take(&mut self, pred: impl Fn(&Pin) -> bool) -> Vec<Pin> {
        let ids: Vec<String> = self
            .pins
            .values()
            .filter(|p| pred(p))
            .map(|p| p.id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| self.pins.remove(&id))
            .collect()
    }

    fn take_where(
        &mut self,
        pred: impl Fn(&Pin) -> bool,
        reason: CancelReason,
    ) -> Vec<(Pin, CancelReason)> {
        self.take(pred).into_iter().map(|p| (p, reason)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[(Pin, CancelReason)]) -> Vec<(&str, CancelReason)> {
        v.iter().map(|(p, r)| (p.id.as_str(), *r)).collect()
    }

    #[test]
    fn a_pin_redeems_once() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (id, _) = s.issue("t1".into(), "g1".into(), None, now);
        assert_eq!(s.redeem(&id, now).map(|p| p.spawn_id), Ok("g1".into()));
        assert_eq!(s.redeem(&id, now), Err(None));
    }

    #[test]
    fn expired_cancelled_and_revoked_pins_are_gone_and_reported() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (old, _) = s.issue("t1".into(), "g1".into(), Some(1), now);
        assert!(matches!(s.redeem(&old, now + PIN_TTL), Err(Some(p)) if p.id == old));
        let (c, _) = s.issue("t1".into(), "g1".into(), None, now);
        assert_eq!(s.remove(&c).map(|p| p.id), Some(c.clone()));
        assert!(s.redeem(&c, now).is_err());
        let (r, _) = s.issue("t1".into(), "g1".into(), None, now);
        assert_eq!(
            ids(&s.revoke_all()),
            vec![(r.as_str(), CancelReason::Disabled)]
        );
        assert!(s.redeem(&r, now).is_err());
    }

    #[test]
    fn issue_reports_expired_pins_it_sweeps() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (old, _) = s.issue("t1".into(), "g1".into(), Some(1), now);
        let (_, removed) = s.issue("t2".into(), "g1".into(), None, now + PIN_TTL);
        assert_eq!(ids(&removed), vec![(old.as_str(), CancelReason::Expired)]);
    }

    #[test]
    fn a_second_indicator_begin_supersedes_only_indicator_pins_of_that_pane() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (legacy, _) = s.issue("t1".into(), "g1".into(), None, now);
        let (first, _) = s.issue("t1".into(), "g1".into(), Some(1), now);
        let (other_pane, _) = s.issue("t2".into(), "g1".into(), Some(3), now);
        let (_, removed) = s.issue("t1".into(), "g1".into(), Some(2), now);
        assert_eq!(
            ids(&removed),
            vec![(first.as_str(), CancelReason::Superseded)]
        );
        assert!(!s.is_indicator(&legacy));
        assert!(s.redeem(&legacy, now).is_ok());
        assert!(s.redeem(&other_pane, now).is_ok());
    }

    #[test]
    fn an_insert_in_flight_is_not_superseded() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (first, _) = s.issue("t1".into(), "g1".into(), Some(1), now);
        assert!(s.redeem(&first, now).is_ok());
        let (_, removed) = s.issue("t1".into(), "g1".into(), Some(2), now);
        assert!(removed.is_empty());
    }

    #[test]
    fn connection_and_terminal_cleanup() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (a, _) = s.issue("t1".into(), "g1".into(), Some(7), now);
        s.issue("t2".into(), "g1".into(), Some(8), now);
        assert!(s.conn_has_pin(7));
        assert!(s.is_indicator(&a));
        assert_eq!(
            s.remove_conn(7)
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>(),
            vec![a]
        );
        assert!(!s.conn_has_pin(7));
        let (legacy, _) = s.issue("t2".into(), "g2".into(), None, now);
        let gone = s.remove_terminal("t2");
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].1, CancelReason::TargetGone);
        assert!(!s.conn_has_pin(8));
        assert!(s.redeem(&legacy, now).is_ok());
    }

    #[test]
    fn remove_expired_only_takes_old_pins() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let (old, _) = s.issue("t1".into(), "g1".into(), Some(1), now);
        let (young, _) = s.issue("t2".into(), "g1".into(), Some(2), now + PIN_TTL / 2);
        assert_eq!(
            ids(&s.remove_expired(now + PIN_TTL)),
            vec![(old.as_str(), CancelReason::Expired)]
        );
        assert!(s.redeem(&young, now + PIN_TTL).is_ok());
    }

    #[test]
    fn the_store_stays_bounded_and_reports_evictions() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let mut evicted = 0;
        for i in 0..100 {
            let (_, removed) = s.issue(
                format!("t{i}"),
                "g".into(),
                None,
                now + Duration::from_millis(i),
            );
            evicted += removed.len();
        }
        assert!(s.pins.len() <= MAX_PINS);
        assert_eq!(evicted, 100 - MAX_PINS);
    }
}
