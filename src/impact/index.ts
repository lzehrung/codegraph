import type { ProjectIndex } from "../indexer.js";
import type { Diff, ImpactReport, ImpactOptions } from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbols } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import { buildImpactReport } from "./report.js";

export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions
): Promise<ImpactReport> {
  // Get the diff
  const diff = await getDiff(options);

  // Map all changed files to changed symbols
  let changedSymbols: any[] = [];
  for (const fileChange of diff.files) {
    const symbols = locateChangedSymbols(index, fileChange.path, fileChange.hunks);
    changedSymbols.push(...symbols);
  }

  // Honor scope option: only consider exported symbols if scope=imported
  if (options.scope === "imported") {
    changedSymbols = changedSymbols.filter(s => s.exported);
  }

  // Analyze impact
  const impactedItems = await analyzeImpact(index, changedSymbols, options);

  // Build report
  return buildImpactReport(index, diff.files, changedSymbols, impactedItems);
}
