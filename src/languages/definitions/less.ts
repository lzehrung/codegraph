import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";
import { cssLikeGraph, cssLikeNodeTypes, cssLikeStructure } from "./cssLike.js";

export const LESS_DEF: LanguageDefinition = {
  id: "less",
  extensions: [".less"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-css"),
  structure: cssLikeStructure(),
  graph: cssLikeGraph(),
  nodeTypes: cssLikeNodeTypes(),
};
registerLanguage(LESS_DEF);
