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
 * Java identifiers (JLS `JavaLetter`/`JavaLetterOrDigit`) permit Unicode letters, `$`,
 * connecting-punctuation characters (e.g. `_`), and currency symbols at the first position;
 * continuation additionally allows Unicode digits and combining marks.
 */
export const JAVA_IDENTIFIER_SOURCE = String.raw`[\p{L}\p{Sc}\p{Pc}$][\p{L}\p{N}\p{Sc}\p{Pc}\p{Mn}\p{Mc}$]*`;

/**
 * C# identifiers (ECMA-334 `identifier-start-character`/`identifier-part-character`) permit
 * Unicode letter categories or an underscore at the first position, plus an optional leading
 * `@` for a verbatim identifier (escaping a keyword, e.g. `@class`); continuation additionally
 * allows decimal digits, connecting-punctuation, combining marks, and formatting characters.
 */
export const CSHARP_IDENTIFIER_SOURCE = String.raw`@?[\p{L}\p{Pc}_][\p{L}\p{N}\p{Pc}\p{Mn}\p{Mc}\p{Cf}_]*`;
