import type { BlockCandidate, Chunk, ChunkIdFactory, ChunkTokenizer } from "./types.js";

export function splitLargeBlockSimple(
  block: BlockCandidate,
  source: string,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  makeChunkId: ChunkIdFactory,
  out: Chunk[],
  languageId: string,
  filePath?: string,
): void {
  const text = source.slice(block.startByte, block.endByte);
  const lines = text.split(/\r?\n/);

  let currentStartLine = block.startLine;
  let currentLines: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (!currentLines.length) return;
    const chunkText = currentLines.join("\n");
    const tokenCount = tokenizer(chunkText);
    const endLine = currentStartLine + currentLines.length - 1;
    out.push({
      id: makeChunkId(),
      languageId,
      type: block.kind,
      startLine: currentStartLine,
      endLine,
      text: chunkText,
      tokenCount,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(block.name !== undefined ? { name: block.name } : {}),
    });
    currentLines = [];
    currentTokens = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineTokens = tokenizer(line);
    if (currentTokens + lineTokens > maxTokens && currentLines.length) {
      flush();
      currentStartLine = block.startLine + i;
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  flush();
}

export function splitLargeBlockUsingInnerBlocks(
  block: BlockCandidate,
  innerBlocks: BlockCandidate[],
  source: string,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  makeChunkId: ChunkIdFactory,
  out: Chunk[],
  languageId: string,
  newlineOffsets: number[],
  filePath?: string,
): void {
  const boundaries = new Set<number>();
  boundaries.add(block.startByte);
  boundaries.add(block.endByte);
  for (const ib of innerBlocks) {
    boundaries.add(ib.startByte);
    boundaries.add(ib.endByte);
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);

  type Segment = { startByte: number; endByte: number };
  const segments: Segment[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const startByte = sorted[i]!;
    const endByte = sorted[i + 1]!;
    if (endByte <= startByte) continue;
    const segText = source.slice(startByte, endByte);
    if (!segText.trim()) continue;
    segments.push({ startByte, endByte });
  }

  if (!segments.length) {
    splitLargeBlockSimple(block, source, tokenizer, maxTokens, makeChunkId, out, languageId, filePath);
    return;
  }

  let currentStart = segments[0]!.startByte;
  let currentEnd = segments[0]!.endByte;
  let currentText = source.slice(currentStart, currentEnd);
  let currentTokens = tokenizer(currentText);

  const pushChunk = () => {
    const chunkText = source.slice(currentStart, currentEnd);
    const tokenCount = tokenizer(chunkText);
    const [startRowZero] = locateLineAndColFromByte(newlineOffsets, currentStart);
    const [endRowZero] = locateLineAndColFromByte(newlineOffsets, currentEnd);

    out.push({
      id: makeChunkId(),
      languageId,
      type: block.kind,
      startLine: startRowZero + 1,
      endLine: endRowZero + 1,
      text: chunkText,
      tokenCount,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(block.name !== undefined ? { name: block.name } : {}),
    });
  };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const segText = source.slice(seg.startByte, seg.endByte);
    const segTokens = tokenizer(segText);

    if (currentTokens + segTokens > maxTokens && currentTokens > 0) {
      pushChunk();
      currentStart = seg.startByte;
      currentEnd = seg.endByte;
      currentText = segText;
      currentTokens = segTokens;
    } else {
      currentEnd = seg.endByte;
      currentText += segText;
      currentTokens += segTokens;
    }
  }

  pushChunk();
}

function locateLineAndColFromByte(newlineOffsets: number[], byteOffset: number): [number, number] {
  let low = 0;
  let high = newlineOffsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (newlineOffsets[mid]! < byteOffset) low = mid + 1;
    else high = mid;
  }
  const line = low;
  const prevNewline = low > 0 ? newlineOffsets[low - 1]! : -1;
  const col = byteOffset - prevNewline - 1;
  return [line, col];
}
