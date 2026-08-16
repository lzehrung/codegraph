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
