export interface CallableSignature {
  minArgs: number;
  maxArgs: number | null;
  confidence: "high";
}

export interface ExtractCallableSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
}

type BalancedRange = {
  start: number;
  end: number;
  inner: string;
};

function isJsTsLanguage(languageId: string): boolean {
  return languageId === "javascript" || languageId === "typescript" || languageId === "tsx" || languageId === "jsx";
}

function findOpeningParen(source: string, startIndex: number): number {
  if (startIndex < 0 || startIndex >= source.length) {
    return -1;
  }
  return source.indexOf("(", startIndex);
}

function findBalancedParentheses(source: string, openIndex: number): BalancedRange | null {
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

function splitTopLevelCommaGroups(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const groups: string[] = [];
  let groupStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
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

    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth;
    if (char === "," && atTopLevel) {
      groups.push(text.slice(groupStart, index).trim());
      groupStart = index + 1;
    }
  }

  if (quote || parenDepth || bracketDepth || braceDepth) {
    return null;
  }

  groups.push(text.slice(groupStart).trim());
  return groups;
}

function hasTopLevelChar(text: string, needle: string): boolean {
  const groups = splitTopLevelCommaGroups(text);
  if (!groups) {
    return false;
  }
  const onlyGroup = groups[0];
  return groups.length === 1 && Boolean(onlyGroup?.includes(needle));
}

function isOptionalParameter(parameter: string): boolean {
  const colonIndex = parameter.indexOf(":");
  let searchText = parameter;
  if (colonIndex >= 0) {
    searchText = parameter.slice(0, colonIndex);
  }
  return searchText.includes("?") || hasTopLevelChar(parameter, "=");
}

export function extractCallableSignature(request: ExtractCallableSignatureRequest): CallableSignature | null {
  if (!isJsTsLanguage(request.languageId)) {
    return null;
  }

  const openIndex = findOpeningParen(request.source, request.symbolStartIndex);
  const balanced = findBalancedParentheses(request.source, openIndex);
  if (!balanced) {
    return null;
  }

  const parameters = splitTopLevelCommaGroups(balanced.inner);
  if (!parameters) {
    return null;
  }

  let minArgs = 0;
  let hasRest = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("...")) {
      hasRest = true;
      continue;
    }
    if (!isOptionalParameter(trimmed)) {
      minArgs += 1;
    }
  }

  const maxArgs = hasRest ? null : parameters.length;
  return { minArgs, maxArgs, confidence: "high" };
}
