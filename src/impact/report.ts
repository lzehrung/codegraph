import type { FileId } from "../types.js";
import path from "node:path";
import type { ProjectIndex } from "../indexer.js";
import type {
  FileChange,
  ChangedSymbol,
  ImpactItem,
  ImpactReport,
  CompactImpactReport,
  ImpactOptions,
  ImpactSuggestion,
  ExportSummaryEntry,
  ImpactTopItem,
  ImpactSurfaceArea,
  CompactImpactSurfaceArea,
} from "./types.js";
import { buildSymbolGraphDetailed } from "../graphs.js";
import { normalizePath } from "../util.js";

export async function buildImpactReport(
  projectRoot: string,
  index: ProjectIndex,
  diffFiles: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  suggestions: ImpactSuggestion[],
  options: Partial<ImpactOptions> & { warning?: string | undefined } = {},
): Promise<ImpactReport | CompactImpactReport> {
  const exportSummary = buildExportSummary(changedSymbols);
  const topImpacts = buildTopImpacts(impactedItems);
  const surfaceArea = buildSurfaceArea(
    projectRoot,
    index,
    diffFiles,
    impactedItems,
  );
  const newFileRangeForHunk = (hunk: FileChange["hunks"][number]) => {
    let newLine = hunk.newStart;
    let lastNewLine = newLine - 1;
    for (const line of hunk.lines) {
      if (line.startsWith(" ") || line.startsWith("+")) {
        lastNewLine = newLine;
        newLine++;
      }
    }
    const end = Math.max(hunk.newStart, lastNewLine);
    return { start: hunk.newStart, end };
  };

  // Build changedFiles summary
  const changedFiles = diffFiles.map((fileChange) => ({
    file: fileChange.path,
    hunks: fileChange.hunks.map((hunk) => newFileRangeForHunk(hunk)),
  }));

  // Build graph data
  const fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }> = [];
  const symbolEdges: Array<{ from: number; to: number; label: string }> = [];

  const relevantFiles = new Set<FileId>();
  for (const fileChange of diffFiles) relevantFiles.add(fileChange.path);
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
  if (changedSymbols?.length > 0) {
    const detailedGraph = await buildSymbolGraphDetailed(index, {
      scope: "all",
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
      const fromIndex = symbolIdToIndex.get(edge.from);
      const toIndex = symbolIdToIndex.get(edge.to);

      if (
        fromIndex !== undefined &&
        toIndex !== undefined &&
        fromIndex !== toIndex
      ) {
        symbolEdges.push({
          from: fromIndex,
          to: toIndex,
          label: edge.label || "uses",
        });
      }
    }
  }

  // Check if compact format is requested
  if (options.compact) {
    const report = buildCompactReport(
      index,
      changedFiles,
      changedSymbols,
      impactedItems,
      suggestions,
      exportSummary,
      topImpacts,
      surfaceArea,
      fileEdges,
      symbolEdges,
    );
    if (options.warning) report.warning = options.warning;
    return report;
  }

  const report: ImpactReport = {
    changedFiles,
    changedSymbols,
    impacted: impactedItems,
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(exportSummary.length > 0 ? { exportSummary } : {}),
    ...(topImpacts.length > 0 ? { topImpacts } : {}),
    surfaceArea,
    graph: {
      fileEdges,
      symbolEdges,
    },
  };
  if (options.warning) report.warning = options.warning;
  return report;
}

function buildCompactReport(
  index: ProjectIndex,
  changedFiles: Array<{
    file: FileId;
    hunks: Array<{ start: number; end: number }>;
  }>,
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  suggestions: ImpactSuggestion[],
  exportSummary: ExportSummaryEntry[],
  topImpacts: ImpactTopItem[],
  surfaceArea: ImpactSurfaceArea,
  fileEdges: Array<{
    from: FileId;
    to: FileId;
    typeOnly?: boolean | undefined;
  }>,
  symbolEdges: Array<{ from: number; to: number; label: string }>,
): CompactImpactReport {
  // Collect all unique file paths
  const allFiles = new Set<FileId>();

  // Add files from changedFiles
  for (const cf of changedFiles) {
    allFiles.add(cf.file);
  }

  // Add files from changedSymbols
  for (const cs of changedSymbols) {
    allFiles.add(cs.file);
  }

  // Add files from impactedItems
  for (const ii of impactedItems) {
    allFiles.add(ii.file);
  }

  // Add files from fileEdges
  for (const fe of fileEdges) {
    allFiles.add(fe.from);
    allFiles.add(fe.to);
  }

  // Add files from surface area
  for (const item of surfaceArea.files) {
    allFiles.add(item.file);
  }
  for (const file of surfaceArea.topFanIn) {
    allFiles.add(file);
  }
  for (const file of surfaceArea.topFanOut) {
    allFiles.add(file);
  }

  // Add files from suggestions
  for (const suggestion of suggestions) {
    allFiles.add(suggestion.file);
    if (suggestion.relatedFile) allFiles.add(suggestion.relatedFile);
  }

  const filesArray = Array.from(allFiles);
  const fileIndex = new Map<FileId, number>();
  for (let i = 0; i < filesArray.length; i++) {
    fileIndex.set(filesArray[i]!, i);
  }

  // Convert to compact format
  const compactChangedFiles = changedFiles.map((cf) => ({
    file: fileIndex.get(cf.file)!,
    hunks: cf.hunks,
  }));

  const compactChangedSymbols = changedSymbols.map((cs) => {
    const symbol: {
      id: string;
      file: number;
      name: string;
      kind: any;
      exported: boolean;
      range: any;
      typeOnly?: boolean;
    } = {
      id: cs.id,
      file: fileIndex.get(cs.file)!,
      name: cs.name,
      kind: cs.kind,
      exported: cs.exported,
      range: cs.range,
    };

    if (cs.typeOnly !== undefined) {
      symbol.typeOnly = cs.typeOnly;
    }

    return symbol;
  });

  const compactImpacted = impactedItems.map((ii) => {
    const item: {
      file: number;
      symbols: string[];
      reasons: any[];
      severity: number;
      depth?: number;
      typeOnly?: boolean;
      explain?: any;
    } = {
      file: fileIndex.get(ii.file)!,
      symbols: ii.symbols,
      reasons: ii.reasons,
      severity: ii.severity,
    };

    if (ii.depth !== undefined) {
      item.depth = ii.depth;
    }
    if (ii.typeOnly !== undefined) {
      item.typeOnly = ii.typeOnly;
    }
    if (ii.explain !== undefined) {
      item.explain = ii.explain;
    }

    return item;
  });

  const compactSuggestions =
    suggestions.length > 0
      ? suggestions.map((suggestion) => ({
          file: fileIndex.get(suggestion.file)!,
          kind: suggestion.kind,
          ...(suggestion.range ? { range: suggestion.range } : {}),
          ...(suggestion.symbol ? { symbol: suggestion.symbol } : {}),
          ...(suggestion.relatedFile !== undefined
            ? { relatedFile: fileIndex.get(suggestion.relatedFile)! }
            : {}),
          ...(suggestion.details ? { details: suggestion.details } : {}),
        }))
      : undefined;

  const compactExportSummary =
    exportSummary.length > 0
      ? exportSummary.map((entry) => ({
          file: fileIndex.get(entry.file)!,
          symbols: entry.symbols,
        }))
      : undefined;

  const compactTopImpacts =
    topImpacts.length > 0
      ? topImpacts.map((item) => ({
          file: fileIndex.get(item.file)!,
          symbols: item.symbols,
          reasons: item.reasons,
          severity: item.severity,
          ...(item.depth !== undefined ? { depth: item.depth } : {}),
          ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
          ...(item.explain ? { explain: item.explain } : {}),
        }))
      : undefined;

  const compactSurfaceArea: CompactImpactSurfaceArea = {
    files: surfaceArea.files.map((item) => ({
      file: fileIndex.get(item.file)!,
      fanIn: item.fanIn,
      fanOut: item.fanOut,
      changed: item.changed,
      impacted: item.impacted,
    })),
    topFanIn: surfaceArea.topFanIn.map((file) => fileIndex.get(file)!),
    topFanOut: surfaceArea.topFanOut.map((file) => fileIndex.get(file)!),
  };

  const compactFileEdges = fileEdges.map((fe) => {
    const edge: { from: number; to: number; typeOnly?: boolean } = {
      from: fileIndex.get(fe.from)!,
      to: fileIndex.get(fe.to)!,
    };
    if (fe.typeOnly !== undefined) {
      edge.typeOnly = fe.typeOnly;
    }
    return edge;
  });

  return {
    files: filesArray,
    changedFiles: compactChangedFiles,
    changedSymbols: compactChangedSymbols,
    impacted: compactImpacted,
    ...(compactSuggestions ? { suggestions: compactSuggestions } : {}),
    ...(compactExportSummary ? { exportSummary: compactExportSummary } : {}),
    ...(compactTopImpacts ? { topImpacts: compactTopImpacts } : {}),
    surfaceArea: compactSurfaceArea,
    graph: {
      fileEdges: compactFileEdges,
      symbolEdges,
    },
  };
}

const TOP_IMPACTS_LIMIT = 10;

function buildExportSummary(
  changedSymbols: ChangedSymbol[],
): ExportSummaryEntry[] {
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
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
    ...(item.explain ? { explain: item.explain } : {}),
  }));
}

const SURFACE_AREA_LIMIT = 10;

function buildSurfaceArea(
  projectRoot: string,
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

  const changedFiles = new Set(
    diffFiles.map((fileChange) =>
      normalizePath(
        path.isAbsolute(fileChange.path)
          ? fileChange.path
          : path.resolve(projectRoot, fileChange.path),
      ),
    ),
  );
  const impactedFiles = new Set(
    impactedItems.map((item) => normalizePath(item.file)),
  );

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
