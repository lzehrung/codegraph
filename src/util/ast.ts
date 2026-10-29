import type { Range } from "../types.js";

/** Node-like interface for AST nodes with position info */
interface NodeLike {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}

export function containsNode(container: NodeLike, node: NodeLike): boolean {
  return container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;
}

/** The topmost ancestor of a node, or the node itself when it has no parent. */
export function rootNodeOf<T extends { parent: T | null }>(node: T): T {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

export function sliceText(node: NodeLike | null | undefined, src: string): string {
  if (!node || !src) return "";
  return src.slice(node.startIndex, node.endIndex);
}
export function unquote(s: string): string {
  if (!s || typeof s !== "string") return s;
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
    ? t.slice(1, -1)
    : t;
}
export function toRange(node: NodeLike | null | undefined): Range {
  if (!node) {
    return {
      start: { line: 0, column: 0, index: 0 },
      end: { line: 0, column: 0, index: 0 },
    };
  }
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      index: node.startIndex,
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column + 1,
      index: node.endIndex,
    },
  };
}

export function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Object]";
    }
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function: ${value.name || "anonymous"}]`;
  }
  return "unknown";
}
