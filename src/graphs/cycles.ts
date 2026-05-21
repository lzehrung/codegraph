import type { FileId, Graph } from "../types.js";
import { GRAPH_ONLY_DOCUMENT_EXTENSIONS } from "../util/graphOnlyExtensions.js";

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

const DOCUMENT_ONLY_CYCLE_EXTENSIONS = new Set(GRAPH_ONLY_DOCUMENT_EXTENSIONS);

function isDocumentOnlyCycleFile(file: string): boolean {
  const normalized = file.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  for (const extension of DOCUMENT_ONLY_CYCLE_EXTENSIONS) {
    if (normalized.endsWith(extension)) {
      return true;
    }
  }
  return false;
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
    if (files.every(isDocumentOnlyCycleFile)) {
      continue;
    }
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
