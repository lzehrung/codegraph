import type { Range } from "../types.js";
import { stringIndexForByte, stringPositionForBytePoint, type ByteToStringIndexMap } from "./byteIndex.js";
import type { NativeCapture, NativeMatch } from "./treeSitterNative.js";

export function capturesByName(match: NativeMatch): Record<string, NativeCapture | undefined> {
  const out: Record<string, NativeCapture | undefined> = {};
  for (const capture of match.captures) {
    if (!(capture.name in out)) out[capture.name] = capture;
  }
  return out;
}

export function capturesNamed(match: NativeMatch, name: string): NativeCapture[] {
  return match.captures.filter((capture) => capture.name === name);
}

/**
 * Native Tree-sitter captures use UTF-8 byte offsets. `Range` and every downstream
 * consumer (source slicing, portable handles, rename edits) expect UTF-16 string indexes,
 * so every native capture converts through the caller's per-file `byteIndexMap` here.
 */
export function rangeFromNativeCapture(capture: NativeCapture, byteIndexMap: ByteToStringIndexMap): Range {
  const startPosition = stringPositionForBytePoint(byteIndexMap, capture.start);
  const endPosition = stringPositionForBytePoint(byteIndexMap, capture.end);
  return {
    start: {
      line: capture.start.row + 1,
      column: startPosition.column + 1,
      index: stringIndexForByte(byteIndexMap, capture.start.index),
    },
    end: {
      line: capture.end.row + 1,
      column: endPosition.column + 1,
      index: stringIndexForByte(byteIndexMap, capture.end.index),
    },
  };
}
