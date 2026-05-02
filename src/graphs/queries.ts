import type { FileId, Graph } from "../types.js";
import { getFiniteNonNegativeLimit } from "./limits.js";
import { builtinModules } from "node:module";

export type DependencyNode = { file: FileId; depth: number };

export type CycleInternalEdge = {
  from: FileId;
  to: FileId;
  raw: string;
  typeOnly?: boolean;
};

export type DetailedCycle = {
  files: FileId[];
  entryEdges: CycleInternalEdge[];
  internalEdges: CycleInternalEdge[];
  fileCount: number;
  internalEdgeCount: number;
  fanInFromOutside: number;
  priorityScore: number;
  remediationHint: string;
};

export type CycleSortMode = "priority" | "size" | "fanin";

const NODE_BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return NODE_BUILTIN_MODULES.has(specifier);
}

export function getDependencies(
  graph: Graph,
  startFile: FileId,
  opts: { depth?: number; limit?: number } = {},
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

    for (const edge of graph.edges) {
      if (edge.from === file && edge.to.type === "file" && !visited.has(edge.to.path)) {
        visited.add(edge.to.path);
        queue.push({ file: edge.to.path, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function getReverseDependencies(
  graph: Graph,
  targetFile: FileId,
  opts: { depth?: number; limit?: number } = {},
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

    for (const edge of graph.edges) {
      if (edge.to.type === "file" && edge.to.path === file && !visited.has(edge.from)) {
        visited.add(edge.from);
        queue.push({ file: edge.from, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function getShortestPath(graph: Graph, from: FileId, to: FileId): FileId[] | null {
  const visited = new Map<string, string | null>();
  const queue: string[] = [from];
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

    for (const edge of graph.edges) {
      if (edge.from === current && edge.to.type === "file" && !visited.has(edge.to.path)) {
        visited.set(edge.to.path, current);
        queue.push(edge.to.path);
      }
    }
  }
  return null;
}

export function findCycles(graph: Graph): FileId[][] {
  return findDetailedCycles(graph).map((cycle) => cycle.files);
}

export function sortDetailedCycles(cycles: DetailedCycle[], mode: CycleSortMode = "priority"): DetailedCycle[] {
  const sorted = [...cycles];
  sorted.sort((left, right) => {
    if (mode === "size") {
      if (right.fileCount !== left.fileCount) return right.fileCount - left.fileCount;
      return right.priorityScore - left.priorityScore;
    }
    if (mode === "fanin") {
      if (right.fanInFromOutside !== left.fanInFromOutside) {
        return right.fanInFromOutside - left.fanInFromOutside;
      }
      return right.priorityScore - left.priorityScore;
    }
    return right.priorityScore - left.priorityScore;
  });
  return sorted;
}

export function findDetailedCycles(
  graph: Graph,
  options: { symbolCoupling?: Map<string, number> } = {},
): DetailedCycle[] {
  const nodes = Array.from(graph.nodes);
  const indexByNode = new Map<string, number>();
  nodes.forEach((node, index) => indexByNode.set(node, index));

  const adjacency = nodes.map(() => [] as number[]);
  for (const edge of graph.edges) {
    if (edge.to.type !== "file") continue;
    const fromIndex = indexByNode.get(edge.from);
    const toIndex = indexByNode.get(edge.to.path);
    if (fromIndex !== undefined && toIndex !== undefined) {
      adjacency[fromIndex]!.push(toIndex);
    }
  }

  const nodeCount = nodes.length;
  const indices: number[] = new Array<number>(nodeCount).fill(-1);
  const lowlink: number[] = new Array<number>(nodeCount).fill(-1);
  const onStack = new Array(nodeCount).fill(false);
  const stack: number[] = [];
  let nextIndex = 0;
  const stronglyConnectedComponents: number[][] = [];

  function strongconnect(vertex: number) {
    indices[vertex] = nextIndex;
    lowlink[vertex] = nextIndex;
    nextIndex++;
    stack.push(vertex);
    onStack[vertex] = true;

    for (const neighbor of adjacency[vertex]!) {
      if (indices[neighbor] === -1) {
        strongconnect(neighbor);
        lowlink[vertex] = Math.min(lowlink[vertex], lowlink[neighbor]!);
      } else if (onStack[neighbor]) {
        lowlink[vertex] = Math.min(lowlink[vertex], indices[neighbor]!);
      }
    }

    if (lowlink[vertex] === indices[vertex]) {
      const component: number[] = [];
      let popped: number;
      do {
        popped = stack.pop()!;
        onStack[popped] = false;
        component.push(popped);
      } while (popped !== vertex);
      if (component.length > 1 || adjacency[vertex]!.includes(vertex)) {
        stronglyConnectedComponents.push(component);
      }
    }
  }

  for (let index = 0; index < nodeCount; index++) {
    if (indices[index] === -1) strongconnect(index);
  }

  const cycleDetails: DetailedCycle[] = [];
  for (const component of stronglyConnectedComponents) {
    const files = component.map((index) => nodes[index]!);
    const componentFiles = new Set(files);
    const internalEdges: CycleInternalEdge[] = [];
    const entryEdges: CycleInternalEdge[] = [];
    let internalEdgeCount = 0;
    let fanInFromOutside = 0;

    for (const edge of graph.edges) {
      if (edge.to.type !== "file") continue;
      const fromInComponent = componentFiles.has(edge.from);
      const toInComponent = componentFiles.has(edge.to.path);
      if (fromInComponent && toInComponent) {
        internalEdgeCount += 1;
        internalEdges.push({
          from: edge.from,
          to: edge.to.path,
          raw: edge.raw,
          ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
        });
      }
      if (!fromInComponent && toInComponent) {
        fanInFromOutside += 1;
        entryEdges.push({
          from: edge.from,
          to: edge.to.path,
          raw: edge.raw,
          ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
        });
      }
    }

    const priorityScore = files.length * 3 + fanInFromOutside * 2 + internalEdgeCount;
    const couplingForEdge = (edge: CycleInternalEdge): number =>
      options.symbolCoupling?.get(`${edge.from} -> ${edge.to}`) ?? 0;
    const weakestEdge = internalEdges.reduce<CycleInternalEdge | null>((best, edge) => {
      if (!best) return edge;
      const bestCoupling = couplingForEdge(best);
      const edgeCoupling = couplingForEdge(edge);
      if (edgeCoupling !== bestCoupling) {
        return edgeCoupling < bestCoupling ? edge : best;
      }
      if (!!edge.typeOnly && !best.typeOnly) return edge;
      return best;
    }, null);

    const remediationHint = weakestEdge
      ? `Break ${weakestEdge.from} -> ${weakestEdge.to} (import ${weakestEdge.raw}) to reduce SCC coupling; estimated symbol coupling=${couplingForEdge(weakestEdge)}.`
      : `Break one import edge in this ${files.length}-file SCC to remove the cycle.`;

    cycleDetails.push({
      files,
      entryEdges,
      internalEdges,
      fileCount: files.length,
      internalEdgeCount,
      fanInFromOutside,
      priorityScore,
      remediationHint,
    });
  }

  return sortDetailedCycles(cycleDetails, "priority");
}

export function getUnresolvedImports(graph: Graph): Array<{
  name: string;
  importers: Array<{ file: FileId; raw: string }>;
}> {
  const unresolved = new Map<string, Array<{ file: FileId; raw: string }>>();
  for (const edge of graph.edges) {
    if (edge.to.type !== "external") continue;
    if (isNodeBuiltinSpecifier(edge.to.name) || isNodeBuiltinSpecifier(edge.raw)) continue;
    const importers = unresolved.get(edge.to.name) ?? [];
    importers.push({ file: edge.from, raw: edge.raw });
    unresolved.set(edge.to.name, importers);
  }
  return Array.from(unresolved.entries())
    .map(([name, importers]) => ({ name, importers }))
    .sort((left, right) => right.importers.length - left.importers.length);
}
