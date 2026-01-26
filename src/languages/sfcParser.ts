import path from "node:path";

export type SFCFramework = "vue" | "svelte";

export interface SFCBlock {
  type: "template" | "script" | "style" | "custom";
  attrs: Record<string, string | boolean>;
  content: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  blockStart: number;
  blockEnd: number;
}

interface Range {
  start: number;
  end: number;
}

const TAG_PATTERN = /<(template|script|style)\b([^>]*)>/gi;

export function detectSFCFramework(filePath: string): SFCFramework | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".vue") return "vue";
  if (ext === ".svelte") return "svelte";
  return null;
}

export function parseSFC(source: string): SFCBlock[] {
  const blocks: SFCBlock[] = [];
  const lower = source.toLowerCase();
  const lineIndex = buildLineIndex(source);

  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(source)) !== null) {
    const tagName = (match[1] ?? "").toLowerCase();
    const attrsText = match[2] ?? "";
    const openTagStart = match.index;
    const openTagEnd = match.index + match[0].length;

    const close = findClosingTag(lower, tagName, openTagEnd);
    if (close === -1) {
      break;
    }
    const closeTagLength = tagName.length + 3; // </tag>
    const blockEnd = close + closeTagLength;
    const contentStart = openTagEnd;
    const contentEnd = close;

    const attrs = parseAttributes(attrsText);
    const type =
      tagName === "template" || tagName === "script" || tagName === "style"
        ? tagName
        : "custom";
    const content = source.slice(contentStart, contentEnd);
    const startLine = lineForOffset(lineIndex, contentStart);
    const endLine =
      contentStart === contentEnd
        ? startLine
        : lineForOffset(lineIndex, Math.max(contentStart, contentEnd - 1));

    blocks.push({
      type: type,
      attrs,
      content,
      startLine,
      endLine,
      startOffset: contentStart,
      endOffset: contentEnd,
      blockStart: openTagStart,
      blockEnd,
    });
    TAG_PATTERN.lastIndex = blockEnd;
  }

  return blocks;
}

export function buildSvelteTemplateBlocks(
  source: string,
  blocks: SFCBlock[],
): SFCBlock[] {
  if (!source) return [];
  const lineIndex = buildLineIndex(source);
  const gaps: Range[] = [];
  const occupied = blocks
    .map((b) => ({ start: b.blockStart, end: b.blockEnd }))
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const range of occupied) {
    if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < source.length) gaps.push({ start: cursor, end: source.length });

  const templateBlocks: SFCBlock[] = [];
  for (const gap of gaps) {
    const slice = source.slice(gap.start, gap.end);
    if (!slice.trim()) continue;
    const startLine = lineForOffset(lineIndex, gap.start);
    const endLine = lineForOffset(lineIndex, Math.max(gap.start, gap.end - 1));
    templateBlocks.push({
      type: "template",
      attrs: {},
      content: slice,
      startLine,
      endLine,
      startOffset: gap.start,
      endOffset: gap.end,
      blockStart: gap.start,
      blockEnd: gap.end,
    });
  }
  return templateBlocks;
}

export function prepareSFCScriptSource(
  source: string,
  framework: SFCFramework,
): {
  maskedSource: string;
  scriptLangId: "js" | "ts" | "tsx";
  hasScript: boolean;
} {
  const blocks = parseSFC(source);
  const scriptBlocks = blocks.filter((b) => b.type === "script");
  const scriptLangId = inferScriptLanguage(scriptBlocks);
  if (scriptBlocks.length === 0) {
    return {
      maskedSource: preserveLineStructure(source),
      scriptLangId,
      hasScript: false,
    };
  }
  const keepRanges = scriptBlocks.map((b) => ({
    start: b.startOffset,
    end: b.endOffset,
  }));
  const maskedSource = maskOutsideRanges(source, keepRanges);
  return {
    maskedSource,
    scriptLangId,
    hasScript: true,
  };
}

export function inferScriptLanguage(
  blocks: SFCBlock[],
  fallback: "js" | "ts" | "tsx" = "js",
): "js" | "ts" | "tsx" {
  for (const block of blocks) {
    const lang = normalizeLang(block.attrs.lang);
    if (lang === "ts" || lang === "tsx") return lang;
  }
  return fallback;
}

export function scriptLanguageIdForBlock(block: SFCBlock): "js" | "ts" | "tsx" {
  return inferScriptLanguage([block]);
}

export function styleLanguageKey(
  block: SFCBlock,
): "css" | "scss" | "less" | null {
  const raw =
    normalizeLang(block.attrs.lang) ?? normalizeLang(block.attrs.type);
  if (!raw) return "css";
  if (raw === "scss" || raw === "less" || raw === "css") return raw;
  if (raw === "sass") return "scss";
  return null;
}

export function templateLanguageKey(framework: SFCFramework): "html" | null {
  return framework === "vue" ? "html" : null;
}

function normalizeLang(
  value: string | boolean | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return undefined;
}

function findClosingTag(
  lowerSource: string,
  tag: string,
  fromIndex: number,
): number {
  const closeExpr = `</${tag}>`;
  return lowerSource.indexOf(closeExpr, fromIndex);
}

function parseAttributes(source: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const attrRegex = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(source)) !== null) {
    const key = match[1] ?? "";
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    attrs[key] = value;
  }
  return attrs;
}

function buildLineIndex(text: string): number[] {
  const index = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      index.push(i + 1);
    }
  }
  return index;
}

function lineForOffset(index: number[], offset: number): number {
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid]! <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function maskOutsideRanges(source: string, ranges: Range[]): string {
  if (ranges.length === 0) return preserveLineStructure(source);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let current = sorted.shift()!;
  const chars = source.split("");
  for (let i = 0; i < chars.length; i++) {
    while (current && i >= current.end) {
      current = sorted.shift()!;
    }
    const inside = current && i >= current.start && i < current.end;
    if (inside) continue;
    const ch = chars[i];
    if (ch === "\n" || ch === "\r") continue;
    chars[i] = " ";
  }
  return chars.join("");
}

function preserveLineStructure(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}
