//! Per-pane subscription usage (Claude Code `rate_limits`), fed by the status
//! line's `/status` probe — same transport as `context_usage`.
//!
//! WHY this source and no other: Claude Code hands the status line a
//! structured `rate_limits` object (5-hour and 7-day windows, each with
//! `used_percentage` and `resets_at` in epoch seconds). That is the only
//! account-usage number any supported CLI exposes as data; anything read off
//! the terminal would be scraped text, which the handoff must never present as
//! usage. Codex has no structured equivalent, so its usage stays "unknown".
//!
//! Encoding and parsing of the query live together in this file so the probe
//! (sender) and the `/status` handler (receiver) cannot drift apart. The
//! parameters ride the same request as `ctx=`: `rl5`/`rl7` are percentages,
//! `rl5r`/`rl7r` reset times. A window without a valid percentage is simply
//! absent — never 0 %.
//!
//! Dedupe works like `ContextUsage`: only a change of the ROUNDED percentages
//! (or of a reset time) becomes an `agent:usage` event, because Claude re-runs
//! the status line many times per second while streaming. Unlike context, a
//! missing sample does NOT clear the last value: rate limits belong to the
//! account, not to the conversation, so a pane that has not called the API
//! yet says nothing new about the account.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One rate-limit window as Claude Code sends it on the status line's stdin.
#[derive(Debug, Default, Clone, Copy, PartialEq, Deserialize)]
pub struct RawWindow {
    pub used_percentage: Option<f64>,
    pub resets_at: Option<f64>,
}

/// The `rate_limits` object of the status line payload.
#[derive(Debug, Default, Clone, Copy, PartialEq, Deserialize)]
pub struct RawRateLimits {
    pub five_hour: Option<RawWindow>,
    pub seven_day: Option<RawWindow>,
}

/// A validated window: whole percent plus optional reset (epoch seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub pct: u8,
    pub resets_at: Option<u64>,
}

/// Both windows, each absent when Claude Code did not report it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
}

impl RateLimits {
    pub fn is_empty(&self) -> bool {
        self.five_hour.is_none() && self.seven_day.is_none()
    }
}

fn pct_of(v: f64) -> Option<u8> {
    (v.is_finite() && (0.0..=100.0).contains(&v)).then_some(v.round() as u8)
}

fn reset_of(v: f64) -> Option<u64> {
    (v.is_finite() && v > 0.0).then_some(v as u64)
}

fn window_of(raw: Option<RawWindow>) -> Option<Window> {
    let raw = raw?;
    Some(Window {
        pct: pct_of(raw.used_percentage?)?,
        resets_at: raw.resets_at.and_then(reset_of),
    })
}

/// Reduce the raw payload to what is shown. Garbage per window is dropped.
pub fn from_raw(raw: Option<&RawRateLimits>) -> RateLimits {
    let Some(raw) = raw else {
        return RateLimits::default();
    };
    RateLimits {
        five_hour: window_of(raw.five_hour),
        seven_day: window_of(raw.seven_day),
    }
}

/// Query parameters for the probe, each prefixed with `&` so the caller can
/// append them after `?ctx=…` or turn the first `&` into `?`.
pub fn to_query(limits: &RateLimits) -> String {
    let mut out = String::new();
    for (key, w) in [("rl5", limits.five_hour), ("rl7", limits.seven_day)] {
        if let Some(w) = w {
            out.push_str(&format!("&{key}={}", w.pct));
            if let Some(r) = w.resets_at {
                out.push_str(&format!("&{key}r={r}"));
            }
        }
    }
    out
}

fn param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}

/// Lenient for the same reason as `parse_ctx_query`: a malformed cosmetic
/// parameter must never turn the probe into a 400 (`mcp ✗`).
pub fn parse_query(query: Option<&str>) -> RateLimits {
    let Some(q) = query else {
        return RateLimits::default();
    };
    let window = |key: &str, reset_key: &str| -> Option<Window> {
        let pct = pct_of(param(q, key)?.parse::<f64>().ok()?)?;
        let resets_at = param(q, reset_key)
            .and_then(|v| v.parse::<f64>().ok())
            .and_then(reset_of);
        Some(Window { pct, resets_at })
    };
    RateLimits {
        five_hour: window("rl5", "rl5r"),
        seven_day: window("rl7", "rl7r"),
    }
}

/// Last broadcast limits per terminal id. Entries die with the PTY (`forget`).
#[derive(Debug, Default)]
pub struct RateLimitUsage {
    by_id: HashMap<String, RateLimits>,
}

impl RateLimitUsage {
    /// `Some(limits)` when the sample differs from what was last broadcast for
    /// this pane; `None` for an empty sample or no change.
    pub fn record(&mut self, id: &str, limits: RateLimits) -> Option<RateLimits> {
        if limits.is_empty() || self.by_id.get(id) == Some(&limits) {
            return None;
        }
        self.by_id.insert(id.to_owned(), limits);
        Some(limits)
    }

    pub fn forget(&mut self, id: &str) {
        self.by_id.remove(id);
    }
}

/// Payload of the `agent:usage` event (camelCase, lockstep with
/// `src/tauri/agent-state.ts::AgentUsageEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageEvent {
    pub terminal_id: String,
    #[serde(flatten)]
    pub limits: RateLimits,
    pub at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(json: &str) -> RawRateLimits {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn from_raw_keeps_valid_windows() {
        let r = raw(
            r#"{"five_hour":{"used_percentage":42.4,"resets_at":1760000000},
                        "seven_day":{"used_percentage":7}}"#,
        );
        assert_eq!(
            from_raw(Some(&r)),
            RateLimits {
                five_hour: Some(Window {
                    pct: 42,
                    resets_at: Some(1_760_000_000)
                }),
                seven_day: Some(Window {
                    pct: 7,
                    resets_at: None
                }),
            }
        );
    }

    #[test]
    fn from_raw_drops_garbage_and_missing() {
        assert!(from_raw(None).is_empty());
        let r = raw(r#"{"five_hour":{"used_percentage":101},"seven_day":{"resets_at":5}}"#);
        assert!(from_raw(Some(&r)).is_empty());
    }

    #[test]
    fn query_round_trips() {
        let l = RateLimits {
            five_hour: Some(Window {
                pct: 42,
                resets_at: Some(1_760_000_000),
            }),
            seven_day: Some(Window {
                pct: 0,
                resets_at: None,
            }),
        };
        let q = to_query(&l);
        assert_eq!(q, "&rl5=42&rl5r=1760000000&rl7=0");
        assert_eq!(parse_query(Some(&format!("ctx=1{q}"))), l);
        assert_eq!(to_query(&RateLimits::default()), "");
    }

    #[test]
    fn parse_query_is_lenient() {
        assert!(parse_query(None).is_empty());
        assert!(parse_query(Some("ctx=3")).is_empty());
        assert!(parse_query(Some("rl5=abc&rl7=NaN")).is_empty());
        assert!(parse_query(Some("rl5=-1&rl7=200")).is_empty());
        // `rl5r` must not be mistaken for `rl5`.
        assert!(parse_query(Some("rl5r=99")).is_empty());
        let only_reset_garbage = parse_query(Some("rl5=10&rl5r=x"));
        assert_eq!(
            only_reset_garbage.five_hour,
            Some(Window {
                pct: 10,
                resets_at: None
            })
        );
    }

    #[test]
    fn record_dedupes_and_ignores_empty() {
        let mut u = RateLimitUsage::default();
        let a = RateLimits {
            five_hour: Some(Window {
                pct: 10,
                resets_at: None,
            }),
            seven_day: None,
        };
        assert_eq!(u.record("t", a), Some(a));
        assert_eq!(u.record("t", a), None);
        // An empty sample keeps the last value (account data, not session data).
        assert_eq!(u.record("t", RateLimits::default()), None);
        let b = RateLimits {
            five_hour: Some(Window {
                pct: 11,
                resets_at: None,
            }),
            seven_day: None,
        };
        assert_eq!(u.record("t", b), Some(b));
        u.forget("t");
        assert_eq!(u.record("t", b), Some(b));
    }

    #[test]
    fn event_serialises_camel_case_flat() {
        let e = AgentUsageEvent {
            terminal_id: "t".into(),
            limits: RateLimits {
                five_hour: Some(Window {
                    pct: 42,
                    resets_at: Some(9),
                }),
                seven_day: None,
            },
            at_ms: 1,
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"terminalId":"t","fiveHour":{"pct":42,"resetsAt":9},"sevenDay":null,"atMs":1}"#
        );
    }
}
