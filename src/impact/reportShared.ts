import type { FileId } from "../types.js";
import type { ExportSummaryEntry, ImpactTopItem, ReexportChainEntry } from "./types.js";

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
