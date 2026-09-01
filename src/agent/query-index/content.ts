import fs from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { LANG_CONFIGS } from "../../bootstrap/treeSitterLanguages.js";
import { chunkFile } from "../../chunking/chunkFile.js";
import { supportForFile, supportForFileWithSource, type LanguageSupport } from "../../languages.js";

export const MAX_QUERY_INDEX_TEXT_BYTES = 300_000;
export const QUERY_INDEX_NORMALIZER_VERSION = 2;
export const QUERY_INDEX_CHUNKER_VERSION = 2;

const CHUNK_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};
function compressQueryText(text: string): Uint8Array {
  const compressed = brotliCompressSync(text, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  // Worker results cross a structured clone, which drops the Buffer prototype. Normalize the
  // in-process result too so a batch prepared either way produces identical rows.
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

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
  normalizedText: Uint8Array;
  chunks: PreparedQueryTextChunk[];
  sourceRead: boolean;
};

export function normalizeQuerySearchText(input: string): string {
  return input
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_]+/gu, " ")
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
  return chunkQueryText(file, text, supportForFileWithSource(file, text));
}

function chunkQueryText(file: string, text: string, support: LanguageSupport | undefined): QueryTextChunk[] {
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
    if (stat.size > MAX_QUERY_INDEX_TEXT_BYTES) {
      // Nothing was read, so an unmapped `.h` header still needs its own sample to report `cpp`.
      const support = supportForFile(input.absolutePath);
      return {
        path: input.path,
        sourceIdentity: input.sourceIdentity,
        surface: detectQueryIndexSurface(input.path),
        ...(support ? { language: support.id } : {}),
        byteLength: stat.size,
        lineCount: 0,
        normalizedText: compressQueryText(""),
        chunks: [],
        sourceRead: false,
      };
    }

    const text = await fs.readFile(input.absolutePath, "utf8");
    const support = supportForFileWithSource(input.absolutePath, text);
    return {
      path: input.path,
      sourceIdentity: input.sourceIdentity,
      surface: detectQueryIndexSurface(input.path),
      ...(support ? { language: support.id } : {}),
      byteLength: stat.size,
      lineCount: text ? text.split(/\r?\n/).length : 0,
      normalizedText: compressQueryText(normalizeQuerySearchText(text)),
      chunks: chunkQueryText(input.absolutePath, text, support).map((chunk) => ({
        ...chunk,
        text: compressQueryText(chunk.text),
      })),
      sourceRead: true,
    };
  } catch {
    return null;
  }
}
