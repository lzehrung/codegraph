import type { LanguageConfig } from "./languageConfig.js";
import { collectChunkBlockGroups } from "./chunkBlocks.js";
import { getChunkMatches } from "./chunkMatches.js";
import { fillGapsWithMiscChunks, mergeSmallChunks } from "./chunkMerge.js";
import { splitLargeBlockSimple, splitLargeBlockUsingInnerBlocks } from "./chunkSplit.js";
import type { Chunk, ChunkTokenizer } from "./types.js";

export type { Chunk } from "./types.js";

/**
 * Options for semantic code chunking.
 */
export interface ChunkFileOptions {
  /** Language configuration for parsing */
  language: LanguageConfig;
  /** Source code to chunk */
  source: string;
  /** Optional source file path for chunk IDs */
  filePath?: string | undefined;
  /** Minimum tokens per chunk (default: 150). Smaller chunks are merged. */
  minTokens?: number;
  /** Maximum tokens per chunk (default: 400). Larger chunks are split. */
  maxTokens?: number;
  /** Custom token counting function (default: whitespace-based) */
  tokenizer?: ChunkTokenizer | undefined;
}

function defaultTokenizer(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Splits code into semantic chunks using Tree-sitter queries.
 * Chunks respect token budgets and preserve semantic boundaries like functions, classes, and methods.
 *
 * @param opts Chunking options
 * @returns Array of semantic chunks
 */
export function chunkFile(opts: ChunkFileOptions): Chunk[] {
  const { language, source, filePath, minTokens = 150, maxTokens = 400, tokenizer = defaultTokenizer } = opts;
  const matches = getChunkMatches(language, source, filePath);
  const newlineOffsets = collectNewlineOffsets(source);
  const { mainBlocks, innerBlocks, comments } = collectChunkBlockGroups(language, matches);
  const preliminaryChunks: Chunk[] = [];
  let chunkIdCounter = 0;
  const makeChunkId = () => `${language.id}:${filePath ?? "unknown"}:${chunkIdCounter++}`;

  for (const block of mainBlocks) {
    const text = source.slice(block.startByte, block.endByte);
    const tokens = tokenizer(text);

    if (tokens <= maxTokens) {
      preliminaryChunks.push({
        id: makeChunkId(),
        languageId: language.id,
        type: block.kind,
        startLine: block.startLine,
        endLine: block.endLine,
        text,
        tokenCount: tokens,
        ...(filePath !== undefined ? { filePath } : {}),
        ...(block.name !== undefined ? { name: block.name } : {}),
      });
      continue;
    }

    const innerInRange = innerBlocks.filter((ib) => ib.startByte > block.startByte && ib.endByte < block.endByte);

    if (!innerInRange.length) {
      splitLargeBlockSimple(block, source, tokenizer, maxTokens, makeChunkId, preliminaryChunks, language.id, filePath);
    } else {
      splitLargeBlockUsingInnerBlocks(
        block,
        innerInRange,
        source,
        tokenizer,
        maxTokens,
        makeChunkId,
        preliminaryChunks,
        language.id,
        newlineOffsets,
        filePath,
      );
    }
  }

  for (const comment of comments) {
    const text = source.slice(comment.startByte, comment.endByte);
    const tokens = tokenizer(text);
    if (tokens === 0) continue;
    preliminaryChunks.push({
      id: makeChunkId(),
      languageId: language.id,
      type: comment.kind,
      startLine: comment.startLine,
      endLine: comment.endLine,
      text,
      tokenCount: tokens,
      ...(filePath !== undefined ? { filePath } : {}),
    });
  }

  preliminaryChunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const mergedChunks = mergeSmallChunks(preliminaryChunks, minTokens, maxTokens, tokenizer);

  return fillGapsWithMiscChunks(
    mergedChunks,
    source,
    language.id,
    filePath,
    tokenizer,
    minTokens,
    maxTokens,
    makeChunkId,
  );
}

function collectNewlineOffsets(source: string): number[] {
  const newlineOffsets: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") newlineOffsets.push(i);
  }
  return newlineOffsets;
}
