import type { ProjectIndex } from "../indexer/types.js";
import type { FileId } from "../types.js";
import type {
  ChangedSymbol,
  ExportSummaryEntry,
  FileChange,
  ImpactCluster,
  ImpactCycle,
  ImpactItem,
  ImpactSuggestion,
  ImpactSurfaceArea,
  ImpactTopItem,
  ReexportChainEntry,
} from "./types.js";

export type ImpactReportChangedFile = {
  file: FileId;
  kind?: FileChange["kind"];
  oldFile?: FileId;
  similarityIndex?: number;
  hunks: Array<{ start: number; end: number }>;
};

export type ImpactReportPartsBase = {
  changedFiles: ImpactReportChangedFile[];
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
};
