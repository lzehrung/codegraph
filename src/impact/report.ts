import type { FileId } from "../types.js";
import type { ProjectIndex } from "../indexer.js";
import type { FileChange, ChangedSymbol, ImpactItem, ImpactReport } from "./types.js";

export function buildImpactReport(
  index: ProjectIndex,
  diffFiles: FileChange[],
  changedSymbols: ChangedSymbol[],
  impactedItems: ImpactItem[]
): ImpactReport {
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

  // Add file-to-file edges from the dependency graph
  for (const edge of index.graph.edges) {
    if (edge.to.type === "file") {
      fileEdges.push({
        from: edge.from,
        to: edge.to.path,
        typeOnly: edge.typeOnly
      });
    }
  }

  // Add symbol-to-symbol edges for changed symbols
  // This would be enhanced if we add detailed symbol graph analysis
  for (let i = 0; i < changedSymbols.length; i++) {
    for (let j = 0; j < changedSymbols.length; j++) {
      if (i !== j) {
        // Simple heuristic: if symbols are in same file, they might be related
        if (changedSymbols[i].file === changedSymbols[j].file) {
          symbolEdges.push({ from: i, to: j, label: "sameFile" });
        }
      }
    }
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
