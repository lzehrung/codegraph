/**
 * Tree-sitter native captures expose UTF-8 byte offsets (Rust `start_byte()`/`end_byte()` and a
 * byte-relative `Point.column`), while codegraph's `Range` type and JS `String.slice` operate on
 * UTF-16 code units. This module builds the byte -> string-index conversion table once per source
 * file so every capture in that file converts in O(1) instead of re-scanning the source per offset.
 */

export type ByteToStringIndexMap = {
  readonly isAscii: boolean;
  readonly sourceLength: number;
  readonly byteToStringIndex: Uint32Array;
  readonly lineStartBytes: readonly number[];
};

const EMPTY_BYTE_TO_STRING_INDEX = new Uint32Array(0);
const EMPTY_LINE_START_BYTES: readonly number[] = [];

export function buildByteToStringIndexMap(source: string): ByteToStringIndexMap {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength === source.length) {
    // Pure ASCII: byte offsets and UTF-16 indexes coincide, so skip building the table.
    return {
      isAscii: true,
      sourceLength: source.length,
      byteToStringIndex: EMPTY_BYTE_TO_STRING_INDEX,
      lineStartBytes: EMPTY_LINE_START_BYTES,
    };
  }

  const byteToStringIndex = new Uint32Array(byteLength + 1);
  const lineStartBytes: number[] = [0];
  let byteOffset = 0;
  let stringIndex = 0;

  while (stringIndex < source.length) {
    const codePoint = source.codePointAt(stringIndex);
    if (codePoint === undefined) break;

    const charStringLength = codePoint > 0xffff ? 2 : 1;
    const charByteLength = utf8ByteLengthForCodePoint(codePoint);

    for (let offset = 1; offset < charByteLength; offset += 1) {
      byteToStringIndex[byteOffset + offset] = stringIndex;
    }

    byteOffset += charByteLength;
    stringIndex += charStringLength;
    byteToStringIndex[byteOffset] = stringIndex;

    if (codePoint === 10) {
      lineStartBytes.push(byteOffset);
    }
  }

  byteToStringIndex[byteOffset] = source.length;
  return { isAscii: false, sourceLength: source.length, byteToStringIndex, lineStartBytes };
}

export function stringIndexForByte(map: ByteToStringIndexMap, byteIndex: number): number {
  if (map.isAscii) return Math.max(0, Math.min(byteIndex, map.sourceLength));
  const bounded = Math.max(0, Math.min(byteIndex, map.byteToStringIndex.length - 1));
  return map.byteToStringIndex[bounded] ?? map.sourceLength;
}

/**
 * Converts a Tree-sitter `Point` (0-based row, byte-offset-within-row column) into the
 * equivalent 0-based row/column pair expressed in UTF-16 code units.
 */
export function stringPositionForBytePoint(
  map: ByteToStringIndexMap,
  point: { row: number; column: number },
): { row: number; column: number } {
  if (map.isAscii) return { row: point.row, column: point.column };
  const lineStartByte = map.lineStartBytes[point.row] ?? 0;
  const lineStartIndex = stringIndexForByte(map, lineStartByte);
  const pointIndex = stringIndexForByte(map, lineStartByte + point.column);
  return { row: point.row, column: Math.max(0, pointIndex - lineStartIndex) };
}

function utf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
