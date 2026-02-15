import type { Chunk } from "./chunkFile.js";

/**
 * Options for text file chunking (JSON, YAML, config files, etc.).
 */
export interface TextChunkOptions {
  /** Text content to chunk */
  source: string;
  /** Optional source file path for chunk IDs */
  filePath?: string | undefined;
  /** Language identifier (e.g., "json", "yaml", "text") */
  languageId?: string;
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
 * Splits text files into chunks respecting token budgets.
 * Useful for JSON, YAML, configuration files, and other non-code text content.
 *
 * @param opts Text chunking options
 * @returns Array of text chunks
 */
export function chunkTextFile(opts: TextChunkOptions): Chunk[] {
  const {
    source,
    filePath,
    languageId = "text",
    maxTokens = 400,
    tokenizer = defaultTokenizer,
  } = opts;

  const lines = source.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let chunkId = 0;

  let currentLines: string[] = [];
  let currentTokens = 0;
  let currentStartLine = 1;

  const pushChunk = () => {
    if (currentLines.length === 0) return;
    const text = currentLines.join("\n");
    const tokenCount = tokenizer(text);
    if (tokenCount === 0) return;
    const endLine = currentStartLine + currentLines.length - 1;
    chunks.push({
      id: `${languageId}:${filePath ?? "unknown"}:${chunkId++}`,
      languageId,
      type: "text",
      startLine: currentStartLine,
      endLine,
      text,
      tokenCount,
      ...(filePath !== undefined ? { filePath } : {}),
    });
    currentLines = [];
    currentTokens = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineTokens = tokenizer(line);
    if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      pushChunk();
      currentStartLine = i + 1;
    }
    currentLines.push(line);
    currentTokens += lineTokens;
  }

  pushChunk();

  return chunks;
}
