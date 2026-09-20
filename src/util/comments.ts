import { buildTriviaMask, maskTrivia, stripTrivia } from "./trivia.js";

export type InlineCommentTrimMode = "preserve" | "trim";

export function stripHashInlineComment(line: string, trimMode: InlineCommentTrimMode): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      const stripped = line.slice(0, i);
      return trimMode === "trim" ? stripped.trim() : stripped;
    }
  }
  return trimMode === "trim" ? line.trim() : line;
}

export function stripJsLikeComments(src: string): string {
  return maskTrivia(src, "js", { maskStrings: false });
}

export function maskJsLikeCommentsAndStrings(src: string): string {
  return maskTrivia(src, "js");
}

function hasJsLikeLiteralDelimiter(source: string): boolean {
  return source.includes("'") || source.includes('"') || source.includes("`") || source.includes("/");
}

function previousVisibleIndex(source: string, mask: Uint8Array, start: number): number {
  for (let i = start; i >= 0; i -= 1) {
    if (mask[i]) continue;
    if (/\s/.test(source[i] ?? "")) continue;
    return i;
  }
  return -1;
}

function precedingKeywordAllowsRegex(source: string, mask: Uint8Array, prevIndex: number): boolean {
  let end = prevIndex + 1;
  while (end > 0 && (mask[end - 1] || /\s/.test(source[end - 1] ?? ""))) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && !mask[start - 1] && /[A-Za-z]/.test(source[start - 1] ?? "")) {
    start -= 1;
  }
  const keyword = source.slice(start, end);
  return keyword === "return" || keyword === "case" || keyword === "throw" || keyword === "yield";
}

function keywordBeforeParenAllowsRegex(source: string, mask: Uint8Array, closeParenIndex: number): boolean {
  let depth = 1;
  for (let i = closeParenIndex - 1; i >= 0; i -= 1) {
    if (mask[i]) continue;
    const ch = source[i] ?? "";
    if (ch === ")") {
      depth += 1;
      continue;
    }
    if (ch === "(") {
      depth -= 1;
      if (!depth) {
        const keywordIndex = previousVisibleIndex(source, mask, i - 1);
        if (keywordIndex < 0) return false;
        const end = keywordIndex + 1;
        let start = end;
        while (start > 0 && !mask[start - 1] && /[A-Za-z]/.test(source[start - 1] ?? "")) {
          start -= 1;
        }
        const keyword = source.slice(start, end);
        return (
          keyword === "if" ||
          keyword === "while" ||
          keyword === "for" ||
          keyword === "switch" ||
          keyword === "catch" ||
          keyword === "with"
        );
      }
    }
  }
  return false;
}

function canStartRegex(source: string, mask: Uint8Array, slashIndex: number): boolean {
  if (mask[slashIndex]) return false;
  const prevIndex = previousVisibleIndex(source, mask, slashIndex - 1);
  if (prevIndex < 0) return true;
  const prev = source[prevIndex] ?? "";
  if ("([{,:;=!?&|^~<>+-*%".includes(prev)) return true;
  if (prev === ")" && keywordBeforeParenAllowsRegex(source, mask, prevIndex)) return true;
  return precedingKeywordAllowsRegex(source, mask, prevIndex);
}

function maskRegexLiteral(source: string, mask: Uint8Array, start: number): number {
  let inClass = false;
  mask[start] = 1;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    mask[i] = 1;
    if (ch === "\n" || ch === "\r") return start + 1;
    if (ch === "\\") {
      const nextIndex = i + 1;
      if (nextIndex < source.length) {
        mask[nextIndex] = 1;
        i = nextIndex;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (ch === "/" && !inClass) {
      let end = i + 1;
      while (/[A-Za-z]/.test(source[end] ?? "")) {
        mask[end] = 1;
        end += 1;
      }
      return end;
    }
  }
  return source.length;
}

export function buildJsLikeLiteralMask(source: string): Uint8Array | undefined {
  if (!hasJsLikeLiteralDelimiter(source)) return undefined;
  const mask = buildTriviaMask(source, "js", { holes: true });
  for (let i = 0; i < source.length; i += 1) {
    if (mask[i]) continue;
    if (source[i] === "/" && canStartRegex(source, mask, i)) {
      i = maskRegexLiteral(source, mask, i) - 1;
    }
  }
  return mask;
}

function applyMask(source: string, mask: Uint8Array | undefined): string {
  if (!mask) return source;
  const parts: string[] = [];
  let segmentStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (!mask[i] || ch === "\n" || ch === "\r") continue;
    if (segmentStart < i) parts.push(source.slice(segmentStart, i));
    const maskStart = i;
    while (i < source.length && mask[i] && source[i] !== "\n" && source[i] !== "\r") {
      i += 1;
    }
    parts.push(" ".repeat(i - maskStart));
    segmentStart = i;
    i -= 1;
  }
  if (!parts.length) return source;
  if (segmentStart < source.length) parts.push(source.slice(segmentStart));
  return parts.join("");
}

export function maskJsLikeCommentsStringsAndRegex(src: string): string {
  const maskedTrivia = maskJsLikeCommentsAndStrings(src);
  return applyMask(maskedTrivia, buildJsLikeLiteralMask(maskedTrivia));
}

export function stripJsonTrailingCommas(src: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;

    if (inSingle || inDouble) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j += 1;
      const next = src[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

export function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonTrailingCommas(stripJsLikeComments(raw))) as T;
}

export function stripPythonCommentsAndStrings(src: string): string {
  return stripTrivia(src, "python");
}

/**
 * Blanks Python comments and string literals to same-length whitespace (preserving embedded
 * newlines) instead of deleting them. Callers that need to map a regex match position in the
 * masked text back to an exact offset in the original source -- rather than only using the
 * masked text to avoid false-positive matches inside unrelated strings/comments -- must use
 * this instead; `stripPythonCommentsAndStrings` is not offset-preserving. Unlike the previous
 * regex implementation, comments are masked before string literals are located, so an
 * apostrophe inside a comment can no longer open a string literal.
 */
export function maskPythonCommentsAndStrings(src: string): string {
  return maskTrivia(src, "python");
}
