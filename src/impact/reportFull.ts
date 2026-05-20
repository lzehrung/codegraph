import type { FileId } from "../types.js";
import type { ProjectIndex } from "../indexer.js";
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
    ...buildFullExportSummary(parts.exportSummary, parts.displayFile),
    ...buildFullReexportChains(parts.reexportChains, parts.displayFile),
    ...buildFullTopImpacts(parts.topImpacts, parts.displayFile),
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
      fileEdges: parts.fileEdges.map((edge) => {
        const fileEdge: { from: FileId; to: FileId; typeOnly?: boolean } = {
          from: parts.displayFile(edge.from),
          to: parts.displayFile(edge.to),
        };
        if (edge.typeOnly !== undefined) {
          fileEdge.typeOnly = edge.typeOnly;
        }
        return fileEdge;
      }),
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

function buildFullExportSummary(
  exportSummary: ExportSummaryEntry[],
  displayFile: (file: FileId) => FileId,
): Pick<ImpactReport, "exportSummary"> {
  if (!exportSummary.length) return {};
  return {
    exportSummary: exportSummary.map((entry) => ({
      ...entry,
      file: displayFile(entry.file),
    })),
  };
}

function buildFullReexportChains(
  reexportChains: { chains: ReexportChainEntry[] } | undefined,
  displayFile: (file: FileId) => FileId,
): Pick<ImpactReport, "reexportChains"> {
  if (!reexportChains) return {};
  return {
    reexportChains: {
      chains: reexportChains.chains.map((entry) => ({
        ...entry,
        file: displayFile(entry.file),
        paths: entry.paths.map((pathChain) => pathChain.map((file) => displayFile(file))),
      })),
    },
  };
}

function buildFullTopImpacts(
  topImpacts: ImpactTopItem[],
  displayFile: (file: FileId) => FileId,
): Pick<ImpactReport, "topImpacts"> {
  if (!topImpacts.length) return {};
  return {
    topImpacts: topImpacts.map((item) => ({
      ...item,
      file: displayFile(item.file),
    })),
  };
}

function buildFullCycles(
  cycles: ImpactCycle[],
  displayFile: (file: FileId) => FileId,
): Pick<ImpactReport, "cycles"> {
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
