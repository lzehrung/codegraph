import type { FileId } from "../types.js";
import type { ProjectIndex } from "../indexer.js";
import { buildSymbolGraphDetailed } from "../graphs.js";
import type { SymbolEdge } from "../graphs.js";
import { buildGraphAdjacency, getForwardNeighbors, getReverseNeighbors } from "../graphs/adjacency.js";
import { createGraphFileResolver } from "./path.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./testPatterns.js";

export interface CandidateTestFile {
  file: FileId;
  confidence: "high" | "medium" | "low";
  reason: "importsChanged" | "dependsOnChanged" | "pattern";
}

export interface ImpactContext {
  /** N-hop subgraph of file dependencies around impacted files */
  fileSubgraph: {
    nodes: Set<FileId>;
    edges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }>;
  };
  /** Symbol neighbors of changed symbols (symbols that use or are used by changed symbols) */
  symbolNeighbors: Array<{
    symbolId: string;
    file: FileId;
    name: string;
    kind: string;
    relationship: "uses" | "usedBy";
  }>;
  /** Files that contain symbol neighbors */
  neighborFiles: Set<FileId>;
}

/**
 * Collect N-hop context around impacted files and symbols.
 * Useful for agents that need more context about the impact area.
 */
export async function collectImpactContext(
  index: ProjectIndex,
  impactedFiles: FileId[],
  changedSymbolIds: string[],
  hops: number = 2,
): Promise<ImpactContext> {
  const fileSubgraph = collectFileSubgraph(index, impactedFiles, hops);
  const symbolNeighbors = await collectSymbolNeighbors(index, changedSymbolIds, hops);

  // Collect files that contain symbol neighbors
  const neighborFiles = new Set<FileId>();
  for (const neighbor of symbolNeighbors) {
    neighborFiles.add(neighbor.file);
  }

  return {
    fileSubgraph,
    symbolNeighbors,
    neighborFiles,
  };
}

function collectFileSubgraph(
  index: ProjectIndex,
  impactedFiles: FileId[],
  hops: number,
): {
  nodes: Set<FileId>;
  edges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }>;
} {
  const nodes = new Set<FileId>();
  const edges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }> = [];
  const visited = new Set<FileId>();
  const queue: Array<{ file: FileId; depth: number }> = [];
  const adjacency = index.graphAdjacency ?? buildGraphAdjacency(index.graph);
  const typeOnlyByPair = new Map<string, { allTypeOnly: boolean; hasTypeOnlyMetadata: boolean }>();

  // Initialize with impacted files
  for (const file of impactedFiles) {
    nodes.add(file);
    visited.add(file);
    queue.push({ file, depth: 0 });
  }

  for (const edge of index.graph.edges) {
    if (edge.to.type === "file") {
      const key = `${edge.from}\0${edge.to.path}`;
      const current = typeOnlyByPair.get(key) ?? { allTypeOnly: true, hasTypeOnlyMetadata: false };
      current.allTypeOnly = current.allTypeOnly && edge.typeOnly === true;
      current.hasTypeOnlyMetadata = current.hasTypeOnlyMetadata || edge.typeOnly !== undefined;
      typeOnlyByPair.set(key, current);
    }
  }

  // BFS to collect N-hop subgraph
  let qi = 0;
  while (qi < queue.length) {
    const { file, depth } = queue[qi++]!;
    if (depth >= hops) continue;

    // Add forward dependencies (files this file depends on)
    const deps = getForwardNeighbors(adjacency, file);
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        nodes.add(dep);
        queue.push({ file: dep, depth: depth + 1 });
      }
      edges.push(edgeFor(file, dep, typeOnlyByPair));
    }

    // Add reverse dependencies (files that depend on this file)
    const revDeps = getReverseNeighbors(adjacency, file);
    for (const revDep of revDeps) {
      if (!visited.has(revDep)) {
        visited.add(revDep);
        nodes.add(revDep);
        queue.push({ file: revDep, depth: depth + 1 });
      }
      edges.push(edgeFor(revDep, file, typeOnlyByPair));
    }
  }

  return { nodes, edges };
}

function edgeFor(
  from: FileId,
  to: FileId,
  typeOnlyByPair: ReadonlyMap<string, { allTypeOnly: boolean; hasTypeOnlyMetadata: boolean }>,
): { from: FileId; to: FileId; typeOnly?: boolean } {
  const typeOnly = typeOnlyByPair.get(`${from}\0${to}`);
  if (!typeOnly) return { from, to };
  if (typeOnly.allTypeOnly) return { from, to, typeOnly: true };
  return typeOnly.hasTypeOnlyMetadata ? { from, to, typeOnly: false } : { from, to };
}

async function collectSymbolNeighbors(
  index: ProjectIndex,
  changedSymbolIds: string[],
  hops: number,
): Promise<
  Array<{
    symbolId: string;
    file: FileId;
    name: string;
    kind: string;
    relationship: "uses" | "usedBy";
  }>
> {
  const neighbors: Array<{
    symbolId: string;
    file: FileId;
    name: string;
    kind: string;
    relationship: "uses" | "usedBy";
  }> = [];

  if (!changedSymbolIds.length) return neighbors;

  const symbolGraph = await buildSymbolGraphDetailed(index, {
    scope: "all",
    maxEdges: 50000, // Larger limit for context collection
    membersOnly: false,
  });

  const symbolIdToInfo = new Map<string, { file: FileId; name: string; kind: string }>();
  for (const [symbolId, node] of symbolGraph.nodes) {
    symbolIdToInfo.set(symbolId, {
      file: node.file,
      name: node.name,
      kind: node.kind,
    });
  }

  const adjacencyFrom = new Map<string, SymbolEdge[]>();
  const adjacencyTo = new Map<string, SymbolEdge[]>();
  for (const edge of symbolGraph.edges) {
    const fromList = adjacencyFrom.get(edge.from);
    if (fromList) {
      fromList.push(edge);
    } else {
      adjacencyFrom.set(edge.from, [edge]);
    }

    const toList = adjacencyTo.get(edge.to);
    if (toList) {
      toList.push(edge);
    } else {
      adjacencyTo.set(edge.to, [edge]);
    }
  }

  const visitedSymbols = new Set<string>(changedSymbolIds);
  let currentLevel = changedSymbolIds.slice();
  for (let depth = 0; depth < hops && currentLevel.length; depth++) {
    const nextLevel: string[] = [];

    for (const symbolId of currentLevel) {
      const outgoing = adjacencyFrom.get(symbolId) || [];
      for (const edge of outgoing) {
        if (visitedSymbols.has(edge.to)) continue;
        visitedSymbols.add(edge.to);
        nextLevel.push(edge.to);

        const info = symbolIdToInfo.get(edge.to);
        if (info) {
          neighbors.push({
            symbolId: edge.to,
            file: info.file,
            name: info.name,
            kind: info.kind,
            relationship: "uses",
          });
        }
      }

      const incoming = adjacencyTo.get(symbolId) || [];
      for (const edge of incoming) {
        if (visitedSymbols.has(edge.from)) continue;
        visitedSymbols.add(edge.from);
        nextLevel.push(edge.from);

        const info = symbolIdToInfo.get(edge.from);
        if (info) {
          neighbors.push({
            symbolId: edge.from,
            file: info.file,
            name: info.name,
            kind: info.kind,
            relationship: "usedBy",
          });
        }
      }
    }

    currentLevel = nextLevel;
  }

  return neighbors;
}

/**
 * Find test files that might be affected by changes.
 * Uses reverse dependencies and optional pattern matching.
 */
export function listCandidateTestFiles(
  index: ProjectIndex,
  changedFiles: FileId[],
  changedSymbolIds: string[],
  options: {
    /** Additional test file patterns beyond default heuristics */
    testPatterns?: string[];
    /** Maximum number of candidates to return */
    maxCandidates?: number;
    /** Explicit project root for sparse indexes that lack metadata */
    projectRoot?: string;
  } = {},
): CandidateTestFile[] {
  const { testPatterns = [], maxCandidates = 100, projectRoot } = options;
  const candidates = new Map<FileId, CandidateTestFile>();
  const resolveGraphFile = createGraphFileResolver(index.graph.nodes);
  const resolvedChangedFiles = changedFiles.map((file) => resolveGraphFile(file));
  const adjacency = index.graphAdjacency ?? buildGraphAdjacency(index.graph);
  // Default test patterns (can be extended by caller)
  const allPatterns = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, allPatterns, projectRoot, resolvedChangedFiles);

  // Find test files that import changed symbols directly
  const symbolFiles = new Set<FileId>();
  for (const symbolId of changedSymbolIds) {
    // Extract file from symbol ID (format: "file::name::index")
    const file = symbolId.split("::")[0];
    if (file) symbolFiles.add(resolveGraphFile(file));
  }

  for (const file of symbolFiles) {
    const dependents = getReverseNeighbors(adjacency, file);
    for (const dependent of dependents) {
      if (isIndexTestFile(dependent)) {
        candidates.set(dependent, {
          file: dependent,
          confidence: "high",
          reason: "importsChanged",
        });
      }
    }
  }

  // Find test files that depend on changed files (lower confidence)
  for (const changedFile of resolvedChangedFiles) {
    const dependents = getReverseNeighbors(adjacency, changedFile);
    for (const dependent of dependents) {
      if (isIndexTestFile(dependent) && !candidates.has(dependent)) {
        candidates.set(dependent, {
          file: dependent,
          confidence: "medium",
          reason: "dependsOnChanged",
        });
      }
    }
  }

  // Find test files by pattern in the entire codebase (lowest confidence)
  if (candidates.size < maxCandidates) {
    for (const [file] of index.byFile) {
      if (candidates.size >= maxCandidates) break;
      if (!candidates.has(file) && isIndexTestFile(file)) {
        candidates.set(file, {
          file,
          confidence: "low",
          reason: "pattern",
        });
      }
    }
  }

  return Array.from(candidates.values()).slice(0, maxCandidates);
}
