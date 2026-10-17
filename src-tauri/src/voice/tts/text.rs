//! What gets said. Pane titles come from the program in the pane (OSC 0/2)
//! and often carry a cwd, a URL or a branch path; a voice reading
//! "D colon backslash GN underscore AI" is noise, so path- and URL-like words
//! are dropped and an empty result falls back to a neutral name.

use crate::voice::protocol::{clean_label, TurnKind};

/// Pane names longer than this are cut at a word boundary: an announcement
/// should be over before the user has turned their head.
const MAX_SPOKEN_NAME_CHARS: usize = 40;

fn is_path_or_url(word: &str) -> bool {
    word.contains('/')
        || word.contains('\\')
        || word.contains("://")
        || word.starts_with("www.")
        || (word.len() >= 2
            && word.as_bytes()[1] == b':'
            && word.as_bytes()[0].is_ascii_alphabetic())
}

/// A pane name fit for speech, or `None` when nothing speakable is left.
pub fn spoken_name(pane_name: &str) -> Option<String> {
    let label = clean_label(pane_name);
    let mut out = String::new();
    // Separators like "·" or "|" join title parts; they are read out by
    // some voices, so they become a pause (comma) instead.
    for word in label.split_whitespace() {
        if is_path_or_url(word) {
            continue;
        }
        let word = match word {
            "·" | "|" | "—" | "-" | "–" => ",",
            w => w,
        };
        if word == "," && (out.is_empty() || out.ends_with(',')) {
            continue;
        }
        if out.chars().count() + word.chars().count() > MAX_SPOKEN_NAME_CHARS {
            break;
        }
        if !out.is_empty() && word != "," {
            out.push(' ');
        }
        out.push_str(word);
    }
    let out = out.trim_end_matches(',').trim().to_owned();
    (!out.is_empty()).then_some(out)
}

fn name_for(pane_name: &str, agent: &str, english: bool) -> String {
    spoken_name(pane_name)
        .or_else(|| spoken_name(agent))
        .unwrap_or_else(|| if english { "An agent" } else { "Ein Agent" }.to_owned())
}

/// The announcement in the voice's language: German unless the voice is
/// English. Status only — never output text (that is `excerpt_line`).
pub fn announcement(pane_name: &str, agent: &str, kind: TurnKind, lang: &str) -> String {
    let english = lang.starts_with("en");
    let name = name_for(pane_name, agent, english);
    match (kind, english) {
        (TurnKind::Done, false) => format!("{name}: fertig."),
        (TurnKind::NeedsInput, false) => format!("{name} wartet auf Eingabe."),
        (TurnKind::Error, false) => format!("{name}: Fehler."),
        (TurnKind::Done, true) => format!("{name} is done."),
        (TurnKind::NeedsInput, true) => format!("{name} needs input."),
        (TurnKind::Error, true) => format!("{name} failed."),
    }
}

/// SWA-58: an excerpt, honestly labelled as one — it is the first sentences,
/// not a summary. The excerpt itself was already reduced to speakable prose.
pub fn excerpt_line(pane_name: &str, agent: &str, excerpt: &str, lang: &str) -> String {
    let english = lang.starts_with("en");
    let name = name_for(pane_name, agent, english);
    if english {
        format!("{name}, excerpt: {excerpt}")
    } else {
        format!("{name}, Auszug: {excerpt}")
    }
}

/// What Ctrl+Shift+R says when there is nothing to read — never silence,
/// or the user cannot tell a missing excerpt from a dead hotkey.
pub fn no_excerpt(lang: &str) -> &'static str {
    if lang.starts_with("en") {
        "No excerpt available."
    } else {
        "Kein Auszug verfügbar."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_status_in_german_by_default() {
        assert_eq!(
            announcement("Backend", "claude-code", TurnKind::Done, "de-DE"),
            "Backend: fertig."
        );
        assert_eq!(
            announcement("Backend", "codex", TurnKind::NeedsInput, ""),
            "Backend wartet auf Eingabe."
        );
        assert_eq!(
            announcement("Backend", "codex", TurnKind::Done, "en-US"),
            "Backend is done."
        );
    }

    #[test]
    fn says_errors_and_labels_excerpts() {
        assert_eq!(
            announcement("Backend", "claude-code", TurnKind::Error, "de"),
            "Backend: Fehler."
        );
        assert_eq!(
            announcement("Backend", "claude-code", TurnKind::Error, "en"),
            "Backend failed."
        );
        assert_eq!(
            excerpt_line("✳ Backend", "claude-code", "Alles grün.", "de"),
            "Backend, Auszug: Alles grün."
        );
        assert_eq!(no_excerpt("en-US"), "No excerpt available.");
    }

    #[test]
    fn drops_paths_urls_and_status_glyphs() {
        assert_eq!(
            spoken_name("✳ Voice Agent Stimme · swarmterm").as_deref(),
            Some("Voice Agent Stimme, swarmterm")
        );
        assert_eq!(
            spoken_name("Fix D:\\GN_AI\\repo build").as_deref(),
            Some("Fix build")
        );
        assert_eq!(
            spoken_name("open https://example.com now").as_deref(),
            Some("open now")
        );
        assert_eq!(spoken_name("feat/swa-66-tts"), None);
    }

    #[test]
    fn falls_back_to_the_agent_then_a_neutral_name() {
        assert_eq!(
            announcement("C:\\Users\\x", "codex", TurnKind::Done, "de"),
            "codex: fertig."
        );
        assert_eq!(
            announcement("", "", TurnKind::Done, "de"),
            "Ein Agent: fertig."
        );
    }

    #[test]
    fn cuts_long_names_at_a_word() {
        let long = "eins zwei drei vier fünf sechs sieben acht neun zehn elf";
        let name = spoken_name(long).unwrap();
        assert!(name.chars().count() <= MAX_SPOKEN_NAME_CHARS);
        assert!(long.starts_with(&name));
    }
}
