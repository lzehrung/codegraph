import Parser, { Query, type Language } from "tree-sitter";

export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python";

export interface LanguageConfig {
  id: SupportedLanguage;
  parser: Parser;
  query: Query;
  captures: {
    name: string;
    blockPrefix: string;
    innerBlock: string;
    comments: string[];
  };
}

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

