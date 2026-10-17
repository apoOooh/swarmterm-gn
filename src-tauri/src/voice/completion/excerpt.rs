//! The spoken excerpt (SWA-58): the first one or two sentences of prose from
//! an agent's final answer, at most `MAX_CHARS`. Pure, so every rule is a
//! unit test.
//!
//! The rules err on the side of saying nothing: an excerpt is read aloud
//! next to other people, so code, paths, URLs, hashes and shell lines are
//! never spoken. A sentence that contains one is dropped WHOLE rather than
//! cleaned, since half a sentence around a removed path reads as nonsense
//! and would still hint at what was removed. Nothing left → `None`, and the
//! announcement says so honestly instead of falling back to screen text.

/// Hard cap, cut at a word boundary.
pub const MAX_CHARS: usize = 300;
/// Sentences per excerpt: enough for "what happened", short enough to be over
/// before the user has turned their head.
const MAX_SENTENCES: usize = 2;

/// The excerpt of `text`, or `None` when no speakable prose is left.
pub fn excerpt(text: &str) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    for unit in prose_units(text) {
        for sentence in split_sentences(&unit) {
            let Some(clean) = clean_sentence(&sentence) else {
                continue;
            };
            out.push(clean);
            if out.len() == MAX_SENTENCES {
                return finish(&out);
            }
        }
    }
    finish(&out)
}

fn finish(sentences: &[String]) -> Option<String> {
    let mut joined = String::new();
    for s in sentences {
        let next = if joined.is_empty() {
            s.clone()
        } else {
            format!("{joined} {s}")
        };
        // The second sentence only if it still fits; the first one is cut.
        if next.chars().count() > MAX_CHARS {
            if joined.is_empty() {
                joined = cut_at_word(s, MAX_CHARS);
            }
            break;
        }
        joined = next;
    }
    (!joined.is_empty()).then_some(joined)
}

fn cut_at_word(s: &str, max: usize) -> String {
    let prefix: String = s.chars().take(max).collect();
    match prefix.rfind(char::is_whitespace) {
        Some(i) if i > 0 => prefix[..i].trim_end().to_owned(),
        _ => prefix,
    }
}

/// Markdown → lines of prose. Code blocks (fenced, also an unterminated
/// fence, and indented), tables, headings and horizontal rules disappear;
/// list and quote markers are stripped so their text counts as a sentence.
fn prose_units(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut fence: Option<&str> = None;
    let mut para = String::new();
    let flush = |para: &mut String, units: &mut Vec<String>| {
        if !para.trim().is_empty() {
            units.push(std::mem::take(para));
        } else {
            para.clear();
        }
    };
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            if trimmed.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush(&mut para, &mut units);
            fence = Some(&trimmed[..3]);
            continue;
        }
        if trimmed.is_empty() {
            flush(&mut para, &mut units);
            continue;
        }
        let indented = line.starts_with("    ") || line.starts_with('\t');
        if (indented && para.is_empty())
            || trimmed.starts_with('|')
            || trimmed.starts_with('#')
            || is_rule(trimmed)
        {
            flush(&mut para, &mut units);
            continue;
        }
        let (body, item) = strip_marker(trimmed);
        // A list item or quote is its own unit: it never runs into the
        // sentence before it.
        if item {
            flush(&mut para, &mut units);
            units.push(body.to_owned());
            continue;
        }
        if !para.is_empty() {
            para.push(' ');
        }
        para.push_str(body);
    }
    flush(&mut para, &mut units);
    units
}

fn is_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3
        && (compact.chars().all(|c| c == '-')
            || compact.chars().all(|c| c == '*')
            || compact.chars().all(|c| c == '_'))
}

/// `- x`, `* x`, `+ x`, `1. x`, `1) x`, `> x` → (`x`, true).
fn strip_marker(line: &str) -> (&str, bool) {
    for m in ["- ", "* ", "+ ", "> "] {
        if let Some(rest) = line.strip_prefix(m) {
            return (rest.trim_start(), true);
        }
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        let rest = &line[digits..];
        if let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return (rest.trim_start(), true);
        }
    }
    (line, false)
}

/// Split at `.`, `!`, `?` (also `…`) followed by whitespace or the end.
fn split_sentences(unit: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = unit.chars().peekable();
    while let Some(c) = chars.next() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?' | '…') && chars.peek().is_none_or(|n| n.is_whitespace()) {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// Inline markdown resolved, or `None` when the sentence must not be spoken.
fn clean_sentence(sentence: &str) -> Option<String> {
    let s = resolve_inline(sentence)?;
    let s: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() || !s.chars().any(char::is_alphabetic) {
        return None;
    }
    if is_shell_line(&s) || s.split_whitespace().any(is_unspeakable_word) {
        return None;
    }
    Some(s)
}

/// `[text](url)` → text, `**x**`/`__x__`/`*x*` → x, `` `word` `` → word.
/// An autolink `<…>` or code span with anything but one plain word drops the
/// sentence (`None`).
fn resolve_inline(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        match c {
            '`' => {
                let ticks = rest.chars().take_while(|&c| c == '`').count();
                let fence = &rest[..ticks];
                let after = &rest[ticks..];
                let end = after.find(fence)?;
                let code = after[..end].trim();
                if !is_plain_word(code) {
                    return None;
                }
                out.push_str(code);
                rest = &after[end + ticks..];
            }
            '[' => {
                // Only a well-formed `[text](target)` is a link; anything
                // else is literal text and goes through the word checks.
                if let Some((text, len)) = link(rest) {
                    out.push_str(text);
                    rest = &rest[len..];
                } else {
                    out.push('[');
                    rest = &rest[1..];
                }
            }
            '<' if rest[1..].starts_with(|c: char| c.is_ascii_alphabetic()) => {
                // Autolink or HTML: never speakable.
                return None;
            }
            '*' | '_' if is_emphasis(out.chars().last(), rest, c) => {
                rest = &rest[c.len_utf8()..];
            }
            _ => {
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    Some(out)
}

fn link(s: &str) -> Option<(&str, usize)> {
    let close = s.find(']')?;
    let text = &s[1..close];
    let after = &s[close + 1..];
    if !after.starts_with('(') || text.contains('[') {
        return None;
    }
    let end = after.find(')')?;
    Some((text, close + 1 + end + 1))
}

/// `*` is always emphasis; `_` only at a word edge, so `snake_case` keeps
/// its underscore and fails the word check later.
fn is_emphasis(prev: Option<char>, rest: &str, c: char) -> bool {
    if c == '*' {
        return true;
    }
    let next = rest[1..].chars().next();
    !prev.is_some_and(char::is_alphanumeric) || !next.is_some_and(char::is_alphanumeric)
}

fn is_plain_word(code: &str) -> bool {
    !code.is_empty()
        && code.chars().count() <= 32
        && code
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

fn is_shell_line(s: &str) -> bool {
    ["$ ", "> ", "PS ", "# ", "% "]
        .iter()
        .any(|p| s.starts_with(p))
}

/// URL, path, file name with an extension, hash or UUID.
fn is_unspeakable_word(word: &str) -> bool {
    let w = word.trim_matches(|c: char| ",;:!?()\"'„“”«»".contains(c));
    let w = w.strip_suffix('.').unwrap_or(w);
    if w.is_empty() {
        return false;
    }
    if w.contains("://") || w.starts_with("www.") || w.contains('\\') {
        return true;
    }
    let b = w.as_bytes();
    // `C:` drive letters, `~/x`, `/x`, `./x`, `a/b`.
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return true;
    }
    if w.starts_with('~') || w.contains('/') {
        return true;
    }
    if has_extension(w) || looks_like_hash(w) {
        return true;
    }
    // `snake_case`, `__init__`: identifiers, not prose.
    w.contains('_')
}

fn has_extension(w: &str) -> bool {
    let Some((stem, ext)) = w.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && (1..=6).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && ext.chars().any(|c| c.is_ascii_alphabetic())
}

fn looks_like_hash(w: &str) -> bool {
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    let parts: Vec<&str> = w.split('-').collect();
    if parts.len() == 5 && parts.iter().all(|p| hex(p)) && w.len() == 36 {
        return true;
    }
    w.len() >= 7
        && hex(w)
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_two_sentences_of_prose() {
        assert_eq!(
            excerpt("Fertig. Alle Tests laufen. Danach kommt der Merge.").as_deref(),
            Some("Fertig. Alle Tests laufen.")
        );
        assert_eq!(excerpt("Nur ein Satz").as_deref(), Some("Nur ein Satz"));
    }

    #[test]
    fn drops_code_blocks_including_unterminated_and_crlf() {
        let t = "```rust\r\nfn main() {}\r\n```\r\nDer Build ist grün.";
        assert_eq!(excerpt(t).as_deref(), Some("Der Build ist grün."));
        let open = "Kurz vorweg.\n```\nlet x = 1;\nNoch Code. Und mehr.";
        assert_eq!(excerpt(open).as_deref(), Some("Kurz vorweg."));
        let indented = "    cargo test\n\nGeprüft.";
        assert_eq!(excerpt(indented).as_deref(), Some("Geprüft."));
    }

    #[test]
    fn drops_tables_headings_and_rules() {
        let t = "## Stand\n\n| a | b |\n|---|---|\n---\nAlles erledigt.";
        assert_eq!(excerpt(t).as_deref(), Some("Alles erledigt."));
    }

    #[test]
    fn drops_whole_sentences_with_paths_urls_and_files() {
        let t = "Ich habe D:\\GN_AI\\repo geändert. Siehe https://example.com. \
                 Die Datei main.rs ist neu. Unter \\\\server\\share liegt es. \
                 Auch ~/x und /usr/bin zählen. Der Rest passt.";
        assert_eq!(excerpt(t).as_deref(), Some("Der Rest passt."));
    }

    #[test]
    fn drops_hashes_uuids_and_identifiers() {
        let t = "Commit 1687b38 ist drin. Session 3f4fe5b8-6a2f-4bbf-a2a2-18d3fa4951e0 lief. \
                 Die Funktion take_valid_utf8 bleibt. Ein Wort bleibt.";
        assert_eq!(excerpt(t).as_deref(), Some("Ein Wort bleibt."));
    }

    #[test]
    fn keeps_plain_inline_words_but_drops_inline_code() {
        assert_eq!(
            excerpt("Das Flag `allowExcerpts` ist aus. `cargo test` lief.").as_deref(),
            Some("Das Flag allowExcerpts ist aus.")
        );
    }

    #[test]
    fn resolves_links_and_emphasis_but_drops_autolinks() {
        assert_eq!(
            excerpt("Lies den [Plan](plans/x.md) und **dann** _bitte_ freigeben.").as_deref(),
            Some("Lies den Plan und dann bitte freigeben.")
        );
        assert_eq!(
            excerpt("Quelle <https://x.y>. Gut so.").as_deref(),
            Some("Gut so.")
        );
    }

    #[test]
    fn list_items_and_quotes_are_sentences_of_their_own() {
        let t = "- Tests grün\n- Build ok\n- Push offen";
        assert_eq!(excerpt(t).as_deref(), Some("Tests grün Build ok"));
        let t = "1. Erst prüfen\n2. Dann mergen";
        assert_eq!(excerpt(t).as_deref(), Some("Erst prüfen Dann mergen"));
    }

    #[test]
    fn shell_lines_and_symbols_only_are_not_speakable() {
        assert_eq!(excerpt("$ npm test\n\n---\n\n123 456"), None);
        assert_eq!(excerpt(""), None);
        assert_eq!(excerpt("```\nonly code\n```"), None);
    }

    #[test]
    fn caps_at_300_chars_on_a_word_boundary_unicode_safe() {
        let long = format!("{}.", "Überprüfung läuft ".repeat(30).trim_end());
        let got = excerpt(&long).unwrap();
        assert!(got.chars().count() <= MAX_CHARS);
        assert!(got.ends_with("läuft") || got.ends_with("Überprüfung"));
        // A second sentence that would overflow is left out, not cut.
        let first = format!("{}.", "a".repeat(200));
        let second = format!("{}.", "b ".repeat(80).trim_end());
        assert_eq!(excerpt(&format!("{first} {second}")).unwrap(), first);
    }

    #[test]
    fn control_characters_never_reach_the_voice() {
        assert_eq!(
            excerpt("Fertig\u{0} und\u{7} gut.").as_deref(),
            Some("Fertig und gut.")
        );
    }
}
