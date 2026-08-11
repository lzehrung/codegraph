import { splitLargeBlockSimple } from "./chunkSplit.js";
import type { BlockCandidate, ChunkTokenizer, RangedChunk } from "./types.js";

export function mergeSmallChunks(
  chunks: RangedChunk[],
  minTokens: number,
  maxTokens: number,
  tokenizer: ChunkTokenizer,
): RangedChunk[] {
  if (!chunks.length) return [];

  const merged: RangedChunk[] = [];
  let index = 0;

  while (index < chunks.length) {
    let current = { ...chunks[index]! };
    index++;

    while (current.tokenCount < minTokens && index < chunks.length) {
      if (current.type === "misc" && current.tokenCount === 0) break;
      const next = chunks[index]!;

      // Chunks are only mergeable when their source ranges touch. In particular,
      // a child range must never be appended to a parent that already contains it.
      if (next.sourceStart < current.sourceEnd) {
        if (next.sourceEnd <= current.sourceEnd) {
          index++;
          continue;
        }
        break;
      }
      if (next.sourceStart !== current.sourceEnd) break;
      const combinedText = `${current.text}${next.text}`;
      const combinedTokens = tokenizer(combinedText);
      if (combinedTokens > maxTokens) break;

      const resolvedName = current.name ?? next.name;

      let type = current.type;
      if (current.type === "misc" && current.tokenCount === 0) {
        type = next.type;
      } else if (next.type === "misc" && next.tokenCount === 0) {
        type = current.type;
      } else if (current.type !== next.type) {
        type = `${current.type}+${next.type}`;
      }

      current = {
        ...current,
        endLine: next.endLine,
        sourceEnd: next.sourceEnd,
        text: combinedText,
        tokenCount: combinedTokens,
        type,
        ...(resolvedName !== undefined ? { name: resolvedName } : {}),
      };
      index++;
    }

    merged.push(current);
  }

  return merged;
}

export function fillGapsWithMiscChunks(
  chunks: RangedChunk[],
  source: string,
  languageId: string,
  filePath: string | undefined,
  tokenizer: ChunkTokenizer,
  minTokens: number,
  maxTokens: number,
  newlineOffsets: number[],
): RangedChunk[] {
  if (!source.length) return [];

  const result: RangedChunk[] = [];
  let currentOffset = 0;
  const sortedChunks = [...chunks].sort(
    (left, right) => left.sourceStart - right.sourceStart || right.sourceEnd - left.sourceEnd,
  );

  for (const chunk of sortedChunks) {
    if (chunk.sourceEnd <= currentOffset) continue;
    if (chunk.sourceStart < currentOffset) continue;

    if (chunk.sourceStart > currentOffset) {
      const appendedToPrevious = appendZeroTokenGap(
        result,
        source,
        currentOffset,
        chunk.sourceStart,
        tokenizer,
        maxTokens,
        newlineOffsets,
      );
      if (!appendedToPrevious) {
        pushMiscRange(
          result,
          source,
          currentOffset,
          chunk.sourceStart,
          languageId,
          filePath,
          tokenizer,
          maxTokens,
          newlineOffsets,
        );
      }
    }

    result.push(chunk);
    currentOffset = chunk.sourceEnd;
  }

  if (currentOffset < source.length) {
    const appendedToPrevious = appendZeroTokenGap(
      result,
      source,
      currentOffset,
      source.length,
      tokenizer,
      maxTokens,
      newlineOffsets,
    );
    if (!appendedToPrevious) {
      pushMiscRange(
        result,
        source,
        currentOffset,
        source.length,
        languageId,
        filePath,
        tokenizer,
        maxTokens,
        newlineOffsets,
      );
    }
  }

  return mergeSmallChunks(result, minTokens, maxTokens, tokenizer);
}

function appendZeroTokenGap(
  chunks: RangedChunk[],
  source: string,
  start: number,
  end: number,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  newlineOffsets: number[],
): boolean {
  if (!chunks.length || end <= start) return false;

  const text = source.slice(start, end);
  if (tokenizer(text) !== 0) return false;

  const previous = chunks[chunks.length - 1]!;
  const combinedText = `${previous.text}${text}`;
  const tokenCount = tokenizer(combinedText);
  if (tokenCount > maxTokens) return false;

  const [endRow] = locateLineFromOffset(newlineOffsets, Math.max(start, end - 1));
  chunks[chunks.length - 1] = {
    ...previous,
    endLine: endRow + 1,
    sourceEnd: end,
    text: combinedText,
    tokenCount,
  };
  return true;
}

function pushMiscRange(
  out: RangedChunk[],
  source: string,
  start: number,
  end: number,
  languageId: string,
  filePath: string | undefined,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  newlineOffsets: number[],
): void {
  if (end <= start) return;

  const [startRow] = locateLineFromOffset(newlineOffsets, start);
  const [endRow] = locateLineFromOffset(newlineOffsets, Math.max(start, end - 1));
  const block: BlockCandidate = {
    kind: "misc",
    startByte: start,
    endByte: end,
    startLine: startRow + 1,
    endLine: endRow + 1,
  };
  const text = source.slice(start, end);
  const tokenCount = tokenizer(text);

  if (tokenCount <= maxTokens) {
    out.push({
      id: "",
      languageId,
      type: "misc",
      startLine: block.startLine,
      endLine: block.endLine,
      text,
      tokenCount,
      sourceStart: start,
      sourceEnd: end,
      ...(filePath !== undefined ? { filePath } : {}),
    });
    return;
  }

  splitLargeBlockSimple(block, source, tokenizer, maxTokens, out, languageId, filePath);
}

function locateLineFromOffset(newlineOffsets: number[], offset: number): [number, number] {
  let low = 0;
  let high = newlineOffsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (newlineOffsets[mid]! < offset) low = mid + 1;
    else high = mid;
  }
  const previousNewline = low > 0 ? newlineOffsets[low - 1]! : -1;
  return [low, offset - previousNewline - 1];
}
