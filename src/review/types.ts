import type { MarkdownLinkCheckResult } from "../documentLinks/check.js";
import type { CandidateTestFile } from "../impact/context.js";
import type { CallCompatibilityHint, FileChange, MemberResolutionCoverage } from "../impact/types.js";
import type { AnalysisSummary } from "../analysisSummary.js";
import type { BuildReport, IncrementalBuildOptions, ProjectIndex } from "../indexer/types.js";
import type { DuplicatePreparedAnalysis } from "../duplicates.js";
import type { SqlReviewContext } from "../sql/review.js";
import type { Edge, Range } from "../types.js";
import type { ProjectFileInfo } from "../util/projectFiles.js";

export type ReviewFileSummary = {
  file: string;
  status: "updated" | "deleted" | "missing";
  oldFile?: string;
  similarityIndex?: number;
  /** True when Git reported a binary diff and symbol analysis was skipped. */
  isBinary?: true;
  /** Unchanged re-exports included only as API context for a changed export. */
  apiContext?: ReviewSymbolSummary[];
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
  analysis?: AnalysisSummary;
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
  markdownLinks?: MarkdownLinkCheckResult;
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
  /** When false, skip prepareDuplicateAnalysis / duplicate review tasks entirely. Default true. */
  duplicateTasks?: boolean;
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
  memberResolutionCoverage?: MemberResolutionCoverage;
};

export type ReviewTimingReport = {
  totalMs?: number;
  changesMs?: number;
  diffMs?: number;
  indexMs?: number;
  referencesMs?: number;
  candidatesMs?: number;
  duplicateAnalysisMs?: number;
};

export type ReviewBuildReport = {
  timings: ReviewTimingReport;
  indexReport?: BuildReport;
  index?: ProjectIndex;
  duplicateAnalysis?: DuplicatePreparedAnalysis;
};

export type ReviewDiffMetadata = Pick<ReviewFileSummary, "oldFile" | "similarityIndex">;

export type ReviewDiffChange = FileChange;

/**
 * Per-collection caps applied only when a `ReviewReport` crosses a bounded
 * transport (currently the MCP `review` tool) — see
 * `boundReviewReportForTransport`.
 */
export type ReviewTransportLimits = {
  projectFiles: number;
  changedFiles: number;
  symbolsPerFile: number;
  graphDelta: number;
  candidateTests: number;
};

export const DEFAULT_REVIEW_TRANSPORT_LIMITS: ReviewTransportLimits = {
  projectFiles: 300,
  changedFiles: 50,
  symbolsPerFile: 20,
  graphDelta: 300,
  candidateTests: 50,
};

export type ReviewTransportOmittedCounts = {
  projectFiles: number;
  changedFiles: number;
  symbols: number;
  graphDelta: number;
  candidateTests: number;
};

export type ReviewReportForTransport = ReviewReport & {
  limits: ReviewTransportLimits;
  omittedCounts: ReviewTransportOmittedCounts;
};

/**
 * Caps each top-level (and per-file nested `symbols`) collection in a
 * `ReviewReport` for wire transports with hard payload/context limits, per
 * finding #45. `summary` counts are left untouched so the numeric totals
 * stay accurate even when the detailed listings are capped. Library callers
 * that need the complete, unbounded report should call `buildReviewReport`
 * directly instead of going through a bounded transport.
 */
export function boundReviewReportForTransport(
  report: ReviewReport,
  limits: ReviewTransportLimits = DEFAULT_REVIEW_TRANSPORT_LIMITS,
): ReviewReportForTransport {
  const projectFilesOmitted = report.projectFiles ? Math.max(0, report.projectFiles.length - limits.projectFiles) : 0;
  const changedFilesOmitted = Math.max(0, report.changedFiles.length - limits.changedFiles);
  const graphDeltaOmitted = Math.max(0, report.graphDelta.length - limits.graphDelta);
  const candidateTestsOmitted = Math.max(0, report.candidateTests.length - limits.candidateTests);

  let symbolsOmitted = 0;
  const changedFiles = report.changedFiles.slice(0, limits.changedFiles).map((file) => {
    const omitted = Math.max(0, file.symbols.length - limits.symbolsPerFile);
    symbolsOmitted += omitted;
    return omitted ? { ...file, symbols: file.symbols.slice(0, limits.symbolsPerFile) } : file;
  });

  return {
    ...report,
    ...(report.projectFiles ? { projectFiles: report.projectFiles.slice(0, limits.projectFiles) } : {}),
    changedFiles,
    graphDelta: report.graphDelta.slice(0, limits.graphDelta),
    candidateTests: report.candidateTests.slice(0, limits.candidateTests),
    limits,
    omittedCounts: {
      projectFiles: projectFilesOmitted,
      changedFiles: changedFilesOmitted,
      symbols: symbolsOmitted,
      graphDelta: graphDeltaOmitted,
      candidateTests: candidateTestsOmitted,
    },
  };
}
