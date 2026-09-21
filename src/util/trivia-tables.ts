/**
 * Per-language trivia tables for the offset-preserving trivia scanner in `./trivia.js`. Rows are
 * keyed by language id; the tables deliberately live outside `LanguageDefinition` because the
 * language definitions are frozen this wave.
 *
 * Every row is written against the actual language grammar, not against whatever the previous
 * JS-flavored masker happened to accept: a Go raw string has no escape character, a C# verbatim
 * string doubles its closing quote instead of honoring backslash escapes, a Python comment can
 * contain apostrophes, and so on.
 */

export type TriviaInterpolation = {
  /** Interpolation start delimiter, e.g. `${` or `\(`. */
  start: string;
  /** Interpolation end delimiter, e.g. `}` or `)`. */
  end: string;
  /** Doubled delimiters are literals rather than nesting (Python f-strings). */
  doubled?: boolean;
  /** The expression between the delimiters stays visible in span masks (JS template holes). */
  excludeFromMask?: boolean;
};

export type TriviaStringForm = {
  /** Sticky-regex source matching the optional prefix immediately before `open` (Python b/r/u/f, Rust b/c). */
  prefix?: string;
  /** Opening delimiter. */
  open: string;
  /** Closing delimiter; hash runs and quote runs are matched dynamically when the flags below are set. */
  close: string;
  /** Escape character inside the literal; omit for raw literals. */
  escape?: string;
  /** A doubled close delimiter escapes it (C# verbatim `""`). */
  doubled?: boolean;
  /** A `#` run between the prefix and `open` must be matched after `close` (Swift extended delimiters, Rust raw strings). */
  hashes?: boolean;
  /** The open and close are runs of `open[0]` at least `open.length` long (C# raw strings). */
  quoteRun?: boolean;
  /** The close delimiter only closes when it is alone on its line (Swift multiline strings). */
  closeAloneOnLine?: boolean;
  /** The quote only opens a literal when it parses as a character literal (Rust lifetimes are not chars). */
  charLike?: boolean;
  /** Interpolation regions scanned recursively so a nested same-quote literal cannot close the string. */
  interpolation?: TriviaInterpolation;
};

export type TriviaBlockComment = {
  open: string;
  close: string;
  nested?: boolean;
  /** The opener is only a comment at the very start of a line (Ruby `=begin`). */
  lineStartOnly?: boolean;
};

export type TriviaHeredocForm = {
  /** Sticky-regex source matching the opener through the terminator id; capture 1 is the terminator id. */
  opener: string;
  /** The terminator may be indented (PHP 7.3+, Ruby `<<~` and `<<-`). */
  indentedTerminator?: boolean;
};

export type TriviaRow = {
  lineComments: string[];
  blockComments: TriviaBlockComment[];
  strings: TriviaStringForm[];
  heredocs?: TriviaHeredocForm[];
  /** Ruby percent literals (`%q(...)`, `%w[...]`, ...). */
  percentLiterals?: boolean;
  /** Zig multiline strings: backslash-prefixed continuation lines. */
  zigMultiline?: boolean;
};

const SLASH_STAR_COMMENT: TriviaBlockComment = { open: "/*", close: "*/" };
const NESTED_SLASH_STAR_COMMENT: TriviaBlockComment = { open: "/*", close: "*/", nested: true };

const JS_LIKE_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: "'", close: "'", escape: "\\" },
    { open: '"', close: '"', escape: "\\" },
    { open: "`", close: "`", escape: "\\", interpolation: { start: "${", end: "}", excludeFromMask: true } },
  ],
};

// Prefix combinations valid for Python string literals; `f` enables interpolation.
const PYTHON_F_PREFIX = "(?:[fF]|[rR][fF]|[fF][rR])";
const PYTHON_PLAIN_PREFIX = "(?:[bBuU]|[bB][rR]|[rR][bB])?";
const PYTHON_INTERPOLATION = { start: "{", end: "}", doubled: true };

const PYTHON_ROW: TriviaRow = {
  lineComments: ["#"],
  blockComments: [],
  strings: [
    { prefix: PYTHON_F_PREFIX, open: '"""', close: '"""', escape: "\\", interpolation: PYTHON_INTERPOLATION },
    { prefix: PYTHON_F_PREFIX, open: "'''", close: "'''", escape: "\\", interpolation: PYTHON_INTERPOLATION },
    { prefix: PYTHON_F_PREFIX, open: '"', close: '"', escape: "\\", interpolation: PYTHON_INTERPOLATION },
    { prefix: PYTHON_F_PREFIX, open: "'", close: "'", escape: "\\", interpolation: PYTHON_INTERPOLATION },
    { prefix: PYTHON_PLAIN_PREFIX, open: '"""', close: '"""', escape: "\\" },
    { prefix: PYTHON_PLAIN_PREFIX, open: "'''", close: "'''", escape: "\\" },
    { prefix: PYTHON_PLAIN_PREFIX, open: '"', close: '"', escape: "\\" },
    { prefix: PYTHON_PLAIN_PREFIX, open: "'", close: "'", escape: "\\" },
  ],
};

const CSHARP_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    // A verbatim (or interpolated verbatim) string doubles its closing quote; the backslash is data.
    { prefix: "(?:[$][@]|[@][$]|[@])", open: '"', close: '"', doubled: true },
    { open: '"""', close: '"""', quoteRun: true },
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
};

const GO_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: "`", close: "`" },
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
};

const RUST_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [NESTED_SLASH_STAR_COMMENT],
  strings: [
    { prefix: "[bc]?r", open: '"', close: '"', hashes: true },
    { prefix: "b?", open: '"', close: '"', escape: "\\" },
    { prefix: "b?", open: "'", close: "'", escape: "\\", charLike: true },
  ],
};

const PHP_HEREDOC_OPENER = "<<<[ \\t]*(?:\"([^\"\\r\\n]*)\"|'([^'\\r\\n]*)'|([A-Za-z_]\\w*))";

const PHP_ROW: TriviaRow = {
  lineComments: ["//", "#"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: "'", close: "'", escape: "\\" },
    { open: '"', close: '"', escape: "\\" },
  ],
  heredocs: [{ opener: PHP_HEREDOC_OPENER, indentedTerminator: true }],
};

const RUBY_HEREDOC_ID = "(?:\"([^\"\\r\\n]*)\"|'([^'\\r\\n]*)'|([A-Za-z_]\\w*))";

const RUBY_ROW: TriviaRow = {
  lineComments: ["#"],
  blockComments: [{ open: "=begin", close: "=end", lineStartOnly: true }],
  strings: [
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
  heredocs: [
    { opener: `<<[~-]${RUBY_HEREDOC_ID}`, indentedTerminator: true },
    { opener: `<<${RUBY_HEREDOC_ID}`, indentedTerminator: false },
  ],
  percentLiterals: true,
};

const SWIFT_INTERPOLATION = { start: "\\(", end: ")" };

const SWIFT_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [NESTED_SLASH_STAR_COMMENT],
  strings: [
    { open: '"""', close: '"""', escape: "\\", closeAloneOnLine: true, interpolation: SWIFT_INTERPOLATION },
    { open: '"', close: '"', escape: "\\", interpolation: SWIFT_INTERPOLATION },
    { hashes: true, open: '"""', close: '"""', closeAloneOnLine: true },
    { hashes: true, open: '"', close: '"' },
  ],
};

const KOTLIN_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [NESTED_SLASH_STAR_COMMENT],
  strings: [
    { open: '"""', close: '"""', interpolation: { start: "${", end: "}" } },
    { open: '"', close: '"', escape: "\\", interpolation: { start: "${", end: "}" } },
    { open: "'", close: "'", escape: "\\" },
  ],
};

const ZIG_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [],
  strings: [
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
  zigMultiline: true,
};

// CSS family: block comments only. `//` is SCSS/Less comment syntax, but an unquoted `url(//...)`
// is not, so a line comment would blank real declarations.
const CSS_FAMILY_ROW: TriviaRow = {
  lineComments: [],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: "'", close: "'", escape: "\\" },
    { open: '"', close: '"', escape: "\\" },
  ],
};

const C_FAMILY_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
};

const JAVA_ROW: TriviaRow = {
  lineComments: ["//"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: '"""', close: '"""', escape: "\\" },
    { open: '"', close: '"', escape: "\\" },
    { open: "'", close: "'", escape: "\\" },
  ],
};

const SQL_ROW: TriviaRow = {
  lineComments: ["--"],
  blockComments: [SLASH_STAR_COMMENT],
  strings: [
    { open: "'", close: "'", doubled: true },
    { open: '"', close: '"', doubled: true },
  ],
};

const TRIVIA_ROWS: Record<string, TriviaRow> = {
  js: JS_LIKE_ROW,
  ts: JS_LIKE_ROW,
  tsx: JS_LIKE_ROW,
  javascript: JS_LIKE_ROW,
  typescript: JS_LIKE_ROW,
  jsx: JS_LIKE_ROW,
  python: PYTHON_ROW,
  csharp: CSHARP_ROW,
  go: GO_ROW,
  rust: RUST_ROW,
  php: PHP_ROW,
  ruby: RUBY_ROW,
  swift: SWIFT_ROW,
  kotlin: KOTLIN_ROW,
  zig: ZIG_ROW,
  css: CSS_FAMILY_ROW,
  less: CSS_FAMILY_ROW,
  scss: CSS_FAMILY_ROW,
  c: C_FAMILY_ROW,
  cpp: C_FAMILY_ROW,
  java: JAVA_ROW,
  sql: SQL_ROW,
};

/** The trivia row for `languageId`; unknown ids fall back to the JS-family row, which is what
 * every consumer used before the per-language tables existed. */
export function triviaRowFor(languageId: string): TriviaRow {
  return TRIVIA_ROWS[languageId] ?? JS_LIKE_ROW;
}
