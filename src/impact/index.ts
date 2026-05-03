import type { ProjectIndex } from "../indexer.js";
import type { ImpactReport, CompactImpactReport, ImpactOptions } from "./types.js";
import { collectImpactAnalysis } from "./collect.js";
import { buildImpactReport } from "./report.js";
import { collectImpactReportSuggestions } from "./report-suggestions.js";

export * from "./types.js";
export { analyzeImpactStreaming, type ImpactStreamChunk } from "./streaming.js";
export { collectImpactReportSuggestions } from "./report-suggestions.js";

/**
 * Analyze a diff against an existing project index and return a structured impact report.
 *
 * Use this batch API when the caller can wait for the complete result. The full
 * report includes changed files, changed symbols, impacted items, optional
 * suggestions, export summaries, re-export chains, graph edges, cycles,
 * diagnostics, and stable schema metadata for downstream pack builders.
 */
export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<ImpactReport | CompactImpactReport> {
  const analysis = await collectImpactAnalysis(projectRoot, index, options);
  const suggestions = await collectImpactReportSuggestions(
    projectRoot,
    index,
    options,
    analysis.normalizedChanges,
    analysis.changedSymbols,
  );

  // Build report
  return await buildImpactReport(
    projectRoot,
    index,
    analysis.normalizedChanges,
    analysis.changedSymbols,
    analysis.impactedItems,
    suggestions,
    { ...options, warning: analysis.warning },
    analysis.diagnostics,
  );
}

// Re-export functions for testing and advanced usage
export { seedTransitiveFromFiles, calculateSeverity } from "./analyzer.js";
export { collectImpactContext, listCandidateTestFiles, type ImpactContext, type CandidateTestFile } from "./context.js";
