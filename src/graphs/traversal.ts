import type { FileId, Graph } from "../types.js";
import {
  getForwardNeighbors,
  getReverseNeighbors,
  graphAdjacencyFor,
  type GraphAdjacencyIndex,
} from "./adjacency.js";
import { getFiniteNonNegativeLimit } from "./limits.js";

export type DependencyNode = { file: FileId; depth: number };

export function getDependencies(
  graph: Graph,
  startFile: FileId,
  opts: { depth?: number; limit?: number; adjacency?: GraphAdjacencyIndex } = {},
): DependencyNode[] {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const finiteLimit = getFiniteNonNegativeLimit(opts.limit);
  const maxResults = finiteLimit ?? Number.POSITIVE_INFINITY;
  if (maxResults === 0) {
    return [];
  }
  const out: DependencyNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: startFile, depth: 0 }];
  const adjacency = opts.adjacency ?? graphAdjacencyFor(graph);
  visited.add(startFile);

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

    for (const neighbor of getForwardNeighbors(adjacency, file)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ file: neighbor, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function getReverseDependencies(
  graph: Graph,
  targetFile: FileId,
  opts: { depth?: number; limit?: number; adjacency?: GraphAdjacencyIndex } = {},
): DependencyNode[] {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const finiteLimit = getFiniteNonNegativeLimit(opts.limit);
  const maxResults = finiteLimit ?? Number.POSITIVE_INFINITY;
  if (maxResults === 0) {
    return [];
  }
  const out: DependencyNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: targetFile, depth: 0 }];
  const adjacency = opts.adjacency ?? graphAdjacencyFor(graph);
  visited.add(targetFile);

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

    for (const neighbor of getReverseNeighbors(adjacency, file)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ file: neighbor, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function getShortestPath(
  graph: Graph,
  from: FileId,
  to: FileId,
  opts: { adjacency?: GraphAdjacencyIndex } = {},
): FileId[] | null {
  const visited = new Map<string, string | null>();
  const queue: string[] = [from];
  const adjacency = opts.adjacency ?? graphAdjacencyFor(graph);
  visited.set(from, null);

  let index = 0;
  while (index < queue.length) {
    const current = queue[index++]!;
    if (current === to) {
      const path: string[] = [];
      let pointer: string | null = current;
      while (pointer !== null) {
        path.push(pointer);
        pointer = visited.get(pointer)!;
      }
      return path.reverse();
    }

    for (const neighbor of getForwardNeighbors(adjacency, current)) {
      if (!visited.has(neighbor)) {
        visited.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  return null;
}
