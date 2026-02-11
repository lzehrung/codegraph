import type { FileId, Range } from "../types.js";
import type { SymbolHandle, SymbolDef } from "../indexer.js";
import type { ProjectFileInfo } from "../util.js";

// Diff parsing types
export type Hunk = {
  oldStart: number; // 1-based line number in old file
  newStart: number; // 1-based line number in new file
  lines: string[]; // raw diff lines ("+", "-", " " prefixes)
};

export type FileChange = {
  path: FileId;
  kind: "added" | "modified" | "deleted" | "renamed";
  oldPath?: FileId; // for renames
  hunks: Hunk[];
};

export type Diff = {
  files: FileChange[];
  warning?: string | undefined;
};

// Provider options
export type DiffProviderOptions =
  | { provider: "git"; base: string; head: string; cwd?: string }
  | { provider: "github"; repo: string; pr: number; token?: string }
  | { provider: "raw"; diffText: string };

// Changed symbols
export type ChangedSymbol = {
  id: SymbolHandle;
  file: FileId;
  name: string;
  kind: SymbolDef["kind"];
  exported: boolean;
  range: Range;
  typeOnly?: boolean;
};

// Impact findings
export type ImpactReason =
  | "directRef" // direct reference to changed symbol
  | "namespaceMember" // usage via namespace import (ns.symbol)
  | "importAlias" // usage via import alias
  | "transitive" // indirect impact through file dependencies
  | "exportChain"; // impact through re-export chains

export type ImpactSuggestionKind =
  | "missingImport"
  | "missingExport"
  | "missingDeclaration"
  | "configImpact"
  | "breakingChange"
  | "untestedChange";

export type ImpactSuggestionConfidence = "high" | "medium" | "low";

export type ImpactSuggestion = {
  file: FileId;
  range?: Range;
  kind: ImpactSuggestionKind;
  symbol?: string;
  relatedFile?: FileId;
  details?: string;
  confidence: ImpactSuggestionConfidence;
};

export type ExportSummaryEntry = {
  file: FileId;
  symbols: string[];
};

export type ReexportChainEntry = {
  symbol: string;
  file: FileId;
  paths: FileId[][];
};

export type ImpactSurfaceAreaFile = {
  file: FileId;
  fanIn: number;
  fanOut: number;
  changed: boolean;
  impacted: boolean;
};

export type ImpactSurfaceArea = {
  files: ImpactSurfaceAreaFile[];
  topFanIn: FileId[];
  topFanOut: FileId[];
};

export type ImpactCluster = {
  id: number;
  files: FileId[];
  changedFiles: FileId[];
  totalSeverity: number;
};

export type CompactImpactSurfaceAreaFile = {
  file: number;
  fanIn: number;
  fanOut: number;
  changed: boolean;
  impacted: boolean;
};

export type CompactImpactSurfaceArea = {
  files: CompactImpactSurfaceAreaFile[];
  topFanIn: number[];
  topFanOut: number[];
};

export type CompactImpactCluster = {
  id: number;
  files: number[];
  changedFiles: number[];
  totalSeverity: number;
};

export type ImpactCycleEdge = {
  from: FileId;
  to: FileId;
  raw: string;
  typeOnly?: boolean;
};

export type ImpactCycle = {
  files: FileId[];
  entryEdges: ImpactCycleEdge[];
  internalEdges: ImpactCycleEdge[];
  fileCount: number;
  internalEdgeCount: number;
  fanInFromOutside: number;
  priorityScore: number;
  remediationHint: string;
  touchesChangedFile: boolean;
  touchesImpactedFile: boolean;
  severity: "medium" | "high";
};

export type ImpactTopItem = {
  file: FileId;
  symbols: string[];
  reasons: ImpactReason[];
  severity: number;
  depth?: number;
  typeOnly?: boolean;
  explain?: ImpactItem["explain"];
};

export type ImpactItem = {
  file: FileId;
  symbols: string[]; // symbol names impacted in this file
  reasons: ImpactReason[];
  severity: number; // 0-1 score
  confidence?: number; // 0-1 confidence in the impact (1 = exact AST match, lower = heuristic)
  depth?: number; // transitive depth from changed files
  typeOnly?: boolean; // true if only type-level impact
  refs?: Array<{ range: Range; context?: string }>; // references with optional context snippets
  explain?: {
    exported?: boolean; // if any changed symbol is exported
    fanIn?: number; // number of files that depend on this one
    sameFile?: boolean; // if the impact is in the same file as the change
    typeOnly?: boolean; // if impact is type-only
    reason?: ImpactReason; // primary reason for impact
    depth?: number; // transitive depth
    refsCount?: number; // number of references found
    hints?: string[]; // lightweight hints like "signatureChanged", "exportChanged"
  };
};

// Main impact report
export type ImpactReport = {
  projectFiles?: ProjectFileInfo[];
  changedFiles: Array<{
    file: FileId;
    hunks: Array<{ start: number; end: number }>; // new-file line ranges
  }>;
  changedSymbols: ChangedSymbol[];
  impacted: ImpactItem[];
  suggestions?: ImpactSuggestion[];
  exportSummary?: ExportSummaryEntry[];
  reexportChains?: {
    chains: ReexportChainEntry[];
  };
  topImpacts?: ImpactTopItem[];
  surfaceArea: ImpactSurfaceArea;
  clusters: ImpactCluster[];
  cycles?: ImpactCycle[];
  graph: {
    fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }>;
    symbolEdges: Array<{ from: number; to: number; label: string }>; // indices into changedSymbols
  };
  warning?: string | undefined;
};

// Compact impact report with indexed arrays
export type CompactImpactReport = {
  projectFiles?: ProjectFileInfo[];
  files: FileId[]; // file index -> file path
  changedFiles: Array<{
    file: number; // index into files array
    hunks: Array<{ start: number; end: number }>; // line ranges
  }>;
  changedSymbols: Array<{
    id: string; // symbol ID
    file: number; // index into files array
    name: string;
    kind: ChangedSymbol["kind"];
    exported: boolean;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    typeOnly?: boolean;
  }>;
  impacted: Array<{
    file: number; // index into files array
    symbols: string[]; // symbol names
    reasons: ImpactReason[];
    severity: number;
    depth?: number;
    typeOnly?: boolean;
    explain?: {
      exported?: boolean;
      fanIn?: number;
      sameFile?: boolean;
      typeOnly?: boolean;
      reason?: ImpactReason;
      depth?: number;
      refsCount?: number;
      hints?: string[];
    };
  }>;
  suggestions?: Array<{
    file: number;
    range?: Range;
    kind: ImpactSuggestionKind;
    symbol?: string;
    relatedFile?: number;
    details?: string;
    confidence: ImpactSuggestionConfidence;
  }>;
  exportSummary?: Array<{
    file: number;
    symbols: string[];
  }>;
  reexportChains?: {
    chains: Array<{
      symbol: string;
      file: number;
      paths: number[][];
    }>;
  };
  topImpacts?: Array<{
    file: number;
    symbols: string[];
    reasons: ImpactReason[];
    severity: number;
    depth?: number;
    typeOnly?: boolean;
    explain?: ImpactItem["explain"];
  }>;
  surfaceArea: CompactImpactSurfaceArea;
  clusters: CompactImpactCluster[];
  cycles?: Array<{
    files: number[];
    entryEdges: Array<{
      from: number;
      to: number;
      raw: string;
      typeOnly?: boolean;
    }>;
    internalEdges: Array<{
      from: number;
      to: number;
      raw: string;
      typeOnly?: boolean;
    }>;
    fileCount: number;
    internalEdgeCount: number;
    fanInFromOutside: number;
    priorityScore: number;
    remediationHint: string;
    touchesChangedFile: boolean;
    touchesImpactedFile: boolean;
    severity: "medium" | "high";
  }>;
  graph: {
    fileEdges: Array<{ from: number; to: number; typeOnly?: boolean }>; // indices into files array
    symbolEdges: Array<{ from: number; to: number; label: string }>; // indices into changedSymbols
  };
  warning?: string | undefined;
};

/**
 * Configurable severity weights for impact scoring.
 * All values are multipliers (1.0 = neutral, >1 = increase severity, <1 = decrease).
 */
export type SeverityWeights = {
  /** Multiplier for exported symbols (default: 1.2) */
  exported: number;
  /** Multiplier for type-only changes (default: 0.7) */
  typeOnly: number;
  /** Multiplier for same-file references (default: 1.2) */
  sameFile: number;
  /** Decay factor per depth level (default: 0.8) */
  depthDecay: number;
  /** Multiplier for direct references (default: 1.0) */
  directRef: number;
  /** Multiplier for namespace member access (default: 0.8) */
  namespaceMember: number;
  /** Multiplier for import alias usage (default: 0.6) */
  importAlias: number;
  /** Multiplier for transitive impact (default: 0.4) */
  transitive: number;
};

/** Default severity weights */
export const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = {
  exported: 1.2,
  typeOnly: 0.7,
  sameFile: 1.2,
  depthDecay: 0.8,
  directRef: 1.0,
  namespaceMember: 0.8,
  importAlias: 0.6,
  transitive: 0.4,
};

// Analysis options
export type ImpactOptions = DiffProviderOptions & {
  scope?: "all" | "imported";
  maxRefs?: number;
  depth?: number;
  includeTests?: boolean;
  membersOnly?: boolean;
  /** Custom regex patterns used to detect test files */
  testPatterns?: string[];
  /** Return compact report with indexed arrays instead of repeated strings */
  compact?: boolean;
  /** File patterns to ignore in impact analysis */
  ignoreGlobs?: string[];
  /** Include context snippets for references */
  refContext?: "line" | "block";
  /** Number of lines around reference for line context (default: 5) */
  refContextLines?: number;
  /** Maximum lines for enclosing block context (default: 60) */
  refBlockMaxLines?: number;
  /** Validate references inside changed lines to surface missing imports/exports/declarations */
  verifyReferences?: boolean;
  /** Cap the number of suggestions returned when verifyReferences is enabled */
  maxSuggestions?: number;
  /** Add config-aware impact suggestions for changed config files */
  configImpactRules?: boolean;
  /** Add potential breaking-change suggestions for exported symbol edits */
  detectBreakingChanges?: boolean;
  /** Add untested-change suggestions when changed symbols have no test references */
  testCoverageSuggestions?: boolean;
  /** Optional LCOV file paths used to rank untested-change suggestions by actual line coverage */
  lcovPaths?: string[];
  /** Optional additional coverage reports (LCOV or Istanbul JSON) */
  coveragePaths?: string[];
  /** Optional command template used in untested-change suggestions (use {files} placeholder) */
  testCommandTemplate?: string;
  /** Custom severity weights for impact scoring */
  severityWeights?: Partial<SeverityWeights>;
};
