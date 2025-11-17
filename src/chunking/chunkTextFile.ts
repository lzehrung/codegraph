import type { Chunk } from "./chunkFile.js";

export interface TextChunkOptions {
  source: string;
  filePath?: string;
  languageId?: string; // e.g. "json", "yaml", "text"
  minTokens?: number;
  maxTokens?: number;
  tokenizer?: (text: string) => number;
}

function defaultTokenizer(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

export function chunkTextFile(opts: TextChunkOptions): Chunk[] {
  const {
    source,
    filePath,
    languageId = "text",
    minTokens = 150,
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

