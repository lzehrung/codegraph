/** ECMAScript identifier syntax, including ZWNJ and ZWJ continuation characters. */
export const ECMASCRIPT_IDENTIFIER_SOURCE = String.raw`[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*`;

/** Unicode XID identifiers, with underscores permitted at every position. */
export const XID_IDENTIFIER_SOURCE = String.raw`[_\p{XID_Start}][_\p{XID_Continue}]*`;

/** Python identifiers use normalized Unicode XID properties (PEP 3131). */
export const PYTHON_IDENTIFIER_SOURCE = XID_IDENTIFIER_SOURCE;
