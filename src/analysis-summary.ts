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

export function formatAnalysisSummaryLabel(summary: AnalysisSummary): string {
  const backend = summary.backend === "native" ? "native semantic" : "semantic";
  const skipped = Math.max(summary.parserDegradedFiles, summary.nativeFilesFellBack);
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
