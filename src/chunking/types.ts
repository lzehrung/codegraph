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

export interface BlockCandidate {
  kind: string;
  name?: string;
  /** Start offset in JS string index units (UTF-16 code units). */
  startByte: number;
  /** End offset in JS string index units (UTF-16 code units). */
  endByte: number;
  startLine: number;
  endLine: number;
}

export type ChunkCapture = {
  name: string;
  text: string;
  /** Start offset in JS string index units (UTF-16 code units). */
  startByte: number;
  /** End offset in JS string index units (UTF-16 code units). */
  endByte: number;
  startLine: number;
  endLine: number;
  nodeType: string;
};

export type ChunkMatch = {
  captures: ChunkCapture[];
};

export type ChunkTokenizer = (text: string) => number;

/** Internal source offsets used while assembling non-overlapping chunks. */
export type RangedChunk = Chunk & {
  sourceStart: number;
  sourceEnd: number;
};
