//! The SWA-92 templates: Compact, Extended and Detailed, laid out for the
//! terminal width (`layout.rs`) and coloured by the chosen scheme
//! (`style.rs`). Pure — the caller resolves the MCP state, the git branch and
//! the clock, so every case is a table test.
//!
//! Width rule (shared with the user's skill line): try the full form in one
//! row; else the short form (4-cell bars, no "left"), packed by segment into
//! as many rows as needed. Below 50 cells branch and cache are dropped —
//! model/context, limits and the MCP state always stay.

use super::layout::{pack, SEP_TEXT};
use super::render::{ctx_color, ctx_info, format_tokens, CtxColor, McpState, StatusInput};
use super::settings::{Preset, StatuslineSettings};
use super::style::{palette, Palette, RESET};

pub struct Frame<'a> {
    pub input: &'a StatusInput,
    pub mcp: McpState,
    pub branch: Option<&'a str>,
    /// Unix seconds, for "resets in" countdowns.
    pub now: u64,
    pub width: usize,
    pub color: bool,
}

struct Ctx<'a> {
    p: &'a Palette,
    color: bool,
}

impl Ctx<'_> {
    fn paint(&self, code: &str, s: &str) -> String {
        if self.color {
            format!("{code}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    fn band(&self, pct: f64) -> &str {
        match ctx_color(pct) {
            CtxColor::Normal => &self.p.ok,
            CtxColor::Warn => &self.p.warn,
            CtxColor::Danger => &self.p.crit,
        }
    }
    fn bar(&self, pct: f64, n: usize) -> String {
        let f = ((pct / 100.0) * n as f64).round().clamp(0.0, n as f64) as usize;
        format!(
            "{}{}",
            self.paint(self.band(pct), &"█".repeat(f)),
            self.paint(&self.p.dim, &"░".repeat(n - f))
        )
    }
}

#[derive(Clone, Copy)]
struct Form {
    bar: usize,
    short: bool,
}

/// `1h 56m` / `3d 11h` / `4m` / `now`.
pub fn time_left(resets_at: u64, now: u64) -> String {
    let s = resets_at.saturating_sub(now);
    if s == 0 {
        return "now".into();
    }
    let (d, h, m) = (s / 86_400, (s % 86_400) / 3_600, (s % 3_600) / 60);
    if d >= 1 {
        format!("{d}d {h}h")
    } else if h >= 1 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

fn mcp_seg(c: &Ctx, mcp: McpState) -> Option<String> {
    match mcp {
        McpState::Connected => Some(c.paint(&c.p.ok, "mcp ✓")),
        McpState::NoClient => Some(c.paint(&c.p.warn, "mcp …")),
        McpState::Unreachable => Some(c.paint(&c.p.crit, "mcp ✗")),
        McpState::Absent => None,
    }
}

fn window_seg(
    c: &Ctx,
    label: &str,
    w: Option<&crate::mcp::rate_limits::RawWindow>,
    now: u64,
    f: Form,
) -> Option<String> {
    let w = w?;
    let pct = w.used_percentage?;
    let mut s = format!(
        "{} {} {}",
        c.paint(&c.p.label, label),
        c.bar(pct, f.bar),
        c.paint(c.band(pct), &format!("{}%", pct.round() as u64))
    );
    if let Some(r) = w.resets_at.filter(|r| *r > 0.0) {
        s.push(' ');
        s.push_str(&c.paint(&c.p.text, &time_left(r as u64, now)));
        if !f.short {
            s.push_str(" left");
        }
    }
    Some(s)
}

/// Model, effort (not in Compact), context as text (Compact) or bar, and the
/// session cost (Detailed).
fn model_seg(c: &Ctx, input: &StatusInput, preset: Preset, f: Form) -> String {
    let mut parts = Vec::new();
    if let Some(name) = input.model.as_ref().and_then(|m| m.display_name.as_deref()) {
        parts.push(c.paint(&c.p.label, name));
    }
    if preset != Preset::Compact {
        if let Some(e) = input.effort.as_ref().and_then(|e| e.level.as_deref()) {
            parts.push(c.paint(&c.p.label, e));
        }
    }
    match input.context_window.as_ref().and_then(ctx_info) {
        None => parts.push(c.paint(&c.p.dim, "ctx —")),
        Some(x) if preset == Preset::Compact => parts.push(c.paint(
            c.band(x.pct),
            &format!(
                "ctx {}/{} {}%",
                format_tokens(x.used),
                format_tokens(x.size),
                x.pct.round() as u64
            ),
        )),
        Some(x) => {
            parts.push(c.bar(x.pct, f.bar));
            parts.push(format!(
                "{}{}",
                c.paint(c.band(x.pct), &format_tokens(x.used)),
                c.paint(&c.p.label, &format!("/{}", format_tokens(x.size)))
            ));
        }
    }
    if preset == Preset::Detailed {
        if let Some(cost) = input.cost.as_ref().and_then(|c| c.total_cost_usd) {
            parts.push(c.paint(&c.p.label, &format!("(${cost:.2})")));
        }
    }
    parts.join(" ")
}

fn cache_seg(c: &Ctx, input: &StatusInput, now: u64, f: Form) -> Option<String> {
    let pc = input.prompt_cache.as_ref()?;
    if pc.caching_observed != Some(true) {
        return None;
    }
    let mut s = c.paint(&c.p.label, "cache");
    if let Some(hr) = pc.hit_ratio {
        let p = (hr * 100.0).round();
        let code = if p >= 80.0 {
            &c.p.ok
        } else if p >= 50.0 {
            &c.p.warn
        } else {
            &c.p.crit
        };
        s.push(' ');
        s.push_str(&c.paint(code, &format!("{p}%")));
    }
    match (pc.warm, pc.expires_at) {
        (Some(true), Some(exp)) => {
            let left = time_left(exp.max(0.0) as u64, now);
            let tail = if f.short {
                left
            } else {
                format!("{left} left")
            };
            s.push_str(&format!(" ({} {})", c.paint(&c.p.ok, "warm"), tail));
        }
        _ => s.push_str(&format!(" ({})", c.paint(&c.p.crit, "cold"))),
    }
    Some(s)
}

fn branch_seg(c: &Ctx, branch: Option<&str>) -> Option<String> {
    Some(format!(
        "{} {}",
        c.paint(&c.p.label, "⎇"),
        c.paint(&c.p.text, branch?)
    ))
}

fn segments(c: &Ctx, fr: &Frame, preset: Preset, f: Form) -> Vec<String> {
    let rl = fr.input.rate_limits.as_ref();
    let five = || window_seg(c, "5h", rl.and_then(|r| r.five_hour.as_ref()), fr.now, f);
    let seven = || window_seg(c, "7d", rl.and_then(|r| r.seven_day.as_ref()), fr.now, f);
    let wide = fr.width >= 50;
    let v: Vec<Option<String>> = match preset {
        Preset::Compact => vec![mcp_seg(c, fr.mcp), Some(model_seg(c, fr.input, preset, f))],
        Preset::Extended => vec![
            Some(model_seg(c, fr.input, preset, f)),
            five(),
            seven(),
            if wide { branch_seg(c, fr.branch) } else { None },
            mcp_seg(c, fr.mcp),
        ],
        Preset::Detailed => vec![
            five(),
            seven(),
            Some(model_seg(c, fr.input, preset, f)),
            if wide {
                cache_seg(c, fr.input, fr.now, f)
            } else {
                None
            },
            if wide { branch_seg(c, fr.branch) } else { None },
            mcp_seg(c, fr.mcp),
        ],
    };
    v.into_iter().flatten().collect()
}

/// The status rows for this frame.
pub fn render(fr: &Frame, s: &StatuslineSettings) -> Vec<String> {
    let p = palette(
        s.scheme,
        s.vibrance,
        s.theme_text.as_deref(),
        s.theme_accent.as_deref(),
    );
    let c = Ctx {
        p: &p,
        color: fr.color,
    };
    let sep = if fr.color {
        format!("{}{}{RESET}", p.sep, SEP_TEXT)
    } else {
        SEP_TEXT.to_string()
    };
    let full = pack(
        &segments(
            &c,
            fr,
            s.claude,
            Form {
                bar: 8,
                short: false,
            },
        ),
        &sep,
        fr.width,
    );
    if full.len() <= 1 {
        return full;
    }
    pack(
        &segments(
            &c,
            fr,
            s.claude,
            Form {
                bar: 4,
                short: true,
            },
        ),
        &sep,
        fr.width,
    )
}

#[cfg(test)]
mod tests {
    use super::super::layout::vlen;
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn input() -> StatusInput {
        serde_json::from_str(&format!(
            r#"{{"model":{{"display_name":"Opus 5.5"}},"effort":{{"level":"high"}},
              "cost":{{"total_cost_usd":12.34}},
              "context_window":{{"total_input_tokens":412000,"context_window_size":1000000,"used_percentage":41.2}},
              "rate_limits":{{"five_hour":{{"used_percentage":63,"resets_at":{}}},
                              "seven_day":{{"used_percentage":41,"resets_at":{}}}}},
              "prompt_cache":{{"caching_observed":true,"hit_ratio":0.91,"warm":true,"expires_at":{}}}}}"#,
            NOW + 7_000,
            NOW + 300_000,
            NOW + 240
        ))
        .unwrap()
    }

    fn rows(preset: Preset, width: usize) -> Vec<String> {
        let i = input();
        let fr = Frame {
            input: &i,
            mcp: McpState::Connected,
            branch: Some("dev"),
            now: NOW,
            width,
            color: false,
        };
        render(
            &fr,
            &StatuslineSettings {
                claude: preset,
                ..Default::default()
            },
        )
    }

    #[test]
    fn compact_is_the_old_line_plus_the_model() {
        assert_eq!(
            rows(Preset::Compact, 118),
            vec!["mcp ✓ | Opus 5.5 ctx 412k/1.0M 41%"]
        );
    }

    #[test]
    fn extended_adds_limits_branch_and_effort() {
        let r = rows(Preset::Extended, 200);
        assert_eq!(r.len(), 1);
        assert_eq!(
            r[0],
            "Opus 5.5 high ███░░░░░ 412k/1.0M | 5h █████░░░ 63% 1h 56m left | 7d ███░░░░░ 41% 3d 11h left | ⎇ dev | mcp ✓"
        );
    }

    #[test]
    fn detailed_adds_cost_and_cache() {
        let r = rows(Preset::Detailed, 250).join("\n");
        assert!(r.contains("($12.34)"), "{r}");
        assert!(r.contains("cache 91% (warm 4m left)"), "{r}");
    }

    #[test]
    fn falls_back_to_the_short_form_and_wraps_by_segment() {
        let r = rows(Preset::Detailed, 80);
        assert!(r.len() > 1);
        assert!(!r.join("").contains(" left"));
        for k in ["5h", "7d", "Opus 5.5", "cache", "dev", "mcp"] {
            assert!(r.iter().any(|l| l.contains(k)), "{k} missing in {r:?}");
        }
    }

    #[test]
    fn narrow_drops_branch_and_cache_only() {
        let r = rows(Preset::Detailed, 40).join("\n");
        assert!(!r.contains("cache") && !r.contains("dev"));
        for k in ["5h", "7d", "Opus", "mcp"] {
            assert!(r.contains(k), "{k}");
        }
    }

    #[test]
    fn no_row_is_wider_than_the_terminal() {
        for preset in [Preset::Compact, Preset::Extended, Preset::Detailed] {
            for w in [20, 30, 40, 60, 80, 118, 200] {
                let i = input();
                let fr = Frame {
                    input: &i,
                    mcp: McpState::NoClient,
                    branch: Some("feat/x"),
                    now: NOW,
                    width: w,
                    color: true,
                };
                for scheme in [
                    super::super::style::Scheme::Subtle,
                    super::super::style::Scheme::AppTheme,
                ] {
                    let s = StatuslineSettings {
                        claude: preset,
                        scheme,
                        ..Default::default()
                    };
                    for row in render(&fr, &s) {
                        assert!(
                            vlen(&row) <= w,
                            "{preset:?} @ {w}: {} > {w}: {row}",
                            vlen(&row)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn missing_data_degrades_to_shorter_rows() {
        let i: StatusInput = serde_json::from_str("{}").unwrap();
        let fr = Frame {
            input: &i,
            mcp: McpState::Absent,
            branch: None,
            now: NOW,
            width: 118,
            color: false,
        };
        let s = StatuslineSettings {
            claude: Preset::Detailed,
            ..Default::default()
        };
        assert_eq!(render(&fr, &s), vec!["ctx —"]);
    }

    #[test]
    fn time_left_formats() {
        assert_eq!(time_left(NOW, NOW), "now");
        assert_eq!(time_left(NOW + 240, NOW), "4m");
        assert_eq!(time_left(NOW + 7_000, NOW), "1h 56m");
        assert_eq!(time_left(NOW + 300_000, NOW), "3d 11h");
    }
}
