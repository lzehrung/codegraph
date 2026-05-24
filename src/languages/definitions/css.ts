import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";
import { cssLikeGraph, cssLikeNodeTypes, cssLikeStructure } from "./cssLike.js";

export const CSS_DEF: LanguageDefinition = {
  id: "css",
  extensions: [".css"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-css"),
  structure: cssLikeStructure(),
  graph: cssLikeGraph(),
  nodeTypes: cssLikeNodeTypes(),
};
registerLanguage(CSS_DEF);
