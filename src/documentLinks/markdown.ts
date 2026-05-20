import path from "node:path";
import { extractJsTsSpecifiers, type ModuleSpecifier } from "../util.js";
import { extractHtmlAttributeSpecifiers } from "./html.js";
import {
  dedupeModuleSpecifiers,
  markResolutionKind,
  normalizeLinkSpecifier,
  normalizeReferenceLabel,
} from "./shared.js";

export function extractMarkdownModuleSpecifiers(source: string): ModuleSpecifier[] {
  const sanitized = stripMarkdownCode(source);
  return extractMarkdownModuleSpecifiersFromSanitized(sanitized);
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

  for (const match of sanitized.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const fullMatch = match[0] ?? "";
    if (fullMatch.startsWith("!")) continue;
    const text = match[1]?.trim();
    const label = match[2]?.trim();
    const resolvedLabel = normalizeReferenceLabel(label || text);
    if (!resolvedLabel) continue;
    const destination = referenceDefs.get(resolvedLabel);
    if (!destination) continue;
    out.push(destination);
  }

  for (const match of sanitized.matchAll(/<([^>\s]+)>/g)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
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

function collectMarkdownReferenceDefinitions(source: string): Map<string, ModuleSpecifier> {
  const out = new Map<string, ModuleSpecifier>();
  const definitionRe = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|[^ \t\n]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;

  for (const match of source.matchAll(definitionRe)) {
    const label = normalizeReferenceLabel(match[1]);
    const rawDestination = match[2];
    if (!label || !rawDestination) continue;
    const normalized = normalizeLinkSpecifier(rawDestination, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized) out.set(label, normalized);
  }

  return out;
}

function collectMarkdownInlineLinkDestinations(source: string): string[] {
  const out: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[") continue;
    if (source[index - 1] === "!") continue;

    const labelEnd = findMarkdownLabelEnd(source, index + 1);
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") continue;

    const parsed = parseMarkdownInlineLink(source, labelEnd + 2);
    if (!parsed) continue;

    out.push(extractMarkdownDestination(parsed.destination));
    index = parsed.endIndex;
  }

  return out;
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

function findMarkdownLabelEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
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
