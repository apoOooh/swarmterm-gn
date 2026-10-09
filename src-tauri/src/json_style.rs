//! Rendering a user-owned JSON file back in its OWN style.
//!
//! `serde_json::to_string_pretty` forces 2-space indent and drops the trailing
//! newline, so the first real write (first boot, exe-path drift,
//! enable/disable) turned a dotfile-tracked `~/.claude.json` into a full-file
//! diff. Shared by `mcp/config.rs`, `statusline/install.rs`, `hook/install.rs`.
//! Key ORDER is the `preserve_order` feature's job (Cargo.toml); this module
//! only mirrors indent + trailing newline. Body line endings stay `\n` (serde's
//! formatter) — only the trailing newline is mirrored for CRLF files; a
//! per-line formatter fork is not worth it for a file Claude rewrites itself.

use serde::Serialize;
use serde_json::ser::PrettyFormatter;
use serde_json::{Serializer, Value};

/// One indentation level as found in the user's file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Indent {
    Spaces(usize),
    Tab,
}

impl Indent {
    fn unit(self) -> Vec<u8> {
        match self {
            Indent::Tab => b"\t".to_vec(),
            Indent::Spaces(n) => vec![b' '; n],
        }
    }
}

/// The indent of the first line that starts with spaces/tabs followed by
/// content. JSON strings cannot hold raw newlines, so a line's leading
/// whitespace is always structural — and the first indented line is by
/// construction the shallowest level, i.e. the unit. Only ' ' and '\t' count
/// (JSON's own whitespace set); a compact or one-line file falls back to
/// serde's 2 spaces, which is also what a brand-new file gets.
pub fn detect_indent(text: &str) -> Indent {
    for line in text.lines() {
        let content = line.trim_start_matches([' ', '\t']);
        if content.trim().is_empty() || content.len() == line.len() {
            continue;
        }
        let ws = &line[..line.len() - content.len()];
        return if ws.starts_with('\t') {
            Indent::Tab
        } else {
            Indent::Spaces(ws.len())
        };
    }
    Indent::Spaces(2)
}

/// Everything about a file's look that serde would otherwise normalise away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonStyle {
    pub indent: Indent,
    /// `""`, `"\n"` or `"\r\n"` — whatever the ORIGINAL bytes ended with. A
    /// new file gets none, byte-identical to `to_string_pretty`.
    pub newline: &'static str,
}

impl JsonStyle {
    /// Detect on the raw file text (NOT a trimmed copy — trimming eats the
    /// very newline this mirrors).
    pub fn detect(existing: Option<&str>) -> JsonStyle {
        let text = existing.unwrap_or("");
        let newline = if text.ends_with("\r\n") {
            "\r\n"
        } else if text.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        JsonStyle {
            indent: detect_indent(text),
            newline,
        }
    }

    pub fn render(&self, value: &Value) -> Result<String, String> {
        let unit = self.indent.unit();
        let mut buf = Vec::new();
        let mut ser = Serializer::with_formatter(&mut buf, PrettyFormatter::with_indent(&unit));
        value.serialize(&mut ser).map_err(|e| e.to_string())?;
        let mut out = String::from_utf8(buf).map_err(|e| e.to_string())?;
        out.push_str(self.newline);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn detects_two_and_four_space_indent() {
        assert_eq!(detect_indent("{\n  \"a\": 1\n}"), Indent::Spaces(2));
        assert_eq!(detect_indent("{\n    \"a\": 1\n}"), Indent::Spaces(4));
        // A blank line (even one holding stray spaces) is not structure.
        assert_eq!(detect_indent("{\n   \n    \"a\": 1\n}"), Indent::Spaces(4));
    }

    #[test]
    fn detects_tab_indent() {
        assert_eq!(
            detect_indent("{\n\t\"a\": {\n\t\t\"b\": 1\n\t}\n}"),
            Indent::Tab
        );
    }

    #[test]
    fn falls_back_to_two_spaces_without_an_indented_line() {
        assert_eq!(detect_indent("{\"a\":1}"), Indent::Spaces(2));
        assert_eq!(detect_indent(""), Indent::Spaces(2));
        assert_eq!(JsonStyle::detect(None).indent, Indent::Spaces(2));
    }

    #[test]
    fn mirrors_the_trailing_newline_of_the_original() {
        assert_eq!(JsonStyle::detect(Some("{}")).newline, "");
        assert_eq!(JsonStyle::detect(Some("{}\n")).newline, "\n");
        assert_eq!(JsonStyle::detect(Some("{}\r\n")).newline, "\r\n");
        assert_eq!(JsonStyle::detect(None).newline, "");
    }

    #[test]
    fn renders_in_written_order_with_four_spaces_and_newline() {
        let style = JsonStyle {
            indent: Indent::Spaces(4),
            newline: "\n",
        };
        let out = style.render(&v(r#"{"z":1,"a":{"y":[1]}}"#)).unwrap();
        assert_eq!(
            out,
            "{\n    \"z\": 1,\n    \"a\": {\n        \"y\": [\n            1\n        ]\n    }\n}\n"
        );
    }

    #[test]
    fn renders_with_tabs_and_no_newline() {
        let style = JsonStyle {
            indent: Indent::Tab,
            newline: "",
        };
        let out = style.render(&v(r#"{"z":1,"a":{"y":[1]}}"#)).unwrap();
        assert_eq!(
            out,
            "{\n\t\"z\": 1,\n\t\"a\": {\n\t\t\"y\": [\n\t\t\t1\n\t\t]\n\t}\n}"
        );
    }

    #[test]
    fn new_file_style_is_byte_identical_to_to_string_pretty() {
        let value = v(r#"{"mcpServers":{"swarmterm":{"type":"http","url":"u"}}}"#);
        let out = JsonStyle::detect(None).render(&value).unwrap();
        assert_eq!(out, serde_json::to_string_pretty(&value).unwrap());
    }

    #[test]
    fn rendered_text_round_trips() {
        let value = v(r#"{"z":[1,{"q":null}],"a":"s\n\"q\""}"#);
        let style = JsonStyle {
            indent: Indent::Spaces(4),
            newline: "\r\n",
        };
        let out = style.render(&value).unwrap();
        assert!(out.ends_with("}\r\n"));
        assert_eq!(v(&out), value);
    }
}
