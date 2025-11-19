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
  expectedChunks: (chunks: any[]) => void; // Function to assert on chunks
}

export interface LanguageTestDefinition {
  id: string;
  samples: LanguageSample[];
}
