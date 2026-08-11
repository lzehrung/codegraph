import { extractJsTsSpecifiers, type ModuleSpecifier } from "../util/specifiers.js";
import { dedupeModuleSpecifiers, markResolutionKind, normalizeLinkSpecifier } from "./shared.js";

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
const HTML_STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi;
const HTML_EMBEDDED_BODY_TAGS = ["script", "style"] as const;

function blankMarkup(source: string): string {
  return source.replace(/[^\r\n]/g, " ");
}

function stripHtmlCommentsAndLiteralBlocks(source: string): string {
  return source.replace(
    /<!--[\s\S]*?(?:-->|$)|<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => blankMarkup(match),
  );
}

function maskHtmlEmbeddedBodies(source: string): string {
  let masked = source;
  for (const tagName of HTML_EMBEDDED_BODY_TAGS) {
    const tagRe = new RegExp(`(<${tagName}\\b[^>]*>)[\\s\\S]*?(<\\/${tagName}\\s*>)`, "gi");
    masked = masked.replace(tagRe, "$1$2");
  }
  return masked;
}

function extractNormalizedStyleSpecifier(rawSpecifier: string): ModuleSpecifier | null {
  return normalizeLinkSpecifier(rawSpecifier, {
    preferRelative: true,
    resolutionKind: "document",
  });
}

export function extractHtmlStyleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripHtmlCommentsAndLiteralBlocks(source);

  for (const match of cleaned.matchAll(HTML_STYLE_TAG_RE)) {
    const body = (match[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const importRe = /(?:^|[;{}])\s*@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^)"'\s;]+))/gim;
    for (const importMatch of body.matchAll(importRe)) {
      const rawSpecifier = importMatch[1] ?? importMatch[2] ?? importMatch[3];
      if (!rawSpecifier) continue;
      const normalized = extractNormalizedStyleSpecifier(rawSpecifier);
      if (normalized) out.push(normalized);
    }

    const urlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi;
    for (const urlMatch of body.matchAll(urlRe)) {
      const rawSpecifier = urlMatch[1] ?? urlMatch[2] ?? urlMatch[3];
      if (!rawSpecifier) continue;
      const normalized = extractNormalizedStyleSpecifier(rawSpecifier);
      if (normalized) out.push(normalized);
    }
  }

  return dedupeModuleSpecifiers(out);
}

export function extractHtmlInlineScriptSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = maskHtmlEmbeddedBodies(stripHtmlCommentsAndLiteralBlocks(source));
  const inlineScriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of cleaned.matchAll(inlineScriptRe)) {
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
  const cleaned = maskHtmlEmbeddedBodies(stripHtmlCommentsAndLiteralBlocks(source));

  for (const match of cleaned.matchAll(HTML_TAG_RE)) {
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
