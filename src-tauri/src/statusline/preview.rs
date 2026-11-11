//! Sample rows for the template picker (SWA-92). Rendered by the same
//! `preset::render` the `--statusline` command uses, from a fixed example
//! session, so the preview is exactly what the line will look like — only
//! the numbers are made up.

use super::breakdown::{bars, State};
use super::preset::{render, Frame};
use super::render::{McpState, StatusInput};
use super::settings::StatuslineSettings;

/// Fixed clock so countdowns in the preview do not tick.
const NOW: u64 = 1_800_000_000;

fn sample_input() -> StatusInput {
    serde_json::from_value(serde_json::json!({
        "model": { "display_name": "Opus 5.5" },
        "effort": { "level": "high" },
        "cost": { "total_cost_usd": 12.34 },
        "context_window": {
            "total_input_tokens": 412_000,
            "context_window_size": 1_000_000,
            "used_percentage": 41.2
        },
        "rate_limits": {
            "five_hour": { "used_percentage": 63, "resets_at": NOW + 7_000 },
            "seven_day": { "used_percentage": 41, "resets_at": NOW + 300_000 }
        },
        "prompt_cache": {
            "caching_observed": true, "hit_ratio": 0.91, "warm": true,
            "expires_at": NOW + 240
        }
    }))
    .unwrap_or_default()
}

fn sample_state() -> State {
    let mut st = State::default();
    st.usage.insert("m".into(), [1_200, 30_000, 90_000, 4_000]);
    st.text_chars = 6_000;
    st.call_chars = 2_000;
    st.results.insert("Read".into(), 24_000);
    st.results.insert("Bash".into(), 8_000);
    st.results.insert("Grep".into(), 3_000);
    st
}

/// ANSI rows for `settings` at `columns` terminal columns (as Claude Code's
/// `COLUMNS`, so the same 2-cell slack applies).
pub fn rows(settings: &StatuslineSettings, columns: usize) -> Vec<String> {
    let input = sample_input();
    let bars = bars(&sample_state());
    let frame = Frame {
        input: &input,
        mcp: McpState::Connected,
        branch: Some("dev"),
        now: NOW,
        width: super::layout::term_width(Some(&columns.to_string())),
        color: true,
        agents: Some((2, 31_200, 0.84)),
        bars: &bars,
    };
    render(&frame, settings)
}

#[cfg(test)]
mod tests {
    use super::super::layout::vlen;
    use super::super::settings::Preset;
    use super::*;

    #[test]
    fn preview_has_every_template_and_respects_the_width() {
        for claude in [Preset::Compact, Preset::Extended, Preset::Detailed] {
            let s = StatuslineSettings {
                claude,
                ..Default::default()
            };
            for cols in [40, 80, 160] {
                let r = rows(&s, cols);
                assert!(!r.is_empty());
                assert!(
                    r.iter().all(|l| vlen(l) <= cols - 2),
                    "{claude:?} @ {cols}: {r:?}"
                );
            }
        }
        let d = StatuslineSettings {
            claude: Preset::Detailed,
            ..Default::default()
        };
        assert!(rows(&d, 160).len() > rows(&StatuslineSettings::default(), 160).len());
    }
}
