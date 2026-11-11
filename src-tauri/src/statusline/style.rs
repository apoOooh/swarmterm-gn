//! Colour schemes and vibrance for the status line (SWA-92). Pure: a scheme +
//! vibrance + optional app-theme colours resolve to a `Palette` of ANSI codes.
//!
//! Subtle is the user's own near-monochrome skill palette (vibrance has no
//! effect there — the UI greys the slider out). App theme takes text/accent
//! from the active Swarmterm theme and scales saturation with vibrance. High
//! contrast uses the 16 basic ANSI colours so the terminal theme decides the
//! exact shades, which is what high contrast users configure.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scheme {
    #[default]
    Subtle,
    AppTheme,
    HighContrast,
}

/// Resolved ANSI codes per role. `reset` is shared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    pub text: String,
    pub label: String,
    pub ok: String,
    pub warn: String,
    pub crit: String,
    pub dim: String,
    pub sep: String,
}

pub const RESET: &str = "\u{1b}[0m";

type Rgb = (u8, u8, u8);

fn fg((r, g, b): Rgb) -> String {
    format!("\u{1b}[38;2;{r};{g};{b}m")
}

fn rgb_to_hsl((r, g, b): Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn hsl_to_rgb((h, s, l): (f64, f64, f64)) -> Rgb {
    if s <= 0.0 {
        let v = (l * 255.0).round() as u8;
        return (v, v, v);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    let c = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    (c(hue(h + 1.0 / 3.0)), c(hue(h)), c(hue(h - 1.0 / 3.0)))
}

/// Scale saturation by vibrance (0–100, 50 = as designed). `floor` keeps a
/// minimum saturation so warnings never fade into the text colour.
pub fn vibrant(c: Rgb, vibrance: u8, floor: f64) -> Rgb {
    let (h, s, l) = rgb_to_hsl(c);
    let k = 0.2 + 1.6 * (vibrance.min(100) as f64 / 100.0); // 0.2× … 1.8×
    hsl_to_rgb((h, (s * k).clamp(floor.min(s), 1.0), l))
}

/// Parse `#rrggbb`; anything else is `None` (falls back to the scheme default).
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

pub fn palette(
    scheme: Scheme,
    vibrance: u8,
    theme_text: Option<&str>,
    theme_accent: Option<&str>,
) -> Palette {
    match scheme {
        // The skill palette (256-colour indices 254/247/250/144/174/236/238) as RGB.
        Scheme::Subtle => Palette {
            text: fg((0xE4, 0xE4, 0xE4)),
            label: fg((0x9E, 0x9E, 0x9E)),
            ok: fg((0xBC, 0xBC, 0xBC)),
            warn: fg((0xAF, 0xAF, 0x87)),
            crit: fg((0xD7, 0x87, 0x87)),
            dim: fg((0x30, 0x30, 0x30)),
            sep: fg((0x44, 0x44, 0x44)),
        },
        Scheme::AppTheme => {
            let text = theme_text.and_then(parse_hex).unwrap_or((0xE6, 0xED, 0xF3));
            let accent = theme_accent
                .and_then(parse_hex)
                .unwrap_or((0x79, 0xC0, 0xFF));
            Palette {
                text: fg(text),
                label: fg(vibrant(accent, vibrance, 0.0)),
                ok: fg(vibrant((0x7E, 0xE7, 0x87), vibrance, 0.0)),
                warn: fg(vibrant((0xE5, 0xB5, 0x67), vibrance, 0.45)),
                crit: fg(vibrant((0xEF, 0x8F, 0x8F), vibrance, 0.55)),
                dim: fg((0x3A, 0x3A, 0x3A)),
                sep: fg((0x55, 0x55, 0x55)),
            }
        }
        Scheme::HighContrast => Palette {
            text: "\u{1b}[97m".into(),
            label: "\u{1b}[96m".into(),
            ok: "\u{1b}[92m".into(),
            warn: "\u{1b}[93m".into(),
            crit: "\u{1b}[91m".into(),
            dim: "\u{1b}[90m".into(),
            sep: "\u{1b}[37m".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsl_round_trips() {
        for c in [
            (0xE5, 0xB5, 0x67),
            (0x79, 0xC0, 0xFF),
            (10, 200, 30),
            (128, 128, 128),
        ] {
            let back = hsl_to_rgb(rgb_to_hsl(c));
            assert!((back.0 as i16 - c.0 as i16).abs() <= 1, "{c:?} → {back:?}");
            assert!((back.1 as i16 - c.1 as i16).abs() <= 1);
            assert!((back.2 as i16 - c.2 as i16).abs() <= 1);
        }
    }

    #[test]
    fn vibrance_changes_saturation_but_keeps_a_floor() {
        let warn = (0xE5, 0xB5, 0x67);
        let s = |c| rgb_to_hsl(c).1;
        assert!(s(vibrant(warn, 100, 0.45)) > s(vibrant(warn, 50, 0.45)));
        assert!(
            s(vibrant(warn, 0, 0.45)) >= 0.44,
            "warnings stay coloured at 0 %"
        );
    }

    #[test]
    fn subtle_ignores_vibrance() {
        assert_eq!(
            palette(Scheme::Subtle, 0, None, None),
            palette(Scheme::Subtle, 100, None, None)
        );
    }

    #[test]
    fn app_theme_takes_the_theme_text_colour() {
        let p = palette(Scheme::AppTheme, 50, Some("#102030"), Some("#zzzzzz"));
        assert_eq!(p.text, "\u{1b}[38;2;16;32;48m");
    }

    #[test]
    fn high_contrast_uses_basic_ansi_only() {
        let p = palette(Scheme::HighContrast, 50, None, None);
        assert!(!p.text.contains("38;2"));
    }

    #[test]
    fn scheme_serialises_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Scheme::AppTheme).unwrap(),
            "\"app-theme\""
        );
    }
}
