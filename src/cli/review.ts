import { performance } from "node:perf_hooks";
import { buildReviewReport, type ReviewBuildReport, type ReviewDepth } from "../review.js";
import type { CandidateTestFile } from "../impact/context.js";
import type { CallCompatibilityHint } from "../impact/types.js";
import type { BuildReport } from "../indexer/types.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import {
  REVIEW_SUMMARY_CANDIDATES_PER_CONFIDENCE_LIMIT,
  REVIEW_SUMMARY_CHANGED_FILE_LIMIT,
  REVIEW_SUMMARY_SYMBOLS_PER_FILE_LIMIT,
  REVIEW_SUMMARY_TASK_LIMIT,
} from "../presentation/bounds.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parseCacheModeOption, parseOptionalNonNegativeIntegerOption } from "./options.js";

type CommandTimingReport = {
  totalMs?: number;
  resolveFilesMs?: number;
  commandMs?: number;
};

type ReviewCommandReport = {
  command: string;
  timings: CommandTimingReport;
  index?: BuildReport;
  review?: ReviewBuildReport;
};

export type ReviewCommandContext = {
  projectRootFs: string;
  discoveryOptions: ProjectFileDiscoveryOptions;
  reportFile: string | undefined;
  commandReport: ReviewCommandReport | undefined;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  nativeMode: NativeRuntimeMode;
  useNativeWorkers: boolean;
  graphOptions: GraphBuildOptions | undefined;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  writeCommandReport: (report: ReviewCommandReport, reportFile: string | undefined) => Promise<void>;
  exit: (code: number) => never;
};

function parseReviewDepth(value: string): ReviewDepth | null {
  if (value === "minimal" || value === "standard" || value === "deep") {
    return value;
  }
  return null;
}

function countCandidateTestsByConfidence(
  candidates: CandidateTestFile[],
): Record<CandidateTestFile["confidence"], number> {
  const counts: Record<CandidateTestFile["confidence"], number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const candidate of candidates) {
    counts[candidate.confidence] += 1;
  }
  return counts;
}

function appendCandidateTestGroup(
  lines: string[],
  title: string,
  candidates: CandidateTestFile[],
  confidence: CandidateTestFile["confidence"],
): number {
  const matches = candidates.filter((candidate) => candidate.confidence === confidence);
  if (!matches.length) return 0;
  lines.push(title);
  for (const candidate of matches.slice(0, REVIEW_SUMMARY_CANDIDATES_PER_CONFIDENCE_LIMIT)) {
    lines.push(`- ${candidate.file}: ${candidate.reason}`);
  }
  const remaining = matches.length - REVIEW_SUMMARY_CANDIDATES_PER_CONFIDENCE_LIMIT;
  if (remaining > 0) {
    lines.push(`- ... and ${remaining} more`);
  }
  return matches.length;
}

function appendLowConfidenceCandidateSummary(lines: string[], lowConfidenceCount: number): void {
  if (!lowConfidenceCount) return;
  lines.push(`Low-confidence pattern matches: ${lowConfidenceCount} available as breadth hints in full JSON.`);
}

function formatReviewRequiredArgumentCount(hint: CallCompatibilityHint): string {
  if (hint.reason === "argument_count_above_maximum" && hint.expected.maxArgs !== null) {
    return `accepts at most ${hint.expected.maxArgs}`;
  }
  return `requires ${hint.expected.minArgs}`;
}

function appendReviewCallCompatibility(lines: string[], report: Awaited<ReturnType<typeof buildReviewReport>>): void {
  const findings: string[] = [];
  for (const file of report.changedFiles) {
    for (const symbol of file.symbols) {
      const hints = symbol.callCompatibility ?? [];
      for (const hint of hints) {
        if (hint.status !== "likely_mismatch") {
          continue;
        }
        const plural = hint.actual.argCount === 1 ? "argument" : "arguments";
        const requirement = formatReviewRequiredArgumentCount(hint);
        findings.push(
          `- ${symbol.name}: ${hint.callsiteFile}:${hint.callsiteRange.start.line} passes ${hint.actual.argCount} ${plural}; new signature ${requirement}.`,
        );
      }
    }
  }
  if (!findings.length) {
    return;
  }
  lines.push("");
  lines.push("Call compatibility:");
  lines.push(...findings);
}

function formatReviewSummary(report: Awaited<ReturnType<typeof buildReviewReport>>): string {
  const lines: string[] = [];
  const candidateCounts = countCandidateTestsByConfidence(report.candidateTests);
  lines.push("Review Summary");
  lines.push("==============");
  lines.push(`Status: ${report.status}`);
  lines.push(`Files changed: ${report.summary.filesChanged}`);
  lines.push(`Symbols changed: ${report.summary.symbolsChanged}`);
  lines.push(
    `Candidate tests: ${report.summary.candidateTests} (high: ${candidateCounts.high}, medium: ${candidateCounts.medium}, low: ${candidateCounts.low})`,
  );
  lines.push(`Risk: ${report.riskSummary.level} (${report.riskSummary.score})`);
  if (report.riskSummary.signals.length) {
    lines.push(`Signals: ${report.riskSummary.signals.join(", ")}`);
  }
  lines.push("");
  lines.push("Changed files:");
  if (!report.changedFiles.length) {
    lines.push("- none");
  } else {
    for (const file of report.changedFiles.slice(0, REVIEW_SUMMARY_CHANGED_FILE_LIMIT)) {
      const symbolNames = file.symbols.slice(0, REVIEW_SUMMARY_SYMBOLS_PER_FILE_LIMIT).map((symbol) => symbol.name);
      const symbolSummary = symbolNames.length ? ` (${symbolNames.join(", ")})` : "";
      lines.push(`- ${file.file}: ${file.status}${symbolSummary}`);
    }
    const remainingFiles = report.changedFiles.length - REVIEW_SUMMARY_CHANGED_FILE_LIMIT;
    if (remainingFiles > 0) {
      lines.push(`- ... and ${remainingFiles} more`);
    }
  }
  lines.push("");
  lines.push("Candidate tests:");
  if (!report.candidateTests.length) {
    lines.push("- none");
  } else {
    const listedCandidates =
      appendCandidateTestGroup(lines, "High-confidence tests:", report.candidateTests, "high") +
      appendCandidateTestGroup(lines, "Medium-confidence tests:", report.candidateTests, "medium");
    if (!listedCandidates) {
      lines.push("No high- or medium-confidence test candidates found.");
    }
    appendLowConfidenceCandidateSummary(lines, candidateCounts.low);
  }
  lines.push("");
  lines.push("Review tasks:");
  if (!report.reviewTasks.length) {
    lines.push("- none");
  } else {
    for (const task of report.reviewTasks.slice(0, REVIEW_SUMMARY_TASK_LIMIT)) {
      lines.push(`- ${task.id}: ${task.priority} - ${task.title} (${task.reason})`);
    }
    const remainingTasks = report.reviewTasks.length - REVIEW_SUMMARY_TASK_LIMIT;
    if (remainingTasks > 0) {
      lines.push(`- ... and ${remainingTasks} more`);
    }
  }
  if (report.diagnostics) {
    lines.push("");
    lines.push("Diagnostics:");
    lines.push(`- missing files: ${report.diagnostics.missingFiles.length}`);
    lines.push(`- symbol mapping parse failures: ${report.diagnostics.symbolMappingParseFailures.length}`);
  }
  appendReviewCallCompatibility(lines, report);
  return `${lines.join("\n")}\n`;
}

export async function handleReviewCommand(context: ReviewCommandContext): Promise<void> {
  const commandStart = performance.now();
  const base = context.getOpt("--base");
  const head = context.getOpt("--head");
  const changedSince = context.getOpt("--changed-since");
  const reviewDepthRaw = context.getOpt("--review-depth");
  const reviewDepth = reviewDepthRaw !== undefined ? parseReviewDepth(reviewDepthRaw) : null;
  if (reviewDepthRaw !== undefined && !reviewDepth) {
    context.writeStderrLine(`Invalid --review-depth value "${reviewDepthRaw}". Expected minimal|standard|deep.`);
    context.exit(2);
  }
  const threadsRaw = context.getOpt("--threads");
  const threads = parseOptionalNonNegativeIntegerOption(threadsRaw, "--threads");
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const cacheStrict = context.hasFlag("--cache-strict");
  const cacheVerify = context.hasFlag("--cache-verify");
  const incrementalStrict = context.hasFlag("--incremental-strict");
  const includeSymbolDetails = context.hasFlag("--include-symbol-details");
  const maxCallsitesRaw = context.getOpt("--max-callsites");
  const maxCallsites = parseOptionalNonNegativeIntegerOption(maxCallsitesRaw, "--max-callsites");
  const maxTestsRaw = context.getOpt("--max-tests");
  const maxTests = parseOptionalNonNegativeIntegerOption(maxTestsRaw, "--max-tests");
  const reviewOpts: Parameters<typeof buildReviewReport>[1] = {};
  reviewOpts.discovery = context.discoveryOptions;
  if (reviewDepth) reviewOpts.reviewDepth = reviewDepth;
  if (base !== undefined) reviewOpts.gitBase = base;
  if (head !== undefined) reviewOpts.gitHead = head;
  if (changedSince !== undefined) reviewOpts.changedSince = changedSince;
  if (threads !== undefined) reviewOpts.threads = threads;
  if (cache === "off" || cache === "memory" || cache === "disk") {
    reviewOpts.cache = cache;
  }
  if (context.nativeMode !== "auto") reviewOpts.native = context.nativeMode;
  if (context.useNativeWorkers) reviewOpts.useNativeWorkers = true;
  if (cacheStrict) reviewOpts.cacheStrict = true;
  if (cacheVerify) reviewOpts.cacheVerify = true;
  if (incrementalStrict) reviewOpts.incrementalStrict = true;
  if (context.graphOptions) reviewOpts.graph = context.graphOptions;
  if (includeSymbolDetails) {
    reviewOpts.includeSymbolDetails = includeSymbolDetails;
  }
  if (maxCallsites !== undefined) reviewOpts.maxCallsites = maxCallsites;
  if (maxTests !== undefined) reviewOpts.maxCandidates = maxTests;
  if (context.commandReport) {
    const reviewReport: ReviewBuildReport = { timings: {} };
    context.commandReport.review = reviewReport;
    reviewOpts.report = reviewReport;
  }
  const report = await buildReviewReport(context.projectRootFs, reviewOpts);
  if (context.hasFlag("--summary") || context.hasFlag("--pretty")) {
    context.writeStdoutLine(formatReviewSummary(report).trimEnd());
  } else {
    context.writeJSONLine(report);
  }
  if (context.commandReport) {
    context.commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
    context.commandReport.timings.totalMs = context.commandReport.timings.commandMs;
    await context.writeCommandReport(context.commandReport, context.reportFile);
  }
}
