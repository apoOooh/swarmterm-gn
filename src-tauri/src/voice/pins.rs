//! Pins: the pane that owned the keyboard when recording began, bound to its
//! PTY generation. Opaque to the client, single-use, short-lived — a pin
//! that outlives its dictation could later type into a pane the user has
//! long forgotten about. Pure apart from the id generator, clock injected.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const PIN_TTL: Duration = Duration::from_secs(120);
/// Bounds the map even if a client begins and never inserts.
const MAX_PINS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub terminal_id: String,
    pub spawn_id: String,
    pub created: Instant,
}

#[derive(Default)]
pub struct PinStore {
    pins: HashMap<String, Pin>,
}

impl PinStore {
    pub fn issue(&mut self, terminal_id: String, spawn_id: String, now: Instant) -> String {
        self.pins
            .retain(|_, p| now.duration_since(p.created) < PIN_TTL);
        if self.pins.len() >= MAX_PINS {
            if let Some(oldest) = self
                .pins
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(k, _)| k.clone())
            {
                self.pins.remove(&oldest);
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.pins.insert(
            id.clone(),
            Pin {
                terminal_id,
                spawn_id,
                created: now,
            },
        );
        id
    }

    /// Consumes the pin: a second insert with it fails, so a client retry
    /// after an unclear outcome can never paste twice.
    pub fn redeem(&mut self, pin: &str, now: Instant) -> Option<Pin> {
        let p = self.pins.remove(pin)?;
        (now.duration_since(p.created) < PIN_TTL).then_some(p)
    }

    pub fn cancel(&mut self, pin: &str) {
        self.pins.remove(pin);
    }

    pub fn revoke_all(&mut self) {
        self.pins.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_redeems_once() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let id = s.issue("t1".into(), "g1".into(), now);
        assert_eq!(s.redeem(&id, now).map(|p| p.spawn_id), Some("g1".into()));
        assert!(s.redeem(&id, now).is_none());
    }

    #[test]
    fn expired_cancelled_and_revoked_pins_are_gone() {
        let mut s = PinStore::default();
        let now = Instant::now();
        let old = s.issue("t1".into(), "g1".into(), now);
        assert!(s.redeem(&old, now + PIN_TTL).is_none());
        let c = s.issue("t1".into(), "g1".into(), now);
        s.cancel(&c);
        assert!(s.redeem(&c, now).is_none());
        let r = s.issue("t1".into(), "g1".into(), now);
        s.revoke_all();
        assert!(s.redeem(&r, now).is_none());
    }

    #[test]
    fn the_store_stays_bounded() {
        let mut s = PinStore::default();
        let now = Instant::now();
        for i in 0..100 {
            s.issue(format!("t{i}"), "g".into(), now + Duration::from_millis(i));
        }
        assert!(s.pins.len() <= MAX_PINS);
    }
}
