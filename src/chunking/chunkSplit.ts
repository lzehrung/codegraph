import type { BlockCandidate, ChunkTokenizer, RangedChunk } from "./types.js";

export function splitLargeBlockSimple(
  block: BlockCandidate,
  source: string,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  out: RangedChunk[],
  languageId: string,
  filePath?: string,
): void {
  let currentStart = -1;
  let currentEnd = -1;
  let currentStartLine = block.startLine;
  let currentTokens = 0;

  const flush = () => {
    if (currentStart === -1) return;
    emitRangeWithinBudget(
      block,
      source,
      currentStart,
      currentEnd,
      currentStartLine,
      tokenizer,
      maxTokens,
      out,
      languageId,
      filePath,
    );
    currentStart = -1;
    currentEnd = -1;
    currentTokens = 0;
  };

  for (const line of lineRanges(source, block.startByte, block.endByte, block.startLine)) {
    const lineText = source.slice(line.start, line.end);
    const lineTokens = tokenizer(lineText);

    if (lineTokens > maxTokens) {
      flush();
      emitRangeWithinBudget(block, source, line.start, line.end, line.startLine, tokenizer, maxTokens, out, languageId, filePath);
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
}

export function splitLargeBlockUsingInnerBlocks(
  block: BlockCandidate,
  innerBlocks: BlockCandidate[],
  source: string,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  out: RangedChunk[],
  languageId: string,
  newlineOffsets: number[],
  filePath?: string,
): void {
  const boundaries = new Set<number>([block.startByte, block.endByte]);
  for (const innerBlock of innerBlocks) {
    boundaries.add(innerBlock.startByte);
    boundaries.add(innerBlock.endByte);
  }
  const sorted = Array.from(boundaries).sort((left, right) => left - right);

  if (sorted.length < 2) {
    splitLargeBlockSimple(block, source, tokenizer, maxTokens, out, languageId, filePath);
    return;
  }

  let currentStart = -1;
  let currentEnd = -1;
  let currentStartLine = block.startLine;
  let currentTokens = 0;

  const flush = () => {
    if (currentStart === -1) return;
    emitRangeWithinBudget(
      block,
      source,
      currentStart,
      currentEnd,
      currentStartLine,
      tokenizer,
      maxTokens,
      out,
      languageId,
      filePath,
    );
    currentStart = -1;
    currentEnd = -1;
    currentTokens = 0;
  };

  for (let index = 0; index < sorted.length - 1; index++) {
    const start = sorted[index]!;
    const end = sorted[index + 1]!;
    if (end <= start) continue;

    const segmentTokens = tokenizer(source.slice(start, end));
    const [segmentStartRow] = locateLineAndColFromByte(newlineOffsets, start);

    if (segmentTokens > maxTokens) {
      flush();
      emitRangeWithinBudget(block, source, start, end, segmentStartRow + 1, tokenizer, maxTokens, out, languageId, filePath);
      continue;
    }

    if (currentStart !== -1 && currentTokens + segmentTokens > maxTokens) {
      flush();
    }

    if (currentStart === -1) {
      currentStart = start;
      currentStartLine = segmentStartRow + 1;
    }
    currentEnd = end;
    currentTokens += segmentTokens;
  }

  flush();
}

/** Splits an oversized string on code-point boundaries using the configured tokenizer. */
export function splitTextWithinTokenBudget(text: string, tokenizer: ChunkTokenizer, maxTokens: number): string[] {
  if (!text.length) return [];
  if (tokenizer(text) <= maxTokens) return [text];

  const segments: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (tokenizer(text.slice(start)) <= maxTokens) {
      segments.push(text.slice(start));
      break;
    }

    let low = nextCodePointBoundary(text, start);
    let high = text.length;
    let end = start;

    while (low <= high) {
      const candidate = previousCodePointBoundary(text, low + ((high - low) >>> 1));
      if (candidate <= start) {
        low = nextCodePointBoundary(text, start);
        continue;
      }

      if (tokenizer(text.slice(start, candidate)) <= maxTokens) {
        end = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }

    if (end === start) {
      const next = nextCodePointBoundary(text, start);
      const singleCodePoint = text.slice(start, next);
      if (tokenizer(singleCodePoint) > maxTokens) {
        throw new RangeError("maxTokens is smaller than the configured tokenizer's smallest unit");
      }
      end = next;
    }

    segments.push(text.slice(start, end));
    start = end;
  }

  return segments;
}

function emitRangeWithinBudget(
  block: BlockCandidate,
  source: string,
  start: number,
  end: number,
  startLine: number,
  tokenizer: ChunkTokenizer,
  maxTokens: number,
  out: RangedChunk[],
  languageId: string,
  filePath: string | undefined,
): void {
  const text = source.slice(start, end);
  const tokenCount = tokenizer(text);
  if (tokenCount <= maxTokens) {
    pushRangedChunk(out, block, languageId, filePath, start, end, startLine, endLineForText(startLine, text), text, tokenCount);
    return;
  }

  let segmentStart = start;
  let segmentStartLine = startLine;
  for (const segment of splitTextWithinTokenBudget(text, tokenizer, maxTokens)) {
    const segmentEnd = segmentStart + segment.length;
    pushRangedChunk(
      out,
      block,
      languageId,
      filePath,
      segmentStart,
      segmentEnd,
      segmentStartLine,
      endLineForText(segmentStartLine, segment),
      segment,
      tokenizer(segment),
    );
    segmentStartLine += countLineBreaks(segment);
    segmentStart = segmentEnd;
  }
}

function pushRangedChunk(
  out: RangedChunk[],
  block: BlockCandidate,
  languageId: string,
  filePath: string | undefined,
  sourceStart: number,
  sourceEnd: number,
  startLine: number,
  endLine: number,
  text: string,
  tokenCount: number,
): void {
  out.push({
    id: "",
    languageId,
    type: block.kind,
    startLine,
    endLine,
    text,
    tokenCount,
    sourceStart,
    sourceEnd,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(block.name !== undefined ? { name: block.name } : {}),
  });
}

function lineRanges(
  source: string,
  start: number,
  end: number,
  startLine: number,
): Array<{ start: number; end: number; startLine: number }> {
  const ranges: Array<{ start: number; end: number; startLine: number }> = [];
  let rangeStart = start;
  let line = startLine;

  for (let offset = start; offset < end; offset++) {
    if (source[offset] !== "\n") continue;
    ranges.push({ start: rangeStart, end: offset + 1, startLine: line });
    rangeStart = offset + 1;
    line++;
  }

  if (rangeStart < end) {
    ranges.push({ start: rangeStart, end, startLine: line });
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

function nextCodePointBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function previousCodePointBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length || text.charCodeAt(index) < 0xdc00 || text.charCodeAt(index) > 0xdfff) {
    return index;
  }
  return index - 1;
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
