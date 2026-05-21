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
