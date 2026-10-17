//! What Swarmterm says after a Claude turn (SWA-58, docs/adr/0004). Pure.
//!
//! First choice is the agent's own spoken line: with "Allow excerpts" on,
//! the `UserPromptSubmit` hook asks Claude to end every answer with
//! `<voice>…</voice>` (`VOICE_INSTRUCTION`). That line is still agent
//! output and therefore untrusted, so it runs through the same filter as an
//! excerpt (no code, paths, URLs, hashes; ≤ 300 chars at a word). Without a
//! usable block the first prose sentences are quoted instead (`Quoted`,
//! announced as "<Pane> schreibt: …"). Nothing left → `None`, and the
//! caller falls back to the status announcement, never to screen text.

use super::excerpt;

const OPEN: &str = "<voice>";
const CLOSE: &str = "</voice>";

/// The additional context the hook hands Claude Code on every prompt while
/// "Allow excerpts" is on. Short on purpose: it costs tokens on every turn.
pub const VOICE_INSTRUCTION: &str = "Swarmterm reads your reply aloud to the user. \
End every answer with one final line <voice>…</voice>: one or two short spoken \
sentences to the user in their language, first person, no code, paths, file \
names or URLs; if you need a decision, ask it as a question.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// The agent's own `<voice>` line, filtered.
    Voice(String),
    /// First prose sentences of the answer (rule-based fallback).
    Quoted(String),
}

/// The content of the LAST `<voice>…</voice>` block, if any.
fn voice_block(text: &str) -> Option<&str> {
    let start = text.rfind(OPEN)? + OPEN.len();
    let len = text[start..].find(CLOSE)?;
    let inner = text[start..start + len].trim();
    (!inner.is_empty()).then_some(inner)
}

/// `text` without any `<voice>` block, so a filtered-out block is never
/// quoted by the fallback either.
fn without_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        match rest[i..].find(CLOSE) {
            Some(j) => rest = &rest[i + j + CLOSE.len()..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The reply to speak for one final answer.
pub fn reply(text: &str) -> Option<Reply> {
    if let Some(spoken) = voice_block(text).and_then(excerpt::excerpt) {
        return Some(Reply::Voice(spoken));
    }
    excerpt::excerpt(&without_blocks(text)).map(Reply::Quoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_voice_block() {
        let text = "## Ergebnis\n\nIch habe `auth.rs` angepasst.\n\n\
                    <voice>Ich habe den Login-Test repariert, alle Tests laufen. Soll ich committen?</voice>";
        assert_eq!(
            reply(text),
            Some(Reply::Voice(
                "Ich habe den Login-Test repariert, alle Tests laufen. Soll ich committen?".into()
            ))
        );
    }

    #[test]
    fn the_last_block_wins() {
        let text = "Erklärung: <voice>alt</voice> mehr.\n<voice>Neu ist fertig.</voice>";
        assert_eq!(reply(text), Some(Reply::Voice("Neu ist fertig.".into())));
    }

    #[test]
    fn filters_the_block_like_any_agent_output() {
        // Untrusted: a path or URL in the block drops that sentence.
        let text = "Fertig.\n<voice>Siehe D:\\geheim\\plan.md. Alles erledigt.</voice>";
        assert_eq!(reply(text), Some(Reply::Voice("Alles erledigt.".into())));
        let long = format!("<voice>{}</voice>", "wort ".repeat(200));
        let Some(Reply::Voice(v)) = reply(&long) else {
            panic!("expected a voice reply");
        };
        assert!(v.chars().count() <= excerpt::MAX_CHARS);
    }

    #[test]
    fn falls_back_to_quoting_prose_without_the_block() {
        assert_eq!(
            reply("Die Migration ist durch. Drei Tabellen sind neu.\n\n```sql\nDROP\n```"),
            Some(Reply::Quoted(
                "Die Migration ist durch. Drei Tabellen sind neu.".into()
            ))
        );
        // A block with nothing speakable never leaks into the fallback.
        assert_eq!(
            reply("Erledigt, alles grün.\n<voice>https://x.example/a</voice>"),
            Some(Reply::Quoted("Erledigt, alles grün.".into()))
        );
        // An unterminated or empty block is no block.
        assert_eq!(
            reply("Gut gelaufen. <voice></voice>"),
            Some(Reply::Quoted("Gut gelaufen.".into()))
        );
    }

    #[test]
    fn nothing_speakable_is_none() {
        assert_eq!(reply("```\ncargo test\n```"), None);
        assert_eq!(reply("<voice>src/main.rs</voice>"), None);
        assert_eq!(reply(""), None);
    }

    #[test]
    fn the_instruction_names_the_marker() {
        assert!(VOICE_INSTRUCTION.contains("<voice>"));
        assert!(VOICE_INSTRUCTION.len() < 400);
    }
}
