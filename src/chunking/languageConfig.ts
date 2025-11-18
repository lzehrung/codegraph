import Parser, { Query, type Language } from "tree-sitter";

/** Supported programming languages for semantic chunking */
export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python";

/**
 * Configuration for a specific language's chunking behavior.
 * Contains Tree-sitter parser, query, and capture group definitions.
 */
export interface LanguageConfig {
  /** Language identifier */
  id: SupportedLanguage;
  /** Tree-sitter parser instance */
  parser: Parser;
  /** Compiled Tree-sitter query for chunk extraction */
  query: Query;
  /** Capture group names used in queries */
  captures: {
    /** Capture name for symbol names (e.g., function names) */
    name: string;
    /** Prefix for semantic block captures */
    blockPrefix: string;
    /** Capture name for inner control-flow blocks */
    innerBlock: string;
    /** Capture names for comments and docstrings */
    comments: string[];
  };
}

/**
 * Creates a language configuration for semantic chunking.
 *
 * @param id Language identifier
 * @param tsLanguage Tree-sitter language grammar
 * @param queryText Tree-sitter query string for chunk extraction
 * @returns Language configuration object
 */
export function makeLanguageConfig(
  id: SupportedLanguage,
  tsLanguage: Language,
  queryText: string,
): LanguageConfig {
  const parser = new Parser();
  parser.setLanguage(tsLanguage);
  const query = new Query(tsLanguage, queryText);

  return {
    id,
    parser,
    query,
    captures: {
      name: "chunk.name",
      blockPrefix: "chunk.block.",
      innerBlock: "chunk.block.inner",
      comments: ["chunk.comment", "chunk.docstring"],
    },
  };
}

