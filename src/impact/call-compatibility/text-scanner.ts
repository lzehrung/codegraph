/** Text-level scanners for call-compatibility signature/argument extraction. */
export type BalancedRange = {
  start: number;
  end: number;
  inner: string;
};

export type AngleMode = "always" | "type-context";

export function findOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }
  return source.indexOf("(", startIndex);
}

export function findSignatureOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }

  let quote: string | null = null;
  let escaped = false;
  let isTypeAnnotation = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return -1;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "<") {
      const closeIndex = findBalancedAngleBrackets(source, index);
      if (closeIndex < 0) {
        return -1;
      }
      index = closeIndex;
      continue;
    }
    if (char === ":") {
      isTypeAnnotation = true;
      continue;
    }
    if (char === "=") {
      if (source[index + 1] === ">") {
        index += 1;
        continue;
      }
      isTypeAnnotation = false;
      continue;
    }
    if (char === "(") {
      if (!isTypeAnnotation) {
        return index;
      }
      const balanced = findBalancedParentheses(source, index);
      if (!balanced) {
        return -1;
      }
      index = balanced.end - 1;
    }
  }

  return -1;
}

export function findCommentEnd(source: string, index: number): number | null {
  if (source[index] !== "/") {
    return null;
  }

  const nextChar = source[index + 1];
  if (nextChar === "/") {
    const newlineIndex = source.indexOf("\n", index + 2);
    if (newlineIndex < 0) {
      return source.length;
    }
    return newlineIndex;
  }

  if (nextChar === "*") {
    const closeIndex = source.indexOf("*/", index + 2);
    if (closeIndex < 0) {
      return -1;
    }
    return closeIndex + 2;
  }

  return null;
}

export function findCallOpeningParen(source: string, startIndex: number, endIndex?: number): number {
  if (endIndex === undefined) {
    return findOpeningParen(source, startIndex);
  }
  if (endIndex < startIndex || endIndex > source.length) {
    return -1;
  }

  let skippedWhitespace = false;
  for (let index = endIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return -1;
    }
    if (/\s/.test(char)) {
      skippedWhitespace = true;
      continue;
    }
    if (char === "(") {
      return index;
    }
    if (char === "<") {
      if (skippedWhitespace) {
        return -1;
      }
      const closeIndex = findBalancedAngleBrackets(source, index);
      if (closeIndex < 0) {
        return -1;
      }
      for (let afterGeneric = closeIndex + 1; afterGeneric < source.length; afterGeneric += 1) {
        const nextChar = source[afterGeneric];
        if (nextChar === undefined) {
          return -1;
        }
        if (/\s/.test(nextChar)) {
          continue;
        }
        if (nextChar === "(") {
          return afterGeneric;
        }
        return -1;
      }
      return -1;
    }
    return -1;
  }
  return -1;
}

export function findBalancedAngleBrackets(source: string, openIndex: number): number {
  if (source[openIndex] !== "<") {
    return -1;
  }

  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return -1;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return -1;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return -1;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return -1;
      }
      continue;
    }
    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "<" && atTopLevel) {
      depth += 1;
      continue;
    }
    if (char === ">" && source[index - 1] !== "=" && atTopLevel) {
      depth -= 1;
      if (!depth) {
        return index;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }

  return -1;
}

export function findBalancedParentheses(source: string, openIndex: number): BalancedRange | null {
  if (openIndex < 0 || source[openIndex] !== "(") {
    return null;
  }

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return null;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (!depth) {
        return {
          start: openIndex,
          end: index + 1,
          inner: source.slice(openIndex + 1, index),
        };
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

export function findBalancedBraces(source: string, openIndex: number): BalancedRange | null {
  if (openIndex < 0 || source[openIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(source, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return null;
      }
      index = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (!depth) {
        return {
          start: openIndex,
          end: index + 1,
          inner: source.slice(openIndex + 1, index),
        };
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

export function hasTypeContextBeforeLessThan(text: string, index: number, groupStart: number): boolean {
  const left = text.slice(groupStart, index).trimEnd();
  if (!left) {
    return false;
  }

  const typeKeywordPattern = /(^|[\s([{,:?=<>|&])(?:as|satisfies|new)\s+[A-Za-z_$][\w$.[\]\s]*$/;
  return typeKeywordPattern.test(left) || hasOpenTypeAnnotationBefore(text, index, groupStart);
}

export function hasOpenTypeAnnotationBefore(text: string, index: number, groupStart: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  let hasTypeAnnotation = false;

  for (let current = groupStart; current < index; current += 1) {
    const char = text[current];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(text, current);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return false;
      }
      current = commentEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return false;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return false;
      }
      continue;
    }

    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (!atTopLevel) {
      continue;
    }
    if (char === ":") {
      hasTypeAnnotation = true;
      continue;
    }
    if (char === "=" && text[current + 1] !== ">") {
      hasTypeAnnotation = false;
    }
  }

  return hasTypeAnnotation;
}

export function previousSignificantIndex(text: string, index: number, groupStart: number): number {
  for (let current = index - 1; current >= groupStart; current -= 1) {
    const char = text[current];
    if (char !== undefined && !/\s/.test(char)) {
      return current;
    }
  }
  return -1;
}

export function previousSignificantChar(text: string, index: number, groupStart: number): string | null {
  const previousIndex = previousSignificantIndex(text, index, groupStart);
  if (previousIndex < 0) {
    return null;
  }
  return text[previousIndex] ?? null;
}

export function previousSignificantCharBefore(text: string, index: number, groupStart: number): string | null {
  const previousIndex = previousSignificantIndex(text, index, groupStart);
  if (previousIndex < 0) {
    return null;
  }

  return previousSignificantChar(text, previousIndex, groupStart);
}

export function canStartRegexLiteral(text: string, index: number, groupStart: number): boolean {
  if (text[index] !== "/" || text[index + 1] === "/" || text[index + 1] === "*") {
    return false;
  }

  const previous = previousSignificantChar(text, index, groupStart);
  if (!previous) {
    return true;
  }
  if (previous === ">" && previousSignificantCharBefore(text, index, groupStart) === "=") {
    return true;
  }

  return "([{,=:+-!*?&|;".includes(previous);
}

export function findRegexLiteralEnd(text: string, index: number): number | null {
  if (text[index] !== "/" || text[index + 1] === "/" || text[index + 1] === "*") {
    return null;
  }

  let escaped = false;
  let inCharacterClass = false;
  for (let current = index + 1; current < text.length; current += 1) {
    const char = text[current];
    if (char === "\n" || char === "\r") {
      return -1;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (char === "/" && !inCharacterClass) {
      let endIndex = current + 1;
      while (/[A-Za-z]/.test(text[endIndex] ?? "")) {
        endIndex += 1;
      }
      return endIndex;
    }
  }

  return -1;
}

export function splitTopLevelCommaGroups(
  text: string,
  angleMode: AngleMode,
  detectRegexLiterals = true,
): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const groups: string[] = [];
  let groupStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    const commentEnd = findCommentEnd(text, index);
    if (commentEnd !== null) {
      if (commentEnd < 0) {
        return null;
      }
      index = commentEnd - 1;
      continue;
    }

    if (detectRegexLiterals && canStartRegexLiteral(text, index, groupStart)) {
      const regexEnd = findRegexLiteralEnd(text, index);
      if (regexEnd === null) {
        return null;
      }
      if (regexEnd < 0) {
        return null;
      }
      index = regexEnd - 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return null;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return null;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        return null;
      }
      continue;
    }
    const atDelimiterTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (
      char === "<" &&
      atDelimiterTopLevel &&
      (angleDepth || angleMode === "always" || hasTypeContextBeforeLessThan(text, index, groupStart))
    ) {
      angleDepth += 1;
      continue;
    }
    if (char === ">" && angleDepth && text[index - 1] !== "=" && atDelimiterTopLevel) {
      angleDepth -= 1;
      continue;
    }

    const atTopLevel = atDelimiterTopLevel && !angleDepth;
    if (char === "," && atTopLevel) {
      groups.push(text.slice(groupStart, index).trim());
      groupStart = index + 1;
    }
  }

  if (quote || parenDepth || bracketDepth || braceDepth || angleDepth) {
    return null;
  }

  groups.push(text.slice(groupStart).trim());
  if (groups.length && groups[groups.length - 1] === "") {
    groups.pop();
  }
  return groups;
}
