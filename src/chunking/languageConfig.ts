import type { LanguageDefinition } from "../languages/types.js";
import { generateChunkingQuery } from "../languages/queryGenerator.js";

/** Supported programming languages for semantic chunking */
export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "tsx"
  | "python"
  | "php";

/**
 * Configuration for a specific language's chunking behavior.
 * Contains Tree-sitter parser, query, and capture group definitions.
 */
export interface LanguageConfig {
  /** Language identifier */
  id: string;
  /** Codegraph language id used by native query execution */
  supportId: string;
  /** Generated query text used for chunk extraction */
  queryText: string;
  /** Original language definition used for JS fallback */
  definition: LanguageDefinition;
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
 * @param def Language definition
 * @param publicId Public language id exposed by chunking output and lookup tables
 * @returns Language configuration object
 */
export function makeLanguageConfig(
  def: LanguageDefinition,
  publicId = def.id,
): LanguageConfig {
  const queryText = generateChunkingQuery(def);

  return {
    id: publicId,
    supportId: def.id,
    queryText,
    definition: def,
    captures: {
      name: "chunk.name",
      blockPrefix: "chunk.block.",
      innerBlock: "chunk.block.inner",
      comments: ["chunk.comment", "chunk.docstring"],
    },
  };
}
