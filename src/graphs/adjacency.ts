import type { FileId, Graph } from "../types.js";

export type GraphAdjacencyIndex = {
  forward: Map<FileId, FileId[]>;
  reverse: Map<FileId, FileId[]>;
};

function appendNeighbor(adjacency: Map<FileId, FileId[]>, from: FileId, to: FileId): void {
  const neighbors = adjacency.get(from);
  if (neighbors) {
    neighbors.push(to);
    return;
  }
  adjacency.set(from, [to]);
}

export function buildGraphAdjacency(graph: Graph): GraphAdjacencyIndex {
  const forward = new Map<FileId, FileId[]>();
  const reverse = new Map<FileId, FileId[]>();
  for (const edge of graph.edges) {
    if (edge.to.type !== "file") continue;
    appendNeighbor(forward, edge.from, edge.to.path);
    appendNeighbor(reverse, edge.to.path, edge.from);
  }
  return { forward, reverse };
}

export function graphAdjacencyFor(graph: Graph): GraphAdjacencyIndex {
  return buildGraphAdjacency(graph);
}

export function getForwardNeighbors(adjacency: GraphAdjacencyIndex, file: FileId): readonly FileId[] {
  return adjacency.forward.get(file) ?? [];
}

export function getReverseNeighbors(adjacency: GraphAdjacencyIndex, file: FileId): readonly FileId[] {
  return adjacency.reverse.get(file) ?? [];
}
