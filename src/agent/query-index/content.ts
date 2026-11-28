import fs from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { chunkLanguageKey, LANG_CONFIGS } from "../../bootstrap/tree-sitter-languages.js";
import { chunkFile } from "../../chunking/chunk-file.js";
import { supportForFile, supportForFileWithSource, type LanguageSupport } from "../../languages.js";

export const MAX_QUERY_INDEX_TEXT_BYTES = 300_000;
export const QUERY_INDEX_NORMALIZER_VERSION = 2;
export const QUERY_INDEX_CHUNKER_VERSION = 3;

function compressQueryText(input: string | Uint8Array): Uint8Array {
  const compressed = brotliCompressSync(input, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  // A small result is a view into a 16 KiB output buffer, which a worker's structured clone would copy whole. The copy
  // keeps only the compressed bytes, and as a plain Uint8Array it has the type a worker result arrives with, so a batch
  // prepared either way produces identical rows.
  return new Uint8Array(compressed);
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

/** A chunk as stored: its text is the UTF-8 byte range `[textStart, textEnd)` of its file's decompressed chunk text. */
export type PreparedQueryTextChunk = Omit<QueryTextChunk, "text"> & {
  textStart: number;
  textEnd: number;
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
  /** The compressed UTF-8 text of every chunk of the file, in ordinal order. */
  chunkText: Uint8Array;
  chunks: PreparedQueryTextChunk[];
  sourceRead: boolean;
};

/**
 * Compresses a file's chunk texts as one block, one compressor per file rather than one per chunk. Each chunk's text is
 * encoded on its own into its byte range, so decoding the range returns exactly what encoding that text alone would.
 */
export function packQueryTextChunks(
  chunks: readonly QueryTextChunk[],
): Pick<PreparedQueryIndexFile, "chunkText" | "chunks"> {
  let byteLength = 0;
  for (const chunk of chunks) byteLength += Buffer.byteLength(chunk.text, "utf8");
  const block = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  const prepared = chunks.map(({ text, ...chunk }) => {
    const textStart = offset;
    offset += block.write(text, offset, "utf8");
    return { ...chunk, textStart, textEnd: offset };
  });
  return { chunkText: compressQueryText(block), chunks: prepared };
}

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
  const languageId = support ? chunkLanguageKey(support.id) : undefined;
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
        ...packQueryTextChunks([]),
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
      ...packQueryTextChunks(chunkQueryText(input.absolutePath, text, support)),
      sourceRead: true,
    };
  } catch {
    return null;
  }
}
