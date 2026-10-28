import type { ProjectIndex, BuildReport } from "./indexer/types.js";
import { fileIdentityKey } from "./util/paths.js";

export type AnalysisMode = "semantic";

export type AnalysisBackend = "native" | "unknown";

export type AnalysisSummary = {
  mode: AnalysisMode;
  backend: AnalysisBackend;
  parserDegradedFiles: number;
  nativeFilesUsed: number;
  nativeFilesFellBack: number;
  label: string;
};

type AnalysisCoverage = Pick<AnalysisSummary, "parserDegradedFiles" | "nativeFilesFellBack">;

/** True when no file was skipped or degraded, so reference and rename evidence covers the whole index. */
export function isAnalysisComplete(summary: AnalysisCoverage): boolean {
  return !summary.parserDegradedFiles && !summary.nativeFilesFellBack;
}

/** What the modules of an index, or the report of a build, show about how native handled the files. */
type AnalysisCounts = {
  /** Files native parsed. */
  used: number;
  /** Files native skipped, for example with `sourceTooLarge` or `queryFailure`. */
  skipped: number;
  /** Files with a part that could not be indexed. */
  degraded: number;
  /** Files that are skipped or degraded, each counted once. The label reports this count. */
  incomplete: number;
};

/** The files `entries` name that `index` holds no module for, by identity key. */
function filesOutsideIndex(index: ProjectIndex, entries: readonly { file: string }[] | undefined): Set<string> {
  const files = new Set<string>();
  for (const { file } of entries ?? []) {
    const key = fileIdentityKey(file);
    if (!index.byFile.has(key)) files.add(key);
  }
  return files;
}

/**
 * Counts the files an index holds by how native handled each when its module was indexed. A build parses only the files
 * it cannot reuse, so its report covers those alone, while the modules also cover files served from the module cache or
 * the project snapshot. The modules therefore decide for every file the index holds, and a file that was skipped and
 * also degraded counts once. The report adds only a file that its `native.errors` or `parser.files` list names and the
 * index holds no module for, such as a C# file that a namespace lookup read and could not parse. Each list holds at
 * most 20 files.
 */
function countIndexedAnalysis(index: ProjectIndex, report: BuildReport | undefined): AnalysisCounts {
  const counts: AnalysisCounts = { used: 0, skipped: 0, degraded: 0, incomplete: 0 };
  for (const mod of index.byFile.values()) {
    const skipped = mod.nativeOutcome === "skipped";
    if (mod.nativeOutcome === "used") counts.used += 1;
    if (skipped) counts.skipped += 1;
    if (mod.parserDegraded) counts.degraded += 1;
    if (skipped || mod.parserDegraded) counts.incomplete += 1;
  }
  const skippedOutside = filesOutsideIndex(index, report?.backend?.native.errors);
  const degradedOutside = filesOutsideIndex(index, report?.backend?.parser?.files);
  counts.skipped += skippedOutside.size;
  counts.degraded += degradedOutside.size;
  counts.incomplete += new Set([...skippedOutside, ...degradedOutside]).size;
  return counts;
}

/** Without an index the build report is all there is, so its own counts stand. */
function countReportedAnalysis(report: BuildReport | undefined): AnalysisCounts {
  const native = report?.backend?.native;
  const skipped = native?.filesFellBack ?? 0;
  const degraded = report?.backend?.parser?.total ?? 0;
  // The report counts each kind of failure and cannot show which files share them, so the larger count is the fewest
  // files that account for both.
  return { used: native?.filesUsed ?? 0, skipped, degraded, incomplete: Math.max(skipped, degraded) };
}

export function summarizeAnalysis(input: {
  index?: ProjectIndex | undefined;
  report?: BuildReport | undefined;
}): AnalysisSummary {
  if (input.index?.analysis) return input.index.analysis;
  const counts = input.index ? countIndexedAnalysis(input.index, input.report) : countReportedAnalysis(input.report);
  const backend = counts.used ? "native" : "unknown";
  const label = backend === "native" ? "native semantic" : "semantic";
  return {
    mode: "semantic",
    backend,
    parserDegradedFiles: counts.degraded,
    nativeFilesUsed: counts.used,
    nativeFilesFellBack: counts.skipped,
    label: counts.incomplete ? `${label} (${counts.incomplete} file(s) skipped)` : label,
  };
}
