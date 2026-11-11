//! Width-aware layout for the status line. Claude Code captures the command's
//! output (no TTY), but sets `COLUMNS` to the terminal width before each run;
//! without it a long line is cut or wrapped mid-segment by the terminal. So
//! the line is laid out here: segments are packed into rows, never split, and
//! a single segment wider than a row is clipped with `…`.

use unicode_segmentation::UnicodeSegmentation;

/// Separator between segments, plain text part (the colour is added by the
/// caller). Kept in one place so `pack` measures what is printed.
pub const SEP_TEXT: &str = " | ";

/// Usable width from `COLUMNS`: two cells of slack because Claude Code indents
/// the status row; no or garbage `COLUMNS` = 120, floor 20.
pub fn term_width(columns: Option<&str>) -> usize {
    let c = columns
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&c| c > 0)
        .unwrap_or(120);
    c.saturating_sub(2).max(20)
}

/// Cell width of one grapheme cluster: emoji (also ZWJ sequences, flags, VS16)
/// and East Asian wide characters take two cells, combining marks none.
fn grapheme_width(g: &str) -> usize {
    let mut chars = g.chars();
    let Some(first) = chars.next() else { return 0 };
    let cp = first as u32;
    if g.contains('\u{200D}') || g.contains('\u{FE0F}') {
        return 2;
    }
    if (0x1F1E6..=0x1F1FF).contains(&cp) {
        return 2; // regional indicator (flag)
    }
    if (0x0300..=0x036F).contains(&cp) || (0x200B..=0x200F).contains(&cp) {
        return 0;
    }
    let wide = matches!(cp,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF | 0x1F680..=0x1F6FF
        | 0x20000..=0x3FFFD);
    if wide {
        2
    } else {
        1
    }
}

/// Splits `s` into (escape sequence, text) tokens; escapes are CSI `ESC [ … m`.
fn tokens(s: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find('\u{1b}') {
        if i > 0 {
            out.push((false, &rest[..i]));
        }
        let tail = &rest[i..];
        let end = tail.find('m').map(|e| e + 1).unwrap_or(tail.len());
        out.push((true, &tail[..end]));
        rest = &tail[end..];
    }
    if !rest.is_empty() {
        out.push((false, rest));
    }
    out
}

/// Visible width in cells, ANSI colour codes excluded.
pub fn vlen(s: &str) -> usize {
    tokens(s)
        .into_iter()
        .filter(|(esc, _)| !esc)
        .flat_map(|(_, t)| t.graphemes(true))
        .map(grapheme_width)
        .sum()
}

/// Clip to `w` cells, keeping colour codes, ending in `…` + reset.
pub fn clip(s: &str, w: usize) -> String {
    if vlen(s) <= w {
        return s.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for (esc, t) in tokens(s) {
        if esc {
            out.push_str(t);
            continue;
        }
        for g in t.graphemes(true) {
            let n = grapheme_width(g);
            if used + n + 1 > w {
                out.push('…');
                out.push_str("\u{1b}[0m");
                return out;
            }
            out.push_str(g);
            used += n;
        }
    }
    out
}

/// Pack segments into rows of at most `w` cells, joined by `sep` (whose
/// visible text must be `SEP_TEXT`). Order is kept; a segment never splits.
pub fn pack(parts: &[String], sep: &str, w: usize) -> Vec<String> {
    let sep_len = vlen(sep);
    let mut rows = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;
    for p in parts {
        let p = clip(p, w);
        let n = vlen(&p);
        if !cur.is_empty() && cur_len + sep_len + n <= w {
            cur.push_str(sep);
            cur.push_str(&p);
            cur_len += sep_len + n;
        } else {
            if !cur.is_empty() {
                rows.push(std::mem::take(&mut cur));
            }
            cur = p;
            cur_len = n;
        }
    }
    if !cur.is_empty() {
        rows.push(cur);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_comes_from_columns_with_slack() {
        assert_eq!(term_width(Some("100")), 98);
        assert_eq!(term_width(None), 118);
        assert_eq!(term_width(Some("x")), 118);
        assert_eq!(term_width(Some("5")), 20);
    }

    #[test]
    fn vlen_counts_cells() {
        assert_eq!(vlen("\u{1b}[38;2;1;2;3mabc\u{1b}[0m"), 3);
        assert_eq!(vlen("█░■⠀"), 4);
        assert_eq!(vlen("日本"), 4);
        assert_eq!(vlen("👍"), 2);
        assert_eq!(vlen("👨‍👩‍👧"), 2);
        assert_eq!(vlen("🇩🇪"), 2);
        assert_eq!(vlen("❤️"), 2);
        assert_eq!(vlen("é"), 1);
        assert_eq!(vlen("mcp ✓"), 5);
    }

    #[test]
    fn clip_keeps_the_width_and_marks_the_cut() {
        let s = "\u{1b}[31mabcdefghij\u{1b}[0m";
        assert_eq!(vlen(&clip(s, 5)), 5);
        assert!(clip(s, 5).contains('…'));
        assert_eq!(clip("abc", 5), "abc");
        assert!(vlen(&clip("日本語テキスト", 5)) <= 5);
    }

    #[test]
    fn pack_wraps_by_segment() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(pack(&p(&["aaa", "bbb"]), SEP_TEXT, 20), vec!["aaa | bbb"]);
        assert_eq!(
            pack(&p(&["aaaaaaaa", "bbbbbbbb"]), SEP_TEXT, 10),
            vec!["aaaaaaaa", "bbbbbbbb"]
        );
    }
}
