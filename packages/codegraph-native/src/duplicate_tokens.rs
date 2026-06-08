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

fn is_identifier_start(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
}

fn is_identifier_continue(ch: char) -> bool {
    is_identifier_start(ch) || ch.is_ascii_digit()
}

fn normalize_token(token: &str) -> String {
    if token.starts_with('"') || token.starts_with('\'') || token.starts_with('`') || token.starts_with(|ch: char| ch.is_ascii_digit()) {
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
    matches!(
        value,
        "abstract"
            | "and"
            | "as"
            | "async"
            | "await"
            | "break"
            | "case"
            | "catch"
            | "class"
            | "const"
            | "continue"
            | "def"
            | "default"
            | "defer"
            | "delete"
            | "do"
            | "else"
            | "enum"
            | "export"
            | "extends"
            | "false"
            | "final"
            | "finally"
            | "fn"
            | "for"
            | "from"
            | "func"
            | "function"
            | "if"
            | "implements"
            | "import"
            | "in"
            | "interface"
            | "is"
            | "lambda"
            | "let"
            | "match"
            | "module"
            | "namespace"
            | "new"
            | "nil"
            | "none"
            | "not"
            | "null"
            | "or"
            | "package"
            | "private"
            | "protected"
            | "public"
            | "return"
            | "self"
            | "static"
            | "struct"
            | "switch"
            | "this"
            | "throw"
            | "throws"
            | "trait"
            | "true"
            | "try"
            | "type"
            | "use"
            | "using"
            | "var"
            | "void"
            | "when"
            | "where"
            | "while"
    )
}

#[cfg(test)]
mod tests {
    use super::tokenize_duplicate_source;

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
                "<identifier>",
                "and",
                "<identifier>",
                "{",
                "delete",
                "<identifier>",
                ";",
                "}",
            ]
        );
    }
}
