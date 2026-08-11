import { checkMarkdownLinksInFiles } from "./documentLinks/check.js";
import { performance } from "node:perf_hooks";
import {
  findDuplicateContextsWithPreparedAnalysis,
  prepareDuplicateAnalysis,
  type DuplicateGroup,
  type DuplicatePreparedAnalysis,
  type DuplicateUnitRef,
} from "./duplicates.js";
import type { FileId } from "./types.js";
import { loadCurrentProjectIndex } from "./indexer/load-current-index.js";
import { summarizeAnalysis } from "./analysisSummary.js";
import { type ProjectIndex, type SymbolDef } from "./indexer/types.js";
import { symbolId } from "./indexer/symbols.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import type { FileChange, Hunk } from "./impact/types.js";
import { normalizePath, toProjectDisplayPath } from "./util/paths.js";
import { fileExists } from "./util/workspace.js";
import { discoverProjectFiles, type ProjectFileInfo } from "./util/projectFiles.js";
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
import { summarizeChangedFiles } from "./review/summaries.js";
import type {
  ReviewBuildReport,
  ReviewDepth,
  ReviewDiagnostics,
  ReviewFileSummary,
  ReviewOptions,
  ReviewReport,
  ReviewTask,
  ReviewTimingReport,
} from "./review/types.js";

export type {
  ReviewBuildReport,
  ReviewChangedFileSummaries,
  ReviewDepth,
  ReviewDiagnostics,
  ReviewFileSummary,
  ReviewOptions,
  ReviewReport,
  ReviewRiskLevel,
  ReviewRiskSummary,
  ReviewSymbolCallsite,
  ReviewSymbolSummary,
  ReviewTask,
  ReviewTaskPriority,
  ReviewTimingReport,
} from "./review/types.js";

/**
 * Structured review bundle for downstream review agents.
 *
 * This is the programmatic counterpart to CLI review output. It keeps risk,
 * tasks, changed symbols, graph deltas, candidate tests, diagnostics, and
 * snippets as data so callers can build deterministic file packs or prompts.
 */
type ReviewPreset = {
  includeSymbolDetails: boolean;
  maxCallsites: number;
  maxCandidates: number;
  graph: { fast: boolean };
};

type ReviewDuplicateTarget = {
  file: string;
  startLine?: number;
  endLine?: number;
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

const REVIEW_DUPLICATE_TASK_LIMIT = 5;
const REVIEW_DUPLICATE_MAX_PAIRS = 20_000;

function mergeGraphOptions(
  base: GraphBuildOptions | undefined,
  override: GraphBuildOptions | undefined,
): GraphBuildOptions | undefined {
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
  reviewReport?: ReviewBuildReport;
  reviewTimings?: ReviewTimingReport;
  /**
   * Reuse an already loaded project index, or load it lazily only if review work reaches
   * the current-project build stage.
   */
  providedIndex?: ProjectIndex;
  loadProvidedIndex?: () => Promise<ProjectIndex>;
}): Promise<ReviewIndexStage> {
  const {
    projectRoot,
    appliedOptions,
    changedFileList,
    diffKindsByFile,
    diffChangesByFile,
    reviewReport,
    reviewTimings,
    providedIndex,
    loadProvidedIndex,
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
  // Review range selection describes the diff, not the freshness scope of the
  // current-project index: the shared loader strips those inputs and lets incremental
  // indexing reconcile the whole project, unioning review targets outside discovery.
  // A caller-provided index (e.g. an already-loaded agent session snapshot) is reused
  // as-is when the review does not request additional files beyond normal project scope.
  let index: ProjectIndex;
  if (providedIndex && !appliedOptions.files?.length) {
    index = providedIndex;
  } else if (loadProvidedIndex && !appliedOptions.files?.length) {
    index = await loadProvidedIndex();
  } else {
    index = await loadCurrentProjectIndex({
      root: projectRoot,
      scope: {
        kind: "project",
        ...(appliedOptions.files?.length ? { additionalFiles: appliedOptions.files } : {}),
      },
      options: {
        ...appliedOptions,
        graph: graphOptions,
        keepParsed: true,
        ...(indexReport ? { report: indexReport } : {}),
      },
    });
  }
  if (reviewReport) {
    Object.defineProperty(reviewReport, "index", {
      value: index,
      enumerable: false,
      configurable: true,
    });
  }
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
export async function buildReviewReport(
  projectRoot: string,
  opts: ReviewOptions = {},
  cached?: {
    index?: ProjectIndex;
    loadIndex?: () => Promise<ProjectIndex>;
    duplicateAnalysis?: DuplicatePreparedAnalysis;
    loadDuplicateAnalysis?: () => Promise<DuplicatePreparedAnalysis>;
  },
): Promise<ReviewReport> {
  const appliedOptions = applyReviewPresetOptions(opts);
  const reviewReport = appliedOptions.report;
  const reviewTimings = reviewReport?.timings;
  if (reviewTimings) reviewTimings.duplicateAnalysisMs = 0;
  if (reviewReport && appliedOptions.duplicateTasks === false) {
    delete reviewReport.duplicateAnalysis;
  }
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
      ...(reviewReport?.indexReport
        ? { analysis: summarizeAnalysis({ nativeMode: appliedOptions.native, report: reviewReport.indexReport }) }
        : {}),
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
    report.head = appliedOptions.gitHead ?? "HEAD";
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
    ...(reviewReport ? { reviewReport } : {}),
    ...(reviewTimings ? { reviewTimings } : {}),
    ...(cached?.index ? { providedIndex: cached.index } : {}),
    ...(cached?.loadIndex ? { loadProvidedIndex: cached.loadIndex } : {}),
  });
  const includeDiffContext = appliedOptions.includeDiffContext ?? (includeSymbolDetails && diffHunksByFile.size > 0);

  const { summaries, changedSymbolIds, exportedChangedCount, riskRelevantParseFailures } = await summarizeChangedFiles({
    projectRoot,
    index,
    changedFileList,
    diffHunksByFile,
    diffKindsByFile,
    diffChangesByFile,
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
  const markdownLinks = await checkMarkdownLinksInFiles(projectRoot, index.byFile.keys());
  const sqlContext = await collectReviewSqlContext({ projectRoot, index, changedFileList });
  const report = assembleReviewReport({
    appliedOptions,
    projectFiles,
    summaries,
    changedSymbolIds,
    candidateTests,
    graphDelta,
    analysis: summarizeAnalysis({
      index,
      ...(reviewReport?.indexReport ? { report: reviewReport.indexReport } : {}),
    }),
    ...(sqlContext ? { sqlContext } : {}),
    markdownLinks,
    diagnostics,
    riskRelevantParseFailures,
    exportedChangedCount,
  });
  const duplicateAnalysisStart = performance.now();
  if (appliedOptions.duplicateTasks !== false) {
    const duplicateReview = await collectReviewDuplicateTasks({
      projectRoot,
      index,
      summaries,
      changedSymbolIds,
      diffHunksByFile,
      ...(cached?.duplicateAnalysis ? { providedAnalysis: cached.duplicateAnalysis } : {}),
      ...(cached?.loadDuplicateAnalysis ? { loadProvidedAnalysis: cached.loadDuplicateAnalysis } : {}),
    });
    report.reviewTasks.push(...duplicateReview.tasks);
    if (reviewReport && duplicateReview.preparedAnalysis) {
      Object.defineProperty(reviewReport, "duplicateAnalysis", {
        value: duplicateReview.preparedAnalysis,
        enumerable: false,
        configurable: true,
      });
    }
  }
  if (reviewTimings && appliedOptions.duplicateTasks !== false) {
    reviewTimings.duplicateAnalysisMs = Math.round(performance.now() - duplicateAnalysisStart);
  }
  if (reviewTimings) reviewTimings.totalMs = Math.round(performance.now() - totalStart);
  return report;
}

function buildSymbolDefLookup(index: ProjectIndex): Map<string, SymbolDef> {
  const lookup = new Map<string, SymbolDef>();
  for (const mod of index.byFile.values()) {
    for (const local of mod.locals) {
      lookup.set(symbolId(local), local);
    }
  }
  return lookup;
}

function relativeReviewPath(projectRoot: string, file: string): string {
  const normalizedRoot = normalizePath(projectRoot);
  const normalizedFile = normalizePath(file);
  return toProjectDisplayPath(normalizedRoot, normalizedFile) || normalizedFile;
}

function changedLinesForHunks(hunks: readonly Hunk[]): number[] {
  const changedLines: number[] = [];
  for (const hunk of hunks) {
    let nextLine = hunk.newStart;
    let recordedLine = false;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === "+") {
        changedLines.push(nextLine);
        nextLine++;
        recordedLine = true;
        continue;
      }
      if (prefix === " ") {
        nextLine++;
      }
    }
    if (!recordedLine && hunk.newStart > 0) {
      changedLines.push(hunk.newStart);
    }
  }
  return changedLines;
}

function compactChangedLineTargets(file: string, lines: readonly number[]): ReviewDuplicateTarget[] {
  if (!lines.length) return [];
  const uniqueLines = Array.from(new Set(lines)).sort((left, right) => left - right);
  const targets: ReviewDuplicateTarget[] = [];
  let startLine = uniqueLines[0]!;
  let endLine = startLine;
  for (const line of uniqueLines.slice(1)) {
    if (line === endLine + 1) {
      endLine = line;
      continue;
    }
    targets.push({ file, startLine, endLine });
    startLine = line;
    endLine = line;
  }
  targets.push({ file, startLine, endLine });
  return targets;
}

function duplicateUnitOverlapsTarget(unit: DuplicateUnitRef, target: ReviewDuplicateTarget): boolean {
  if (unit.file !== target.file) return false;
  if (target.startLine === undefined) return true;
  const targetEndLine = target.endLine ?? target.startLine;
  return unit.startLine <= targetEndLine && target.startLine <= unit.endLine;
}

function duplicateSiblingForTarget(group: DuplicateGroup, target: ReviewDuplicateTarget): DuplicateUnitRef {
  if (duplicateUnitOverlapsTarget(group.primaryLeft, target)) return group.primaryRight;
  if (duplicateUnitOverlapsTarget(group.primaryRight, target)) return group.primaryLeft;
  for (const variant of group.variants) {
    if (duplicateUnitOverlapsTarget(variant.left, target)) return variant.right;
    if (duplicateUnitOverlapsTarget(variant.right, target)) return variant.left;
  }
  return group.primaryLeft;
}

function duplicateReviewTask(group: DuplicateGroup, target: ReviewDuplicateTarget): ReviewTask {
  const sibling = duplicateSiblingForTarget(group, target);
  const targetLabel =
    target.startLine === undefined
      ? target.file
      : `${target.file}:${target.startLine}-${target.endLine ?? target.startLine}`;
  const siblingLabel = `${sibling.file}:${sibling.startLine}-${sibling.endLine}`;
  return {
    id: `duplicate-sibling-check:${group.id}`,
    title: "Check related duplicate implementation",
    description:
      `${targetLabel} overlaps a ${group.confidence}-confidence ${group.cloneType} duplicate group. ` +
      `Check sibling ${siblingLabel} for drift before changing only one side.`,
    priority: group.confidence === "high" ? "high" : "medium",
    reason: "duplicate-sibling",
  };
}

async function collectReviewDuplicateTasks(input: {
  projectRoot: string;
  index: ProjectIndex;
  summaries: readonly ReviewFileSummary[];
  changedSymbolIds: readonly string[];
  diffHunksByFile: ReadonlyMap<string, Hunk[]>;
  /** A pre-bucketed analysis to reuse instead of preparing one from scratch. */
  providedAnalysis?: DuplicatePreparedAnalysis;
  /** Loads a reusable prepared analysis only if duplicate tasks are actually needed. */
  loadProvidedAnalysis?: () => Promise<DuplicatePreparedAnalysis>;
}): Promise<{ tasks: ReviewTask[]; preparedAnalysis?: DuplicatePreparedAnalysis }> {
  const diffHunksByDisplayFile = new Map(
    Array.from(input.diffHunksByFile, ([file, hunks]) => [relativeReviewPath(input.projectRoot, file), hunks]),
  );
  const symbolLookup = buildSymbolDefLookup(input.index);
  const targets: ReviewDuplicateTarget[] = input.changedSymbolIds
    .map((id) => symbolLookup.get(id))
    .filter((def): def is SymbolDef => def !== undefined)
    .map((def) => ({
      file: relativeReviewPath(input.projectRoot, def.file),
      startLine: def.range.start.line,
      endLine: def.range.end.line,
    }));
  for (const summary of input.summaries) {
    if (summary.status !== "updated") continue;
    const hunks = diffHunksByDisplayFile.get(summary.file);
    if (!hunks?.length) {
      targets.push({ file: summary.file });
      continue;
    }
    const symbolTargets = targets.filter((target) => target.file === summary.file && target.startLine !== undefined);
    const uncoveredChangedLines = changedLinesForHunks(hunks).filter((line) => {
      return !symbolTargets.some((target) => {
        const targetEndLine = target.endLine ?? target.startLine!;
        return target.startLine! <= line && line <= targetEndLine;
      });
    });
    if (!uncoveredChangedLines.length) continue;
    targets.push(...compactChangedLineTargets(summary.file, uncoveredChangedLines));
  }
  if (!targets.length) return { tasks: [] };

  const preparedAnalysis =
    input.providedAnalysis ??
    (input.loadProvidedAnalysis ? await input.loadProvidedAnalysis() : undefined) ??
    (await prepareDuplicateAnalysis(input.index, {
      projectRoot: input.projectRoot,
    }));
  const contexts = await findDuplicateContextsWithPreparedAnalysis(preparedAnalysis, targets, {
    projectRoot: input.projectRoot,
    minConfidence: "high",
    includeSameFile: true,
    limit: REVIEW_DUPLICATE_TASK_LIMIT,
    maxPairs: REVIEW_DUPLICATE_MAX_PAIRS,
  });
  const tasks = new Map<string, ReviewTask>();
  for (const context of contexts) {
    for (const group of context.groups) {
      if (tasks.size >= REVIEW_DUPLICATE_TASK_LIMIT) {
        return { tasks: [...tasks.values()], preparedAnalysis };
      }
      const task = duplicateReviewTask(group, context.target);
      if (!tasks.has(task.id)) tasks.set(task.id, task);
    }
  }
  return { tasks: [...tasks.values()], preparedAnalysis };
}
