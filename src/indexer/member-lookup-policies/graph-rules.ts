import { cGraphHooks } from "./c-graph.js";
import { cppGraphHooks } from "./cpp-graph.js";
import { csharpGraphHooks } from "./csharp-graph.js";
import { javaGraphHooks } from "./java-graph.js";
import { phpGraphHooks } from "./php-graph.js";
import { swiftGraphHooks } from "./swift-graph.js";
import { kotlinGraphHooks } from "./kotlin-graph.js";
import { rubyGraphHooks } from "./ruby-graph.js";
import { typescriptGraphHooks } from "./typescript-graph.js";
import { goGraphHooks } from "./go-graph.js";
import { rustGraphHooks } from "./rust-graph.js";
import { zigGraphHooks } from "./zig-graph.js";
import type { GraphHooks } from "./types.js";

const NO_GRAPH_RULES: GraphHooks = {};
const GRAPH_RULES: Readonly<Record<string, GraphHooks>> = {
  c: cGraphHooks,
  cpp: cppGraphHooks,
  csharp: csharpGraphHooks,
  java: javaGraphHooks,
  php: phpGraphHooks,
  swift: swiftGraphHooks,
  kotlin: kotlinGraphHooks,
  ruby: rubyGraphHooks,
  ts: typescriptGraphHooks,
  tsx: typescriptGraphHooks,
  go: goGraphHooks,
  rust: rustGraphHooks,
  zig: zigGraphHooks,
};

/** Leaf selection for graph consumers that the full member-policy registry depends on. */
export function graphRulesFor(languageId: string): GraphHooks {
  return GRAPH_RULES[languageId] ?? NO_GRAPH_RULES;
}
