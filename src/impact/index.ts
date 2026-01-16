import path from "node:path";
import pm from "picomatch";
import type { ProjectIndex } from "../indexer.js";
import type {
  ImpactReport,
  CompactImpactReport,
  ImpactOptions,
} from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbols } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import { buildImpactReport } from "./report.js";
import { collectImpactSuggestions } from "./suggestions.js";

export * from "./types.js";

export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<ImpactReport | CompactImpactReport> {
  // Get the diff
  const diff = await getDiff(options);

  const { ignoreGlobs = [] } = options;
  const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

  // Filter out ignored files from diff
  const filteredFiles =
    ignoreGlobs.length > 0
      ? diff.files.filter((f) => !isIgnored(f.path))
      : diff.files;

  // Map all changed files to changed symbols
  let changedSymbols: any[] = [];
  for (const fileChange of filteredFiles) {
    const absPath = path.isAbsolute(fileChange.path)
      ? fileChange.path.replace(/\\/g, "/")
      : path.resolve(projectRoot, fileChange.path).replace(/\\/g, "/");
    const symbols = locateChangedSymbols(index, absPath, fileChange.hunks);
    changedSymbols.push(...symbols);
  }

  // Honor scope option: only consider exported symbols if scope=imported
  if (options.scope === "imported") {
    changedSymbols = changedSymbols.filter((s) => s.exported);
  }

  // Analyze impact
  const impactedItems = await analyzeImpact(
    index,
    changedSymbols,
    filteredFiles,
    options,
  );

  const suggestions = options.verifyReferences
    ? await collectImpactSuggestions(index, projectRoot, filteredFiles, options)
    : [];

  // Build report
  return await buildImpactReport(
    projectRoot,
    index,
    filteredFiles,
    changedSymbols,
    impactedItems,
    suggestions,
    { ...options, warning: diff.warning },
  );
}

// Re-export functions for testing and advanced usage
export { seedTransitiveFromFiles, calculateSeverity } from "./analyzer.js";
export {
  collectImpactContext,
  listCandidateTestFiles,
  type ImpactContext,
  type CandidateTestFile,
} from "./context.js";
