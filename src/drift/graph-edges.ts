import type { Edge } from "../types.js";
import { edgeKey } from "../util/graph-edges.js";
import type { ArchitectureGraphEdge } from "./types.js";

export function toArchitectureGraphEdges(
  edges: readonly Edge[],
  displayPath: (file: string) => string = (file) => file,
): ArchitectureGraphEdge[] {
  const edgeTarget = (edge: Edge): string =>
    edge.to.type === "file" ? displayPath(edge.to.path) : `external:${edge.to.name}`;
  return edges
    .map((edge) => ({
      key: edgeKey(edge, true, displayPath),
      from: displayPath(edge.from),
      to: edgeTarget(edge),
      raw: edge.raw,
      ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
      ...(edge.includeForm ? { includeForm: edge.includeForm } : {}),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}
