import type { CandidateTestFile } from "../impact/context.js";
import type { CallCompatibilityHint, FileChange } from "../impact/types.js";
import type { BuildReport, IncrementalBuildOptions, ProjectIndex } from "../indexer/types.js";
import type { SqlReviewContext } from "../sql/review.js";
import type { Edge, Range } from "../types.js";
import type { ProjectFileInfo } from "../util/projectFiles.js";

export type ReviewFileSummary = {
  file: string;
  status: "updated" | "deleted" | "missing";
  oldFile?: string;
  similarityIndex?: number;
  symbols: ReviewSymbolSummary[];
};

export type ReviewSymbolCallsite = {
  file: string;
  range: Range;
};

export type ReviewSymbolSummary = {
  name: string;
  kind: string;
  handle: string;
  exported: boolean;
  callCompatibility?: CallCompatibilityHint[];
  definitionSnippet?: string;
  diffSnippets?: string[];
  callsites?: ReviewSymbolCallsite[];
};

export type ReviewChangedFileSummaries = {
  summaries: ReviewFileSummary[];
  changedSymbolIds: string[];
  exportedChangedCount: number;
  riskRelevantParseFailures: number;
};

export type ReviewReport = {
  schemaVersion: number;
  status: "ok" | "no_changes";
  base?: string;
  head?: string;
  projectFiles?: ProjectFileInfo[];
  summary: {
    filesChanged: number;
    symbolsChanged: number;
    candidateTests: number;
  };
  riskSummary: ReviewRiskSummary;
  reviewTasks: ReviewTask[];
  changedFiles: ReviewFileSummary[];
  graphDelta: Edge[];
  candidateTests: CandidateTestFile[];
  sqlContext?: SqlReviewContext;
  diagnostics?: ReviewDiagnostics;
};

export type ReviewOptions = IncrementalBuildOptions & {
  reviewDepth?: ReviewDepth;
  maxCandidates?: number;
  includeSymbolDetails?: boolean;
  maxCallsites?: number;
  includeDiffContext?: boolean;
  diffContextLines?: number;
  diffText?: string;
  testPatterns?: string[];
  referenceConcurrency?: number;
  report?: ReviewBuildReport;
};

export type ReviewDepth = "minimal" | "standard" | "deep";

export type ReviewRiskLevel = "low" | "medium" | "high";

export type ReviewRiskSummary = {
  level: ReviewRiskLevel;
  score: number;
  signals: string[];
};

export type ReviewTaskPriority = "low" | "medium" | "high";

export type ReviewTask = {
  id: string;
  title: string;
  description: string;
  priority: ReviewTaskPriority;
  reason: string;
};

export type ReviewDiagnostics = {
  missingFiles: string[];
  symbolMappingParseFailures: string[];
};

export type ReviewTimingReport = {
  totalMs?: number;
  changesMs?: number;
  diffMs?: number;
  indexMs?: number;
  referencesMs?: number;
  candidatesMs?: number;
};

export type ReviewBuildReport = {
  timings: ReviewTimingReport;
  indexReport?: BuildReport;
  index?: ProjectIndex;
};

export type ReviewDiffMetadata = Pick<ReviewFileSummary, "oldFile" | "similarityIndex">;

export type ReviewDiffChange = FileChange;
