import type { LanguageConfig } from "./languageConfig.js";
import { collectChunkBlockGroups } from "./chunkBlocks.js";
import { getChunkMatches } from "./chunkMatches.js";
import { withStableChunkIds } from "./chunkId.js";
import { fillGapsWithMiscChunks, mergeSmallChunks } from "./chunkMerge.js";
import { splitLargeBlockSimple, splitLargeBlockUsingInnerBlocks } from "./chunkSplit.js";
import { countWhitespaceTokens } from "./tokenizer.js";
import type { BlockCandidate, Chunk, ChunkTokenizer, RangedChunk } from "./types.js";

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

/**
 * Splits code into semantic chunks using Tree-sitter queries.
 * Nested declarations retain their hierarchical chunks: parents and children are
 * emitted independently. Every source byte is covered by at least one chunk, and
 * no individual chunk text repeats a source span internally.
 *
 * A parent that exceeds `maxTokens` is split at semantic inner boundaries (or
 * token boundaries when no such boundaries exist), while child declarations
 * remain available as their own chunks.
 * @param opts Chunking options
 * @returns Array of semantic chunks
 */
export function chunkFile(opts: ChunkFileOptions): Chunk[] {
  const { language, source, filePath, minTokens = 150, maxTokens = 400, tokenizer = countWhitespaceTokens } = opts;
  const matches = getChunkMatches(language, source, filePath);
  const newlineOffsets = collectNewlineOffsets(source);
  const { mainBlocks, innerBlocks, comments } = collectChunkBlockGroups(language, matches);
  const selectedBlocks = selectMainBlocks(mainBlocks);
  const preliminaryChunks: RangedChunk[] = [];

  const sortedInnerBlocks = [...innerBlocks].sort(
    (left, right) => left.startByte - right.startByte || left.endByte - right.endByte,
  );
  for (const block of selectedBlocks) {
    appendBlockChunks(
      block,
      sortedInnerBlocks,
      source,
      tokenizer,
      maxTokens,
      preliminaryChunks,
      language.id,
      newlineOffsets,
      filePath,
    );
  }

  for (const comment of selectStandaloneComments(comments, selectedBlocks)) {
    appendBlockChunks(
      comment,
      [],
      source,
      tokenizer,
      maxTokens,
      preliminaryChunks,
      language.id,
      newlineOffsets,
      filePath,
    );
  }

  preliminaryChunks.sort(
    (left, right) => left.sourceStart - right.sourceStart || right.sourceEnd - left.sourceEnd,
  );
  const mergedChunks = mergeSmallChunks(preliminaryChunks, minTokens, maxTokens, tokenizer);
  const completeChunks = fillGapsWithMiscChunks(
    mergedChunks,
    source,
    language.id,
    filePath,
    tokenizer,
    minTokens,
    maxTokens,
    newlineOffsets,
  );

  return withStableChunkIds(
    completeChunks.map(({ sourceStart: _sourceStart, sourceEnd: _sourceEnd, ...chunk }) => chunk),
    language.id,
    filePath,
  );
}

function appendBlockChunks(
  block: BlockCandidate,
  innerBlocks: BlockCandidate[],
  source: string,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  out: RangedChunk[],
  languageId: string,
  newlineOffsets: number[],
  filePath: string | undefined,
): void {
  const text = source.slice(block.startByte, block.endByte);
  const tokens = tokenizer(text);

  if (tokens <= maxTokens) {
    out.push({
      id: "",
      languageId,
      type: block.kind,
      startLine: block.startLine,
      endLine: block.endLine,
      text,
      tokenCount: tokens,
      sourceStart: block.startByte,
      sourceEnd: block.endByte,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(block.name !== undefined ? { name: block.name } : {}),
    });
    return;
  }

  const innerInRange = collectContainedInnerBlocks(innerBlocks, block);
  if (!innerInRange.length) {
    splitLargeBlockSimple(block, source, tokenizer, maxTokens, out, languageId, filePath);
    return;
  }

  splitLargeBlockUsingInnerBlocks(
    block,
    innerInRange,
    source,
    tokenizer,
    maxTokens,
    out,
    languageId,
    newlineOffsets,
    filePath,
  );
}

function collectContainedInnerBlocks(sortedInnerBlocks: BlockCandidate[], block: BlockCandidate): BlockCandidate[] {
  let low = 0;
  let high = sortedInnerBlocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedInnerBlocks[mid]!.startByte <= block.startByte) low = mid + 1;
    else high = mid;
  }

  const innerInRange: BlockCandidate[] = [];
  for (let index = low; index < sortedInnerBlocks.length; index++) {
    const innerBlock = sortedInnerBlocks[index]!;
    if (innerBlock.startByte >= block.endByte) break;
    if (innerBlock.endByte < block.endByte) innerInRange.push(innerBlock);
  }
  return innerInRange;
}

function selectMainBlocks(mainBlocks: BlockCandidate[]): BlockCandidate[] {
  const nodes = buildBlockTree(mainBlocks);
  const selected: BlockCandidate[] = [];

  const visit = (node: BlockNode) => {
    selected.push(node.block);
    for (const child of node.children) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return selected;
}

type BlockNode = {
  block: BlockCandidate;
  children: BlockNode[];
};

function buildBlockTree(mainBlocks: BlockCandidate[]): BlockNode[] {
  const sortedBlocks = deduplicateBlocks(mainBlocks).sort(
    (left, right) => left.startByte - right.startByte || right.endByte - left.endByte,
  );
  const roots: BlockNode[] = [];
  const stack: BlockNode[] = [];

  for (const block of sortedBlocks) {
    while (stack.length && stack[stack.length - 1]!.block.endByte <= block.startByte) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    const node: BlockNode = { block, children: [] };
    if (parent && block.endByte <= parent.block.endByte) {
      parent.children.push(node);
      stack.push(node);
      continue;
    }

    if (parent && block.startByte < parent.block.endByte) {
      continue;
    }

    roots.push(node);
    stack.push(node);
  }

  return roots;
}

function deduplicateBlocks(blocks: BlockCandidate[]): BlockCandidate[] {
  const byRange = new Map<string, BlockCandidate>();

  for (const block of blocks) {
    const key = `${block.startByte}:${block.endByte}`;
    const existing = byRange.get(key);
    if (!existing || (!existing.name && block.name) || (existing.name === block.name && block.kind < existing.kind)) {
      byRange.set(key, block);
    }
  }

  return [...byRange.values()];
}

function selectStandaloneComments(comments: BlockCandidate[], selectedBlocks: BlockCandidate[]): BlockCandidate[] {
  const selectedComments: BlockCandidate[] = [];

  for (const comment of deduplicateBlocks(comments)) {
    if (
      selectedBlocks.some(
        (block) => block.startByte <= comment.startByte && comment.endByte <= block.endByte,
      )
    ) {
      continue;
    }

    const previous = selectedComments[selectedComments.length - 1];
    if (previous && comment.startByte < previous.endByte) continue;
    selectedComments.push(comment);
  }

  return selectedComments;
}

function collectNewlineOffsets(source: string): number[] {
  const newlineOffsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") newlineOffsets.push(index);
  }
  return newlineOffsets;
}
