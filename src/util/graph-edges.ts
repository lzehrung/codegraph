import type { Edge } from "../types.js";
import { toProjectDisplayPath } from "./paths.js";

export function edgeKey(edge: Edge): string {
  const toKey = edge.to.type === "file" ? `file:${edge.to.path}` : `external:${edge.to.name}`;
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${edge.from}|${toKey}|${edge.raw}|${typeOnly}`;
}

export function compareEdges(left: Edge, right: Edge): number {
  const fromCompare = left.from.localeCompare(right.from);
  if (fromCompare) return fromCompare;
  if (left.to.type !== right.to.type) {
    return left.to.type === "file" ? -1 : 1;
  }
  const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
  const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
  const toCompare = leftTo.localeCompare(rightTo);
  if (toCompare) return toCompare;
  const rawCompare = left.raw.localeCompare(right.raw);
  if (rawCompare) return rawCompare;
  const leftTypeOnly = left.typeOnly ? 1 : 0;
  const rightTypeOnly = right.typeOnly ? 1 : 0;
  return leftTypeOnly - rightTypeOnly;
}

export function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
  const from = toProjectDisplayPath(projectRoot, edge.from);
  let to = edge.to;
  if (edge.to.type === "file") {
    to = {
      type: "file",
      path: toProjectDisplayPath(projectRoot, edge.to.path),
    };
  }
  return {
    from,
    to,
    raw: edge.raw,
    ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
  };
}
