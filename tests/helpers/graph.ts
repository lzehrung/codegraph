import type { Edge } from "../../src/index.js";
import { normalizeTestPath } from "./filesystem.js";

export function graphEdgeTargetKey(to: Edge["to"]): string {
  if (to.type === "file") return normalizeTestPath(to.path);
  return to.name;
}

export function graphEdgeKey(edge: Edge): string {
  return `${normalizeTestPath(edge.from)}|${graphEdgeTargetKey(edge.to)}|${edge.raw}`;
}

export function edgeFrom(filePath: string): (edge: Pick<Edge, "from">) => boolean {
  return (edge) => normalizeTestPath(edge.from) === normalizeTestPath(filePath);
}
