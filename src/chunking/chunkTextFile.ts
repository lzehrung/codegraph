import type { Chunk } from "./chunkFile.js";
import { withStableChunkIds } from "./chunkId.js";
import { splitTextWithinTokenBudget } from "./chunkSplit.js";
import { countWhitespaceTokens } from "./tokenizer.js";
import type { ChunkTokenizer } from "./types.js";

/**
 * Options for text file chunking (JSON, YAML, config files, etc.).
 */
export interface TextChunkOptions {
  /** Text content to chunk */
  source: string;
  /** Optional source file path for chunk IDs */
  filePath?: string | undefined;
  /** Language identifier (e.g., "json", "yaml", "text") */
  languageId?: string;
  /** Minimum tokens per chunk (default: 150). Smaller chunks are merged. */
  minTokens?: number;
  /** Maximum tokens per chunk (default: 400). Larger chunks are split. */
  maxTokens?: number;
  /** Custom token counting function (default: whitespace-based) */
  tokenizer?: ChunkTokenizer | undefined;
}

/**
 * Splits text files into chunks respecting token budgets.
 * Useful for JSON, YAML, configuration files, and other non-code text content.
 *
 * @param opts Text chunking options
 * @returns Array of text chunks
 */
export function chunkTextFile(opts: TextChunkOptions): Chunk[] {
  const { source, filePath, languageId = "text", maxTokens = 400, tokenizer = countWhitespaceTokens } = opts;
  if (!source.length) return [];

  const chunks: Chunk[] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let currentStartLine = 1;
  let currentTokens = 0;

  const flush = () => {
    if (currentStart === -1) return;
    pushBoundedRange(chunks, source, currentStart, currentEnd, currentStartLine, languageId, filePath, tokenizer, maxTokens);
    currentStart = -1;
    currentEnd = -1;
    currentTokens = 0;
  };

  for (const line of lineRanges(source)) {
    const lineTokens = tokenizer(source.slice(line.start, line.end));
    if (lineTokens > maxTokens) {
      flush();
      pushBoundedRange(chunks, source, line.start, line.end, line.startLine, languageId, filePath, tokenizer, maxTokens);
      continue;
    }

    if (currentStart !== -1 && currentTokens + lineTokens > maxTokens) {
      flush();
    }

    if (currentStart === -1) {
      currentStart = line.start;
      currentStartLine = line.startLine;
    }
    currentEnd = line.end;
    currentTokens += lineTokens;
  }

  flush();
  return withStableChunkIds(chunks, languageId, filePath);
}

function pushBoundedRange(
  chunks: Chunk[],
  source: string,
  start: number,
  end: number,
  startLine: number,
  languageId: string,
  filePath: string | undefined,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
): void {
  const text = source.slice(start, end);
  const tokenCount = tokenizer(text);
  if (tokenCount <= maxTokens) {
    chunks.push({
      id: "",
      languageId,
      type: "text",
      startLine,
      endLine: endLineForText(startLine, text),
      text,
      tokenCount,
      ...(filePath !== undefined ? { filePath } : {}),
    });
    return;
  }

  let segmentStartLine = startLine;
  for (const segment of splitTextWithinTokenBudget(text, tokenizer, maxTokens)) {
    chunks.push({
      id: "",
      languageId,
      type: "text",
      startLine: segmentStartLine,
      endLine: endLineForText(segmentStartLine, segment),
      text: segment,
      tokenCount: tokenizer(segment),
      ...(filePath !== undefined ? { filePath } : {}),
    });
    segmentStartLine += countLineBreaks(segment);
  }
}

function lineRanges(source: string): Array<{ start: number; end: number; startLine: number }> {
  const ranges: Array<{ start: number; end: number; startLine: number }> = [];
  let start = 0;
  let line = 1;

  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] !== "\n") continue;
    ranges.push({ start, end: offset + 1, startLine: line });
    start = offset + 1;
    line++;
  }

  if (start < source.length) {
    ranges.push({ start, end: source.length, startLine: line });
  }

  return ranges;
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") count++;
  }
  return count;
}

function endLineForText(startLine: number, text: string): number {
  const lineBreaks = countLineBreaks(text);
  return startLine + lineBreaks - (text.endsWith("\n") ? 1 : 0);
}
