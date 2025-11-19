import type { Chunk } from "./chunkFile.js";
import { chunkFile } from "./chunkFile.js";
import { chunkTextFile } from "./chunkTextFile.js";
import type { TextChunkOptions } from "./chunkTextFile.js";
import type { LanguageConfig } from "../bootstrap/treeSitterLanguages.js";
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

export interface ChunkSFCOptions {
  source: string;
  filePath?: string;
  framework: SFCFramework;
  minTokens?: number;
  maxTokens?: number;
  tokenizer?: (text: string) => number;
}

export function chunkSFCFile(opts: ChunkSFCOptions): Chunk[] {
  const {
    source,
    filePath,
    framework,
    minTokens = 150,
    maxTokens = 400,
    tokenizer,
  } = opts;
  const baseBlocks = parseSFC(source);
  const blocks = framework === "svelte"
    ? [...baseBlocks, ...buildSvelteTemplateBlocks(source, baseBlocks)]
    : baseBlocks;

  if (blocks.length === 0) {
    return chunkTextFile({
      source,
      filePath,
      languageId: framework,
      minTokens,
      maxTokens,
      tokenizer,
    });
  }

  const sortedBlocks = blocks.sort((a, b) => a.startLine - b.startLine);
  const chunks: Chunk[] = [];
  let chunkCounter = 0;
  const makeChunkId = () =>
    `${framework}:${filePath ?? "unknown"}:${chunkCounter++}`;

  for (const block of sortedBlocks) {
    const blockChunks = chunkBlock({
      block,
      framework,
      filePath,
      minTokens,
      maxTokens,
      tokenizer,
    });
    for (const chunk of blockChunks) {
      chunk.id = makeChunkId();
      chunk.startLine += block.startLine - 1;
      chunk.endLine += block.startLine - 1;
      chunk.type = `${block.type}:${chunk.type}`;
      chunk.filePath = filePath ?? chunk.filePath;
      chunks.push(chunk);
    }
  }

  return chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function chunkBlock(opts: {
  block: SFCBlock;
  framework: SFCFramework;
  filePath?: string;
  minTokens: number;
  maxTokens: number;
  tokenizer?: (text: string) => number;
}): Chunk[] {
  const { block, framework, filePath, minTokens, maxTokens, tokenizer } = opts;

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
        console.warn(
          `Warning: Semantic chunking failed for ${framework} ${block.type} block:`,
          error
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
    filePath?: string;
    minTokens: number;
    maxTokens: number;
    tokenizer?: (text: string) => number;
  }
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
  } as TextChunkOptions);
  return textChunks;
}

