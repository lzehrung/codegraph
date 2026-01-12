import path from "node:path";
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

export * from "./types.js";

export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<ImpactReport | CompactImpactReport> {
  // Get the diff
  const diff = await getDiff(options);

  // Map all changed files to changed symbols
  let changedSymbols: any[] = [];
  for (const fileChange of diff.files) {
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
    diff.files,
    options,
  );

  // Build report
  return await buildImpactReport(
    index,
    diff.files,
    changedSymbols,
    impactedItems,
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
