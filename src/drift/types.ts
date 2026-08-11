import type { BuildOptions } from "../indexer/types.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";

export type ArchitectureDriftFindingKind =
  | "new-cycle"
  | "resolved-cycle"
  | "hotspot-jump"
  | "hotspot-drop"
  | "unresolved-import"
  | "resolved-unresolved-import"
  | "public-api-addition"
  | "public-api-removal"
  | "duplicate-increase"
  | "duplicate-decrease"
  | "graph-edge-added"
  | "graph-edge-removed"
  | "graph-edge-type-changed";

export type ArchitectureDriftSeverity = "error" | "warning" | "info";

export interface ArchitectureHotspot {
  file: string;
  fanIn: number;
  fanOut: number;
  score: number;
}

export interface ArchitectureCycle {
  key: string;
  files: string[];
  priorityScore: number;
  size: number;
}

export interface ArchitectureUnresolvedImport {
  key: string;
  file: string;
  specifier: string;
}

export interface ArchitecturePublicApiSymbol {
  id: string;
  file: string;
  name: string;
  kind: string;
}

export interface ArchitectureDuplicateSummary {
  groups: {
    total: number;
  };
  topGroupKeys: string[];
}

export interface ArchitectureGraphEdge {
  key: string;
  from: string;
  to: string;
  raw: string;
  typeOnly?: boolean;
}

export interface ArchitectureUnresolvedImportSummary {
  total: number;
  imports: ArchitectureUnresolvedImport[];
}

export interface ArchitectureSignalAvailability {
  unresolved?: boolean;
  publicApi?: boolean;
  duplicates?: boolean;
}
export const ARCHITECTURE_SNAPSHOT_SCHEMA_VERSION = 2 as const;


export interface ArchitectureSnapshot {
  schemaVersion: typeof ARCHITECTURE_SNAPSHOT_SCHEMA_VERSION;
  root: string;
  files: { total: number; byLanguage: Record<string, number> };
  hotspots: ArchitectureHotspot[];
  cycles: ArchitectureCycle[];
  unresolved: ArchitectureUnresolvedImportSummary;
  publicApi: ArchitecturePublicApiSymbol[];
  duplicates: ArchitectureDuplicateSummary;
  graphEdges: ArchitectureGraphEdge[];
  signalAvailability?: ArchitectureSignalAvailability;
}

export interface ArchitectureSnapshotSummary {
  root: string;
  ref?: string;
  files: ArchitectureSnapshot["files"];
  hotspots: ArchitectureHotspot[];
  cycles: ArchitectureCycle[];
  unresolved: ArchitectureUnresolvedImportSummary;
  publicApi: ArchitecturePublicApiSymbol[];
  duplicates: ArchitectureDuplicateSummary;
}

export interface ArchitectureDriftSummary {
  byKind: Partial<Record<ArchitectureDriftFindingKind, number>>;
  bySeverity: Partial<Record<ArchitectureDriftSeverity, number>>;
}

export type ArchitectureDriftFormat = "full" | "compact";

export type ArchitectureDriftGraphEdgesMode = "full" | "summary" | "off";

export type ArchitectureDriftPublicApiMode = "all" | "removals" | "off";

export interface ArchitectureDriftFinding {
  kind: ArchitectureDriftFindingKind;
  severity: ArchitectureDriftSeverity;
  key: string;
  title: string;
  before?: number;
  after?: number;
  files?: string[];
  file?: string;
  specifier?: string;
  symbol?: ArchitecturePublicApiSymbol;
  edge?: ArchitectureGraphEdge;
  details?: Record<string, string | number | boolean | string[]>;
}

export interface ArchitectureDriftReport {
  schemaVersion: 1;
  format?: ArchitectureDriftFormat;
  root: string;
  base: ArchitectureSnapshotSummary;
  head: ArchitectureSnapshotSummary;
  findings: ArchitectureDriftFinding[];
  summary?: ArchitectureDriftSummary;
  policy: {
    failed: boolean;
    failOn: ArchitectureDriftFindingKind[];
    failedKinds: ArchitectureDriftFindingKind[];
  };
  omittedCounts: {
    findings: number;
  };
}

export interface ArchitectureDriftThresholds {
  hotspotJump: number;
  maxFindings: number;
}

export interface ArchitectureDriftCompareOptions {
  failOn?: ArchitectureDriftFindingKind[];
  thresholds?: Partial<ArchitectureDriftThresholds>;
  format?: ArchitectureDriftFormat;
  graphEdges?: ArchitectureDriftGraphEdgesMode;
  publicApi?: ArchitectureDriftPublicApiMode;
}

export interface ArchitectureSnapshotOptions {
  includeRoots?: string[];
  discovery?: ProjectFileDiscoveryOptions;
  graph?: GraphBuildOptions;
  index?: BuildOptions;
  native?: NativeRuntimeMode;
  duplicateLimit?: number;
}

export type ArchitectureDriftProvider = "git";

export interface ArchitectureDriftOptions extends ArchitectureSnapshotOptions, ArchitectureDriftCompareOptions {
  provider?: ArchitectureDriftProvider;
  base?: string;
  head?: string;
  baseArtifact?: string;
}
