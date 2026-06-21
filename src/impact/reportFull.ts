import type { FileId } from "../types.js";
import {
  buildOptionalExportSummary,
  buildOptionalReexportChains,
  buildOptionalTopImpacts,
  mapFileEdges,
  mapImpactCyclesForDisplay,
} from "./reportShared.js";
import type { ImpactReportPartsBase } from "./reportParts.js";
import { IMPACT_SCHEMA_VERSION } from "./types.js";
import type { ImpactCycle, ImpactDiagnostics, ImpactReport, ImpactSuggestion } from "./types.js";

export type FullImpactReportParts = ImpactReportPartsBase & {
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
    cycles: mapImpactCyclesForDisplay(cycles, displayFile),
  };
}
