import type { Pos } from "../types.js";

export function collectLineStartOffsets(source: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    // A lone carriage return ends a line; `\r\n` is ended by its `\n` alone, so the pair
    // contributes one line start rather than two.
    if (char === "\n" || (char === "\r" && source[index + 1] !== "\n")) lineStarts.push(index + 1);
  }
  return lineStarts;
}

export function positionAtOffset(lineStarts: readonly number[], index: number): Pos {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: index - lineStarts[low]! + 1, index };
}
