import path from "node:path";
import { extractJsTsSpecifiers, type ModuleSpecifier } from "./util.js";

export const GRAPH_ONLY_LANGUAGE_IDS = new Set(["markdown", "mdx", "astro", "hbs", "rst", "adoc"]);

const GRAPH_ONLY_ALIAS_LANGUAGE_IDS = new Set(["mdx", "astro"]);

const DEFAULT_HTML_TAG_ATTRS: Record<string, string[]> = {
  script: ["src"],
  link: ["href"],
  a: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src"],
  audio: ["src"],
  iframe: ["src"],
  track: ["src"],
};

const HTML_TAG_RE = /<(script|link|a|img|source|video|audio|iframe|track)\b([^>]*)>/gi;

const DOCUMENT_RELATIVE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".astro",
  ".hbs",
  ".handlebars",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".txt",
  ".yaml",
  ".yml",
]);

export function isGraphOnlyLanguage(languageId: string): boolean {
  return GRAPH_ONLY_LANGUAGE_IDS.has(languageId);
}

export function graphOnlyLanguageSupportsImportAliases(languageId: string): boolean {
  return GRAPH_ONLY_ALIAS_LANGUAGE_IDS.has(languageId);
}

export function graphOnlySpecifierNeedsResolutionConfig(specifier: string): boolean {
  return !(
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  );
}

export function extractHtmlInlineScriptSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const inlineScriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of source.matchAll(inlineScriptRe)) {
    const attrs = match[1] ?? "";
    if (/\bsrc\s*=\s*["'][^"']+["']/i.test(attrs)) continue;
    const body = match[2] ?? "";
    if (!body.trim()) continue;
    out.push(...markResolutionKind(extractJsTsSpecifiers(body), "source"));
  }
  return dedupeModuleSpecifiers(out);
}

export function extractHtmlAttributeSpecifiers(
  source: string,
  tagAttrNames: Record<string, string[]> = DEFAULT_HTML_TAG_ATTRS,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  for (const match of source.matchAll(HTML_TAG_RE)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const attrNames = tagAttrNames[tag] ?? [];

    for (const attrName of attrNames) {
      const attrRe = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s"'=<>\\x60]+))`, "i");
      const attrMatch = attrs.match(attrRe);
      const raw = (attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3])?.trim();
      if (!raw) continue;
      if (attrName === "srcset") {
        const candidates = raw
          .split(",")
          .map((entry) => entry.trim().split(/\s+/)[0]?.trim())
          .filter((entry): entry is string => !!entry);
        for (const spec of candidates) {
          const normalized = normalizeLinkSpecifier(spec, {
            preferRelative: true,
            resolutionKind: "document",
          });
          if (normalized) out.push(normalized);
        }
        continue;
      }
      const normalized = normalizeLinkSpecifier(raw, {
        preferRelative: true,
        resolutionKind: "document",
      });
      if (normalized) out.push(normalized);
    }
  }

  return dedupeModuleSpecifiers(out);
}

export function extractGraphOnlyModuleSpecifiers(languageId: string, source: string): ModuleSpecifier[] {
  if (languageId === "markdown") {
    return extractMarkdownModuleSpecifiers(source);
  }
  if (languageId === "mdx") {
    return extractMdxModuleSpecifiers(source);
  }
  if (languageId === "astro") {
    return extractAstroModuleSpecifiers(source);
  }
  if (languageId === "hbs") {
    return extractHandlebarsModuleSpecifiers(source);
  }
  if (languageId === "rst") {
    return extractRstModuleSpecifiers(source);
  }
  if (languageId === "adoc") {
    return extractAsciidocModuleSpecifiers(source);
  }
  return [];
}

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

export function extractAstroModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  out.push(...extractHtmlAttributeSpecifiers(source));
  out.push(...extractHtmlInlineScriptSpecifiers(source));

  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch?.[1]) {
    out.push(...markResolutionKind(extractJsTsSpecifiers(frontmatterMatch[1]), "source"));
  }

  return dedupeModuleSpecifiers(out);
}

export function extractHandlebarsModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  out.push(...extractHtmlAttributeSpecifiers(source));

  for (const match of source.matchAll(/\{\{\s*>\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/g)) {
    const rawSpecifier = match[1] ?? match[2] ?? match[3];
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized) out.push(normalized);
  }

  return dedupeModuleSpecifiers(out);
}

export function extractRstModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const namedTargets = collectRstTargetDefinitions(source);

  for (const match of source.matchAll(/`[^`<\n]*<([^>\n]+)>`_/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of source.matchAll(/`([^`\n]+)`_/g)) {
    const label = normalizeReferenceLabel(match[1]);
    if (!label) continue;
    const normalized = namedTargets.get(label);
    if (normalized) out.push(normalized);
  }

  for (const match of source.matchAll(/^\s*\.\.\s+include::\s+([^\s]+)\s*$/gm)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  out.push(...extractRstToctreeSpecifiers(source));

  return dedupeModuleSpecifiers(out);
}

export function extractAsciidocModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  for (const match of source.matchAll(/\b(xref|link):([^\[\s]+)\[[^\]]*]/g)) {
    const directive = (match[1] ?? "").toLowerCase();
    const rawSpecifier = match[2]?.trim();
    if (!rawSpecifier) continue;
    const fileLikeTarget =
      directive === "xref" ? isLikelyAsciidocXrefTarget(rawSpecifier) : isLikelyAsciidocFileTarget(rawSpecifier);
    if (!fileLikeTarget) continue;
    const ambiguousXrefTarget = directive === "xref" && isAmbiguousAsciidocXrefTarget(rawSpecifier);
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) {
      out.push(ambiguousXrefTarget ? { ...normalized, dropIfUnresolved: true } : normalized);
    }
  }

  for (const match of source.matchAll(/\binclude::([^\[\n]+)\[[^\]]*]/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of source.matchAll(/<<([^>,]+)(?:,[^>]*)?>>/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    if (!isLikelyAsciidocFileTarget(rawSpecifier)) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  out.push(
    ...extractHtmlAttributeSpecifiers(source, {
      a: ["href"],
    }),
  );

  return dedupeModuleSpecifiers(out);
}

function dedupeModuleSpecifiers(entries: ModuleSpecifier[]): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.spec}::${entry.typeOnly ? 1 : 0}::${entry.resolutionKind ?? ""}::${entry.dropIfUnresolved ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
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

function collectRstTargetDefinitions(source: string): Map<string, ModuleSpecifier> {
  const out = new Map<string, ModuleSpecifier>();
  const definitionRe = /^\s*\.\.\s+_([^:]+):\s*(\S+)\s*$/gm;

  for (const match of source.matchAll(definitionRe)) {
    const label = normalizeReferenceLabel(match[1]);
    const rawSpecifier = match[2];
    if (!label || !rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.set(label, normalized);
  }

  return out;
}

function extractRstToctreeSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const lines = source.split(/\r?\n/);
  let inToctree = false;

  for (const line of lines) {
    if (/^\s*\.\.\s+toctree::\s*$/.test(line)) {
      inToctree = true;
      continue;
    }

    if (!inToctree) continue;

    if (!line.trim()) {
      continue;
    }

    const indentMatch = line.match(/^(\s+)(.+)$/);
    if (!indentMatch) {
      inToctree = false;
      continue;
    }

    const content = indentMatch[2]?.trim();
    if (!content || content.startsWith(":")) {
      continue;
    }

    const titledMatch = content.match(/<([^>]+)>/);
    const rawSpecifier = titledMatch?.[1]?.trim() ?? content;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  return out;
}

function normalizeReferenceLabel(label: string | undefined): string | null {
  const normalized = label?.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized ? normalized : null;
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

function normalizeLinkSpecifier(
  rawSpecifier: string,
  opts?: {
    preferRelative?: boolean;
    forceRelative?: boolean;
    resolutionKind?: "document" | "source";
  },
): ModuleSpecifier | null {
  const original = rawSpecifier.trim();
  if (!original) return null;

  let normalized = original;
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized || normalized.startsWith("#")) return null;
  if (isObviouslyDynamicSpecifier(normalized)) return null;

  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(normalized);
  const isProtocolRelative = normalized.startsWith("//");

  if (!hasSchemePrefix && !isProtocolRelative && !isWindowsAbsolutePath) {
    const hashIndex = normalized.indexOf("#");
    if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex);
    const queryIndex = normalized.indexOf("?");
    if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex);
  }

  normalized = normalized.trim();
  if (!normalized) return null;

  if (opts?.forceRelative && shouldForceRelativePath(normalized)) {
    normalized = `./${normalized}`;
  } else if (opts?.preferRelative && shouldPreferRelativePath(normalized)) {
    normalized = `./${normalized}`;
  }

  if (normalized === original) {
    return {
      spec: normalized,
      ...(opts?.resolutionKind ? { resolutionKind: opts.resolutionKind } : {}),
    };
  }
  return {
    spec: normalized,
    raw: original,
    ...(opts?.resolutionKind ? { resolutionKind: opts.resolutionKind } : {}),
  };
}

function markResolutionKind(entries: ModuleSpecifier[], resolutionKind: "document" | "source"): ModuleSpecifier[] {
  return entries.map((entry) => ({
    ...entry,
    resolutionKind,
  }));
}

function shouldForceRelativePath(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@") ||
    specifier.startsWith("//")
  ) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return false;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
  return true;
}

function shouldPreferRelativePath(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@") ||
    specifier.startsWith("//")
  ) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return false;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
  if (specifier.includes("/")) {
    const firstSegment = specifier.split(/[\\/]/, 1)[0] ?? "";
    if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/i.test(firstSegment)) {
      return false;
    }
    return true;
  }

  const ext = path.extname(specifier).toLowerCase();
  return DOCUMENT_RELATIVE_EXTENSIONS.has(ext);
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
  return path.extname(candidate).length > 0;
}

function isLikelyAsciidocXrefTarget(rawSpecifier: string): boolean {
  if (isLikelyAsciidocFileTarget(rawSpecifier)) return true;

  const withoutFragment = rawSpecifier.trim().split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!withoutFragment) return false;
  return /^[A-Za-z0-9._-]+$/.test(withoutFragment);
}

function isAmbiguousAsciidocXrefTarget(rawSpecifier: string): boolean {
  return isLikelyAsciidocXrefTarget(rawSpecifier) && !isLikelyAsciidocFileTarget(rawSpecifier);
}

function isLikelyAsciidocFileTarget(rawSpecifier: string): boolean {
  const trimmed = rawSpecifier.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return true;
  if (trimmed.startsWith("//")) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;

  const withoutFragment = trimmed.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!withoutFragment) return false;
  if (withoutFragment.startsWith("./") || withoutFragment.startsWith("../") || withoutFragment.startsWith("/")) {
    return true;
  }
  if (withoutFragment.includes("/") || withoutFragment.includes("\\")) {
    return true;
  }
  return path.extname(withoutFragment).length > 0;
}

function isObviouslyDynamicSpecifier(specifier: string): boolean {
  return (
    specifier.includes("{") ||
    specifier.includes("}") ||
    specifier.includes("{{") ||
    specifier.includes("}}") ||
    specifier.includes("{%") ||
    specifier.includes("%}") ||
    specifier.includes("<%") ||
    specifier.includes("%>") ||
    specifier.includes("${")
  );
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
