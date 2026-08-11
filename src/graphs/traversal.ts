import type { FileId, Graph } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { getForwardNeighbors, getReverseNeighbors, graphAdjacencyFor, type GraphAdjacencyIndex } from "./adjacency.js";
import { getFiniteNonNegativeLimit } from "./limits.js";
export type DependencyNode = { file: FileId; depth: number };

type NeighborProvider = (adjacency: GraphAdjacencyIndex, file: FileId) => readonly FileId[];

function walkDependencies(
  graph: Graph,
  startFile: FileId,
  opts: { depth?: number; limit?: number; adjacency?: GraphAdjacencyIndex },
  getNeighbors: NeighborProvider,
): DependencyNode[] {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const finiteLimit = getFiniteNonNegativeLimit(opts.limit);
  const maxResults = finiteLimit ?? Number.POSITIVE_INFINITY;
  if (maxResults === 0) {
    return [];
  }
  const out: DependencyNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: FileId; depth: number }> = [{ file: startFile, depth: 0 }];
  const adjacency = opts.adjacency ?? graphAdjacencyFor(graph);
  visited.add(fileIdentityKey(startFile));

  let index = 0;
  while (index < queue.length) {
    const { file, depth } = queue[index++]!;
    if (depth > 0) {
      out.push({ file, depth });
      if (out.length >= maxResults) {
        break;
      }
    }
    if (depth >= maxDepth) continue;

    for (const neighbor of getNeighbors(adjacency, file)) {
      const neighborKey = fileIdentityKey(neighbor);
      if (!visited.has(neighborKey)) {
        visited.add(neighborKey);
        queue.push({ file: neighbor, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function getDependencies(
  graph: Graph,
  startFile: FileId,
  opts: { depth?: number; limit?: number; adjacency?: GraphAdjacencyIndex } = {},
): DependencyNode[] {
  return walkDependencies(graph, startFile, opts, getForwardNeighbors);
}

export function getReverseDependencies(
  graph: Graph,
  targetFile: FileId,
  opts: { depth?: number; limit?: number; adjacency?: GraphAdjacencyIndex } = {},
): DependencyNode[] {
  return walkDependencies(graph, targetFile, opts, getReverseNeighbors);
}

export function getShortestPath(
  graph: Graph,
  from: FileId,
  to: FileId,
  opts: { adjacency?: GraphAdjacencyIndex } = {},
): FileId[] | null {
  const visited = new Map<string, { file: FileId; previous: string | null }>();
  const queue: FileId[] = [from];
  const adjacency = opts.adjacency ?? graphAdjacencyFor(graph);
  const targetKey = fileIdentityKey(to);
  visited.set(fileIdentityKey(from), { file: from, previous: null });

  let index = 0;
  while (index < queue.length) {
    const current = queue[index++]!;
    const currentKey = fileIdentityKey(current);
    if (currentKey === targetKey) {
      const path: FileId[] = [];
      let pointer: string | null = currentKey;
      while (pointer !== null) {
        const entry = visited.get(pointer);
        if (!entry) return null;
        path.push(entry.file);
        pointer = entry.previous;
      }
      return path.reverse();
    }

    for (const neighbor of getForwardNeighbors(adjacency, current)) {
      const neighborKey = fileIdentityKey(neighbor);
      if (!visited.has(neighborKey)) {
        visited.set(neighborKey, { file: neighbor, previous: currentKey });
        queue.push(neighbor);
      }
    }
  }
  return null;
}
