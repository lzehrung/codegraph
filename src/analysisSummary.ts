import type { ProjectIndex, BuildReport } from "./indexer/types.js";

export type AnalysisMode = "semantic" | "mixed" | "reduced";

export type AnalysisBackend = "native" | "mixed" | "graph-only" | "unknown";

export type AnalysisSummary = {
  mode: AnalysisMode;
  backend: AnalysisBackend;
  parserDegradedFiles: number;
  fallbackImportExtractionFiles: number;
  nativeFilesUsed: number;
  nativeFilesFellBack: number;
  label: string;
};

function deriveAnalysisBackend(input: {
  index?: ProjectIndex | undefined;
  report?: BuildReport | undefined;
}): AnalysisBackend {
  const nativeReport = input.report?.backend?.native;
  const parserFallbackCount = input.report?.backend?.parser?.total ?? 0;
  const importFallbackCount = input.report?.graph?.fallbackImportExtraction?.total ?? 0;
  if (nativeReport) {
    if (!nativeReport.filesUsed && (parserFallbackCount || importFallbackCount)) {
      return "graph-only";
    }
    if (nativeReport.filesUsed && (nativeReport.filesFellBack || parserFallbackCount || importFallbackCount)) {
      return "mixed";
    }
    if (nativeReport.filesUsed) {
      return "native";
    }
  }
  if (input.index?.nativeMode === "off") {
    return "graph-only";
  }
  return "unknown";
}

function deriveAnalysisMode(summary: Omit<AnalysisSummary, "mode" | "label">): AnalysisMode {
  if (summary.backend === "graph-only") {
    return "reduced";
  }
  if (
    summary.backend === "mixed" ||
    summary.parserDegradedFiles > 0 ||
    summary.fallbackImportExtractionFiles > 0 ||
    summary.nativeFilesFellBack > 0
  ) {
    return "mixed";
  }
  return "semantic";
}

export function formatAnalysisSummaryLabel(summary: AnalysisSummary): string {
  if (summary.mode === "semantic") {
    return summary.backend === "native" ? "native semantic" : "semantic";
  }
  if (summary.mode === "reduced") {
    return "reduced graph-only";
  }
  const details: string[] = [];
  if (summary.parserDegradedFiles) {
    details.push(`${summary.parserDegradedFiles} parser fallback`);
  }
  if (summary.fallbackImportExtractionFiles) {
    details.push(`${summary.fallbackImportExtractionFiles} regex import fallback`);
  }
  if (!details.length && summary.nativeFilesFellBack) {
    details.push(`${summary.nativeFilesFellBack} native fallback`);
  }
  return details.length ? `mixed semantics (${details.join(", ")})` : "mixed semantics";
}

export function summarizeAnalysis(input: {
  index?: ProjectIndex | undefined;
  report?: BuildReport | undefined;
}): AnalysisSummary {
  const parserDegradedFiles = input.report?.backend?.parser?.total ?? 0;
  const fallbackImportExtractionFiles = input.report?.graph?.fallbackImportExtraction?.total ?? 0;
  const nativeFilesUsed = input.report?.backend?.native?.filesUsed ?? 0;
  const nativeFilesFellBack = input.report?.backend?.native?.filesFellBack ?? 0;
  const backend = deriveAnalysisBackend(input);
  const summaryBase = {
    backend,
    parserDegradedFiles,
    fallbackImportExtractionFiles,
    nativeFilesUsed,
    nativeFilesFellBack,
  };
  const mode = deriveAnalysisMode(summaryBase);
  const summary: AnalysisSummary = {
    ...summaryBase,
    mode,
    label: "",
  };
  summary.label = formatAnalysisSummaryLabel(summary);
  return summary;
}
