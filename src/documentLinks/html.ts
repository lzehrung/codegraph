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

const HTML_RAW_TEXT_TAGS: Record<string, true> = { script: true, style: true };
const HTML_LITERAL_BLOCK_TAGS: Record<string, true> = { pre: true, code: true };

interface HtmlCommentEvent {
  kind: "comment";
  start: number;
  end: number;
}

interface HtmlTagEvent {
  kind: "tag";
  name: string;
  start: number;
  end: number;
  attrsStart: number;
  attrsEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

type HtmlScanEvent = HtmlCommentEvent | HtmlTagEvent;

/**
 * Quote- and context-aware HTML walk. Tag ends are located with attribute-value
 * quotes in mind, so a `>` or `<!--` inside a quoted attribute never truncates a
 * tag or starts a comment. Raw-text bodies (script/style) are skipped opaquely
 * with JS/CSS string and comment awareness, so their contents are never mistaken
 * for markup. An unterminated open tag ends the walk, matching HTML parsing
 * where the rest of the document becomes attribute text. An unclosed raw-text
 * tag exposes the remainder as its body but the walk resumes after its opener,
 * so later real markup in a malformed document still yields events.
 */
function* scanHtmlEvents(source: string): Generator<HtmlScanEvent> {
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const closeIndex = source.indexOf("-->", index + 4);
      const end = closeIndex === -1 ? source.length : closeIndex + 3;
      yield { kind: "comment", start: index, end };
      index = end;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      index = skipHtmlDelimited(source, index + 9, "]]>");
      continue;
    }
    if (source[index] !== "<") {
      index++;
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) break;
    if (next === "/" || next === "!" || next === "?") {
      const tagEnd = findHtmlTagEnd(source, index + 2);
      index = tagEnd === -1 ? source.length : tagEnd;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      index++;
      continue;
    }
    const nameStart = index + 1;
    let nameEnd = nameStart;
    while (/[A-Za-z0-9:-]/.test(source[nameEnd] ?? "")) nameEnd++;
    const openEnd = findHtmlTagEnd(source, nameEnd);
    if (openEnd === -1) return;
    const name = source.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = source[openEnd - 2] === "/";
    if (HTML_RAW_TEXT_TAGS[name] && !selfClosing) {
      const closeTag = findHtmlCloseTag(source, name, openEnd, true);
      if (closeTag) {
        yield {
          kind: "tag",
          name,
          start: index,
          end: closeTag.end,
          attrsStart: nameEnd,
          attrsEnd: openEnd - 1,
          bodyStart: openEnd,
          bodyEnd: closeTag.start,
        };
        index = closeTag.end;
        continue;
      }
      yield {
        kind: "tag",
        name,
        start: index,
        end: openEnd,
        attrsStart: nameEnd,
        attrsEnd: openEnd - 1,
        bodyStart: openEnd,
        bodyEnd: source.length,
      };
      index = openEnd;
      continue;
    }
    if (HTML_LITERAL_BLOCK_TAGS[name] && !selfClosing) {
      const closeTag = findHtmlCloseTag(source, name, openEnd, false);
      const end = closeTag ? closeTag.end : source.length;
      const bodyEnd = closeTag ? closeTag.start : source.length;
      yield {
        kind: "tag",
        name,
        start: index,
        end,
        attrsStart: nameEnd,
        attrsEnd: openEnd - 1,
        bodyStart: openEnd,
        bodyEnd,
      };
      index = end;
      continue;
    }
    yield {
      kind: "tag",
      name,
      start: index,
      end: openEnd,
      attrsStart: nameEnd,
      attrsEnd: openEnd - 1,
      bodyStart: openEnd,
      bodyEnd: openEnd,
    };
    index = openEnd;
  }
}

function findHtmlTagEnd(source: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'" || char === "`") {
      index = skipHtmlAttributeValue(source, index);
      continue;
    }
    if (char === ">") return index + 1;
    index++;
  }
  return -1;
}

function skipHtmlAttributeValue(source: string, quoteStart: number): number {
  const quote = source[quoteStart]!;
  let index = quoteStart + 1;
  while (index < source.length) {
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function skipHtmlBodyString(source: string, quoteStart: number): number {
  const quote = source[quoteStart]!;
  let index = quoteStart + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function skipHtmlDelimited(source: string, contentStart: number, closing: string): number {
  const closingIndex = source.indexOf(closing, contentStart);
  return closingIndex === -1 ? source.length : closingIndex + closing.length;
}

function matchesHtmlTagName(source: string, start: number, tag: string): boolean {
  if (start + tag.length > source.length) return false;
  for (let index = 0; index < tag.length; index++) {
    if (source[start + index]!.toLowerCase() !== tag[index]!) return false;
  }
  return true;
}

function findHtmlCloseTag(
  source: string,
  tag: string,
  fromIndex: number,
  rawText: boolean,
): { start: number; end: number } | null {
  let index = fromIndex;
  while (index < source.length) {
    if (rawText) {
      if (source.startsWith("<!--", index)) {
        index = skipHtmlDelimited(source, index + 4, "-->");
        continue;
      }
      if (source.startsWith("<![CDATA[", index)) {
        index = skipHtmlDelimited(source, index + 9, "]]>");
        continue;
      }
      const char = source[index]!;
      if (char === '"' || char === "'" || char === "`") {
        index = skipHtmlBodyString(source, index);
        continue;
      }
      if (tag === "script" && source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline === -1 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith("/*", index)) {
        index = skipHtmlDelimited(source, index + 2, "*/");
        continue;
      }
    }
    if (source[index] === "<" && source[index + 1] === "/") {
      const nameStart = index + 2;
      if (matchesHtmlTagName(source, nameStart, tag)) {
        const nameEnd = nameStart + tag.length;
        const boundary = source[nameEnd];
        if (boundary === undefined || boundary === ">" || boundary === "/" || /\s/.test(boundary)) {
          const tagEnd = findHtmlTagEnd(source, nameEnd);
          if (tagEnd !== -1) return { start: index, end: tagEnd };
        }
      }
    }
    index++;
  }
  return null;
}

function stripHtmlCommentsAndLiteralBlocks(source: string): string {
  let chars: string[] | null = null;
  for (const event of scanHtmlEvents(source)) {
    if (event.kind !== "comment" && !HTML_LITERAL_BLOCK_TAGS[event.name]) continue;
    if (!chars) chars = source.split("");
    for (let offset = event.start; offset < event.end; offset++) {
      const char = chars[offset]!;
      if (char !== "\n" && char !== "\r") chars[offset] = " ";
    }
  }
  return chars ? chars.join("") : source;
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

  for (const event of scanHtmlEvents(cleaned)) {
    if (event.kind !== "tag" || event.name !== "style") continue;
    const body = cleaned.slice(event.bodyStart, event.bodyEnd).replace(/\/\*[\s\S]*?\*\//g, "");
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
  const cleaned = stripHtmlCommentsAndLiteralBlocks(source);
  for (const event of scanHtmlEvents(cleaned)) {
    if (event.kind !== "tag" || event.name !== "script") continue;
    const attrs = cleaned.slice(event.attrsStart, event.attrsEnd);
    if (/\bsrc\s*=\s*["'][^"']+["']/i.test(attrs)) continue;
    const body = cleaned.slice(event.bodyStart, event.bodyEnd);
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
  const cleaned = stripHtmlCommentsAndLiteralBlocks(source);

  for (const event of scanHtmlEvents(cleaned)) {
    if (event.kind !== "tag") continue;
    const attrNames = tagAttrNames[event.name];
    if (!attrNames) continue;
    const attrs = cleaned.slice(event.attrsStart, event.attrsEnd);

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
