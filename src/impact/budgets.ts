import { performance } from "node:perf_hooks";
import type { FileId } from "../types.js";
import { SymbolKind, type ProjectIndex } from "../indexer/types.js";
import { buildDependencyStats } from "./severity.js";
import type { ChangedSymbol, ImpactDiagnostics, ImpactOptions } from "./types.js";

const CALLABLE_KINDS = new Set<SymbolKind>([
  SymbolKind.Function,
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.TypeAlias,
  SymbolKind.Routine,
  SymbolKind.Default,
]);

export type ImpactWorkBudget = {
  deadlineAt?: number;
  maxReferenceLookups?: number;
  maxTotalReferences?: number;
  referenceLookupsStarted: number;
  referenceLookupsOmitted: number;
  referencesRetained: number;
  referencesOmitted: number;
  deadlineExceeded: boolean;
};

export function createImpactWorkBudget(
  options: Pick<ImpactOptions, "timeBudgetMs" | "maxReferenceLookups" | "maxTotalReferences">,
): ImpactWorkBudget {
  return {
    ...(typeof options.timeBudgetMs === "number" && options.timeBudgetMs >= 0
      ? { deadlineAt: performance.now() + options.timeBudgetMs }
      : {}),
    ...(typeof options.maxReferenceLookups === "number" && options.maxReferenceLookups >= 0
      ? { maxReferenceLookups: options.maxReferenceLookups }
      : {}),
    ...(typeof options.maxTotalReferences === "number" && options.maxTotalReferences >= 0
      ? { maxTotalReferences: options.maxTotalReferences }
      : {}),
    referenceLookupsStarted: 0,
    referenceLookupsOmitted: 0,
    referencesRetained: 0,
    referencesOmitted: 0,
    deadlineExceeded: false,
  };
}

export function isImpactDeadlineExceeded(budget: ImpactWorkBudget): boolean {
  if (budget.deadlineExceeded) return true;
  if (budget.deadlineAt === undefined) return false;
  if (performance.now() >= budget.deadlineAt) {
    budget.deadlineExceeded = true;
    return true;
  }
  return false;
}

export function canStartReferenceLookup(budget: ImpactWorkBudget): boolean {
  if (budget.maxReferenceLookups === undefined) return true;
  return budget.referenceLookupsStarted < budget.maxReferenceLookups;
}

export function recordReferenceLookupStarted(budget: ImpactWorkBudget): void {
  budget.referenceLookupsStarted += 1;
}

export function recordReferenceLookupOmitted(budget: ImpactWorkBudget, count = 1): void {
  budget.referenceLookupsOmitted += Math.max(0, count);
}

export function remainingReferenceRetainBudget(budget: ImpactWorkBudget): number | undefined {
  if (budget.maxTotalReferences === undefined) return undefined;
  return Math.max(0, budget.maxTotalReferences - budget.referencesRetained);
}

export function recordReferencesRetained(budget: ImpactWorkBudget, count: number): void {
  budget.referencesRetained += Math.max(0, count);
}

export function recordReferencesOmitted(budget: ImpactWorkBudget, count: number): void {
  budget.referencesOmitted += Math.max(0, count);
}

export function syncBudgetDiagnostics(
  diagnostics: ImpactDiagnostics | undefined,
  budget: ImpactWorkBudget | undefined,
): void {
  if (!diagnostics || !budget) return;
  diagnostics.referenceLookupsStarted = budget.referenceLookupsStarted;
  diagnostics.referenceLookupsOmitted = budget.referenceLookupsOmitted;
  diagnostics.referencesRetained = budget.referencesRetained;
  diagnostics.referencesOmitted = budget.referencesOmitted;
  diagnostics.deadlineExceeded = budget.deadlineExceeded;
}

function kindPriority(kind: ChangedSymbol["kind"]): number {
  if (CALLABLE_KINDS.has(kind as SymbolKind)) return 0;
  if (kind === SymbolKind.Variable) return 2;
  return 1;
}

function comparePathsStable(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministic ranking for request-wide symbol budgets.
 * Higher priority symbols are analyzed first when limits truncate work.
 */
export function rankChangedSymbolsForBudget(
  changedSymbols: readonly ChangedSymbol[],
  index: ProjectIndex,
  fanInByFile?: Map<FileId, number>,
): ChangedSymbol[] {
  const fanIn = fanInByFile ?? buildDependencyStats(index.graph.edges).fanInByFile;
  const hasIncomingEdge = new Map<FileId, boolean>();
  if (index.graphAdjacency) {
    for (const symbol of changedSymbols) {
      if (hasIncomingEdge.has(symbol.file)) continue;
      const incoming = index.graphAdjacency.reverse.get(symbol.file);
      hasIncomingEdge.set(symbol.file, Boolean(incoming && incoming.length > 0));
    }
  } else {
    for (const edge of index.graph.edges) {
      if (edge.to.type !== "file") continue;
      hasIncomingEdge.set(edge.to.path, true);
    }
  }

  return [...changedSymbols].sort((a, b) => {
    const signatureDelta = Number(Boolean(b.signatureChanged)) - Number(Boolean(a.signatureChanged));
    if (signatureDelta) return signatureDelta;
    const exportDelta = Number(b.exported) - Number(a.exported);
    if (exportDelta) return exportDelta;
    const incomingDelta =
      Number(Boolean(hasIncomingEdge.get(b.file))) - Number(Boolean(hasIncomingEdge.get(a.file)));
    if (incomingDelta) return incomingDelta;
    const kindDelta = kindPriority(a.kind) - kindPriority(b.kind);
    if (kindDelta) return kindDelta;
    const fanInDelta = (fanIn.get(b.file) ?? 0) - (fanIn.get(a.file) ?? 0);
    if (fanInDelta) return fanInDelta;
    const fileDelta = comparePathsStable(a.file, b.file);
    if (fileDelta) return fileDelta;
    const lineDelta = a.range.start.line - b.range.start.line;
    if (lineDelta) return lineDelta;
    const colDelta = a.range.start.column - b.range.start.column;
    if (colDelta) return colDelta;
    const endLineDelta = a.range.end.line - b.range.end.line;
    if (endLineDelta) return endLineDelta;
    const endColDelta = a.range.end.column - b.range.end.column;
    if (endColDelta) return endColDelta;
    return comparePathsStable(a.id, b.id);
  });
}

export function selectChangedSymbolsForBudget(
  changedSymbols: readonly ChangedSymbol[],
  index: ProjectIndex,
  options: Pick<ImpactOptions, "maxChangedSymbols" | "maxReferenceLookups" | "maxTotalReferences" | "timeBudgetMs">,
  diagnostics: ImpactDiagnostics | undefined,
  fanInByFile?: Map<FileId, number>,
): ChangedSymbol[] {
  const hasRequestBudget =
    options.maxChangedSymbols !== undefined ||
    options.maxReferenceLookups !== undefined ||
    options.maxTotalReferences !== undefined ||
    options.timeBudgetMs !== undefined;
  const ranked = hasRequestBudget
    ? rankChangedSymbolsForBudget(changedSymbols, index, fanInByFile)
    : [...changedSymbols];
  if (diagnostics) {
    diagnostics.changedSymbolsTotal = ranked.length;
  }
  const limit = options.maxChangedSymbols;
  if (typeof limit !== "number" || limit < 0 || ranked.length <= limit) {
    if (diagnostics) {
      diagnostics.changedSymbolsAnalyzed = ranked.length;
      diagnostics.changedSymbolsOmitted = 0;
    }
    return ranked;
  }
  const selected = ranked.slice(0, limit);
  if (diagnostics) {
    diagnostics.changedSymbolsAnalyzed = selected.length;
    diagnostics.changedSymbolsOmitted = ranked.length - selected.length;
  }
  return selected;
}

export const IMPACT_SYMBOL_BATCH_SIZE = 8;

export const DEFAULT_BOUNDED_IMPACT_BUDGETS = {
  maxChangedSymbols: 250,
  maxReferenceLookups: 250,
  maxTotalReferences: 5000,
  timeBudgetMs: 25_000,
} as const;
