import type { FileId } from "../types.js";
import { type ProjectIndex } from "../indexer/types.js";
import {
  buildOptionalExportSummary,
  buildOptionalReexportChains,
  buildOptionalTopImpacts,
  mapFileEdges,
} from "./reportShared.js";
import { IMPACT_SCHEMA_VERSION } from "./types.js";
import type {
  ChangedSymbol,
  ExportSummaryEntry,
  ImpactCluster,
  ImpactCycle,
  ImpactDiagnostics,
  ImpactItem,
  ImpactReport,
  ImpactSuggestion,
  ImpactSurfaceArea,
  ImpactTopItem,
  ReexportChainEntry,
} from "./types.js";

export type FullImpactReportParts = {
  changedFiles: Array<{
    file: FileId;
    hunks: Array<{ start: number; end: number }>;
  }>;
  changedSymbols: ChangedSymbol[];
  impactedItems: ImpactItem[];
  suggestions: ImpactSuggestion[];
  exportSummary: ExportSummaryEntry[];
  reexportChains: { chains: ReexportChainEntry[] } | undefined;
  topImpacts: ImpactTopItem[];
  surfaceArea: ImpactSurfaceArea;
  clusters: ImpactCluster[];
  cycles: ImpactCycle[];
  fileEdges: Array<{
    from: FileId;
    to: FileId;
    typeOnly?: boolean | undefined;
  }>;
  symbolEdges: Array<{ from: number; to: number; label: string }>;
  projectFiles: ProjectIndex["projectFiles"];
  displayFile: (file: FileId) => FileId;
  diagnostics?: ImpactDiagnostics | undefined;
  warning?: string | undefined;
};

export function buildFullImpactReport(parts: FullImpactReportParts): ImpactReport {
  const report: ImpactReport = {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    format: "full",
    ...(parts.projectFiles ? { projectFiles: parts.projectFiles } : {}),
    changedFiles: parts.changedFiles,
    changedSymbols: parts.changedSymbols.map((symbol) => ({
      ...symbol,
      file: parts.displayFile(symbol.file),
    })),
    impacted: parts.impactedItems.map((item) => ({
      ...item,
      file: parts.displayFile(item.file),
    })),
    ...buildFullSuggestions(parts.suggestions, parts.displayFile),
    ...buildOptionalExportSummary(parts.exportSummary, parts.displayFile),
    ...buildOptionalReexportChains(parts.reexportChains, parts.displayFile),
    ...buildOptionalTopImpacts(parts.topImpacts, parts.displayFile),
    surfaceArea: {
      files: parts.surfaceArea.files.map((item) => ({
        ...item,
        file: parts.displayFile(item.file),
      })),
      topFanIn: parts.surfaceArea.topFanIn.map((file) => parts.displayFile(file)),
      topFanOut: parts.surfaceArea.topFanOut.map((file) => parts.displayFile(file)),
    },
    clusters: parts.clusters.map((cluster) => ({
      ...cluster,
      files: cluster.files.map((file) => parts.displayFile(file)),
      changedFiles: cluster.changedFiles.map((file) => parts.displayFile(file)),
    })),
    ...buildFullCycles(parts.cycles, parts.displayFile),
    graph: {
      fileEdges: mapFileEdges(parts.fileEdges, parts.displayFile),
      symbolEdges: parts.symbolEdges,
    },
  };
  if (parts.diagnostics) report.diagnostics = parts.diagnostics;
  if (parts.warning) report.warning = parts.warning;
  return report;
}

function buildFullSuggestions(
  suggestions: ImpactSuggestion[],
  displayFile: (file: FileId) => FileId,
): Pick<ImpactReport, "suggestions"> {
  if (!suggestions.length) return {};
  return {
    suggestions: suggestions.map((suggestion) => ({
      ...suggestion,
      file: displayFile(suggestion.file),
      ...(suggestion.relatedFile ? { relatedFile: displayFile(suggestion.relatedFile) } : {}),
    })),
  };
}

function buildFullCycles(cycles: ImpactCycle[], displayFile: (file: FileId) => FileId): Pick<ImpactReport, "cycles"> {
  if (!cycles.length) return {};
  return {
    cycles: cycles.map((cycle) => ({
      ...cycle,
      files: cycle.files.map((file) => displayFile(file)),
      entryEdges: cycle.entryEdges.map((edge) => ({
        ...edge,
        from: displayFile(edge.from),
        to: displayFile(edge.to),
      })),
      internalEdges: cycle.internalEdges.map((edge) => ({
        ...edge,
        from: displayFile(edge.from),
        to: displayFile(edge.to),
      })),
    })),
  };
}
