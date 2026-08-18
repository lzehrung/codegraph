import { duplicateIdentifierKeywords } from "./duplicate-keywords.js";
import { DUPLICATE_TOKENIZER_IDENTIFIER_SOURCE } from "./util/identifiers.js";

const duplicateTokenPattern = new RegExp(
  [
    String.raw`"(?:\\.|[^"\\])*"`,
    String.raw`'(?:\\.|[^'\\])*'`,
    "`(?:\\\\.|[^`\\\\])*`",
    DUPLICATE_TOKENIZER_IDENTIFIER_SOURCE,
    String.raw`\d+(?:\.\d+)?`,
    String.raw`[^\s]`,
  ].join("|"),
  "gu",
);
const identifierTokenPattern = new RegExp(String.raw`^${DUPLICATE_TOKENIZER_IDENTIFIER_SOURCE}$`, "u");

export function tokenizeDuplicateSource(text: string): string[] {
  return text.match(duplicateTokenPattern) ?? [];
}

export function countDuplicateTokens(text: string): number {
  return tokenizeDuplicateSource(text).length;
}

export function normalizeDuplicateToken(token: string): string {
  if (/^["'`]/.test(token)) return "<literal>";
  if (/^\d/.test(token)) return "<literal>";
  if (identifierTokenPattern.test(token)) {
    const lower = token.toLowerCase();
    if (duplicateIdentifierKeywords.has(lower)) return lower;
    return "<identifier>";
  }
  return token;
}

export function normalizeDuplicateSourceTokens(text: string): string[] {
  return tokenizeDuplicateSource(text).map(normalizeDuplicateToken);
}

export function hasUnterminatedQuotedLiteral(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let escaped = false;
    let closed = false;
    for (index += 1; index < text.length; index++) {
      const current = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        closed = true;
        break;
      }
    }
    if (!closed) return true;
  }
  return false;
}
