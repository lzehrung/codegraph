import Parser, { Query } from "tree-sitter";
import type { LanguageDefinition } from "../languages/types.js";
import { generateChunkingQuery } from "../languages/queryGenerator.js";

/** Supported programming languages for semantic chunking */
export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python";

/**
 * Configuration for a specific language's chunking behavior.
 * Contains Tree-sitter parser, query, and capture group definitions.
 */
export interface LanguageConfig {
  /** Language identifier */
  id: string;
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
 * @param def Language definition
 * @param filename Optional filename to select the correct grammar variant (e.g. .tsx)
 * @returns Language configuration object
 */
export function makeLanguageConfig(
  def: LanguageDefinition,
  filename?: string
): LanguageConfig {
  const parser = new Parser();
  const lang = def.grammar(filename);
  try {
    parser.setLanguage(lang);
  } catch (e) {
    console.error(`Error setting language for ${def.id}:`, e);
    console.log("Language object:", lang);
    throw e;
  }

  const queryText = generateChunkingQuery(def);
  // console.log(`Generated query for ${def.id}:`, queryText);
  let query: Query;
  try {
    query = new Query(lang, queryText);
  } catch (e) {
    console.error(`Error compiling query for language ${def.id}:`);
    console.error(queryText);
    throw e;
  }

  return {
    id: def.id,
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
