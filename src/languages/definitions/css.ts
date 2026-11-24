import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { cssLikeGraph, cssLikeNodeTypes, cssLikeStructure } from "./css-like.js";
import { STYLESHEET_IMPACT_DEFINITIONS } from "./stylesheet-imports.js";

export const CSS_DEF: LanguageDefinition = {
  id: "css",
  extensions: [".css"],
  impactDefinitionTypes: STYLESHEET_IMPACT_DEFINITIONS,
  structure: cssLikeStructure(),
  graph: cssLikeGraph(),
  nodeTypes: cssLikeNodeTypes(),
};
registerLanguage(CSS_DEF);
