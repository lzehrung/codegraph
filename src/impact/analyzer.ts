import type { Edge, FileId } from "../types.js";
import { type ProjectIndex } from "../indexer/types.js";
import { fileIdentityKey } from "../util/paths.js";
import { sqlEdgeMatchesChangedObjects } from "../sql/source-graph.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./test-patterns.js";
import type { ChangedSymbol, ImpactItem, ImpactOptions, FileChange } from "./types.js";
import { createImpactIgnoreMatcher } from "./path.js";
import { analyzeDirectReferences } from "./direct.js";
import { analyzeTransitiveImpact, seedTransitiveFromFiles } from "./transitive.js";
import { buildDependencyStats, normalizeSeverityWeights, selectStrongerImpactReason } from "./severity.js";
import { attachCallCompatibilityHints } from "./call-compatibility.js";
import { computeMemberResolutionCoverage } from "./member-resolution-coverage.js";
import { createReferenceLookupCache } from "./reference-cache.js";
import {
  createImpactWorkBudget,
  IMPACT_SYMBOL_BATCH_SIZE,
  isImpactDeadlineExceeded,
  recordReferenceLookupOmitted,
  selectChangedSymbolsForBudget,
  syncBudgetDiagnostics,
} from "./budgets.js";
export { calculateSeverity, calculateTransitiveSeverity } from "./severity.js";
export { seedTransitiveFromFiles } from "./transitive.js";

/**
 * Impact scores are normalized effective scores: confidence already
 * contributes to severity. Remaining ties prefer more certain, shallower
 * evidence before stable file and symbol identities, so async lookup completion
 * order cannot affect ranked output.
 */
function compareImpactItems(left: ImpactItem, right: ImpactItem): number {
  const severityDifference = right.severity - left.severity;
  if (severityDifference !== 0) return severityDifference;

  const confidenceDifference = (right.confidence ?? 0) - (left.confidence ?? 0);
  if (confidenceDifference !== 0) return confidenceDifference;

  const depthDifference = (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER);
  if (depthDifference !== 0) return depthDifference;

  if (left.file < right.file) return -1;
  if (left.file > right.file) return 1;

  const leftSymbol = left.symbols[0] ?? "";
  const rightSymbol = right.symbols[0] ?? "";
  if (leftSymbol < rightSymbol) return -1;
  if (leftSymbol > rightSymbol) return 1;
  return 0;
}

function throwIfImpactAnalysisAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Impact analysis was cancelled.");
  error.name = "AbortError";
  throw error;
}

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
    signal,
  } = options;
  const diagnostics = options.diagnostics;
  const projectRoot =
    options.projectRoot ?? index.projectRoot ?? index.projectFiles?.find((entry) => entry.projectRoot)?.projectRoot;
  const normalizedSeverityWeights = normalizeSeverityWeights(options.severityWeights);
  const normalizedOptions = {
    ...options,
    severityWeights: normalizedSeverityWeights,
    ...(projectRoot ? { projectRoot } : {}),
  };
  const patternMatchers = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, patternMatchers, projectRoot);
  const isIgnored = projectRoot ? createImpactIgnoreMatcher(projectRoot, ignoreGlobs) : () => false;
  const referenceCache = createReferenceLookupCache();
  const workBudget = createImpactWorkBudget(options);
  throwIfImpactAnalysisAborted(signal);

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

  // Filter out changed symbols in ignored files, then apply request-wide ranking budgets.
  const filteredChangedSymbols = changedSymbols.filter((s) => !isIgnored(s.file));
  const budgetedChangedSymbols = selectChangedSymbolsForBudget(
    filteredChangedSymbols,
    index,
    options,
    diagnostics,
    fanInByFile,
  );
  const reverseDepsForImpact = reverseDepsForSqlChangedObjects(reverseDeps, filteredChangedSymbols);
  recordReferenceLookupOmitted(workBudget, filteredChangedSymbols.length - budgetedChangedSymbols.length);
  if (diagnostics) {
    const memberResolutionCoverage = computeMemberResolutionCoverage(filteredChangedSymbols, index);
    if (memberResolutionCoverage.limitedLanguages.length) {
      diagnostics.memberResolutionCoverage = memberResolutionCoverage;
    }
  }

  const directOptions = {
    maxRefs,
    includeTests,
    severityWeights: normalizedSeverityWeights,
    ...(refContext !== undefined ? { refContext } : {}),
    ...(refContextLines !== undefined ? { refContextLines } : {}),
    ...(refBlockMaxLines !== undefined ? { refBlockMaxLines } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    referenceCache,
    workBudget,
  };

  for (let offset = 0; offset < budgetedChangedSymbols.length; offset += IMPACT_SYMBOL_BATCH_SIZE) {
    if (isImpactDeadlineExceeded(workBudget)) {
      const remaining = budgetedChangedSymbols.length - offset;
      recordReferenceLookupOmitted(workBudget, remaining);
      if (diagnostics) {
        diagnostics.changedSymbolsAnalyzed = Math.min(diagnostics.changedSymbolsAnalyzed, offset);
        diagnostics.changedSymbolsOmitted += remaining;
      }
      break;
    }
    const batch = budgetedChangedSymbols.slice(offset, offset + IMPACT_SYMBOL_BATCH_SIZE);
    await attachCallCompatibilityHints(index, batch, {
      maxRefs,
      ...(projectRoot ? { projectRoot } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      referenceCache,
      workBudget,
      shouldIncludeReference: (file) => {
        if (!includeTests && isIndexTestFile(file)) return false;
        return !isIgnored(file);
      },
    });
    throwIfImpactAnalysisAborted(signal);
    syncBudgetDiagnostics(diagnostics, workBudget);
    await analyzeDirectReferences({
      index,
      changedSymbols: batch,
      impacted,
      processedSymbols,
      isIndexTestFile,
      isIgnored,
      fanInByFile,
      options: directOptions,
      emitImpactItem,
    });
    syncBudgetDiagnostics(diagnostics, workBudget);
    throwIfImpactAnalysisAborted(signal);
  }

  throwIfImpactAnalysisAborted(signal);
  if (!options.membersOnly && !isImpactDeadlineExceeded(workBudget)) {
    seedSqlObjectDependents(
      impacted,
      filteredChangedSymbols,
      reverseDeps,
      includeTests,
      isIndexTestFile,
      isIgnored,
      emitImpactItem,
    );
  }

  // Seed transitive impact from changed files.  This is NOT redundant with
  // analyzeTransitiveImpact below: deleted/renamed files produce no changedSymbols
  // (they no longer exist), so they would never enter `impacted` through the symbol
  // loop above.  seedTransitiveFromFiles plants them directly so the transitive pass
  // can propagate their impact to dependents.
  if (!options.membersOnly && !isImpactDeadlineExceeded(workBudget)) {
    seedTransitiveFromFiles(index, impacted, changedFiles, normalizedOptions, reverseDepsForImpact, emitImpactItem);
  }
  throwIfImpactAnalysisAborted(signal);

  // Transitive impact via graph traversal (skip if membersOnly)
  if (!options.membersOnly && !isImpactDeadlineExceeded(workBudget)) {
    analyzeTransitiveImpact(impacted, depth, normalizedOptions, isIndexTestFile, reverseDepsForImpact, emitImpactItem);
  }
  throwIfImpactAnalysisAborted(signal);

  syncBudgetDiagnostics(diagnostics, workBudget);
  const sorted = Array.from(impacted.values()).sort(compareImpactItems);
  throwIfImpactAnalysisAborted(signal);
  for (const item of sorted) {
    emitImpactItem(item, "final");
  }
  return sorted;
}

function reverseDepsForSqlChangedObjects(
  reverseDeps: Map<FileId, Edge[]>,
  changedSymbols: readonly ChangedSymbol[],
): Map<FileId, Edge[]> {
  const objectNamesByFile = new Map<string, Set<string>>();
  for (const symbol of changedSymbols) {
    const fileKey = fileIdentityKey(symbol.file);
    const names = objectNamesByFile.get(fileKey);
    if (names) {
      names.add(symbol.name);
      continue;
    }
    objectNamesByFile.set(fileKey, new Set([symbol.name]));
  }
  if (!objectNamesByFile.size) return reverseDeps;

  const filtered = new Map<FileId, Edge[]>();
  for (const [file, edges] of reverseDeps) {
    const objectNames = objectNamesByFile.get(file);
    if (!objectNames) {
      filtered.set(file, edges);
      continue;
    }
    filtered.set(
      file,
      edges.filter((edge) => {
        if (!edge.raw.startsWith("sql:")) return true;
        return sqlEdgeMatchesChangedObjects(edge.raw, objectNames);
      }),
    );
  }
  return filtered;
}

function seedSqlObjectDependents(
  impacted: Map<FileId, ImpactItem>,
  changedSymbols: readonly ChangedSymbol[],
  reverseDeps: Map<FileId, Edge[]>,
  includeTests: boolean,
  isIndexTestFile: (file: FileId) => boolean,
  isIgnored: (file: FileId) => boolean,
  emitImpactItem: (item: ImpactItem, phase: "partial" | "final") => void,
): void {
  for (const symbol of changedSymbols) {
    const incoming = reverseDeps.get(fileIdentityKey(symbol.file)) ?? [];
    if (!incoming.length) continue;
    const objectNames = new Set([symbol.name]);
    for (const edge of incoming) {
      if (!sqlEdgeMatchesChangedObjects(edge.raw, objectNames)) continue;
      const dependent = edge.from;
      if (!includeTests && isIndexTestFile(dependent)) continue;
      if (isIgnored(dependent)) continue;

      const existing = impacted.get(dependent);
      const reasons = existing?.reasons ? [...existing.reasons] : [];
      if (!reasons.includes("directRef")) {
        reasons.push("directRef");
        reasons.sort();
      }
      const symbols = existing?.symbols ? [...existing.symbols] : [];
      if (!symbols.includes(symbol.name)) {
        symbols.push(symbol.name);
        symbols.sort();
      }
      const bestReason = selectStrongerImpactReason(existing?.explain?.reason, "directRef");
      const impactItem: ImpactItem = {
        file: dependent,
        symbols,
        reasons,
        severity: Math.max(existing?.severity ?? 0, 0.8),
        depth: 0,
        explain: {
          ...existing?.explain,
          ...(bestReason !== undefined ? { reason: bestReason } : {}),
          depth: 0,
        },
        confidence: Math.max(existing?.confidence ?? 0, 0.9),
      };
      impacted.set(dependent, impactItem);
      emitImpactItem(impactItem, "partial");
    }
  }
}
