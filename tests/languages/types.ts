import type { Chunk } from "../../src/chunking/chunkFile.js";

export interface ChunkExpectation {
  type: string;
  name?: string;
  text?: string;
  tokenCount?: number;
  startLine?: number;
  endLine?: number;
}

type LanguageSampleBase = {
  name: string;
  source?: string;
  sourceFile?: string; // Path relative to tests/languages/samples/
  options?: {
    minTokens?: number;
    maxTokens?: number;
  };
};

/**
 * Prefer `exactChunks`: a complete ordered contract (count, names, ranges).
 * `expectedChunks` remains for unconverted subset-style suites.
 */
export type LanguageSample =
  | (LanguageSampleBase & {
      /** Preferred: exact chunk list matched in order on type/name/ranges. */
      exactChunks: ChunkExpectation[];
      expectedChunks?: undefined;
    })
  | (LanguageSampleBase & {
      exactChunks?: undefined;
      /** Subset/legacy callback assertions. */
      expectedChunks: (chunks: Chunk[]) => void;
    });

export type GraphEdgeExpectation =
  | { type: "file"; path: string }
  | { type: "external"; name: string };

export interface DependencyGraphExpectation {
  from: string; // Path relative to tests/samples/<language>/
  to: GraphEdgeExpectation;
  typeOnly?: boolean;
}

export interface SymbolExpectation {
  file: string; // Path relative to tests/samples/<language>/
  includes: Array<{ name: string; kind?: string }>;
  excludes?: string[];
}

/** Complete symbol multiset for a file (name + optional kind). */
export interface ExactSymbolExpectation {
  file: string;
  symbols: Array<{ name: string; kind?: string }>;
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

export interface ExactReferencesExpectation {
  name: string;
  file: string;
  line: number;
  column: number;
  expectedStatus?: "ok" | "not_found";
  /** Required when status is ok (default): precise reference count. */
  exactCount?: number;
}

/**
 * Preferred exact-set contracts. When present for a category, the runner asserts
 * equality (no extras / no missing) instead of subset presence checks.
 */
export interface ExactParityExpectations {
  dependencyGraph?: DependencyGraphExpectation[];
  symbols?: ExactSymbolExpectation[];
  references?: ExactReferencesExpectation[];
}

export interface LanguageParityDefinition {
  sampleDir: string; // tests/samples/<sampleDir>/
  /**
   * Preferred exact assertions for edges, symbols, and references.
   * Keep subset fields below only for suites not yet converted.
   */
  exact?: ExactParityExpectations;
  /** Subset mode: each listed edge must exist (extras allowed). */
  dependencyGraph?: DependencyGraphExpectation[];
  absentDependencyGraph?: DependencyGraphExpectation[];
  /** Subset mode: listed symbols must be present. */
  symbols?: SymbolExpectation[];
  goToDefinition?: GoToDefinitionExpectation[];
  /** Subset mode: reference count is a minimum. */
  references?: ReferencesExpectation[];
}

export interface LanguageTestDefinition {
  id: string;
  samples?: LanguageSample[];
  parity?: LanguageParityDefinition;
}
