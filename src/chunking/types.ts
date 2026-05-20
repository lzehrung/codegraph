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
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export type ChunkCapture = {
  name: string;
  text: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  nodeType: string;
};

export type ChunkMatch = {
  captures: ChunkCapture[];
};

export type ChunkTokenizer = (text: string) => number;
export type ChunkIdFactory = () => string;
