import type { Chunk } from "../../src/chunking/chunkFile.js";

export interface ChunkExpectation {
  type: string;
  name?: string;
  text?: string;
  tokenCount?: number;
  startLine?: number;
  endLine?: number;
}

export interface LanguageSample {
  name: string;
  source?: string;
  sourceFile?: string; // Path relative to tests/languages/samples/
  options?: {
    minTokens?: number;
    maxTokens?: number;
  };
  expectedChunks: (chunks: Chunk[]) => void; // Function to assert on chunks
}

export type GraphEdgeExpectation =
  | { type: "file"; path: string }
  | { type: "external"; name: string };

export interface DependencyGraphExpectation {
  from: string; // Path relative to tests/samples/<language>/
  to: GraphEdgeExpectation;
}

export interface SymbolExpectation {
  file: string; // Path relative to tests/samples/<language>/
  includes: Array<{ name: string; kind?: string }>;
  excludes?: string[];
}

export interface GoToDefinitionExpectation {
  name: string;
  file: string; // Path relative to tests/samples/<language>/
  line: number;
  column: number;
  expectedStatus?: "ok" | "not_found";
  expectedDefinition?: {
    file: string; // Path relative to tests/samples/<language>/
    line: number;
  };
}

export interface ReferencesExpectation {
  name: string;
  file: string; // Path relative to tests/samples/<language>/
  line: number;
  column: number;
  expectedStatus?: "ok" | "not_found";
  minimumCount?: number;
}

export interface LanguageParityDefinition {
  sampleDir: string; // tests/samples/<sampleDir>/
  dependencyGraph?: DependencyGraphExpectation[];
  symbols?: SymbolExpectation[];
  goToDefinition?: GoToDefinitionExpectation[];
  references?: ReferencesExpectation[];
}

export interface LanguageTestDefinition {
  id: string;
  samples?: LanguageSample[];
  parity?: LanguageParityDefinition;
}
