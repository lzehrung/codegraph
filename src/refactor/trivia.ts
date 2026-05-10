import fs from "node:fs";
import { parseWithJsLanguage } from "../jsFallback.js";
import { supportForFile } from "../languages.js";
import { toRange } from "../util.js";
import { isLeadingTriviaNode, isLeadingTriviaTransparentNode } from "./trivia-table.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { ProjectIndex, SymbolDef } from "../indexer/types.js";
import type { Range } from "../types.js";
import type { SymbolRangeOptions, TriviaMode } from "./types.js";

const declarationNameTypes = new Set(["identifier", "type_identifier", "property_identifier"]);

export function getDeclarationAnchor(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  if (!node) return null;
  let target = node;
  if (declarationNameTypes.has(target.type) && target.parent) {
    target = target.parent;
  }
  if (target.type === "variable_declarator" && target.parent) {
    target = target.parent;
  }
  if (target.parent?.type === "export_statement") {
    target = target.parent;
  }
  return target;
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

function parseTreeForDef(index: ProjectIndex, def: SymbolDef): { source: string; tree: SyntaxTreeLike; languageId: string } | null {
  const cached = index.parsed?.get(def.file);
  if (cached?.sup && cached.tree) {
    return { source: cached.source, tree: cached.tree, languageId: cached.sup.id };
  }

  const support = supportForFile(def.file);
  if (!support) return null;
  try {
    const source = fs.readFileSync(def.file, "utf8");
    const tree = parseWithJsLanguage(source, support.language(def.file));
    return { source, tree, languageId: support.id };
  } catch {
    return null;
  }
}

export function getSymbolRange(index: ProjectIndex, def: SymbolDef, opts?: SymbolRangeOptions): Range {
  const mode = opts?.trivia ?? "exclude";
  if (mode === "exclude") return def.range;
  const parsed = parseTreeForDef(index, def);
  if (!parsed) return def.range;
  const startIndex = def.range.start.index ?? 0;
  const endIndex = def.range.end.index ?? startIndex;
  const node = parsed.tree.rootNode.descendantForIndex(startIndex, endIndex);
  return computeLeadingTriviaRange(node, parsed.source, parsed.languageId, mode);
}
