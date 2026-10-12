//! Login state, plan and rate limits per account profile, read from the CLIs'
//! own files. Only metadata leaves this module: tokens are parsed in place and
//! dropped, never serialised to the renderer.
//!
//! WHY local files and no network: both CLIs already persist what the
//! Accounts panel shows. Claude Code keeps `subscriptionType` and token
//! expiries in `<config>/.credentials.json`; Codex keeps the ChatGPT plan in
//! the `id_token` claims of `<CODEX_HOME>/auth.json` and writes its server's
//! `rate_limits` (5 h = `primary`, 7 d = `secondary`) into every rollout's
//! `token_count` event. Calling the providers ourselves would mean handling
//! their tokens — exactly what the profile design avoids.
//!
//! Everything is fail-open: an unreadable or unexpected file yields
//! `LoggedOut`/no usage, never an error that would block the panel.

use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginState {
    /// Credentials present and refreshable.
    Connected,
    /// Credentials present but the CLI can no longer refresh them.
    Expired,
    /// No usable credentials in the profile's folder.
    LoggedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub pct: u8,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    /// When the CLI recorded the sample (epoch ms).
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub state: LoginState,
    pub plan: Option<String>,
    pub email: Option<String>,
    pub usage: Option<Usage>,
}

const MAX_CREDENTIAL_BYTES: u64 = 256 * 1024;
const ROLLOUT_TAIL_BYTES: u64 = 512 * 1024;

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CREDENTIAL_BYTES {
        return None;
    }
    fs::read(path).ok()
}

fn clean_label(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?.trim();
    (!s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control)).then(|| s.to_owned())
}

/// `<config>/.credentials.json` → state + plan. `now_ms` is injected for tests.
pub fn parse_claude_credentials(raw: &[u8], now_ms: u64) -> AccountStatus {
    let logged_out = AccountStatus {
        state: LoginState::LoggedOut,
        plan: None,
        email: None,
        usage: None,
    };
    let Ok(json) = serde_json::from_slice::<Value>(raw) else {
        return logged_out;
    };
    let Some(oauth) = json.get("claudeAiOauth").filter(|v| v.is_object()) else {
        return logged_out;
    };
    let has = |key: &str| {
        oauth
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    if !has("accessToken") && !has("refreshToken") {
        return logged_out;
    }
    let expiry = |key: &str| oauth.get(key).and_then(Value::as_u64);
    // An expired access token is routine (the CLI refreshes it); only a dead
    // or missing refresh token means the user has to log in again.
    let refreshable =
        has("refreshToken") && expiry("refreshTokenExpiresAt").is_none_or(|t| t > now_ms);
    let access_valid = has("accessToken") && expiry("expiresAt").is_none_or(|t| t > now_ms);
    AccountStatus {
        state: if refreshable || access_valid {
            LoginState::Connected
        } else {
            LoginState::Expired
        },
        plan: clean_label(oauth.get("subscriptionType")),
        email: None,
        usage: None,
    }
}

/// Unpadded base64url, enough for a JWT payload; avoids a crate for 15 lines.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in input.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn jwt_claims(token: &str) -> Option<Value> {
    serde_json::from_slice(&base64url_decode(token.split('.').nth(1)?)?).ok()
}

/// `<CODEX_HOME>/auth.json` → state + plan + email. The JWT is decoded for
/// display only, deliberately without signature verification.
pub fn parse_codex_auth(raw: &[u8]) -> AccountStatus {
    let logged_out = AccountStatus {
        state: LoginState::LoggedOut,
        plan: None,
        email: None,
        usage: None,
    };
    let Ok(json) = serde_json::from_slice::<Value>(raw) else {
        return logged_out;
    };
    let tokens = json.get("tokens").filter(|v| v.is_object());
    let refresh = tokens
        .and_then(|t| t.get("refresh_token"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if let Some(claims) = tokens
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str)
        .and_then(jwt_claims)
    {
        let auth = claims.get("https://api.openai.com/auth");
        return AccountStatus {
            state: if refresh {
                LoginState::Connected
            } else {
                LoginState::Expired
            },
            plan: clean_label(auth.and_then(|a| a.get("chatgpt_plan_type"))),
            email: clean_label(claims.get("email")),
            usage: None,
        };
    }
    let api_key = json
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if api_key {
        return AccountStatus {
            state: LoginState::Connected,
            plan: Some("API key".into()),
            email: None,
            usage: None,
        };
    }
    logged_out
}

fn window(v: Option<&Value>) -> Option<UsageWindow> {
    let v = v?;
    let pct = v.get("used_percent")?.as_f64()?;
    if !pct.is_finite() || !(0.0..=100.0).contains(&pct) {
        return None;
    }
    Some(UsageWindow {
        pct: pct.round() as u8,
        resets_at: v.get("resets_at").and_then(Value::as_u64),
    })
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` as Codex writes it (always UTC). Anything
/// else yields `None`; the sample then just has no age.
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || !s.ends_with('Z') || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let frac = s.get(19..s.len() - 1).unwrap_or("");
    let ms = match frac.strip_prefix('.') {
        Some(f) if !f.is_empty() => format!("{:0<3}", &f[..f.len().min(3)])
            .parse::<i64>()
            .ok()?,
        _ => 0,
    };
    // Howard Hinnant's days_from_civil.
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(((days * 86400 + hh * 3600 + mm * 60 + ss) * 1000) + ms).ok()
}

/// Last `rate_limits` in a rollout's JSONL tail, plus the plan Codex reported.
/// Windows are matched by `window_minutes`, not position, so a server-side
/// reorder cannot swap 5 h and 7 d.
pub fn parse_codex_rollout_tail(text: &str) -> Option<(Usage, Option<String>)> {
    for line in text.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(limits) = json
            .pointer("/payload/rate_limits")
            .filter(|v| v.is_object())
        else {
            continue;
        };
        let mut five = None;
        let mut seven = None;
        for key in ["primary", "secondary"] {
            let w = limits.get(key);
            match w
                .and_then(|w| w.get("window_minutes"))
                .and_then(Value::as_u64)
            {
                Some(300) => five = window(w),
                Some(10080) => seven = window(w),
                _ => {}
            }
        }
        if five.is_none() && seven.is_none() {
            continue;
        }
        let at = json
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms)
            .unwrap_or(0);
        return Some((
            Usage {
                five_hour: five,
                seven_day: seven,
                at,
            },
            clean_label(limits.get("plan_type")),
        ));
    }
    None
}

/// Newest `rollout-*.jsonl` under `sessions/YYYY/MM/DD`, walking the date
/// folders newest-first so a long history is not scanned.
fn newest_rollout(codex_home: &Path) -> Option<PathBuf> {
    let sorted_dirs = |dir: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        v.sort();
        v.reverse();
        v
    };
    for year in sorted_dirs(&codex_home.join("sessions")) {
        for month in sorted_dirs(&year) {
            for day in sorted_dirs(&month) {
                let newest = fs::read_dir(&day)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().ends_with(".jsonl"))
                    .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
                    .max_by_key(|(t, _)| *t);
                if let Some((_, path)) = newest {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(ROLLOUT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.take(ROLLOUT_TAIL_BYTES).read_to_end(&mut buf).ok()?;
    // The cut may land mid-line or mid-codepoint; the parser skips bad lines.
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Status for one profile folder. `config_dir` is the resolved folder
/// (profile dir, or the default `~/.claude` / `~/.codex`).
pub fn read_status(agent_id: &str, config_dir: &Path) -> AccountStatus {
    match agent_id {
        "claude-code" => read_small(&config_dir.join(".credentials.json"))
            .map(|raw| parse_claude_credentials(&raw, now_ms()))
            .unwrap_or(AccountStatus {
                state: LoginState::LoggedOut,
                plan: None,
                email: None,
                usage: None,
            }),
        _ => {
            let mut status = read_small(&config_dir.join("auth.json"))
                .map(|raw| parse_codex_auth(&raw))
                .unwrap_or(AccountStatus {
                    state: LoginState::LoggedOut,
                    plan: None,
                    email: None,
                    usage: None,
                });
            if status.state != LoginState::LoggedOut {
                if let Some((usage, plan)) = newest_rollout(config_dir)
                    .and_then(|p| read_tail(&p))
                    .and_then(|t| parse_codex_rollout_tail(&t))
                {
                    status.usage = Some(usage);
                    status.plan = status.plan.or(plan);
                }
            }
            status
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |a, (i, b)| a | (*b as u32) << (16 - 8 * i));
            for i in 0..=chunk.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        out
    }

    fn jwt(claims: &Value) -> String {
        format!(
            "{}.{}.sig",
            b64url(b"{}"),
            b64url(claims.to_string().as_bytes())
        )
    }

    #[test]
    fn claude_connected_with_plan_even_when_access_token_expired() {
        let raw = serde_json::json!({ "claudeAiOauth": {
            "accessToken": "a", "refreshToken": "r", "expiresAt": 1,
            "refreshTokenExpiresAt": 5_000, "subscriptionType": "max" } });
        let s = parse_claude_credentials(raw.to_string().as_bytes(), 2_000);
        assert_eq!(s.state, LoginState::Connected);
        assert_eq!(s.plan.as_deref(), Some("max"));
        let s = parse_claude_credentials(raw.to_string().as_bytes(), 9_000);
        assert_eq!(s.state, LoginState::Expired);
    }

    #[test]
    fn claude_missing_or_garbage_is_logged_out() {
        assert_eq!(
            parse_claude_credentials(b"nope", 0).state,
            LoginState::LoggedOut
        );
        assert_eq!(
            parse_claude_credentials(b"{}", 0).state,
            LoginState::LoggedOut
        );
    }

    #[test]
    fn codex_reads_plan_and_email_from_id_token() {
        let id = jwt(&serde_json::json!({ "email": "a@b.c",
            "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } }));
        let raw = serde_json::json!({ "tokens": { "id_token": id, "refresh_token": "r" } });
        let s = parse_codex_auth(raw.to_string().as_bytes());
        assert_eq!(s.state, LoginState::Connected);
        assert_eq!(s.plan.as_deref(), Some("plus"));
        assert_eq!(s.email.as_deref(), Some("a@b.c"));
        let serialised = serde_json::to_string(&s).unwrap();
        assert!(!serialised.contains("refresh"));
    }

    #[test]
    fn codex_api_key_mode_and_empty_file() {
        let s = parse_codex_auth(br#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#);
        assert_eq!(s.plan.as_deref(), Some("API key"));
        assert_eq!(
            parse_codex_auth(br#"{"OPENAI_API_KEY":null}"#).state,
            LoginState::LoggedOut
        );
    }

    #[test]
    fn rollout_tail_takes_last_sample_and_matches_windows_by_length() {
        let line = |pct: u32, ts: &str| {
            serde_json::json!({ "timestamp": ts, "type": "event_msg",
            "payload": { "type": "token_count", "rate_limits": {
                "primary": { "used_percent": 35, "window_minutes": 10080, "resets_at": 9 },
                "secondary": { "used_percent": pct, "window_minutes": 300 },
                "plan_type": "plus" } } })
            .to_string()
        };
        let text = format!(
            "{}\n{}\n{{broken",
            line(10, "2026-10-12T14:00:00Z"),
            line(89, "2026-10-12T14:50:01.597Z")
        );
        let (usage, plan) = parse_codex_rollout_tail(&text).unwrap();
        assert_eq!(
            usage.five_hour,
            Some(UsageWindow {
                pct: 89,
                resets_at: None
            })
        );
        assert_eq!(
            usage.seven_day,
            Some(UsageWindow {
                pct: 35,
                resets_at: Some(9)
            })
        );
        assert_eq!(usage.at, 1_791_816_601_597);
        assert_eq!(plan.as_deref(), Some("plus"));
        assert!(parse_codex_rollout_tail("{}\n").is_none());
    }

    #[test]
    fn newest_rollout_walks_date_folders() {
        let dir = tempfile::tempdir().unwrap();
        for d in ["2026/09/30", "2026/10/12"] {
            let p = dir.path().join("sessions").join(d);
            fs::create_dir_all(&p).unwrap();
            fs::write(p.join("rollout-x.jsonl"), d).unwrap();
        }
        let found = newest_rollout(dir.path()).unwrap();
        assert!(found
            .to_string_lossy()
            .replace('\\', "/")
            .contains("2026/10/12"));
    }
}
