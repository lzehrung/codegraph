import type { FileId, Range } from "../types.js";
import type { SymbolHandle, SymbolDef } from "../indexer.js";

// Diff parsing types
export type Hunk = {
  startLine: number; // 1-based line number in original file
  lines: string[]; // actual diff lines (+/- content)
};

export type FileChange = {
  path: FileId;
  kind: "added" | "modified" | "deleted" | "renamed";
  oldPath?: FileId; // for renames
  hunks: Hunk[];
};

export type Diff = {
  files: FileChange[];
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
  | "directRef"     // direct reference to changed symbol
  | "namespaceMember" // usage via namespace import (ns.symbol)
  | "importAlias"   // usage via import alias
  | "transitive"    // indirect impact through file dependencies
  | "exportChain";  // impact through re-export chains

export type ImpactItem = {
  file: FileId;
  symbols: string[]; // symbol names impacted in this file
  reasons: ImpactReason[];
  severity: number; // 0-1 score
  depth?: number; // transitive depth from changed files
  typeOnly?: boolean; // true if only type-level impact
  explain?: {
    exported?: boolean; // if any changed symbol is exported
    fanIn?: number; // number of files that depend on this one
    sameFile?: boolean; // if the impact is in the same file as the change
    typeOnly?: boolean; // if impact is type-only
    reason?: ImpactReason; // primary reason for impact
    depth?: number; // transitive depth
    refsCount?: number; // number of references found
  };
};

// Main impact report
export type ImpactReport = {
  changedFiles: Array<{
    file: FileId;
    hunks: Array<{ start: number; end: number }>; // line ranges
  }>;
  changedSymbols: ChangedSymbol[];
  impacted: ImpactItem[];
  graph: {
    fileEdges: Array<{ from: FileId; to: FileId; typeOnly?: boolean }>;
    symbolEdges: Array<{ from: number; to: number; label: string }>; // indices into changedSymbols
  };
};

// Analysis options
export type ImpactOptions = DiffProviderOptions & {
  scope?: "all" | "imported";
  maxRefs?: number;
  depth?: number;
  includeTests?: boolean;
  membersOnly?: boolean;
};
