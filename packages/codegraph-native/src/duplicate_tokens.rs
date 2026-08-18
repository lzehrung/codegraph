use crate::duplicate_keywords::DUPLICATE_IDENTIFIER_KEYWORDS;
use crate::types::NativeDuplicateTokens;

pub fn tokenize_duplicate_source(source: &str) -> NativeDuplicateTokens {
    let tokens = tokenize_source(source);
    let normalized_tokens = tokens.into_iter().map(|token| normalize_token(&token)).collect();
    NativeDuplicateTokens { normalized_tokens }
}

fn tokenize_source(source: &str) -> Vec<String> {
    let chars: Vec<(usize, char)> = source.char_indices().collect();
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < chars.len() {
        let (_, ch) = chars[cursor];
        if ch.is_whitespace() {
            cursor += 1;
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            let start_byte = chars[cursor].0;
            let quote = ch;
            cursor += 1;
            let mut escaped = false;
            while cursor < chars.len() {
                let (_, current) = chars[cursor];
                cursor += 1;
                if escaped {
                    escaped = false;
                    continue;
                }
                if current == '\\' {
                    escaped = true;
                    continue;
                }
                if current == quote {
                    break;
                }
            }
            tokens.push(source[start_byte..byte_end(source, &chars, cursor)].to_string());
            continue;
        }
        if is_identifier_start(ch) {
            let start_byte = chars[cursor].0;
            cursor += 1;
            while cursor < chars.len() && is_identifier_continue(chars[cursor].1) {
                cursor += 1;
            }
            tokens.push(source[start_byte..byte_end(source, &chars, cursor)].to_string());
            continue;
        }
        if ch.is_ascii_digit() {
            let start_byte = chars[cursor].0;
            cursor += 1;
            while cursor < chars.len() && chars[cursor].1.is_ascii_digit() {
                cursor += 1;
            }
            if cursor + 1 < chars.len() && chars[cursor].1 == '.' && chars[cursor + 1].1.is_ascii_digit() {
                cursor += 1;
                while cursor < chars.len() && chars[cursor].1.is_ascii_digit() {
                    cursor += 1;
                }
            }
            tokens.push(source[start_byte..byte_end(source, &chars, cursor)].to_string());
            continue;
        }
        tokens.push(ch.to_string());
        cursor += 1;
    }
    tokens
}

fn byte_end(source: &str, chars: &[(usize, char)], cursor: usize) -> usize {
    if cursor < chars.len() {
        chars[cursor].0
    } else {
        source.len()
    }
}

// Duplicate tokenization intentionally mirrors the JavaScript XID-based grammar rather than
// ECMAScript IdentifierName: XID properties plus `$`/`_`, Other_ID_* and ZWNJ/ZWJ continuation
// characters. XID_* removes NFKC-closure-breaking characters from ID_*, so the start and
// continuation predicates both differ from ECMAScript's ID_* grammar.
fn is_other_id_start(ch: char) -> bool {
    matches!(
        ch,
        '\u{1885}' | '\u{1886}' | '\u{2118}' | '\u{212E}' | '\u{309B}' | '\u{309C}'
    )
}

fn is_other_id_continue(ch: char) -> bool {
    matches!(ch, '\u{00B7}' | '\u{0387}' | '\u{19DA}') || ('\u{1369}'..='\u{1371}').contains(&ch)
}

fn is_identifier_start(ch: char) -> bool {
    ch == '_' || ch == '$' || unicode_ident::is_xid_start(ch) || is_other_id_start(ch)
}

fn is_identifier_continue(ch: char) -> bool {
    ch == '_'
        || ch == '$'
        || ch == '\u{200C}'
        || ch == '\u{200D}'
        || unicode_ident::is_xid_continue(ch)
        || is_other_id_start(ch)
        || is_other_id_continue(ch)
}

fn normalize_token(token: &str) -> String {
    if token.starts_with('"')
        || token.starts_with('\'')
        || token.starts_with('`')
        || token.chars().next().map_or(false, |ch| ch.is_ascii_digit())
    {
        return "<literal>".to_string();
    }
    if token.chars().next().is_some_and(is_identifier_start) && token.chars().all(is_identifier_continue) {
        let lower = token.to_lowercase();
        if is_identifier_keyword(&lower) {
            return lower;
        }
        return "<identifier>".to_string();
    }
    token.to_string()
}

fn is_identifier_keyword(value: &str) -> bool {
    DUPLICATE_IDENTIFIER_KEYWORDS.contains(value)
}

#[cfg(test)]
mod tests {
    use super::tokenize_duplicate_source;
    use crate::duplicate_keywords::DUPLICATE_IDENTIFIER_KEYWORDS;

    #[test]
    fn normalizes_duplicate_tokens() {
        let tokens = tokenize_duplicate_source("function add(a, 1) { return a + \"x\"; }");
        assert_eq!(
            tokens.normalized_tokens,
            vec![
                "function",
                "<identifier>",
                "(",
                "<identifier>",
                ",",
                "<literal>",
                ")",
                "{",
                "return",
                "<identifier>",
                "+",
                "<literal>",
                ";",
                "}",
            ]
        );
    }

    #[test]
    fn preserves_keyword_tokens_like_js_fallback() {
        let tokens = tokenize_duplicate_source("if left and right { delete cache; }");
        assert_eq!(
            tokens.normalized_tokens,
            vec![
                "if",
                "left",
                "and",
                "right",
                "{",
                "delete",
                "<identifier>",
                ";",
                "}",
            ]
        );
    }

    #[test]
    fn collapses_unicode_identifiers_like_js_fallback() {
        let nfc = tokenize_duplicate_source("function café(x) { return café; }");
        assert_eq!(
            nfc.normalized_tokens,
            vec![
                "function",
                "<identifier>",
                "(",
                "<identifier>",
                ")",
                "{",
                "return",
                "<identifier>",
                ";",
                "}",
            ]
        );

        // NFD: ASCII letters plus combining acute must stay one identifier token.
        let nfd = tokenize_duplicate_source("cafe\u{0301}");
        assert_eq!(nfd.normalized_tokens, vec!["<identifier>".to_string()]);

        let ascii = tokenize_duplicate_source("function foo(x) { return foo; }");
        let unicode = tokenize_duplicate_source("function αβγ(x) { return αβγ; }");
        assert_eq!(ascii.normalized_tokens, unicode.normalized_tokens);
    }

    #[test]
    fn collapses_ecmascript_other_id_and_zwnj_like_js_fallback() {
        // U+2118 is Other_ID_Start (in ID_Start, not XID_Start).
        let other_id = tokenize_duplicate_source("function \u{2118}(x) { return \u{2118}; }");
        assert_eq!(
            other_id.normalized_tokens,
            vec![
                "function",
                "<identifier>",
                "(",
                "<identifier>",
                ")",
                "{",
                "return",
                "<identifier>",
                ";",
                "}",
            ]
        );

        // ZWNJ (U+200C) is an ECMAScript IdentifierPart continuation.
        let zwnj = tokenize_duplicate_source("a\u{200C}b");
        assert_eq!(zwnj.normalized_tokens, vec!["<identifier>".to_string()]);

        let ascii = tokenize_duplicate_source("function foo(x) { return foo; }");
        assert_eq!(ascii.normalized_tokens, other_id.normalized_tokens);
    }

    #[test]
    fn generated_keyword_set_matches_canonical_source_file() {
        let source = include_str!("duplicate_keywords.txt");
        let keywords: Vec<&str> = source
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        assert_eq!(DUPLICATE_IDENTIFIER_KEYWORDS.len(), keywords.len());
        for keyword in keywords {
            assert!(DUPLICATE_IDENTIFIER_KEYWORDS.contains(keyword));
        }
    }

    #[test]
    fn tokenization_preserves_every_generated_keyword() {
        let mut keywords: Vec<&str> = DUPLICATE_IDENTIFIER_KEYWORDS.iter().copied().collect();
        keywords.sort_unstable();
        let source = keywords.join(" ");
        let tokens = tokenize_duplicate_source(&source);
        assert_eq!(tokens.normalized_tokens, keywords);
    }
}
