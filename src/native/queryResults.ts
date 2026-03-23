import type { Range } from "../types.js";
import type { NativeCapture, NativeMatch } from "./treeSitterNative.js";

export function capturesByName(
  match: NativeMatch,
): Record<string, NativeCapture | undefined> {
  const out: Record<string, NativeCapture | undefined> = {};
  for (const capture of match.captures) {
    if (!(capture.name in out)) out[capture.name] = capture;
  }
  return out;
}

export function capturesNamed(
  match: NativeMatch,
  name: string,
): NativeCapture[] {
  return match.captures.filter((capture) => capture.name === name);
}

export function rangeFromNativeCapture(capture: NativeCapture): Range {
  return {
    start: {
      line: capture.start.row + 1,
      column: capture.start.column + 1,
      index: capture.start.index,
    },
    end: {
      line: capture.end.row + 1,
      column: capture.end.column + 1,
      index: capture.end.index,
    },
  };
}
