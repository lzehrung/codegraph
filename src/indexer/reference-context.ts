import { sliceText } from "../util/ast.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { SymbolDef } from "./types.js";

export function sameDef(left: SymbolDef, right: SymbolDef): boolean {
  const leftIndex = left.range.start.index ?? 0;
  const rightIndex = right.range.start.index ?? 0;
  return left.file === right.file && left.localName === right.localName && leftIndex === rightIndex;
}

export function rangeContains(range: Range, pos: { row: number; column: number }): boolean {
  if (pos.row < range.start.line || pos.row > range.end.line) return false;
  if (pos.row === range.start.line && pos.column < range.start.column) {
    return false;
  }
  if (pos.row === range.end.line && pos.column > range.end.column) {
    return false;
  }
  return true;
}

export function extractLineContext(source: string, line: number, lines: number): string {
  const allLines = source.split(/\r?\n/);
  const startLine = Math.max(0, line - 1 - lines);
  const endLine = Math.min(allLines.length, line - 1 + lines + 1);
  return allLines.slice(startLine, endLine).join("\n");
}

export function extractLineContextWithMaxTotal(source: string, line: number, maxLines: number): string {
  const allLines = source.split(/\r?\n/);
  const safeMaxLines = Math.max(1, maxLines);
  const focusIndex = Math.max(0, line - 1);
  let startLine = Math.max(0, focusIndex - Math.floor((safeMaxLines - 1) / 2));
  let endLine = Math.min(allLines.length, startLine + safeMaxLines);

  if (endLine - startLine < safeMaxLines) {
    startLine = Math.max(0, endLine - safeMaxLines);
  }

  return allLines.slice(startLine, endLine).join("\n");
}

export function extractEnclosingBlock(
  source: string,
  tree: SyntaxTreeLike,
  range: Range,
  maxLines: number,
  sup: LanguageSupport,
): string {
  const node = tree.rootNode.descendantForIndex(range.start.index ?? 0, range.end.index ?? range.start.index ?? 0);
  if (!node) {
    return extractLineContextWithMaxTotal(source, range.start.line, maxLines);
  }

  let current: SyntaxNodeLike | null = node;
  let genericCandidate: SyntaxNodeLike | null = null;
  const isRootLikeNode = (type: string): boolean =>
    type === "program" || type === "module" || type === "source_file" || type === "document";
  const blockTypePriority = (type: string): number => {
    if (sup.id === "ts" || sup.id === "tsx" || sup.id === "js") {
      if (
        type === "function_declaration" ||
        type === "method_definition" ||
        type === "class_declaration" ||
        type === "arrow_function" ||
        type === "function_expression"
      ) {
        return 2;
      }
      if (type === "statement_block" || type === "class_body") {
        return 1;
      }
      return 0;
    }
    if (sup.id === "python") {
      if (type === "function_definition" || type === "class_definition") {
        return 2;
      }
      if (type === "suite") {
        return 1;
      }
      return 0;
    }
    return 0;
  };

  let bestBlockNode: SyntaxNodeLike | null = null;
  let bestBlockPriority = 0;
  while (current) {
    const priority = blockTypePriority(current.type);
    if (priority > bestBlockPriority) {
      bestBlockNode = current;
      bestBlockPriority = priority;
      if (priority >= 2) break;
    }
    if (!isRootLikeNode(current.type) && current.startPosition.row !== current.endPosition.row) {
      genericCandidate = current;
    }
    const parent: SyntaxNodeLike | null = current.parent;
    if (!parent) break;
    current = parent;
  }

  const blockNode = bestBlockNode ?? genericCandidate;
  if (!blockNode) {
    return extractLineContextWithMaxTotal(source, range.start.line, maxLines);
  }

  const blockText = sliceText(blockNode, source);
  const blockLines = blockText.split(/\r?\n/);
  if (blockLines.length > maxLines) {
    if (maxLines <= 1) {
      return "...";
    }
    return [...blockLines.slice(0, maxLines - 1), "..."].join("\n");
  }

  return blockText;
}
