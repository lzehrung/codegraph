import type { FileId } from "../types.js";
import type { ProjectIndex } from "../indexer.js";
import type { FileChange, ChangedSymbol, ImpactItem, ImpactReport, CompactImpactReport, ImpactOptions } from "./types.js";
import { buildSymbolGraphDetailed } from "../graphs.js";

export async function buildImpactReport(
  index: ProjectIndex,
  diffFiles: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  options: Partial<ImpactOptions> = {}
): Promise<ImpactReport | CompactImpactReport> {
  // Build changedFiles summary
  const changedFiles = diffFiles.map(fileChange => ({
    file: fileChange.path,
    hunks: fileChange.hunks.map(hunk => ({
      start: hunk.startLine,
      end: hunk.startLine + hunk.lines.length - 1
    }))
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
      if (
        !relevantFiles.has(edge.from) ||
        !relevantFiles.has(edge.to.path)
      ) {
        continue;
      }
      const fileEdge: { from: FileId; to: FileId; typeOnly?: boolean } = {
        from: edge.from,
        to: edge.to.path
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
      membersOnly: false
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

      if (fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
        symbolEdges.push({
          from: fromIndex,
          to: toIndex,
          label: edge.label || "uses"
        });
      }
    }
  }

  // Check if compact format is requested
  if (options.compact) {
    return buildCompactReport(
      index,
      changedFiles,
      changedSymbols,
      impactedItems,
      fileEdges,
      symbolEdges
    );
  }

  return {
    changedFiles,
    changedSymbols,
    impacted: impactedItems,
    graph: {
      fileEdges,
      symbolEdges
    }
  };
}

function buildCompactReport(
  index: ProjectIndex,
  changedFiles: Array<{ file: FileId; hunks: Array<{ start: number; end: number }> }>,
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[],
  fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean | undefined }>,
  symbolEdges: Array<{ from: number; to: number; label: string }>
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

  const filesArray = Array.from(allFiles);
  const fileIndex = new Map<FileId, number>();
  for (let i = 0; i < filesArray.length; i++) {
    fileIndex.set(filesArray[i]!, i);
  }

  // Convert to compact format
  const compactChangedFiles = changedFiles.map(cf => ({
    file: fileIndex.get(cf.file)!,
    hunks: cf.hunks
  }));

  const compactChangedSymbols = changedSymbols.map(cs => {
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
      range: cs.range
    };

    if (cs.typeOnly !== undefined) {
      symbol.typeOnly = cs.typeOnly;
    }

    return symbol;
  });

  const compactImpacted = impactedItems.map(ii => {
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
      severity: ii.severity
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

  const compactFileEdges = fileEdges.map(fe => {
    const edge: { from: number; to: number; typeOnly?: boolean } = {
      from: fileIndex.get(fe.from)!,
      to: fileIndex.get(fe.to)!
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
    graph: {
      fileEdges: compactFileEdges,
      symbolEdges
    }
  };
}
