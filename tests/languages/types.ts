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

/** Complete ordered chunk contract (count, names, and ranges). */
export type LanguageSample = LanguageSampleBase & {
  exactChunks: ChunkExpectation[];
};

export type GraphEdgeExpectation = { type: "file"; path: string } | { type: "external"; name: string };

export interface DependencyGraphExpectation {
  from: string; // Path relative to tests/samples/<language>/
  to: GraphEdgeExpectation;
  typeOnly?: boolean;
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

/** A single expected reference site, matched on normalized file + line identity. */
export interface ExactReferenceSite {
  file: string; // Path relative to tests/samples/<language>/
  line: number; // 1-based line number
}

type ExactReferencesExpectationBase = {
  name: string;
  file: string;
  line: number;
  column: number;
};

export type ExactReferencesExpectation =
  | (ExactReferencesExpectationBase & {
      expectedStatus?: "ok";
      references: [ExactReferenceSite, ...ExactReferenceSite[]];
    })
  | (ExactReferencesExpectationBase & {
      expectedStatus: "not_found";
      references?: never;
    });

/** Complete exact-set contracts for language parity assertions. */
export interface ExactParityExpectations {
  dependencyGraph?: DependencyGraphExpectation[];
  symbols?: ExactSymbolExpectation[];
  references?: ExactReferencesExpectation[];
}

export interface LanguageParityDefinition {
  sampleDir: string; // tests/samples/<sampleDir>/
  exact: ExactParityExpectations;
  absentDependencyGraph?: DependencyGraphExpectation[];
  goToDefinition?: GoToDefinitionExpectation[];
}

export interface LanguageTestDefinition {
  id: string;
  samples?: LanguageSample[];
  parity?: LanguageParityDefinition;
}
