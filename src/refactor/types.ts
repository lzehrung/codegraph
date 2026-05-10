import type { FileId, Range } from "../types.js";

export type TriviaMode = "exclude" | "leading-doc" | "leading-all";

export interface SymbolRangeOptions {
  trivia?: TriviaMode;
}

export interface TextEdit {
  file: FileId;
  start: number;
  end: number;
  newText: string;
  display?: Range;
}

export interface RefactorResult {
  status: "ok" | "unsupported" | "error";
  edits: TextEdit[];
  warnings: string[];
  reason?: string;
}

export interface ApplyEditsOptions {
  dryRun?: boolean;
  useGit?: boolean;
  gitCwd?: string;
}

export interface ApplyEditsResult {
  writes: string[];
  conflicts: string[];
  skipped: string[];
  previews: Record<string, string>;
  warnings: string[];
}
