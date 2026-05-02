import path from "node:path";

import { normalizePath } from "../util.js";
import type { Edge } from "../types.js";

export const DEFAULT_REF_CONTEXT_LINES = 5;

export const QUERY_DRIVEN_LOCALS_LANGUAGES = new Set([
  "python",
  "php",
  "java",
  "csharp",
  "rust",
  "kotlin",
  "swift",
  "zig",
  "cpp",
]);

export function parseGoImportAlias(stmtText: string): string | null {
  const trimmed = stmtText.trim();
  const match = trimmed.match(/^(?:import\s+)?([._A-Za-z][\w]*)\s+["'`]/);
  return match?.[1] ?? null;
}

export function edgeKey(edge: Edge): string {
  const toKey = edge.to.type === "file" ? `file:${edge.to.path}` : `external:${edge.to.name}`;
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${edge.from}|${toKey}|${edge.raw}|${typeOnly}`;
}

export function compareEdges(left: Edge, right: Edge): number {
  const fromCompare = left.from.localeCompare(right.from);
  if (fromCompare !== 0) return fromCompare;
  if (left.to.type !== right.to.type) {
    return left.to.type === "file" ? -1 : 1;
  }
  const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
  const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
  const toCompare = leftTo.localeCompare(rightTo);
  if (toCompare !== 0) return toCompare;
  const rawCompare = left.raw.localeCompare(right.raw);
  if (rawCompare !== 0) return rawCompare;
  const leftTypeOnly = left.typeOnly ? 1 : 0;
  const rightTypeOnly = right.typeOnly ? 1 : 0;
  return leftTypeOnly - rightTypeOnly;
}

export function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
  return {
    from: normalizePath(path.relative(projectRoot, edge.from)),
    to:
      edge.to.type === "file"
        ? {
            type: "file",
            path: normalizePath(path.relative(projectRoot, edge.to.path)),
          }
        : edge.to,
    raw: edge.raw,
    ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
  };
}
