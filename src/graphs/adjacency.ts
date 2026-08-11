import { fileIdentityKey } from "../util/paths.js";
import type { FileId, Graph } from "../types.js";

export type GraphAdjacencyIndex = {
  forward: Map<FileId, FileId[]>;
  reverse: Map<FileId, FileId[]>;
};

function appendNeighbor(adjacency: Map<FileId, FileId[]>, from: FileId, to: FileId): void {
  const key = fileIdentityKey(from);
  const neighbors = adjacency.get(key);
  if (neighbors) {
    neighbors.push(to);
    return;
  }
  adjacency.set(key, [to]);
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

const adjacencyByGraph = new WeakMap<Graph, GraphAdjacencyIndex>();

export function graphAdjacencyFor(graph: Graph): GraphAdjacencyIndex {
  const cached = adjacencyByGraph.get(graph);
  if (cached) {
    return cached;
  }
  const built = buildGraphAdjacency(graph);
  adjacencyByGraph.set(graph, built);
  return built;
}

export function getForwardNeighbors(adjacency: GraphAdjacencyIndex, file: FileId): readonly FileId[] {
  return adjacency.forward.get(fileIdentityKey(file)) ?? [];
}

export function getReverseNeighbors(adjacency: GraphAdjacencyIndex, file: FileId): readonly FileId[] {
  return adjacency.reverse.get(fileIdentityKey(file)) ?? [];
}
