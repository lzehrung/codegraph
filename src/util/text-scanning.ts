export function skipQuotedString(source: string, quoteStart: number): number {
  const quote = source[quoteStart]!;
  let index = quoteStart + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

/** The index just past the next `closing` marker at or after `contentStart`, or the end of the source when unterminated. */
export function skipDelimited(source: string, contentStart: number, closing: string): number {
  const closingIndex = source.indexOf(closing, contentStart);
  return closingIndex === -1 ? source.length : closingIndex + closing.length;
}

export function matchesCaseInsensitive(source: string, start: number, value: string): boolean {
  if (start + value.length > source.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (source[start + index]!.toLowerCase() !== value[index]!) return false;
  }
  return true;
}
export function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}
