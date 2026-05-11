import fs from "node:fs";
import { toRange } from "../util.js";
import { getDeclarationAnchor } from "./declaration-anchor.js";
import { attemptParsePreparedFileContext, prepareFileForIndexingFromSource } from "./parse-context.js";
import { isLeadingTriviaNode, isLeadingTriviaTransparentNode } from "./symbol-range-trivia.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ProjectIndex, SymbolDef } from "./types.js";

export type TriviaMode = "exclude" | "leading-doc" | "leading-all";

export interface SymbolRangeOptions {
  trivia?: TriviaMode;
  source?: "cache" | "disk";
}

function hasBlankLineBetween(source: string, leftEnd: number, rightStart: number): boolean {
  return /\r?\n[ \t]*\r?\n/.test(source.slice(leftEnd, rightStart));
}

export function computeLeadingTriviaRange(
  node: SyntaxNodeLike,
  source: string,
  languageId: string,
  mode: TriviaMode,
): Range {
  const anchor = getDeclarationAnchor(node) ?? node;
  const bareRange = toRange(anchor);
  if (mode === "exclude") return bareRange;

  let firstTrivia: SyntaxNodeLike | null = null;
  let cursor: SyntaxNodeLike | null = anchor;
  let prev = cursor.previousNamedSibling ?? null;

  while (prev) {
    if (hasBlankLineBetween(source, prev.endIndex, cursor.startIndex)) {
      break;
    }
    if (isLeadingTriviaNode(languageId, prev.type, mode)) {
      firstTrivia = prev;
      cursor = prev;
      prev = prev.previousNamedSibling ?? null;
      continue;
    }
    if (isLeadingTriviaTransparentNode(languageId, prev.type)) {
      cursor = prev;
      prev = prev.previousNamedSibling ?? null;
      continue;
    }
    break;
  }

  if (!firstTrivia) return bareRange;
  return {
    start: toRange(firstTrivia).start,
    end: bareRange.end,
  };
}

function parseTreeForDef(
  index: ProjectIndex,
  def: SymbolDef,
  sourceMode: "cache" | "disk",
): { source: string; tree: SyntaxTreeLike; languageId: string } | null {
  const cached = sourceMode === "cache" ? index.parsed?.get(def.file) : undefined;
  if (cached?.sup && cached.tree) {
    return { source: cached.source, tree: cached.tree, languageId: cached.sup.id };
  }

  try {
    const source = fs.readFileSync(def.file, "utf8");
    const prepared = prepareFileForIndexingFromSource(def.file, source, index.nativeMode);
    const parsed = attemptParsePreparedFileContext(prepared).parsed;
    if (!parsed) return null;
    return { source: parsed.source, tree: parsed.tree, languageId: parsed.sup.id };
  } catch {
    return null;
  }
}

export function getSymbolRange(index: ProjectIndex, def: SymbolDef, opts?: SymbolRangeOptions): Range {
  const mode = opts?.trivia ?? "exclude";
  if (mode === "exclude") return def.range;
  const parsed = parseTreeForDef(index, def, opts?.source ?? "cache");
  if (!parsed) return def.range;
  const startIndex = def.range.start.index ?? 0;
  const endIndex = def.range.end.index ?? startIndex;
  const node = parsed.tree.rootNode.descendantForIndex(startIndex, endIndex);
  return computeLeadingTriviaRange(node, parsed.source, parsed.languageId, mode);
}
