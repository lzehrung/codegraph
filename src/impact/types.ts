import type { FileId, Range } from "../types.js";
import type { SymbolHandle, SymbolDef } from "../indexer.js";

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

export type ImpactItem = {
  file: FileId;
  symbols: string[]; // symbol names impacted in this file
  reasons: ImpactReason[];
  severity: number; // 0-1 score
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
  changedFiles: Array<{
    file: FileId;
    hunks: Array<{ start: number; end: number }>; // new-file line ranges
  }>;
  changedSymbols: ChangedSymbol[];
  impacted: ImpactItem[];
  graph: {
    fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }>;
    symbolEdges: Array<{ from: number; to: number; label: string }>; // indices into changedSymbols
  };
  warning?: string | undefined;
};

// Compact impact report with indexed arrays
export type CompactImpactReport = {
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
  graph: {
    fileEdges: Array<{ from: number; to: number; typeOnly?: boolean }>; // indices into files array
    symbolEdges: Array<{ from: number; to: number; label: string }>; // indices into changedSymbols
  };
  warning?: string | undefined;
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
};
