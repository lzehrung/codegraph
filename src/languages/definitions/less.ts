import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { cssLikeGraph, cssLikeNodeTypes, cssLikeStructure } from "./css-like.js";
import { STYLESHEET_IMPACT_DEFINITIONS } from "./stylesheet-imports.js";

export const LESS_DEF: LanguageDefinition = {
  id: "less",
  extensions: [".less"],
  impactDefinitionTypes: STYLESHEET_IMPACT_DEFINITIONS,
  structure: cssLikeStructure(),
  graph: cssLikeGraph(),
  nodeTypes: cssLikeNodeTypes(),
};
registerLanguage(LESS_DEF);
