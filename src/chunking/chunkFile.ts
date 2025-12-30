import type { QueryMatch, SyntaxNode } from "tree-sitter";

import type { LanguageConfig } from "./languageConfig.js";

/**
 * Represents a semantic chunk of code or text, ready for LLM processing or vector embeddings.
 */
export interface Chunk {
  /** Unique identifier for the chunk */
  id: string;
  /** Language identifier (e.g., "javascript", "typescript", "python") */
  languageId: string;
  /** Optional source file path */
  filePath?: string | undefined;
  /** Chunk type (e.g., "function", "class", "method", "import", "misc") */
  type: string;
  /** Symbol name if applicable (e.g., function name, class name) */
  name?: string;
  /** 1-based start line number */
  startLine: number;
  /** 1-based end line number */
  endLine: number;
  /** The chunk content text */
  text: string;
  /** Estimated token count */
  tokenCount: number;
}

interface BlockCandidate {
  kind: string;
  name?: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

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
  tokenizer?: ((text: string) => number) | undefined;
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
  const {
    language,
    source,
    filePath,
    minTokens = 150,
    maxTokens = 400,
    tokenizer = defaultTokenizer,
  } = opts;

  const tree = language.parser.parse(source);
  const root = tree.rootNode;
  const matches: QueryMatch[] = language.query.matches(root);

  const newlineOffsets: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") newlineOffsets.push(i);
  }

  const mainBlocks: BlockCandidate[] = [];
  const innerBlocks: BlockCandidate[] = [];
  const comments: BlockCandidate[] = [];

  for (const match of matches) {
    let nameNode: SyntaxNode | undefined;
    let blockNode: SyntaxNode | undefined;
    let innerNode: SyntaxNode | undefined;
    let blockKind: string | undefined;

    for (const capture of match.captures) {
      const { name, node } = capture;

      if (name === language.captures.name) {
        nameNode = node;
      }

      if (language.captures.comments.includes(name)) {
        const startRow = node.startPosition.row;
        const endRow = node.endPosition.row;
        comments.push({
          kind: name === "chunk.docstring" ? "docstring" : "comment",
          startByte: node.startIndex,
          endByte: node.endIndex,
          startLine: startRow + 1,
          endLine: endRow + 1,
        });
      }

      if (name === language.captures.innerBlock) {
        innerNode = node;
      }

      if (
        name.startsWith(language.captures.blockPrefix) &&
        name !== language.captures.innerBlock
      ) {
        blockNode = node;
        blockKind =
          name.slice(language.captures.blockPrefix.length) || node.type;
      }
    }

    if (innerNode) {
      const startRow = innerNode.startPosition.row;
      const endRow = innerNode.endPosition.row;
      innerBlocks.push({
        kind: "inner",
        startByte: innerNode.startIndex,
        endByte: innerNode.endIndex,
        startLine: startRow + 1,
        endLine: endRow + 1,
      });
    }

    if (blockNode) {
      const startRow = blockNode.startPosition.row;
      const endRow = blockNode.endPosition.row;
      const candidate: BlockCandidate = {
        kind: blockKind ?? "block",
        startByte: blockNode.startIndex,
        endByte: blockNode.endIndex,
        startLine: startRow + 1,
        endLine: endRow + 1,
      };

      if (nameNode) {
        candidate.name = nameNode.text;
      }

      mainBlocks.push(candidate);
    }
  }

  mainBlocks.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  innerBlocks.sort(
    (a, b) => a.startByte - b.startByte || a.endByte - b.endByte,
  );
  comments.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);

  const preliminaryChunks: Chunk[] = [];
  let chunkIdCounter = 0;
  const makeChunkId = () =>
    `${language.id}:${filePath ?? "unknown"}:${chunkIdCounter++}`;

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

    const innerInRange = innerBlocks.filter(
      (ib) => ib.startByte > block.startByte && ib.endByte < block.endByte,
    );

    if (innerInRange.length === 0) {
      splitLargeBlockSimple(
        block,
        source,
        tokenizer,
        maxTokens,
        makeChunkId,
        preliminaryChunks,
        language.id,
        filePath,
      );
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

  for (const c of comments) {
    const text = source.slice(c.startByte, c.endByte);
    const tokens = tokenizer(text);
    if (tokens === 0) continue;
    preliminaryChunks.push({
      id: makeChunkId(),
      languageId: language.id,
      type: c.kind,
      startLine: c.startLine,
      endLine: c.endLine,
      text,
      tokenCount: tokens,
      ...(filePath !== undefined ? { filePath } : {}),
    });
  }

  preliminaryChunks.sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );

  const mergedChunks = mergeSmallChunks(
    preliminaryChunks,
    minTokens,
    maxTokens,
    tokenizer,
  );

  const finalChunks = fillGapsWithMiscChunks(
    mergedChunks,
    source,
    language.id,
    filePath,
    tokenizer,
    minTokens,
    maxTokens,
    makeChunkId,
  );

  return finalChunks;
}

function splitLargeBlockSimple(
  block: BlockCandidate,
  source: string,
  tokenizer: (text: string) => number,
  maxTokens: number,
  makeChunkId: () => string,
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
    if (currentLines.length === 0) return;
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
    if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      flush();
      currentStartLine = block.startLine + i;
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  flush();
}

function splitLargeBlockUsingInnerBlocks(
  block: BlockCandidate,
  innerBlocks: BlockCandidate[],
  source: string,
  tokenizer: (text: string) => number,
  maxTokens: number,
  makeChunkId: () => string,
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

  if (segments.length === 0) {
    splitLargeBlockSimple(
      block,
      source,
      tokenizer,
      maxTokens,
      makeChunkId,
      out,
      languageId,
      filePath,
    );
    return;
  }

  let currentStart = segments[0]!.startByte;
  let currentEnd = segments[0]!.endByte;
  let currentText = source.slice(currentStart, currentEnd);
  let currentTokens = tokenizer(currentText);

  const pushChunk = () => {
    const chunkText = source.slice(currentStart, currentEnd);
    const tokenCount = tokenizer(chunkText);
    const [startRowZero] = locateLineAndColFromByte(
      newlineOffsets,
      currentStart,
    );
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

function locateLineAndColFromByte(
  newlineOffsets: number[],
  byteOffset: number,
): [number, number] {
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

function mergeSmallChunks(
  chunks: Chunk[],
  minTokens: number,
  maxTokens: number,
  tokenizer: (text: string) => number,
): Chunk[] {
  if (chunks.length === 0) return [];

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
        type:
          current.type === next.type
            ? current.type
            : `${current.type}+${next.type}`,
        ...(resolvedName !== undefined ? { name: resolvedName } : {}),
      };
      i++;
    }

    merged.push(current);
  }

  return merged;
}

function fillGapsWithMiscChunks(
  chunks: Chunk[],
  source: string,
  languageId: string,
  filePath: string | undefined,
  tokenizer: (text: string) => number,
  minTokens: number,
  maxTokens: number,
  makeChunkId: () => string,
): Chunk[] {
  if (chunks.length === 0) {
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
