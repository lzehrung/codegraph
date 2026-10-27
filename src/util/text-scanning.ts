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

export function matchesCaseInsensitive(source: string, start: number, value: string): boolean {
  if (start + value.length > source.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (source[start + index]!.toLowerCase() !== value[index]!) return false;
  }
  return true;
}
