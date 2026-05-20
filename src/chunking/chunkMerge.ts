import type { Chunk, ChunkIdFactory, ChunkTokenizer } from "./types.js";

export function mergeSmallChunks(
  chunks: Chunk[],
  minTokens: number,
  maxTokens: number,
  tokenizer: ChunkTokenizer,
): Chunk[] {
  if (!chunks.length) return [];

  const merged: Chunk[] = [];
  let i = 0;

  while (i < chunks.length) {
    let current = { ...chunks[i]! };
    i++;

    while (current.tokenCount < minTokens && i < chunks.length) {
      const next = chunks[i]!;
      const combinedText = `${current.text}\n${next.text}`;
      const combinedTokens = tokenizer(combinedText);
      if (combinedTokens > maxTokens) break;

      const resolvedName = current.name ?? next.name;

      current = {
        ...current,
        endLine: next.endLine,
        text: combinedText,
        tokenCount: combinedTokens,
        type: current.type === next.type ? current.type : `${current.type}+${next.type}`,
        ...(resolvedName !== undefined ? { name: resolvedName } : {}),
      };
      i++;
    }

    merged.push(current);
  }

  return merged;
}

export function fillGapsWithMiscChunks(
  chunks: Chunk[],
  source: string,
  languageId: string,
  filePath: string | undefined,
  tokenizer: ChunkTokenizer,
  minTokens: number,
  maxTokens: number,
  makeChunkId: ChunkIdFactory,
): Chunk[] {
  if (!chunks.length) {
    const tokens = tokenizer(source);
    if (tokens === 0) return [];
    return [
      {
        id: makeChunkId(),
        languageId,
        type: "misc",
        startLine: 1,
        endLine: source.split(/\r?\n/).length,
        text: source,
        tokenCount: tokens,
        ...(filePath !== undefined ? { filePath } : {}),
      },
    ];
  }

  const byLine = source.split(/\r?\n/);
  const lastLine = byLine.length;
  const result: Chunk[] = [];
  let currentLine = 1;

  const pushMiscRange = (startLine: number, endLine: number) => {
    if (startLine > endLine) return;
    const text = byLine.slice(startLine - 1, endLine).join("\n");
    const tokens = tokenizer(text);
    if (tokens === 0) return;

    result.push({
      id: makeChunkId(),
      languageId,
      type: "misc",
      startLine,
      endLine,
      text,
      tokenCount: tokens,
      ...(filePath !== undefined ? { filePath } : {}),
    });
  };

  for (const chunk of chunks) {
    if (chunk.startLine > currentLine) {
      pushMiscRange(currentLine, chunk.startLine - 1);
    }
    result.push(chunk);
    currentLine = chunk.endLine + 1;
  }

  if (currentLine <= lastLine) {
    pushMiscRange(currentLine, lastLine);
  }

  const final = mergeSmallChunks(result, minTokens, maxTokens, tokenizer);
  return final;
}
