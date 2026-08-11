import type { Chunk } from "./chunkFile.js";
import { chunkFile } from "./chunkFile.js";
import { chunkTextFile } from "./chunkTextFile.js";
import { withStableChunkIds } from "./chunkId.js";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import {
  parseSFC,
  buildSvelteTemplateBlocks,
  scriptLanguageIdForBlock,
  styleLanguageKey,
  templateLanguageKey,
  type SFCBlock,
  type SFCFramework,
} from "../languages/sfc.js";
import { logWithLevel, type LogLevel } from "../logging.js";

export interface ChunkSFCOptions {
  source: string;
  filePath?: string | undefined;
  framework: SFCFramework;
  minTokens?: number;
  maxTokens?: number;
  tokenizer?: ((text: string) => number) | undefined;
  logLevel?: LogLevel;
}

/**
 * Chunks an SFC while preserving whole-file coverage: every source byte belongs
 * to at least one semantic block chunk or bounded misc chunk.
 */
export function chunkSFCFile(opts: ChunkSFCOptions): Chunk[] {
  const { source, filePath, framework, minTokens = 150, maxTokens = 400, tokenizer, logLevel } = opts;
  const baseBlocks = parseSFC(source);
  const blocks =
    framework === "svelte" ? [...baseBlocks, ...buildSvelteTemplateBlocks(source, baseBlocks)] : baseBlocks;

  if (!blocks.length) {
    return chunkTextFile({
      source,
      filePath,
      languageId: framework,
      minTokens,
      maxTokens,
      tokenizer,
    });
  }

  const sortedBlocks = blocks.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const chunks: Chunk[] = [];

  for (const block of sortedBlocks) {
    const blockChunks = chunkBlock({
      block,
      framework,
      filePath,
      minTokens,
      maxTokens,
      tokenizer,
      ...(logLevel ? { logLevel } : {}),
    });
    for (const chunk of blockChunks) {
      chunks.push({
        ...chunk,
        id: "",
        startLine: chunk.startLine + block.startLine - 1,
        endLine: chunk.endLine + block.startLine - 1,
        type: `${block.type}:${chunk.type}`,
        filePath: filePath ?? chunk.filePath,
      });
    }
  }

  // Semantic and text block chunkers cover every byte of non-blank block content.
  // Keep each block's wrappers separate from inter-block text so inserting a
  // preceding block cannot change an unchanged block's content-addressed misc IDs.
  let coveredUntil = 0;
  for (const block of sortedBlocks) {
    if (block.blockStart < coveredUntil) continue;
    appendMiscChunks(
      chunks,
      source,
      coveredUntil,
      block.blockStart,
      framework,
      filePath,
      minTokens,
      maxTokens,
      tokenizer,
    );
    if (block.content.trim()) {
      appendMiscChunks(
        chunks,
        source,
        block.blockStart,
        block.startOffset,
        framework,
        filePath,
        minTokens,
        maxTokens,
        tokenizer,
      );
      appendMiscChunks(
        chunks,
        source,
        block.endOffset,
        block.blockEnd,
        framework,
        filePath,
        minTokens,
        maxTokens,
        tokenizer,
      );
    } else {
      appendMiscChunks(
        chunks,
        source,
        block.blockStart,
        block.blockEnd,
        framework,
        filePath,
        minTokens,
        maxTokens,
        tokenizer,
      );
    }
    coveredUntil = block.blockEnd;
  }
  appendMiscChunks(chunks, source, coveredUntil, source.length, framework, filePath, minTokens, maxTokens, tokenizer);

  const sortedChunks = chunks.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  return withStableChunkIds(sortedChunks, framework, filePath);
}

function appendMiscChunks(
  chunks: Chunk[],
  source: string,
  startOffset: number,
  endOffset: number,
  framework: SFCFramework,
  filePath: string | undefined,
  minTokens: number,
  maxTokens: number,
  tokenizer: ((text: string) => number) | undefined,
): void {
  if (endOffset <= startOffset) return;
  const startLine = lineForOffset(source, startOffset);
  const gapChunks = chunkTextFile({
    source: source.slice(startOffset, endOffset),
    filePath,
    languageId: framework,
    minTokens,
    maxTokens,
    tokenizer,
  });
  for (const chunk of gapChunks) {
    chunks.push({
      ...chunk,
      id: "",
      startLine: chunk.startLine + startLine - 1,
      endLine: chunk.endLine + startLine - 1,
      type: "misc",
      filePath: filePath ?? chunk.filePath,
    });
  }
}

function lineForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") line++;
  }
  return line;
}

function chunkBlock(opts: {
  block: SFCBlock;
  framework: SFCFramework;
  filePath?: string | undefined;
  minTokens: number;
  maxTokens: number;
  tokenizer?: ((text: string) => number) | undefined;
  logLevel?: LogLevel;
}): Chunk[] {
  const { block, framework, filePath, minTokens, maxTokens, tokenizer, logLevel } = opts;

  if (!block.content.trim()) {
    return [];
  }

  const languageKey = selectLanguageKey(block, framework);
  if (languageKey) {
    const config = LANG_CONFIGS[languageKey];
    if (config) {
      try {
        return chunkFile({
          language: config,
          source: block.content,
          filePath,
          minTokens,
          maxTokens,
          tokenizer,
        });
      } catch (error) {
        logWithLevel(
          logLevel,
          "warn",
          `Warning: Semantic chunking failed for ${framework} ${block.type} block:`,
          error,
        );
      }
    }
  }

  return chunkTextBlock(block, {
    framework,
    filePath,
    minTokens,
    maxTokens,
    tokenizer,
  });
}

function selectLanguageKey(block: SFCBlock, framework: SFCFramework): string | null {
  if (block.type === "script") {
    const langId = scriptLanguageIdForBlock(block);
    if (langId === "ts") return "typescript";
    if (langId === "tsx") return "tsx";
    return "javascript";
  }
  if (block.type === "style") {
    const styleKey = styleLanguageKey(block);
    if (!styleKey) return null;
    return styleKey;
  }
  if (block.type === "template") {
    return templateLanguageKey(framework);
  }
  return null;
}

function chunkTextBlock(
  block: SFCBlock,
  opts: {
    framework: SFCFramework;
    filePath?: string | undefined;
    minTokens: number;
    maxTokens: number;
    tokenizer?: ((text: string) => number) | undefined;
  },
): Chunk[] {
  const { framework, filePath, minTokens, maxTokens, tokenizer } = opts;
  const languageId = `${framework}-${block.type}`;
  const textChunks = chunkTextFile({
    source: block.content,
    filePath,
    languageId,
    minTokens,
    maxTokens,
    tokenizer,
  });
  return textChunks;
}
