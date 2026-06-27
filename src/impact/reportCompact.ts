import type { FileId } from "../types.js";
import type { AnalysisSummary } from "../analysisSummary.js";
import {
  buildOptionalExportSummary,
  buildOptionalReexportChains,
  buildOptionalTopImpacts,
  mapFileEdges,
  mapSuggestions,
  mapImpactCyclesToCompact,
  mapSurfaceArea,
} from "./reportShared.js";
import type { ImpactReportPartsBase } from "./reportParts.js";
import { IMPACT_SCHEMA_VERSION } from "./types.js";
import type {
  ChangedSymbol,
  CompactImpactCluster,
  CompactImpactReport,
  CompactImpactSurfaceArea,
  ImpactCluster,
  ImpactCycle,
  ImpactItem,
  ImpactReason,
  ImpactSuggestion,
  ImpactSurfaceArea,
} from "./types.js";

export type CompactImpactReportParts = ImpactReportPartsBase & {
  analysis?: AnalysisSummary;
};

export function buildCompactImpactReport(parts: CompactImpactReportParts): CompactImpactReport {
  const context = buildCompactSerializerContext(parts);

  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    format: "compact",
    ...(parts.analysis ? { analysis: parts.analysis } : {}),
    ...(parts.projectFiles ? { projectFiles: parts.projectFiles } : {}),
    files: context.files,
    changedFiles: parts.changedFiles.map((fileChange) => ({
      file: context.fileId(fileChange.file),
      ...(fileChange.kind !== undefined ? { kind: fileChange.kind } : {}),
      ...(fileChange.oldFile !== undefined ? { oldFile: context.fileId(fileChange.oldFile) } : {}),
      ...(fileChange.similarityIndex !== undefined ? { similarityIndex: fileChange.similarityIndex } : {}),
      hunks: fileChange.hunks,
    })),
    changedSymbols: parts.changedSymbols.map((symbol) => compactChangedSymbol(symbol, context.fileId(symbol.file))),
    impacted: parts.impactedItems.map((item) => compactImpactItem(item, context.fileId(item.file))),
    ...buildCompactSuggestions(parts.suggestions, context.fileId),
    ...buildOptionalExportSummary(parts.exportSummary, context.fileId),
    ...buildOptionalReexportChains(parts.reexportChains, context.fileId),
    ...buildOptionalTopImpacts(parts.topImpacts, context.fileId),
    surfaceArea: buildCompactSurfaceArea(parts.surfaceArea, context.fileId),
    clusters: buildCompactClusters(parts.clusters, context.fileId),
    ...buildCompactCycles(parts.cycles, context.fileId),
    graph: {
      fileEdges: mapFileEdges(parts.fileEdges, context.fileId),
      symbolEdges: parts.symbolEdges,
    },
  };
}

type CompactSerializerContext = {
  files: FileId[];
  fileId: (file: FileId) => number;
};

function buildCompactSerializerContext(parts: CompactImpactReportParts): CompactSerializerContext {
  const allFiles = new Set<FileId>();
  const addFile = (file: FileId): void => {
    allFiles.add(parts.displayFile(file));
  };

  for (const fileChange of parts.changedFiles) {
    addFile(fileChange.file);
    if (fileChange.oldFile !== undefined) addFile(fileChange.oldFile);
  }
  for (const symbol of parts.changedSymbols) addFile(symbol.file);
  for (const item of parts.impactedItems) addFile(item.file);
  for (const edge of parts.fileEdges) {
    addFile(edge.from);
    addFile(edge.to);
  }
  for (const item of parts.surfaceArea.files) addFile(item.file);
  for (const file of parts.surfaceArea.topFanIn) addFile(file);
  for (const file of parts.surfaceArea.topFanOut) addFile(file);
  for (const cycle of parts.cycles) {
    for (const file of cycle.files) addFile(file);
  }
  for (const suggestion of parts.suggestions) {
    addFile(suggestion.file);
    if (suggestion.relatedFile) addFile(suggestion.relatedFile);
  }
  if (parts.reexportChains) {
    for (const chain of parts.reexportChains.chains) {
      addFile(chain.file);
      for (const pathChain of chain.paths) {
        for (const file of pathChain) addFile(file);
      }
    }
  }

  const files = Array.from(allFiles);
  const fileIndex = new Map<FileId, number>();
  for (let i = 0; i < files.length; i++) {
    fileIndex.set(files[i]!, i);
  }
  return {
    files,
    fileId: (file: FileId): number => {
      const id = fileIndex.get(parts.displayFile(file));
      if (id === undefined) {
        throw new Error(`Missing file path in compact impact report index: ${file}`);
      }
      return id;
    },
  };
}

function compactChangedSymbol(symbol: ChangedSymbol, file: number): CompactImpactReport["changedSymbols"][number] {
  const compact: CompactImpactReport["changedSymbols"][number] = {
    id: symbol.id,
    file,
    name: symbol.name,
    kind: symbol.kind,
    exported: symbol.exported,
    range: symbol.range,
  };
  if (symbol.typeOnly !== undefined) {
    compact.typeOnly = symbol.typeOnly;
  }
  if (symbol.callCompatibility?.length) {
    compact.callCompatibility = symbol.callCompatibility;
  }
  return compact;
}

function compactImpactItem(item: ImpactItem, file: number): CompactImpactReport["impacted"][number] {
  const compact: {
    file: number;
    symbols: string[];
    reasons: ImpactReason[];
    severity: number;
    confidence?: number;
    depth?: number;
    typeOnly?: boolean;
    explain?: NonNullable<ImpactItem["explain"]>;
  } = {
    file,
    symbols: item.symbols,
    reasons: item.reasons,
    severity: item.severity,
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
    ...(item.explain !== undefined ? { explain: item.explain } : {}),
  };
  return compact;
}

function buildCompactSuggestions(
  suggestions: ImpactSuggestion[],
  fileId: (file: FileId) => number,
): Pick<CompactImpactReport, "suggestions"> {
  if (!suggestions.length) return {};
  return { suggestions: mapSuggestions(suggestions, fileId) };
}

function buildCompactSurfaceArea(
  surfaceArea: ImpactSurfaceArea,
  fileId: (file: FileId) => number,
): CompactImpactSurfaceArea {
  return mapSurfaceArea(surfaceArea, fileId);
}

function buildCompactClusters(clusters: ImpactCluster[], fileId: (file: FileId) => number): CompactImpactCluster[] {
  return clusters.map((cluster) => ({
    id: cluster.id,
    files: cluster.files.map((file) => fileId(file)),
    changedFiles: cluster.changedFiles.map((file) => fileId(file)),
    totalSeverity: cluster.totalSeverity,
  }));
}

function buildCompactCycles(
  cycles: ImpactCycle[],
  fileId: (file: FileId) => number,
): Pick<CompactImpactReport, "cycles"> {
  if (!cycles.length) return {};
  return {
    cycles: mapImpactCyclesToCompact(cycles, fileId),
  };
}
