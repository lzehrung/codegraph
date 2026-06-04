import type { FileId } from "../types.js";
import path from "node:path";
import { type ProjectIndex } from "../indexer/types.js";
import type {
  FileChange,
  ChangedSymbol,
  ImpactItem,
  ImpactReport,
  CompactImpactReport,
  ImpactOptions,
  ImpactSuggestion,
  ExportSummaryEntry,
  ReexportChainEntry,
  ImpactTopItem,
  ImpactSurfaceArea,
  ImpactCluster,
  ImpactCycle,
  ImpactDiagnostics,
} from "./types.js";
import { buildSymbolGraphDetailed } from "../graphs/symbol-graph-detailed.js";
import { findDetailedCycles } from "../graphs/queries.js";
import { discoverProjectFiles } from "../util/projectFiles.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { newFileRangeForHunk } from "./hunks.js";
import { createGraphFileResolver, normalizeImpactFileChange, toImpactReportFilePath } from "./path.js";
import { buildCompactImpactReport } from "./reportCompact.js";
import { buildFullImpactReport } from "./reportFull.js";
export { newFileRangeForHunk } from "./hunks.js";

export async function buildImpactReport(
  projectRoot: string,
  index: ProjectIndex,
  diffFiles: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  suggestions: ImpactSuggestion[],
  options: Partial<ImpactOptions> & { warning?: string | undefined } = {},
  diagnostics?: ImpactDiagnostics,
): Promise<ImpactReport | CompactImpactReport> {
  const normalizedDiffFiles = diffFiles.map((change) => normalizeImpactFileChange(projectRoot, change));
  const displayFile = (file: FileId): FileId => toImpactReportFilePath(projectRoot, file);
  const exportSummary = buildExportSummary(changedSymbols);
  const reexportChains = buildReexportChains(index, changedSymbols);
  const topImpacts = buildTopImpacts(impactedItems);
  const surfaceArea = buildSurfaceArea(index, normalizedDiffFiles, impactedItems);
  const projectFiles = index.projectFiles ?? (await discoverProjectFiles(projectRoot));

  // Build changedFiles summary
  const changedFiles = normalizedDiffFiles.map((fileChange) => ({
    file: displayFile(fileChange.path),
    kind: fileChange.kind,
    ...(fileChange.oldPath !== undefined ? { oldFile: displayFile(fileChange.oldPath) } : {}),
    ...(fileChange.similarityIndex !== undefined ? { similarityIndex: fileChange.similarityIndex } : {}),
    hunks: fileChange.hunks.map((hunk) => newFileRangeForHunk(hunk)),
  }));

  // Build graph data
  const fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }> = [];
  const symbolEdges: Array<{ from: number; to: number; label: string }> = [];
  const symbolCoupling = new Map<string, number>();

  const relevantFiles = new Set<FileId>();
  for (const fileChange of normalizedDiffFiles) relevantFiles.add(fileChange.path);
  for (const symbol of changedSymbols) relevantFiles.add(symbol.file);
  for (const item of impactedItems) relevantFiles.add(item.file);

  // Add file-to-file edges from the dependency graph
  for (const edge of index.graph.edges) {
    if (edge.to.type === "file") {
      if (!relevantFiles.has(edge.from) || !relevantFiles.has(edge.to.path)) {
        continue;
      }
      const fileEdge: { from: FileId; to: FileId; typeOnly?: boolean } = {
        from: edge.from,
        to: edge.to.path,
      };
      if (edge.typeOnly !== undefined) {
        fileEdge.typeOnly = edge.typeOnly;
      }
      fileEdges.push(fileEdge);
    }
  }

  // Add real symbol-to-symbol edges using detailed symbol graph
  if (changedSymbols?.length) {
    const detailedGraph = await buildSymbolGraphDetailed(index, {
      scope: "all",
      files: relevantFiles,
      maxEdges: 10000, // Reasonable limit for impact analysis
      membersOnly: false,
    });

    // Create a map from symbol ID to index in changedSymbols array
    const symbolIdToIndex = new Map<string, number>();
    for (let i = 0; i < changedSymbols.length; i++) {
      symbolIdToIndex.set(changedSymbols[i]!.id, i);
    }

    // Add edges between changed symbols, pruned to only include changed symbols
    for (const edge of detailedGraph.edges) {
      const fromNode = detailedGraph.nodes.get(edge.from);
      const toNode = detailedGraph.nodes.get(edge.to);
      if (fromNode && toNode && fromNode.file !== toNode.file) {
        const couplingKey = `${fromNode.file} -> ${toNode.file}`;
        const current = symbolCoupling.get(couplingKey) ?? 0;
        symbolCoupling.set(couplingKey, current + 1);
      }

      const fromIndex = symbolIdToIndex.get(edge.from);
      const toIndex = symbolIdToIndex.get(edge.to);

      if (fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
        symbolEdges.push({
          from: fromIndex,
          to: toIndex,
          label: edge.label || "uses",
        });
      }
    }
  }

  const changedFileEntries = normalizedDiffFiles.map((fileChange) => ({
    file: normalizePath(fileChange.path),
  }));
  const clusters = buildClusters(changedFileEntries, impactedItems, fileEdges);
  const cycles = buildImpactCycles(index, changedFileEntries, impactedItems, symbolCoupling);

  // Check if compact format is requested
  if (options.compact) {
    const report = buildCompactImpactReport({
      changedFiles,
      changedSymbols,
      impactedItems,
      suggestions,
      exportSummary,
      reexportChains,
      topImpacts,
      surfaceArea,
      clusters,
      cycles,
      fileEdges,
      symbolEdges,
      projectFiles,
      displayFile,
    });
    if (options.warning) report.warning = options.warning;
    if (diagnostics) report.diagnostics = diagnostics;
    return report;
  }

  return buildFullImpactReport({
    projectFiles,
    changedFiles,
    changedSymbols,
    impactedItems,
    suggestions,
    exportSummary,
    reexportChains,
    topImpacts,
    surfaceArea,
    clusters,
    cycles,
    fileEdges,
    symbolEdges,
    displayFile,
    diagnostics,
    warning: options.warning,
  });
}

function buildImpactCycles(
  index: ProjectIndex,
  changedFiles: Array<{ file: FileId }>,
  impactedItems: ImpactItem[],
  symbolCoupling: Map<string, number>,
): ImpactCycle[] {
  const canonicalizeFile = createGraphFileResolver(index.graph.nodes);

  const changedSet = new Set(changedFiles.map((entry) => canonicalizeFile(entry.file)));
  const impactedSet = new Set(impactedItems.map((entry) => entry.file));
  const out: ImpactCycle[] = [];
  for (const cycle of findDetailedCycles(index.graph, { symbolCoupling })) {
    const touchesChangedFile = cycle.files.some((file) => changedSet.has(file));
    const touchesImpactedFile = cycle.files.some((file) => impactedSet.has(file));
    if (!touchesChangedFile && !touchesImpactedFile) continue;
    out.push({
      files: cycle.files,
      entryEdges: cycle.entryEdges,
      internalEdges: cycle.internalEdges,
      fileCount: cycle.fileCount,
      internalEdgeCount: cycle.internalEdgeCount,
      fanInFromOutside: cycle.fanInFromOutside,
      priorityScore: cycle.priorityScore,
      remediationHint: cycle.remediationHint,
      touchesChangedFile,
      touchesImpactedFile,
      severity: touchesChangedFile ? "high" : "medium",
    });
  }
  return out;
}

type ReexportEdge = {
  exporter: FileId;
  type: "reexport" | "exportStar" | "namespaceReexport";
  sourceSpecifier?: string;
};

const REEXPORT_CHAIN_MAX_DEPTH = 3;

function buildReexportChains(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  maxDepth = REEXPORT_CHAIN_MAX_DEPTH,
): { chains: ReexportChainEntry[] } | undefined {
  const exportedSymbols = changedSymbols.filter((symbol) => symbol.exported);
  if (!exportedSymbols.length) return undefined;

  const reexportsBySource = new Map<FileId, ReexportEdge[]>();
  for (const [file, mod] of index.byFile) {
    for (const entry of mod.exports) {
      if (entry.type !== "reexport" && entry.type !== "exportStar" && entry.type !== "namespaceReexport") {
        continue;
      }
      let resolvedSourcePath = entry.fromModule;
      if (entry.fromModule.startsWith(".")) {
        resolvedSourcePath = resolveFilePathFromRoot(path.dirname(file), entry.fromModule);
      }
      const sourceFile = normalizePath(resolvedSourcePath);
      const edges = reexportsBySource.get(sourceFile) ?? [];
      const edge: ReexportEdge = {
        exporter: file,
        type: entry.type,
      };
      if (entry.type === "reexport") {
        edge.sourceSpecifier = entry.sourceSpecifier;
      }
      edges.push(edge);
      reexportsBySource.set(sourceFile, edges);
    }
  }

  const chains: ReexportChainEntry[] = [];
  for (const symbol of exportedSymbols) {
    const paths: FileId[][] = [];
    const seenPaths = new Set<string>();
    const stack: Array<{
      file: FileId;
      path: FileId[];
      pathSet: Set<FileId>;
      depth: number;
    }> = [
      {
        file: symbol.file,
        path: [symbol.file],
        pathSet: new Set([symbol.file]),
        depth: 0,
      },
    ];

    while (stack.length) {
      const current = stack.pop()!;
      const edges = reexportsBySource.get(current.file) ?? [];
      for (const edge of edges) {
        // Only filter named re-exports by symbol name. Export-star and namespace
        // re-exports include all symbols from the source module.
        if (edge.type === "reexport" && edge.sourceSpecifier !== symbol.name) {
          continue;
        }
        if (current.pathSet.has(edge.exporter)) {
          continue;
        }
        const nextPath = [...current.path, edge.exporter];
        const nextPathSet = new Set(current.pathSet);
        nextPathSet.add(edge.exporter);
        const key = nextPath.join("::");
        if (!seenPaths.has(key)) {
          paths.push(nextPath);
          seenPaths.add(key);
        }
        if (current.depth + 1 < maxDepth) {
          stack.push({
            file: edge.exporter,
            path: nextPath,
            pathSet: nextPathSet,
            depth: current.depth + 1,
          });
        }
      }
    }

    chains.push({
      symbol: symbol.name,
      file: symbol.file,
      paths,
    });
  }

  return { chains };
}

const TOP_IMPACTS_LIMIT = 10;

function buildExportSummary(changedSymbols: ChangedSymbol[]): ExportSummaryEntry[] {
  const byFile = new Map<FileId, Set<string>>();
  for (const symbol of changedSymbols) {
    if (!symbol.exported) continue;
    const existing = byFile.get(symbol.file) ?? new Set<string>();
    existing.add(symbol.name);
    byFile.set(symbol.file, existing);
  }
  return [...byFile.entries()].map(([file, symbols]) => ({
    file,
    symbols: [...symbols].sort(),
  }));
}

function buildTopImpacts(impactedItems: ImpactItem[]): ImpactTopItem[] {
  return impactedItems.slice(0, TOP_IMPACTS_LIMIT).map((item) => ({
    file: item.file,
    symbols: item.symbols,
    reasons: item.reasons,
    severity: item.severity,
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
    ...(item.explain ? { explain: item.explain } : {}),
  }));
}

const SURFACE_AREA_LIMIT = 10;

function buildClusters(
  changedFiles: Array<{ file: FileId }>,
  impactedItems: ImpactItem[],
  fileEdges: Array<{ from: FileId; to: FileId }>,
): ImpactCluster[] {
  const changedFilesSet = new Set(changedFiles.map((file) => file.file));
  const impactedFilesSet = new Set(impactedItems.map((item) => item.file));
  const candidateFiles = new Set<FileId>([...changedFilesSet, ...impactedFilesSet]);

  if (candidateFiles.size === 0) {
    return [];
  }

  const adjacency = new Map<FileId, Set<FileId>>();
  for (const file of candidateFiles) {
    adjacency.set(file, new Set());
  }

  for (const edge of fileEdges) {
    if (!candidateFiles.has(edge.from) || !candidateFiles.has(edge.to)) {
      continue;
    }
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const severityByFile = new Map<FileId, number>();
  for (const item of impactedItems) {
    const current = severityByFile.get(item.file) ?? 0;
    severityByFile.set(item.file, current + item.severity);
  }

  const orderedFiles = Array.from(candidateFiles).sort((a, b) => a.localeCompare(b));
  const visited = new Set<FileId>();
  const clusters: ImpactCluster[] = [];

  for (const file of orderedFiles) {
    if (visited.has(file)) {
      continue;
    }

    const queue: FileId[] = [file];
    let queueIndex = 0;
    visited.add(file);
    const componentFiles: FileId[] = [];

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (!current) continue;
      componentFiles.push(current);
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    componentFiles.sort((a, b) => a.localeCompare(b));
    const componentChanged = componentFiles.filter((componentFile) => changedFilesSet.has(componentFile));

    let totalSeverity = 0;
    for (const componentFile of componentFiles) {
      totalSeverity += severityByFile.get(componentFile) ?? 0;
    }

    clusters.push({
      id: 0,
      files: componentFiles,
      changedFiles: componentChanged,
      totalSeverity,
    });
  }

  clusters.sort((a, b) => {
    if (a.totalSeverity !== b.totalSeverity) {
      return b.totalSeverity - a.totalSeverity;
    }
    const aKey = a.files[0] ?? "";
    const bKey = b.files[0] ?? "";
    if (aKey !== bKey) {
      return aKey.localeCompare(bKey);
    }
    return a.files.length - b.files.length;
  });

  for (let i = 0; i < clusters.length; i++) {
    clusters[i]!.id = i + 1;
  }

  return clusters;
}

function buildSurfaceArea(
  index: ProjectIndex,
  diffFiles: FileChange[],
  impactedItems: ImpactItem[],
): ImpactSurfaceArea {
  const fanIn = new Map<FileId, number>();
  const fanOut = new Map<FileId, number>();

  for (const node of index.graph.nodes) {
    const normalizedNode = normalizePath(node);
    fanIn.set(normalizedNode, 0);
    fanOut.set(normalizedNode, 0);
  }

  for (const edge of index.graph.edges) {
    const from = normalizePath(edge.from);
    fanOut.set(from, (fanOut.get(from) || 0) + 1);
    if (edge.to.type === "file") {
      const to = normalizePath(edge.to.path);
      fanIn.set(to, (fanIn.get(to) || 0) + 1);
    }
  }

  const changedFiles = new Set(diffFiles.map((fileChange) => normalizePath(fileChange.path)));
  const impactedFiles = new Set(impactedItems.map((item) => normalizePath(item.file)));

  const files = Array.from(index.graph.nodes).map((file) => {
    const normalizedFile = normalizePath(file);
    return {
      file: normalizedFile,
      fanIn: fanIn.get(normalizedFile) || 0,
      fanOut: fanOut.get(normalizedFile) || 0,
      changed: changedFiles.has(normalizedFile),
      impacted: impactedFiles.has(normalizedFile),
    };
  });

  const topFanIn = [...files]
    .sort((a, b) => {
      if (b.fanIn !== a.fanIn) return b.fanIn - a.fanIn;
      return a.file.localeCompare(b.file);
    })
    .slice(0, SURFACE_AREA_LIMIT)
    .map((item) => item.file);

  const topFanOut = [...files]
    .sort((a, b) => {
      if (b.fanOut !== a.fanOut) return b.fanOut - a.fanOut;
      return a.file.localeCompare(b.file);
    })
    .slice(0, SURFACE_AREA_LIMIT)
    .map((item) => item.file);

  return { files, topFanIn, topFanOut };
}
