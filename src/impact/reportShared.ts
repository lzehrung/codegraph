import type { FileId } from "../types.js";
import type {
  CallCompatibilityHint,
  ExportSummaryEntry,
  ImpactSuggestion,
  ImpactSurfaceAreaFile,
  ImpactTopItem,
  ReexportChainEntry,
} from "./types.js";

export type MappedExportSummaryEntry<TFile extends FileId | number> = Omit<ExportSummaryEntry, "file"> & {
  file: TFile;
};

export type MappedReexportChainEntry<TFile extends FileId | number> = Omit<ReexportChainEntry, "file" | "paths"> & {
  file: TFile;
  paths: TFile[][];
};

export type MappedImpactTopItem<TFile extends FileId | number> = Omit<ImpactTopItem, "file"> & {
  file: TFile;
};

export function mapExportSummary<TFile extends FileId | number>(
  exportSummary: readonly ExportSummaryEntry[],
  mapFile: (file: FileId) => TFile,
): Array<MappedExportSummaryEntry<TFile>> {
  return exportSummary.map((entry) => ({
    ...entry,
    file: mapFile(entry.file),
  }));
}

export function mapReexportChains<TFile extends FileId | number>(
  reexportChains: { chains: ReexportChainEntry[] } | undefined,
  mapFile: (file: FileId) => TFile,
): { chains: Array<MappedReexportChainEntry<TFile>> } | undefined {
  if (!reexportChains) return undefined;
  return {
    chains: reexportChains.chains.map((entry) => ({
      ...entry,
      file: mapFile(entry.file),
      paths: entry.paths.map((pathChain) => pathChain.map((file) => mapFile(file))),
    })),
  };
}

export function mapTopImpacts<TFile extends FileId | number>(
  topImpacts: readonly ImpactTopItem[],
  mapFile: (file: FileId) => TFile,
): Array<MappedImpactTopItem<TFile>> {
  return topImpacts.map((item) => ({
    ...item,
    file: mapFile(item.file),
  }));
}

export function buildOptionalExportSummary<TFile extends FileId | number>(
  exportSummary: readonly ExportSummaryEntry[],
  mapFile: (file: FileId) => TFile,
): { exportSummary?: Array<MappedExportSummaryEntry<TFile>> } {
  if (!exportSummary.length) return {};
  return { exportSummary: mapExportSummary(exportSummary, mapFile) };
}

export function buildOptionalReexportChains<TFile extends FileId | number>(
  reexportChains: { chains: ReexportChainEntry[] } | undefined,
  mapFile: (file: FileId) => TFile,
): { reexportChains?: { chains: Array<MappedReexportChainEntry<TFile>> } } {
  const mapped = mapReexportChains(reexportChains, mapFile);
  if (!mapped) return {};
  return { reexportChains: mapped };
}

export function buildOptionalTopImpacts<TFile extends FileId | number>(
  topImpacts: readonly ImpactTopItem[],
  mapFile: (file: FileId) => TFile,
): { topImpacts?: Array<MappedImpactTopItem<TFile>> } {
  if (!topImpacts.length) return {};
  return { topImpacts: mapTopImpacts(topImpacts, mapFile) };
}

export type MappedImpactSuggestion<TFile extends FileId | number> = Omit<ImpactSuggestion, "file" | "relatedFile"> & {
  file: TFile;
  relatedFile?: TFile;
};

// Generic over both directions: compact serialization maps FileId -> number, while the CLI
// re-hydrates a compact report by mapping number -> FileId.
export function mapSuggestions<TIn extends FileId | number, TOut extends FileId | number>(
  suggestions: readonly MappedImpactSuggestion<TIn>[],
  mapFile: (file: TIn) => TOut,
): Array<MappedImpactSuggestion<TOut>> {
  return suggestions.map((suggestion) => ({
    file: mapFile(suggestion.file),
    kind: suggestion.kind,
    ...(suggestion.range ? { range: suggestion.range } : {}),
    ...(suggestion.symbol ? { symbol: suggestion.symbol } : {}),
    ...(suggestion.relatedFile !== undefined ? { relatedFile: mapFile(suggestion.relatedFile) } : {}),
    ...(suggestion.details ? { details: suggestion.details } : {}),
    confidence: suggestion.confidence,
  }));
}

export type MappedImpactSurfaceArea<TFile extends FileId | number> = {
  files: Array<Omit<ImpactSurfaceAreaFile, "file"> & { file: TFile }>;
  topFanIn: TFile[];
  topFanOut: TFile[];
};

export function mapSurfaceArea<TIn extends FileId | number, TOut extends FileId | number>(
  surfaceArea: MappedImpactSurfaceArea<TIn>,
  mapFile: (file: TIn) => TOut,
): MappedImpactSurfaceArea<TOut> {
  return {
    files: surfaceArea.files.map((item) => ({
      file: mapFile(item.file),
      fanIn: item.fanIn,
      fanOut: item.fanOut,
      changed: item.changed,
      impacted: item.impacted,
    })),
    topFanIn: surfaceArea.topFanIn.map((file) => mapFile(file)),
    topFanOut: surfaceArea.topFanOut.map((file) => mapFile(file)),
  };
}

/**
 * Render the required-argument-count clause of a call-compatibility hint for human-facing summaries.
 * Shared by the impact and review CLI presenters.
 */
export function formatRequiredArgumentCount(hint: CallCompatibilityHint): string {
  if (hint.reason === "argument_count_above_maximum" && hint.expected.maxArgs !== null) {
    return `accepts at most ${hint.expected.maxArgs}`;
  }
  return `requires ${hint.expected.minArgs}`;
}

export function mapFileEdges<TFile extends FileId | number>(
  fileEdges: ReadonlyArray<{ from: FileId; to: FileId; typeOnly?: boolean | undefined }>,
  mapFile: (file: FileId) => TFile,
): Array<{ from: TFile; to: TFile; typeOnly?: boolean }> {
  return fileEdges.map((edge) => {
    const mapped: { from: TFile; to: TFile; typeOnly?: boolean } = {
      from: mapFile(edge.from),
      to: mapFile(edge.to),
    };
    if (edge.typeOnly !== undefined) {
      mapped.typeOnly = edge.typeOnly;
    }
    return mapped;
  });
}
