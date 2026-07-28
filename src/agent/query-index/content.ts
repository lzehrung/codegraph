import fs from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { LANG_CONFIGS } from "../../bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../../chunking/chunkFile.js";
import { supportForFile } from "../../languages.js";

export const MAX_QUERY_INDEX_TEXT_BYTES = 300_000;
export const QUERY_INDEX_NORMALIZER_VERSION = 1;
export const QUERY_INDEX_CHUNKER_VERSION = 2;

const CHUNK_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};

export type QueryTextChunk = {
  ordinal: number;
  kind: string;
  name?: string;
  text: string;
  normalizedText: string;
  startLine: number;
  endLine: number;
};

export type PreparedQueryTextChunk = Omit<QueryTextChunk, "text"> & {
  text: Uint8Array;
};

export type QueryIndexFileInput = {
  absolutePath: string;
  path: string;
  sourceIdentity: string;
};

export type PreparedQueryIndexFile = {
  path: string;
  sourceIdentity: string;
  surface: "code" | "docs" | "config";
  language?: string;
  byteLength: number;
  lineCount: number;
  chunks: PreparedQueryTextChunk[];
  sourceRead: boolean;
};

export function normalizeQuerySearchText(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function detectQueryIndexSurface(relativePath: string): "code" | "docs" | "config" {
  const lower = relativePath.toLowerCase();
  if (
    lower === "readme.md" ||
    lower.startsWith("docs/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".rst") ||
    lower.endsWith(".adoc") ||
    lower.endsWith(".txt")
  ) {
    return "docs";
  }
  if (
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".env") ||
    lower === "dockerfile" ||
    lower.startsWith(".github/")
  ) {
    return "config";
  }
  return "code";
}

export function buildQueryTextChunks(file: string, text: string): QueryTextChunk[] {
  const support = supportForFile(file);
  const languageId = support ? (CHUNK_LANGUAGE_ALIASES[support.id] ?? support.id) : undefined;
  const language = languageId ? LANG_CONFIGS[languageId] : undefined;
  if (language) {
    try {
      const chunks = chunkFile({
        language,
        source: text,
        filePath: file,
        minTokens: 1,
        maxTokens: 120,
      });
      if (chunks.length) {
        return chunks.map((chunk, ordinal) => ({
          ordinal,
          kind: chunk.type,
          ...(chunk.name ? { name: chunk.name } : {}),
          text: chunk.text,
          normalizedText: normalizeQuerySearchText([chunk.name, chunk.text].filter(Boolean).join(" ")),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        }));
      }
    } catch {
      // Keep the existing line-chunk fallback when semantic chunking is unavailable.
    }
  }

  return text.split(/\r?\n/).map((line, ordinal) => ({
    ordinal,
    kind: "line",
    text: line,
    normalizedText: normalizeQuerySearchText(line),
    startLine: ordinal + 1,
    endLine: ordinal + 1,
  }));
}

export async function prepareQueryIndexFile(input: QueryIndexFileInput): Promise<PreparedQueryIndexFile | null> {
  try {
    const stat = await fs.stat(input.absolutePath);
    const support = supportForFile(input.absolutePath);
    if (stat.size > MAX_QUERY_INDEX_TEXT_BYTES) {
      return {
        path: input.path,
        sourceIdentity: input.sourceIdentity,
        surface: detectQueryIndexSurface(input.path),
        ...(support ? { language: support.id } : {}),
        byteLength: stat.size,
        lineCount: 0,
        chunks: [],
        sourceRead: false,
      };
    }

    const text = await fs.readFile(input.absolutePath, "utf8");
    return {
      path: input.path,
      sourceIdentity: input.sourceIdentity,
      surface: detectQueryIndexSurface(input.path),
      ...(support ? { language: support.id } : {}),
      byteLength: stat.size,
      lineCount: text ? text.split(/\r?\n/).length : 0,
      chunks: buildQueryTextChunks(input.absolutePath, text).map((chunk) => ({
        ...chunk,
        text: brotliCompressSync(chunk.text, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        }),
      })),
      sourceRead: true,
    };
  } catch {
    return null;
  }
}
