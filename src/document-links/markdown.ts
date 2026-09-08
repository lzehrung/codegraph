import path from "node:path";
import { extractJsTsSpecifiers, type ModuleSpecifier } from "../util/specifiers.js";
import { type Range } from "../types.js";
import { extractHtmlAttributeSpecifiers } from "./html.js";
import {
  dedupeModuleSpecifiers,
  isObviouslyDynamicSpecifier,
  markResolutionKind,
  normalizeLinkSpecifier,
  normalizeReferenceLabel,
} from "./shared.js";

const MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH = 999;
const MAX_MARKDOWN_INLINE_LABEL_SCAN_LENGTH = Number.POSITIVE_INFINITY;

export function extractMarkdownModuleSpecifiers(source: string): ModuleSpecifier[] {
  const sanitized = stripMarkdownCode(source);
  return extractMarkdownModuleSpecifiersFromSanitized(sanitized);
}

export type MarkdownLinkOccurrence =
  | {
      raw: string;
      range: Range;
      destination: string;
    }
  | {
      raw: string;
      range: Range;
      missingReference: true;
    };

type MarkdownReferenceDefinition = {
  destination: string;
};

export function extractMarkdownLinkOccurrences(source: string): MarkdownLinkOccurrence[] {
  const sanitized = stripMarkdownCode(source);
  const lineStarts = collectMarkdownLineStarts(sanitized);
  const referenceDefs = collectMarkdownReferenceDefinitionsForOccurrences(sanitized);
  const out: MarkdownLinkOccurrence[] = [];

  for (let index = 0; index < sanitized.length; index += 1) {
    if (sanitized[index] !== "[") continue;
    if (sanitized[index - 1] === "!") continue;

    const inlineLabelEnd = findMarkdownLabelEnd(sanitized, index + 1, MAX_MARKDOWN_INLINE_LABEL_SCAN_LENGTH);
    if (inlineLabelEnd >= 0 && sanitized[inlineLabelEnd + 1] === "(") {
      const parsed = parseMarkdownInlineLink(sanitized, inlineLabelEnd + 2);
      if (parsed) {
        const destination = extractMarkdownDestination(parsed.destination);
        if (destination && !isObviouslyDynamicSpecifier(destination)) {
          const destinationStart = findMarkdownDestinationStart(sanitized, inlineLabelEnd + 2);
          out.push({
            raw: destination,
            destination,
            range: markdownRange(sanitized, destinationStart, destinationStart + destination.length, lineStarts),
          });
        }
        index = parsed.endIndex;
        continue;
      }
      if (isEmptyMarkdownInlineDestination(sanitized, inlineLabelEnd + 2)) {
        index = findEmptyMarkdownInlineDestinationEnd(sanitized, inlineLabelEnd + 2);
        continue;
      }
    }

    const labelEnd = findMarkdownLabelEnd(sanitized, index + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
    if (labelEnd < 0) {
      index = skipConsecutiveMarkdownOpeners(sanitized, index);
      continue;
    }

    const suffix = parseMarkdownReferenceSuffix(sanitized, labelEnd + 1);
    if (!suffix && isMarkdownReferenceDefinitionLabel(sanitized, index, labelEnd)) {
      const lineEnd = sanitized.indexOf("\n", labelEnd + 1);
      index = lineEnd >= 0 ? lineEnd : sanitized.length;
      continue;
    }

    const text = sanitized.slice(index + 1, labelEnd).trim();
    const rawLabel = suffix ? suffix.label.trim() || text : text;
    const resolvedLabel = normalizeReferenceLabel(rawLabel);
    if (!resolvedLabel) continue;

    const destination = referenceDefs.get(resolvedLabel);
    const rangeEnd = (suffix?.endIndex ?? labelEnd) + 1;
    const range = markdownRange(sanitized, index, rangeEnd, lineStarts);
    if (destination) {
      out.push({ raw: destination.destination, destination: destination.destination, range });
    } else if (suffix) {
      out.push({ raw: rawLabel, range, missingReference: true });
    }
    index = suffix?.endIndex ?? labelEnd;
  }

  for (const match of sanitized.matchAll(/<([^>\s]+)>/g)) {
    const candidate = match[1]?.trim();
    if (!candidate || match.index === undefined) continue;
    if (isMarkdownAngleDestinationInLinkSyntax(sanitized, match.index)) continue;
    if (candidate.startsWith("/") || candidate.startsWith("?")) continue;
    if (!isLikelyMarkdownAutolinkTarget(candidate) || isObviouslyDynamicSpecifier(candidate)) continue;
    const start = match.index + 1;
    out.push({
      raw: candidate,
      destination: candidate,
      range: markdownRange(sanitized, start, start + candidate.length, lineStarts),
    });
  }

  for (const match of sanitized.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)) {
    const destination = match[1] ?? match[2] ?? match[3];
    if (!destination || match.index === undefined || isObviouslyDynamicSpecifier(destination)) continue;
    const destinationOffset = match[0].indexOf(destination);
    if (destinationOffset < 0) continue;
    const start = match.index + destinationOffset;
    out.push({
      raw: destination,
      destination,
      range: markdownRange(sanitized, start, start + destination.length, lineStarts),
    });
  }

  return out;
}

function extractMarkdownModuleSpecifiersFromSanitized(sanitized: string): ModuleSpecifier[] {
  const referenceDefs = collectMarkdownReferenceDefinitions(sanitized);
  const out: ModuleSpecifier[] = [];

  for (const destination of collectMarkdownInlineLinkDestinations(sanitized)) {
    const normalized = normalizeLinkSpecifier(destination, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized) out.push(normalized);
  }

  out.push(...collectMarkdownReferenceLinkSpecifiers(sanitized, referenceDefs));

  for (const match of sanitized.matchAll(/<([^>\s]+)>/g)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (match.index !== undefined && isMarkdownAngleDestinationInLinkSyntax(sanitized, match.index)) continue;
    if (candidate.startsWith("/") || candidate.startsWith("?")) continue;
    if (!isLikelyMarkdownAutolinkTarget(candidate)) continue;
    const normalized = normalizeLinkSpecifier(candidate, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized) out.push(normalized);
  }

  out.push(
    ...extractHtmlAttributeSpecifiers(sanitized, {
      a: ["href"],
    }),
  );

  return dedupeModuleSpecifiers(out);
}

export function extractMdxModuleSpecifiers(source: string): ModuleSpecifier[] {
  const sanitized = stripMarkdownCode(source);
  const out = extractMarkdownModuleSpecifiersFromSanitized(sanitized);
  out.push(...markResolutionKind(extractJsTsSpecifiers(sanitized), "source"));
  return dedupeModuleSpecifiers(out);
}

function collectMarkdownReferenceDefinitionsForOccurrences(source: string): Map<string, MarkdownReferenceDefinition> {
  const out = new Map<string, MarkdownReferenceDefinition>();

  for (let lineStart = 0; lineStart < source.length; lineStart += 1) {
    const lineEnd = source.indexOf("\n", lineStart);
    const endIndex = lineEnd >= 0 ? lineEnd : source.length;
    const line = source.slice(lineStart, endIndex);
    const leading = line.match(/^ {0,3}/)?.[0] ?? "";
    const labelStart = leading.length;
    if (line[labelStart] !== "[") {
      lineStart = endIndex;
      continue;
    }

    const absoluteLabelStart = lineStart + labelStart;
    const labelEnd = findMarkdownLabelEnd(source, absoluteLabelStart + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
    if (labelEnd < 0 || labelEnd > lineStart + line.length || source[labelEnd + 1] !== ":") {
      lineStart = endIndex;
      continue;
    }

    const label = normalizeReferenceLabel(source.slice(absoluteLabelStart + 1, labelEnd));
    const rawDestination = parseMarkdownReferenceDefinitionDestination(source.slice(labelEnd + 2, endIndex));
    const destination = rawDestination ? extractMarkdownDestination(rawDestination) : "";
    if (label && destination && !isObviouslyDynamicSpecifier(destination) && !out.has(label)) {
      out.set(label, { destination });
    }
    lineStart = endIndex;
  }

  return out;
}

function collectMarkdownLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return lineStarts;
}

function findMarkdownDestinationStart(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && /\s/.test(source.charAt(index))) {
    index += 1;
  }
  return index;
}

function markdownRange(source: string, start: number, end: number, lineStarts: readonly number[]): Range {
  return {
    start: markdownPosition(source, start, lineStarts),
    end: markdownPosition(source, end, lineStarts),
  };
}

function markdownPosition(source: string, index: number, lineStarts: readonly number[]): Range["start"] {
  const boundedIndex = Math.max(0, Math.min(index, source.length));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= boundedIndex) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: boundedIndex - lineStart + 1, index: boundedIndex };
}
function collectMarkdownReferenceDefinitions(source: string): Map<string, ModuleSpecifier> {
  const out = new Map<string, ModuleSpecifier>();

  for (let lineStart = 0; lineStart < source.length; lineStart += 1) {
    const lineEnd = source.indexOf("\n", lineStart);
    const endIndex = lineEnd >= 0 ? lineEnd : source.length;
    const line = source.slice(lineStart, endIndex);
    const leading = line.match(/^ {0,3}/)?.[0] ?? "";
    const labelStart = leading.length;
    if (line[labelStart] !== "[") {
      lineStart = endIndex;
      continue;
    }

    const absoluteLabelStart = lineStart + labelStart;
    const labelEnd = findMarkdownLabelEnd(source, absoluteLabelStart + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
    if (labelEnd < 0 || labelEnd > lineStart + line.length || source[labelEnd + 1] !== ":") {
      lineStart = endIndex;
      continue;
    }

    const label = normalizeReferenceLabel(source.slice(absoluteLabelStart + 1, labelEnd));
    if (!label) {
      lineStart = endIndex;
      continue;
    }

    const rawDestination = parseMarkdownReferenceDefinitionDestination(source.slice(labelEnd + 2, endIndex));
    if (!rawDestination) {
      lineStart = endIndex;
      continue;
    }
    const normalized = normalizeLinkSpecifier(rawDestination, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized && !out.has(label)) out.set(label, normalized);
    lineStart = endIndex;
  }

  return out;
}

function collectMarkdownReferenceLinkSpecifiers(
  source: string,
  referenceDefs: ReadonlyMap<string, ModuleSpecifier>,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[") continue;
    if (source[index - 1] === "!") {
      const labelEnd = findMarkdownLabelEnd(source, index + 1, MAX_MARKDOWN_INLINE_LABEL_SCAN_LENGTH);
      if (labelEnd < 0) {
        index = skipConsecutiveMarkdownOpeners(source, index);
        continue;
      }
      const suffix = parseMarkdownReferenceSuffix(source, labelEnd + 1);
      if (suffix) {
        index = suffix.endIndex;
        continue;
      }
      if (source[labelEnd + 1] === "(") {
        const parsed = parseMarkdownInlineLink(source, labelEnd + 2);
        index = parsed?.endIndex ?? labelEnd;
        continue;
      }
      index = labelEnd;
      continue;
    }
    const inlineLabelEnd = findMarkdownLabelEnd(source, index + 1, MAX_MARKDOWN_INLINE_LABEL_SCAN_LENGTH);
    if (inlineLabelEnd >= 0 && source[inlineLabelEnd + 1] === "(") {
      const parsed = parseMarkdownInlineLink(source, inlineLabelEnd + 2);
      if (parsed) {
        index = parsed.endIndex;
        continue;
      }
      if (isEmptyMarkdownInlineDestination(source, inlineLabelEnd + 2)) {
        index = findEmptyMarkdownInlineDestinationEnd(source, inlineLabelEnd + 2);
        continue;
      }
    }

    const labelEnd = findMarkdownLabelEnd(source, index + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
    if (labelEnd < 0) {
      index = skipConsecutiveMarkdownOpeners(source, index);
      continue;
    }

    const suffix = parseMarkdownReferenceSuffix(source, labelEnd + 1);
    if (!suffix && isMarkdownReferenceDefinitionLabel(source, index, labelEnd)) {
      const lineEnd = source.indexOf("\n", labelEnd + 1);
      index = lineEnd >= 0 ? lineEnd : source.length;
      continue;
    }

    const text = source.slice(index + 1, labelEnd).trim();
    const rawLabel = suffix ? suffix.label.trim() || text : text;
    const resolvedLabel = normalizeReferenceLabel(rawLabel);
    if (!resolvedLabel) continue;

    const destination = referenceDefs.get(resolvedLabel);
    if (!destination) continue;
    out.push(destination);
    index = suffix?.endIndex ?? labelEnd;
  }

  return out;
}

function isMarkdownReferenceDefinitionLabel(source: string, labelStartIndex: number, labelEndIndex: number): boolean {
  const lineStart = source.lastIndexOf("\n", labelStartIndex - 1) + 1;
  const prefix = source.slice(lineStart, labelStartIndex);
  if (!/^\s{0,3}$/.test(prefix)) return false;
  const lineEnd = source.indexOf("\n", labelEndIndex + 1);
  const suffixEnd = lineEnd >= 0 ? lineEnd : source.length;
  return /^\s*:/.test(source.slice(labelEndIndex + 1, suffixEnd));
}

function parseMarkdownReferenceSuffix(source: string, startIndex: number): { label: string; endIndex: number } | null {
  if (source[startIndex] !== "[") return null;
  const labelEnd = findMarkdownLabelEnd(source, startIndex + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
  if (labelEnd < 0) return null;
  return {
    label: source.slice(startIndex + 1, labelEnd),
    endIndex: labelEnd,
  };
}

function collectMarkdownInlineLinkDestinations(source: string): string[] {
  const out: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[") continue;
    if (source[index - 1] === "!") continue;

    const labelEnd = findMarkdownLabelEnd(source, index + 1, MAX_MARKDOWN_INLINE_LABEL_SCAN_LENGTH);
    if (labelEnd < 0) {
      index = skipConsecutiveMarkdownOpeners(source, index);
      continue;
    }
    if (source[labelEnd + 1] !== "(") continue;
    const parsed = parseMarkdownInlineLink(source, labelEnd + 2);
    if (!parsed) continue;

    out.push(extractMarkdownDestination(parsed.destination));
    index = parsed.endIndex;
  }

  return out;
}

function findMarkdownLabelEnd(source: string, openIndex: number, maxLength: number): number {
  let depth = 0;
  const maxIndex = Math.min(source.length, openIndex + maxLength + 1);
  for (let index = openIndex; index < maxIndex; index += 1) {
    const char = source.charAt(index);
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "]") continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return -1;
}

function skipConsecutiveMarkdownOpeners(source: string, startIndex: number): number {
  let index = startIndex;
  while (source[index + 1] === "[") {
    index += 1;
  }
  return index;
}

function parseMarkdownReferenceDefinitionDestination(rawTail: string): string | null {
  const trimmed = rawTail.trim();
  if (!trimmed) return null;

  let destination = "";
  let remainder = "";
  if (trimmed.startsWith("<")) {
    const endIndex = trimmed.indexOf(">");
    if (endIndex <= 0) return null;
    destination = trimmed.slice(0, endIndex + 1);
    remainder = trimmed.slice(endIndex + 1).trim();
  } else {
    const whitespaceIndex = trimmed.search(/\s/);
    if (whitespaceIndex < 0) {
      return trimmed;
    }
    destination = trimmed.slice(0, whitespaceIndex);
    remainder = trimmed.slice(whitespaceIndex).trim();
  }

  if (!remainder) return destination;
  return isValidMarkdownReferenceTitle(remainder) ? destination : null;
}

function isValidMarkdownReferenceTitle(remainder: string): boolean {
  const opener = remainder.charAt(0);
  if (opener === '"' || opener === "'") {
    return closesAtEnd(remainder, opener);
  }
  if (!remainder.startsWith("(")) return false;
  return remainder.indexOf(")") === remainder.length - 1;
}

function closesAtEnd(value: string, delimiter: string): boolean {
  for (let index = 1; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== delimiter) continue;
    return index === value.length - 1;
  }
  return false;
}

function isEmptyMarkdownInlineDestination(source: string, startIndex: number): boolean {
  return findEmptyMarkdownInlineDestinationEnd(source, startIndex) >= 0;
}

function findEmptyMarkdownInlineDestinationEnd(source: string, startIndex: number): number {
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === ")") return index;
    if (char === "\n") return -1;
    if (!/\s/.test(char)) return -1;
  }
  return -1;
}

function isMarkdownAngleDestinationInLinkSyntax(source: string, matchIndex: number): boolean {
  let index = matchIndex - 1;
  while (index >= 0 && /\s/.test(source.charAt(index))) {
    if (source.charAt(index) === "\n") return false;
    index -= 1;
  }
  if (index >= 1 && source.charAt(index) === "(" && source.charAt(index - 1) === "]") {
    return true;
  }

  const lineStart = source.lastIndexOf("\n", matchIndex - 1) + 1;
  const labelOpen = lineStart + (source.slice(lineStart).match(/^ {0,3}/)?.[0].length ?? 0);
  if (source[labelOpen] !== "[") return false;
  const labelEnd = findMarkdownLabelEnd(source, labelOpen + 1, MAX_MARKDOWN_REFERENCE_LABEL_SCAN_LENGTH);
  return labelEnd >= 0 && labelEnd < matchIndex && /^\s*:\s*$/.test(source.slice(labelEnd + 1, matchIndex));
}

function extractMarkdownDestination(rawDestination: string): string {
  const trimmed = rawDestination.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("<")) {
    const endIndex = trimmed.indexOf(">");
    if (endIndex > 0) return trimmed.slice(0, endIndex + 1);
  }
  const whitespaceIndex = trimmed.search(/\s/);
  return whitespaceIndex >= 0 ? trimmed.slice(0, whitespaceIndex) : trimmed;
}

function parseMarkdownInlineLink(source: string, startIndex: number): { destination: string; endIndex: number } | null {
  let depth = 1;
  let destinationEnd = -1;
  let quote: '"' | "'" | null = null;
  let sawDestinationStart = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "\n") return null;
    if (char === "\\") {
      index += 1;
      continue;
    }

    if (!sawDestinationStart) {
      if (/\s/.test(char)) continue;
      sawDestinationStart = true;
    }

    if (destinationEnd >= 0) {
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth !== 0) continue;
      const destination = source.slice(startIndex, destinationEnd >= 0 ? destinationEnd : index).trim();
      return destination ? { destination, endIndex: index } : null;
    }

    if (destinationEnd < 0 && /\s/.test(char) && depth === 1) {
      destinationEnd = index;
    }
  }

  return null;
}

function isLikelyMarkdownAutolinkTarget(candidate: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) return true;
  if (candidate.startsWith("//")) return true;
  if (candidate.startsWith("./") || candidate.startsWith("../")) return true;
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return true;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(candidate)) return false;
  if (/^[A-Za-z][A-Za-z0-9:_-]*\/?$/.test(candidate)) return false;
  if (candidate.includes("/") || candidate.includes("\\")) return true;
  return !!path.extname(candidate).length;
}

function stripMarkdownCode(source: string): string {
  let sanitized = source.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, maskMatch);
  sanitized = sanitized.replace(/`[^`\n]*`/g, maskMatch);
  sanitized = sanitized.replace(/^(?: {4}|\t).*$/gm, maskMatch);
  return sanitized;
}

function maskMatch(segment: string): string {
  return segment.replace(/[^\r\n]/g, " ");
}
