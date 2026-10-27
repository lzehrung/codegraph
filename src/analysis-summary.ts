import type { ProjectIndex, BuildReport } from "./indexer/types.js";

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

/** Files the native parser skipped (for example `sourceTooLarge` or `queryFailure`). */
export function analysisSkippedFileCount(summary: AnalysisCoverage): number {
  return Math.max(summary.parserDegradedFiles, summary.nativeFilesFellBack);
}

/** True when no file was skipped, so reference and rename evidence covers the whole index. */
export function isAnalysisComplete(summary: AnalysisCoverage): boolean {
  return !analysisSkippedFileCount(summary);
}

export function formatAnalysisSummaryLabel(summary: AnalysisSummary): string {
  const backend = summary.backend === "native" ? "native semantic" : "semantic";
  const skipped = analysisSkippedFileCount(summary);
  return skipped ? `${backend} (${skipped} file(s) skipped)` : backend;
}

/**
 * Counts indexed files by the native outcome their module was indexed with. A build parses only the files it cannot
 * reuse, so its report counts those alone; the modules also cover files served from the module cache or the
 * project snapshot.
 */
function countModuleNativeOutcomes(index: ProjectIndex | undefined): { used: number; skipped: number } {
  let used = 0;
  let skipped = 0;
  for (const mod of index?.byFile.values() ?? []) {
    if (mod.nativeOutcome === "used") used += 1;
    else if (mod.nativeOutcome === "skipped") skipped += 1;
  }
  return { used, skipped };
}

export function summarizeAnalysis(input: {
  index?: ProjectIndex | undefined;
  report?: BuildReport | undefined;
}): AnalysisSummary {
  if (input.index?.analysis) return input.index.analysis;
  const native = input.report?.backend?.native;
  const indexed = countModuleNativeOutcomes(input.index);
  // Take the larger count: the report covers the files this build parsed, the modules cover every indexed file, and
  // an index whose modules carry no outcome keeps the report's counts.
  const nativeFilesUsed = Math.max(native?.filesUsed ?? 0, indexed.used);
  const summary: AnalysisSummary = {
    mode: "semantic",
    backend: nativeFilesUsed ? "native" : "unknown",
    parserDegradedFiles: input.report?.backend?.parser?.total ?? 0,
    nativeFilesUsed,
    nativeFilesFellBack: Math.max(native?.filesFellBack ?? 0, indexed.skipped),
    label: "",
  };
  summary.label = formatAnalysisSummaryLabel(summary);
  return summary;
}
