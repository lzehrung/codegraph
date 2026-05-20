import { performance } from "node:perf_hooks";
import type { Edge, FileId } from "./types.js";
import { buildProjectIndexIncremental } from "./indexer/build-index.js";
import { type BuildReport, type IncrementalBuildOptions, type ProjectIndex } from "./indexer/types.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import type { FileChange, Hunk } from "./impact/types.js";
import type { CandidateTestFile } from "./impact/context.js";
import { fileExists } from "./util/workspace.js";
import { discoverProjectFiles, type ProjectFileInfo } from "./util/projectFiles.js";
import type { SqlReviewContext } from "./sql/review.js";
import { collectReviewCandidateTests } from "./review/candidates.js";
import { collectReviewChanges } from "./review/changes.js";
import { buildDeletedFileSnapshots, type DeletedFileSnapshot } from "./review/deleted.js";
import {
  assembleReviewReport,
  collectReviewGraphDelta,
  collectReviewSqlContext,
  REVIEW_SCHEMA_VERSION,
} from "./review/report.js";
import { buildReviewTasks, computeRiskSummary } from "./review/risk.js";
import { summarizeChangedFiles, type ReviewFileSummary } from "./review/summaries.js";

/**
 * Structured review bundle for downstream review agents.
 *
 * This is the programmatic counterpart to CLI review output. It keeps risk,
 * tasks, changed symbols, graph deltas, candidate tests, diagnostics, and
 * snippets as data so callers can build deterministic file packs or prompts.
 */
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

/**
 * Options for `buildReviewReport()`.
 *
 * Most review agents use a git range (`gitBase`/`gitHead`) or `diffText`, choose
 * a `reviewDepth`, and preserve the returned structured fields instead of
 * re-parsing terminal summaries.
 */
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
};

type ReviewPreset = {
  includeSymbolDetails: boolean;
  maxCallsites: number;
  maxCandidates: number;
  graph: { fast: boolean };
};

const REVIEW_PRESETS: Record<ReviewDepth, ReviewPreset> = {
  minimal: {
    includeSymbolDetails: false,
    maxCallsites: 0,
    maxCandidates: 10,
    graph: { fast: true },
  },
  standard: {
    includeSymbolDetails: true,
    maxCallsites: 2,
    maxCandidates: 25,
    graph: { fast: false },
  },
  deep: {
    includeSymbolDetails: true,
    maxCallsites: 10,
    maxCandidates: 50,
    graph: { fast: false },
  },
};

function mergeGraphOptions(
  base: IncrementalBuildOptions["graph"] | undefined,
  override: IncrementalBuildOptions["graph"] | undefined,
): IncrementalBuildOptions["graph"] | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

function applyReviewPresetOptions(opts: ReviewOptions): ReviewOptions {
  if (!opts.reviewDepth) return opts;
  const preset = REVIEW_PRESETS[opts.reviewDepth];
  const mergedGraph = mergeGraphOptions(preset.graph, opts.graph);
  return {
    ...opts,
    includeSymbolDetails: opts.includeSymbolDetails ?? preset.includeSymbolDetails,
    maxCallsites: opts.maxCallsites ?? preset.maxCallsites,
    maxCandidates: opts.maxCandidates ?? preset.maxCandidates,
    ...(mergedGraph ? { graph: mergedGraph } : {}),
  };
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

type ReviewIndexStage = {
  index: ProjectIndex;
  existenceByFile: Map<string, boolean>;
  deletedFiles: string[];
  deletedSnapshots: Map<FileId, DeletedFileSnapshot>;
  graphOptions: GraphBuildOptions;
};

async function buildReviewIndex(input: {
  projectRoot: string;
  appliedOptions: ReviewOptions;
  changedFileList: string[];
  diffKindsByFile: ReadonlyMap<string, string>;
  diffChangesByFile: ReadonlyMap<string, FileChange>;
  includeSymbolDetails: boolean;
  maxCallsites: number;
  reviewReport?: ReviewBuildReport;
  reviewTimings?: ReviewTimingReport;
}): Promise<ReviewIndexStage> {
  const {
    projectRoot,
    appliedOptions,
    changedFileList,
    diffKindsByFile,
    diffChangesByFile,
    includeSymbolDetails,
    maxCallsites,
    reviewReport,
    reviewTimings,
  } = input;
  const fastGraphRequested = appliedOptions.graph?.fast ?? false;
  const graphOptions = appliedOptions.graph ? { ...appliedOptions.graph, fast: fastGraphRequested } : { fast: false };
  const existenceChecks = await Promise.all(
    changedFileList.map(async (file) => ({
      file,
      exists: await fileExists(file),
    })),
  );
  const existenceByFile = new Map(existenceChecks.map((entry) => [entry.file, entry.exists] as const));
  const filesToIndex = existenceChecks.filter((entry) => entry.exists).map((entry) => entry.file);
  const hasUnavailableChangedFiles = existenceChecks.some((entry) => !entry.exists);
  const deletedFiles = changedFileList.filter((file) => diffKindsByFile.get(file) === "deleted");
  const deletedSnapshots = await buildDeletedFileSnapshots(projectRoot, deletedFiles, {
    ...((appliedOptions.gitBase ?? appliedOptions.changedSince)
      ? { revision: appliedOptions.gitBase ?? appliedOptions.changedSince }
      : {}),
    diffChangesByFile,
    graphOptions,
  });

  const indexStart = performance.now();
  const indexReport = reviewReport?.indexReport ?? (reviewReport ? { timings: {} } : undefined);
  if (reviewReport && !reviewReport.indexReport && indexReport) {
    reviewReport.indexReport = indexReport;
  }
  const indexOpts: IncrementalBuildOptions = {
    ...(appliedOptions ?? {}),
    graph: graphOptions,
    ...(includeSymbolDetails && maxCallsites > 0 ? { keepParsed: true } : {}),
    ...(indexReport ? { report: indexReport } : {}),
  };
  if (!hasUnavailableChangedFiles) {
    indexOpts.files = filesToIndex;
  }
  const index = await buildProjectIndexIncremental(projectRoot, indexOpts);
  if (reviewTimings) {
    reviewTimings.indexMs = Math.round(performance.now() - indexStart);
  }

  return {
    index,
    existenceByFile,
    deletedFiles,
    deletedSnapshots,
    graphOptions,
  };
}

/**
 * Build the structured review report used by programmatic review agents.
 *
 * The report keeps changed files, changed symbols, graph deltas, candidate tests,
 * risk signals, review tasks, diagnostics, and optional snippets as data instead
 * of terminal prose. Prefer this API over CLI summary output when composing
 * deterministic model context or review file packs.
 */
export async function buildReviewReport(projectRoot: string, opts: ReviewOptions = {}): Promise<ReviewReport> {
  const appliedOptions = applyReviewPresetOptions(opts);
  const reviewReport = appliedOptions.report;
  const reviewTimings = reviewReport?.timings;
  const totalStart = performance.now();
  const { changedFiles, explicitFiles, diffHunksByFile, diffKindsByFile, diffChangesByFile } =
    await collectReviewChanges(projectRoot, appliedOptions, reviewTimings);

  if (changedFiles.size === 0) {
    const riskSummary = computeRiskSummary({
      filesChanged: 0,
      symbolsChanged: 0,
      exportedChanged: 0,
      missingFiles: 0,
      parseFailures: 0,
    });
    const projectFiles = await discoverProjectFiles(projectRoot);
    const report: ReviewReport = {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      status: "no_changes",
      projectFiles,
      summary: { filesChanged: 0, symbolsChanged: 0, candidateTests: 0 },
      riskSummary,
      reviewTasks: buildReviewTasks({
        filesChanged: 0,
        symbolsChanged: 0,
        exportedChanged: 0,
        candidateTests: 0,
        missingFiles: 0,
        parseFailures: 0,
      }),
      changedFiles: [],
      graphDelta: [],
      candidateTests: [],
    };
    if (appliedOptions.gitBase !== undefined) report.base = appliedOptions.gitBase;
    if (appliedOptions.gitHead !== undefined) report.head = appliedOptions.gitHead;
    if (reviewTimings) reviewTimings.totalMs = Math.round(performance.now() - totalStart);
    return report;
  }

  const changedFileList = Array.from(changedFiles).sort(comparePaths);
  const diagnostics: ReviewDiagnostics = {
    missingFiles: [],
    symbolMappingParseFailures: [],
  };
  const includeSymbolDetails = appliedOptions.includeSymbolDetails ?? false;
  const diffContextLines =
    typeof appliedOptions.diffContextLines === "number" && appliedOptions.diffContextLines >= 0
      ? appliedOptions.diffContextLines
      : 2;
  const maxCallsites =
    typeof appliedOptions.maxCallsites === "number" && appliedOptions.maxCallsites >= 0
      ? appliedOptions.maxCallsites
      : 5;
  const referenceConcurrency =
    typeof appliedOptions.referenceConcurrency === "number" && appliedOptions.referenceConcurrency > 0
      ? appliedOptions.referenceConcurrency
      : 8;
  const { index, existenceByFile, deletedFiles, deletedSnapshots } = await buildReviewIndex({
    projectRoot,
    appliedOptions,
    changedFileList,
    diffKindsByFile,
    diffChangesByFile,
    includeSymbolDetails,
    maxCallsites,
    ...(reviewReport ? { reviewReport } : {}),
    ...(reviewTimings ? { reviewTimings } : {}),
  });
  const includeDiffContext = appliedOptions.includeDiffContext ?? (includeSymbolDetails && diffHunksByFile.size > 0);

  const { summaries, changedSymbolIds, exportedChangedCount, riskRelevantParseFailures } = await summarizeChangedFiles({
    projectRoot,
    index,
    changedFileList,
    diffHunksByFile,
    diffKindsByFile,
    explicitFiles,
    existenceByFile,
    deletedSnapshots,
    includeSymbolDetails,
    includeDiffContext,
    diffContextLines,
    maxCallsites,
    referenceConcurrency,
    diagnostics,
    ...(reviewTimings ? { reviewTimings } : {}),
  });

  const graphDelta = await collectReviewGraphDelta({
    projectRoot,
    index,
    changedFiles,
    deletedFiles,
    deletedSnapshots,
  });

  const candidateTests = await collectReviewCandidateTests({
    projectRoot,
    index,
    changedFileList,
    changedSymbolIds,
    deletedFiles,
    appliedOptions,
    ...(reviewTimings ? { reviewTimings } : {}),
  });

  const projectFiles = index.projectFiles ?? (await discoverProjectFiles(projectRoot));
  const sqlContext = await collectReviewSqlContext({ projectRoot, index, changedFileList });
  const report = assembleReviewReport({
    appliedOptions,
    projectFiles,
    summaries,
    changedSymbolIds,
    candidateTests,
    graphDelta,
    ...(sqlContext ? { sqlContext } : {}),
    diagnostics,
    riskRelevantParseFailures,
    exportedChangedCount,
  });
  if (reviewTimings) reviewTimings.totalMs = Math.round(performance.now() - totalStart);
  return report;
}
