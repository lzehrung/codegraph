import type { FileId } from "../types.js";
import { type ProjectIndex } from "../indexer/types.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./testPatterns.js";
import type { ChangedSymbol, ImpactItem, ImpactOptions, FileChange } from "./types.js";
import { createImpactIgnoreMatcher } from "./path.js";
import { analyzeDirectReferences } from "./direct.js";
import { analyzeTransitiveImpact, seedTransitiveFromFiles } from "./transitive.js";
import { buildDependencyStats } from "./severity.js";
export { calculateSeverity, calculateTransitiveSeverity } from "./severity.js";
export { seedTransitiveFromFiles } from "./transitive.js";

export async function analyzeImpact(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  changedFiles: FileChange[],
  options: Partial<ImpactOptions> & { projectRoot?: string } = {},
): Promise<ImpactItem[]> {
  const {
    maxRefs = 1000,
    depth = 3,
    includeTests = false,
    testPatterns,
    ignoreGlobs = [],
    refContext,
    refContextLines,
    refBlockMaxLines,
    onImpactItem,
  } = options;
  const diagnostics = options.diagnostics;
  const projectRoot =
    options.projectRoot ?? index.projectRoot ?? index.projectFiles?.find((entry) => entry.projectRoot)?.projectRoot;
  const normalizedOptions = {
    ...options,
    ...(projectRoot ? { projectRoot } : {}),
  };

  const patternMatchers = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, patternMatchers, projectRoot);
  const isIgnored = projectRoot ? createImpactIgnoreMatcher(projectRoot, ignoreGlobs) : () => false;

  const impacted = new Map<FileId, ImpactItem>();
  const processedSymbols = new Set<string>();

  const { fanInByFile, reverseDeps } = buildDependencyStats(index.graph.edges);

  const emitImpactItem = (item: ImpactItem, phase: "partial" | "final"): void => {
    onImpactItem?.(
      {
        ...item,
        symbols: [...item.symbols],
        reasons: [...item.reasons],
        ...(item.refs
          ? {
              refs: item.refs.map((ref) => ({
                range: ref.range,
                ...(ref.context !== undefined ? { context: ref.context } : {}),
              })),
            }
          : {}),
        ...(item.explain
          ? {
              explain: {
                ...item.explain,
                ...(item.explain.hints ? { hints: [...item.explain.hints] } : {}),
              },
            }
          : {}),
      },
      phase,
    );
  };

  // Filter out changed symbols in ignored files
  const filteredChangedSymbols = changedSymbols.filter((s) => !isIgnored(s.file));
  const directOptions = {
    maxRefs,
    includeTests,
    ...(refContext !== undefined ? { refContext } : {}),
    ...(refContextLines !== undefined ? { refContextLines } : {}),
    ...(refBlockMaxLines !== undefined ? { refBlockMaxLines } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };

  await analyzeDirectReferences({
    index,
    changedSymbols: filteredChangedSymbols,
    impacted,
    processedSymbols,
    isIndexTestFile,
    isIgnored,
    fanInByFile,
    options: directOptions,
    emitImpactItem,
  });

  // Seed transitive impact from changed files.  This is NOT redundant with
  // analyzeTransitiveImpact below: deleted/renamed files produce no changedSymbols
  // (they no longer exist), so they would never enter `impacted` through the symbol
  // loop above.  seedTransitiveFromFiles plants them directly so the transitive pass
  // can propagate their impact to dependents.
  if (!options.membersOnly) {
    seedTransitiveFromFiles(index, impacted, changedFiles, normalizedOptions, reverseDeps, emitImpactItem);
  }

  // Transitive impact via graph traversal (skip if membersOnly)
  if (!options.membersOnly) {
    analyzeTransitiveImpact(impacted, depth, normalizedOptions, isIndexTestFile, reverseDeps, emitImpactItem);
  }

  const sorted = Array.from(impacted.values()).sort((a, b) => b.severity - a.severity);
  for (const item of sorted) {
    emitImpactItem(item, "final");
  }
  return sorted;
}
