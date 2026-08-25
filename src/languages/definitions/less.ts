import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { cssLikeGraph, cssLikeNodeTypes, cssLikeStructure } from "./cssLike.js";

export const LESS_DEF: LanguageDefinition = {
  id: "less",
  extensions: [".less"],
  structure: cssLikeStructure(),
  graph: cssLikeGraph(),
  nodeTypes: cssLikeNodeTypes(),
};
registerLanguage(LESS_DEF);
