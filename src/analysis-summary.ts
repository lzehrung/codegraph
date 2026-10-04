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

export function summarizeAnalysis(input: {
  index?: ProjectIndex | undefined;
  report?: BuildReport | undefined;
}): AnalysisSummary {
  if (input.index?.analysis) return input.index.analysis;
  const nativeFilesUsed = input.report?.backend?.native?.filesUsed ?? 0;
  const summary: AnalysisSummary = {
    mode: "semantic",
    backend: nativeFilesUsed ? "native" : "unknown",
    parserDegradedFiles: input.report?.backend?.parser?.total ?? 0,
    nativeFilesUsed,
    nativeFilesFellBack: input.report?.backend?.native?.filesFellBack ?? 0,
    label: "",
  };
  summary.label = formatAnalysisSummaryLabel(summary);
  return summary;
}
