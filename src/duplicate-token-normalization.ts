import { duplicateIdentifierKeywords } from "./duplicate-keywords.js";
import {
  DUPLICATE_IDENTIFIER_CONTINUE_RANGES,
  DUPLICATE_IDENTIFIER_START_RANGES,
} from "./duplicate-identifier-ranges.js";

function characterClassSource(ranges: ReadonlyArray<readonly [number, number]>): string {
  const escape = (codePoint: number): string => `\\u{${codePoint.toString(16)}}`;
  return ranges.map(([from, to]) => (from === to ? escape(from) : `${escape(from)}-${escape(to)}`)).join("");
}

/**
 * Duplicate-tokenizer identifiers mirror the native `unicode_ident` grammar: XID properties plus
 * `$`, `_`, `Other_ID_*`, and ZWNJ/ZWJ. Fingerprints require cross-implementation determinism
 * rather than ECMAScript conformance, so the grammar is built from generated ranges pinned to the
 * native tokenizer's Unicode version. A Unicode property escape would resolve against whichever
 * Unicode version the host Node build embeds, so the same file would fingerprint differently on
 * different Node versions. The explicit ranges cost roughly 1.5x the match time of a property
 * escape, which this fallback path trades for that determinism.
 */
const DUPLICATE_TOKENIZER_IDENTIFIER_SOURCE = `[${characterClassSource(DUPLICATE_IDENTIFIER_START_RANGES)}](?:[${characterClassSource(DUPLICATE_IDENTIFIER_CONTINUE_RANGES)}])*`;

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
