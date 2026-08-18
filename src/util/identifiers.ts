/**
/**
 * Returns whether identifier equality needs Unicode processing. Java also sends C0
 * controls through its normalization path because some are identifier-ignorable.
 */
export function hasNonAsciiCodePoint(value: string, includeC0Controls = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7f || (includeC0Controls && codePoint <= 0x1f)) return true;
  }
  return false;
}

/**
 * ECMAScript identifier syntax, including ZWNJ and ZWJ continuation characters. Import
 * extraction requires this exact language-conforming grammar.
 */
export const ECMASCRIPT_IDENTIFIER_SOURCE = String.raw`[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*`;

/**
 * Duplicate-tokenizer identifiers intentionally mirror the native `unicode_ident` grammar:
 * XID properties plus `$`, `_`, `Other_ID_*`, and ZWNJ/ZWJ. Fingerprints require
 * cross-implementation determinism rather than ECMAScript conformance.
 */
export const DUPLICATE_TOKENIZER_IDENTIFIER_SOURCE = String.raw`[$_\p{XID_Start}\u1885\u1886\u2118\u212E\u309B\u309C](?:[$_\p{XID_Continue}\u00B7\u0387\u1369-\u1371\u19DA\u200C\u200D\u1885\u1886\u2118\u212E\u309B\u309C])*`;

/** Unicode XID identifiers, with underscores permitted at every position. */
export const XID_IDENTIFIER_SOURCE = String.raw`[_\p{XID_Start}][_\p{XID_Continue}]*`;

/** Python identifiers use normalized Unicode XID properties (PEP 3131). */
export const PYTHON_IDENTIFIER_SOURCE = XID_IDENTIFIER_SOURCE;

/**
 * PHP identifiers permit ASCII letters/underscore or any byte from 0x80-0xff at every
 * position (non-ASCII bytes are unrestricted), with ASCII digits allowed only after the
 * first character.
 */
export const PHP_IDENTIFIER_SOURCE = String.raw`[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z0-9_\u{80}-\u{10FFFF}]*`;

/**
 * Java identifier-ignorable characters: formatting characters plus the ISO control
 * ranges accepted by Character.isIdentifierIgnorable.
 */
export const JAVA_IDENTIFIER_IGNORABLE_SOURCE = String.raw`\p{Cf}\u0000-\u0008\u000E-\u001B\u007F-\u009F`;

/** C# formatting characters permitted in identifier-part-character. */
export const CSHARP_IDENTIFIER_FORMAT_SOURCE = String.raw`\p{Cf}`;

/**
 * Java identifiers (`Character.isJavaIdentifierStart`/`isJavaIdentifierPart`) permit a
 * Unicode letter (Lu/Ll/Lt/Lm/Lo), a letter-number (Nl, e.g. Roman numerals), a currency
 * symbol (Sc, e.g. `$`), or a connecting-punctuation character (Pc, e.g. `_`) at every
 * position; continuation additionally allows decimal digits (Nd), combining marks (Mn/Mc),
 * and identifier-ignorable characters. Non-decimal number categories (No) are not part of
 * the Java grammar.
 */
export const JAVA_IDENTIFIER_SOURCE = String.raw`[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}${JAVA_IDENTIFIER_IGNORABLE_SOURCE}]*`;

/**
 * C# identifiers (ECMA-334 `identifier-start-character`/`identifier-part-character`) permit a
 * Unicode letter (Lu/Ll/Lt/Lm/Lo), a letter-number (Nl), or a literal underscore at the first
 * position, plus an optional leading `@` for a verbatim identifier (escaping a keyword, e.g.
 * `@class`); continuation additionally allows decimal digits (Nd), connecting-punctuation
 * (Pc), combining marks (Mn/Mc), and formatting characters.
 */
export const CSHARP_IDENTIFIER_SOURCE = String.raw`@?[\p{L}\p{Nl}_][\p{L}\p{Nl}_\p{Nd}\p{Pc}\p{Mn}\p{Mc}${CSHARP_IDENTIFIER_FORMAT_SOURCE}]*`;

/**
 * Go identifiers (`unicode_letter`/`unicode_digit` in the Go spec's `identifier` production)
 * permit a Unicode letter (Lu/Ll/Lt/Lm/Lo) or underscore at every position; continuation
 * additionally allows decimal digits (Nd). Letter-numbers (Nl), other number categories
 * (No), and combining marks are not part of the Go grammar.
 */
export const GO_IDENTIFIER_SOURCE = String.raw`[\p{L}_][\p{L}\p{Nd}_]*`;

/**
 * Kotlin identifiers (the `Letter`/`UnicodeDigit` lexer fragments in the Kotlin grammar)
 * permit a Unicode letter (Lu/Ll/Lt/Lm/Lo) or underscore at every position; continuation
 * additionally allows decimal digits (Nd). Letter-numbers (Nl), other number categories
 * (No), and combining marks are not part of the Kotlin grammar.
 */
export const KOTLIN_IDENTIFIER_SOURCE = String.raw`[\p{L}_][\p{L}\p{Nd}_]*`;
