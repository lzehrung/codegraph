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

interface SFCOpeningTag {
  name: "template" | "script" | "style";
  attrsText: string;
  start: number;
  end: number;
}

interface SFCClosingTag {
  start: number;
  end: number;
}

export function detectSFCFramework(filePath: string): SFCFramework | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".vue") return "vue";
  if (ext === ".svelte") return "svelte";
  return null;
}

export function parseSFC(source: string): SFCBlock[] {
  const blocks: SFCBlock[] = [];
  const lineIndex = buildLineIndex(source);

  let cursor = 0;
  while (cursor < source.length) {
    const openTag = findNextSFCOpeningTag(source, cursor);
    if (!openTag) break;

    const closeTag = findClosingTag(source, openTag.name, openTag.end);
    if (!closeTag) {
      // Malformed document: stop at the first unmatched opening tag rather
      // than scanning inside the unclosed block and reporting its contents as
      // additional top-level blocks.
      break;
    }
    const contentStart = openTag.end;
    const contentEnd = closeTag.start;
    const content = source.slice(contentStart, contentEnd);
    const startLine = lineForOffset(lineIndex, contentStart);
    const endLine =
      contentStart === contentEnd ? startLine : lineForOffset(lineIndex, Math.max(contentStart, contentEnd - 1));

    blocks.push({
      type: openTag.name,
      attrs: parseAttributes(openTag.attrsText),
      content,
      startLine,
      endLine,
      startOffset: contentStart,
      endOffset: contentEnd,
      blockStart: openTag.start,
      blockEnd: closeTag.end,
    });
    cursor = closeTag.end;
  }

  return blocks;
}

export function buildSvelteTemplateBlocks(source: string, blocks: SFCBlock[]): SFCBlock[] {
  if (!source) return [];
  const lineIndex = buildLineIndex(source);
  const gaps: Range[] = [];
  const occupied = blocks.map((b) => ({ start: b.blockStart, end: b.blockEnd })).sort((a, b) => a.start - b.start);
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

/**
 * Preserves a block's original offsets while making it safe to parse with the
 * language that owns the block rather than the enclosing SFC grammar.
 */
export function prepareSFCBlockSource(source: string, block: SFCBlock): string {
  return maskOutsideRanges(source, [{ start: block.startOffset, end: block.endOffset }]);
}

export function prepareSFCScriptSource(
  source: string,
  _framework: SFCFramework,
): {
  maskedSource: string;
  scriptLangId: "js" | "ts" | "tsx";
  hasScript: boolean;
} {
  const blocks = parseSFC(source);
  const scriptBlocks = blocks.filter((b) => b.type === "script");
  const scriptLangId = inferScriptLanguage(scriptBlocks);
  const externalScriptImports = extractExternalScriptImports(scriptBlocks);
  if (!scriptBlocks.length) {
    return {
      maskedSource: appendSyntheticImports(preserveLineStructure(source), externalScriptImports),
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
    maskedSource: appendSyntheticImports(maskedSource, externalScriptImports),
    scriptLangId,
    hasScript: true,
  };
}

export function inferScriptLanguage(blocks: SFCBlock[], fallback: "js" | "ts" | "tsx" = "js"): "js" | "ts" | "tsx" {
  for (const block of blocks) {
    const lang = normalizeLang(block.attrs.lang);
    if (lang === "ts" || lang === "tsx") return lang;
  }
  return fallback;
}

export function scriptLanguageIdForBlock(block: SFCBlock): "js" | "ts" | "tsx" {
  return inferScriptLanguage([block]);
}

export function styleLanguageKey(block: SFCBlock): "css" | "scss" | "less" | null {
  const raw = normalizeLang(block.attrs.lang) ?? normalizeLang(block.attrs.type);
  if (!raw) return "css";
  if (raw === "scss" || raw === "less" || raw === "css") return raw;
  if (raw === "sass") return "scss";
  return null;
}

export function templateLanguageKey(_framework: SFCFramework): "html" {
  return "html";
}

function normalizeLang(value: string | boolean | undefined): string | undefined {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return undefined;
}

function normalizeSrc(value: string | boolean | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractExternalScriptImports(blocks: SFCBlock[]): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const src = normalizeSrc(block.attrs.src);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    imports.push(src);
  }
  return imports;
}

function appendSyntheticImports(source: string, imports: string[]): string {
  if (!imports.length) return source;
  const syntheticSource = imports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n");
  return `${source}\n${syntheticSource}`;
}

function findNextSFCOpeningTag(source: string, fromIndex: number): SFCOpeningTag | null {
  let index = fromIndex;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      index = skipDelimited(source, index + 4, "-->");
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      index = skipDelimited(source, index + 9, "]]>");
      continue;
    }

    const char = source[index]!;
    if (isQuote(char)) {
      index = skipQuotedString(source, index);
      continue;
    }
    if (char !== "<") {
      index++;
      continue;
    }
    if (source[index + 1] === "/" || source[index + 1] === "!" || source[index + 1] === "?") {
      const tagEnd = findTagEnd(source, index + 1);
      index = tagEnd === -1 ? index + 1 : tagEnd;
      continue;
    }

    const nameStart = index + 1;
    let nameEnd = nameStart;
    while (isTagNameCharacter(source[nameEnd])) nameEnd++;
    if (nameEnd === nameStart) {
      index++;
      continue;
    }

    const tagEnd = findTagEnd(source, nameEnd);
    if (tagEnd === -1) {
      index = nameEnd;
      continue;
    }

    const tagName = source.slice(nameStart, nameEnd).toLowerCase();
    const attrsEnd = source[tagEnd - 2] === "/" ? tagEnd - 2 : tagEnd - 1;
    if (
      (tagName === "template" || tagName === "script" || tagName === "style") &&
      isTagBoundary(source[nameEnd]) &&
      source[tagEnd - 2] !== "/"
    ) {
      return {
        name: tagName,
        attrsText: source.slice(nameEnd, attrsEnd),
        start: index,
        end: tagEnd,
      };
    }
    index = tagEnd;
  }
  return null;
}

function findClosingTag(source: string, tag: string, fromIndex: number): SFCClosingTag | null {
  let index = fromIndex;
  // Template bodies are parsed content and commonly nest same-name blocks
  // (Vue <template v-if>), so their close tag is matched by depth. Script and
  // style bodies are raw text that cannot nest, so the first matching close
  // tag still wins there.
  let depth = 1;
  const trackNesting = tag === "template";
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      index = skipDelimited(source, index + 4, "-->");
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      index = skipDelimited(source, index + 9, "]]>");
      continue;
    }

    const char = source[index]!;
    if (isQuote(char)) {
      index = skipQuotedString(source, index);
      continue;
    }
    if (tag === "script" && source.startsWith("//", index)) {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if ((tag === "script" || tag === "style") && source.startsWith("/*", index)) {
      index = skipDelimited(source, index + 2, "*/");
      continue;
    }
    if (char !== "<") {
      index++;
      continue;
    }

    if (source[index + 1] === "/") {
      const nameStart = index + 2;
      if (!matchesCaseInsensitive(source, nameStart, tag)) {
        index++;
        continue;
      }
      const nameEnd = nameStart + tag.length;
      if (!isTagBoundary(source[nameEnd])) {
        index++;
        continue;
      }
      const tagEnd = findTagEnd(source, nameEnd);
      if (tagEnd === -1) {
        index++;
        continue;
      }
      depth--;
      if (depth === 0) return { start: index, end: tagEnd };
      index = tagEnd;
      continue;
    }

    if (trackNesting) {
      const nameStart = index + 1;
      if (matchesCaseInsensitive(source, nameStart, tag)) {
        const nameEnd = nameStart + tag.length;
        if (isTagBoundary(source[nameEnd])) {
          const tagEnd = findTagEnd(source, nameEnd);
          if (tagEnd !== -1) {
            if (source[tagEnd - 2] !== "/") depth++;
            index = tagEnd;
            continue;
          }
        }
      }
    }
    index++;
  }
  return null;
}

function findTagEnd(source: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < source.length) {
    const char = source[index]!;
    if (isQuote(char)) {
      index = skipQuotedString(source, index);
      continue;
    }
    if (char === ">") return index + 1;
    index++;
  }
  return -1;
}

function skipQuotedString(source: string, quoteStart: number): number {
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

function skipDelimited(source: string, contentStart: number, closing: string): number {
  const closingIndex = source.indexOf(closing, contentStart);
  return closingIndex === -1 ? source.length : closingIndex + closing.length;
}

function skipLineComment(source: string, contentStart: number): number {
  const newline = source.indexOf("\n", contentStart);
  return newline === -1 ? source.length : newline + 1;
}

function matchesCaseInsensitive(source: string, start: number, value: string): boolean {
  if (start + value.length > source.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (source[start + index]!.toLowerCase() !== value[index]!) return false;
  }
  return true;
}

function isTagNameCharacter(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9:_-]/.test(char);
}

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

function isQuote(char: string): boolean {
  return char === "'" || char === '"' || char === "`";
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
  if (!ranges.length) return preserveLineStructure(source);
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
