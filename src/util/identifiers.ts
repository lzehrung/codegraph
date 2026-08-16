/** ECMAScript identifier syntax, including ZWNJ and ZWJ continuation characters. */
export const ECMASCRIPT_IDENTIFIER_SOURCE = String.raw`[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*`;

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
 * Java identifiers (`Character.isJavaIdentifierStart`/`isJavaIdentifierPart`) permit a
 * Unicode letter (Lu/Ll/Lt/Lm/Lo), a letter-number (Nl, e.g. Roman numerals), a currency
 * symbol (Sc, e.g. `$`), or a connecting-punctuation character (Pc, e.g. `_`) at every
 * position; continuation additionally allows decimal digits (Nd) and identifier-ignorable
 * formatting characters (Cf, e.g. ZWNJ/ZWJ). Combining marks and non-decimal number
 * categories (No) are not part of the Java grammar.
 */
export const JAVA_IDENTIFIER_SOURCE = String.raw`[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Cf}]*`;

/**
 * C# identifiers (ECMA-334 `identifier-start-character`/`identifier-part-character`) permit a
 * Unicode letter (Lu/Ll/Lt/Lm/Lo), a letter-number (Nl), or a literal underscore at the first
 * position, plus an optional leading `@` for a verbatim identifier (escaping a keyword, e.g.
 * `@class`); continuation additionally allows decimal digits (Nd), connecting-punctuation
 * (Pc), combining marks (Mn/Mc), and formatting characters (Cf).
 */
export const CSHARP_IDENTIFIER_SOURCE = String.raw`@?[\p{L}\p{Nl}_][\p{L}\p{Nl}_\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*`;
