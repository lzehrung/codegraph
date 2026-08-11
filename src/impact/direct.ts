import type { FileId } from "../types.js";
import { type ProjectIndex, type SymbolDef } from "../indexer/types.js";
import { findReferences } from "../indexer/navigation.js";
import { Semaphore } from "../util/concurrency.js";
import type { ChangedSymbol, ImpactItem, ImpactOptions, ImpactReason } from "./types.js";
import type { ReferenceLookupCache } from "./referenceCache.js";
import { calculateSeverity, selectStrongerImpactReason } from "./severity.js";
import {
  canStartReferenceLookup,
  recordReferenceLookupOmitted,
  recordReferenceLookupStarted,
  recordReferencesOmitted,
  recordReferencesRetained,
  remainingReferenceRetainBudget,
  syncBudgetDiagnostics,
  type ImpactWorkBudget,
} from "./budgets.js";

type ImpactEmitter = (item: ImpactItem, phase: "partial" | "final") => void;

export type DirectImpactOptions = Pick<
  ImpactOptions,
  "refContext" | "refContextLines" | "refBlockMaxLines" | "diagnostics"
> & {
  maxRefs: number;
  includeTests: boolean;
  referenceCache?: ReferenceLookupCache;
  workBudget?: ImpactWorkBudget;
};

export type DirectImpactContext = {
  index: ProjectIndex;
  changedSymbols: ChangedSymbol[];
  impacted: Map<FileId, ImpactItem>;
  processedSymbols: Set<string>;
  isIndexTestFile: (file: FileId) => boolean;
  isIgnored: (file: FileId) => boolean;
  fanInByFile: Map<FileId, number>;
  options: DirectImpactOptions;
  emitImpactItem: ImpactEmitter;
};

function referenceScanLimitForKeptRefs(maxRefs: number): number {
  return Math.max(maxRefs + 50, maxRefs * 4);
}

function isStrongerImpactEvidence(
  existing: ImpactItem | undefined,
  candidateSeverity: number,
  candidateConfidence: number,
): boolean {
  if (!existing) return true;
  if (candidateSeverity !== existing.severity) {
    return candidateSeverity > existing.severity;
  }
  return candidateConfidence > (existing.confidence ?? 0);
}

function compareReferenceContexts(
  left: NonNullable<ImpactItem["refs"]>[number],
  right: NonNullable<ImpactItem["refs"]>[number],
): number {
  const positionDifference =
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column ||
    left.range.end.line - right.range.end.line ||
    left.range.end.column - right.range.end.column;
  if (positionDifference !== 0) return positionDifference;
  const leftContext = left.context ?? "";
  const rightContext = right.context ?? "";
  if (leftContext < rightContext) return -1;
  if (leftContext > rightContext) return 1;
  return 0;
}

export async function analyzeDirectReferences(context: DirectImpactContext): Promise<void> {
  const semaphore = new Semaphore(8);
  const tasks: Array<Promise<void>> = [];
  const workBudget = context.options.workBudget;

  for (const changedSymbol of context.changedSymbols) {
    if (context.processedSymbols.has(changedSymbol.id)) continue;
    if (workBudget && !canStartReferenceLookup(workBudget)) {
      recordReferenceLookupOmitted(workBudget, 1);
      continue;
    }
    context.processedSymbols.add(changedSymbol.id);

    tasks.push(semaphore.withPermit(async () => analyzeChangedSymbolReferences(context, changedSymbol)));
  }

  await Promise.all(tasks);
  if (workBudget) {
    syncBudgetDiagnostics(context.options.diagnostics, workBudget);
  }
}

async function analyzeChangedSymbolReferences(
  context: DirectImpactContext,
  changedSymbol: ChangedSymbol,
): Promise<void> {
  const { index, options } = context;
  const workBudget = options.workBudget;
  if (workBudget && !canStartReferenceLookup(workBudget)) {
    recordReferenceLookupOmitted(workBudget, 1);
    syncBudgetDiagnostics(options.diagnostics, workBudget);
    return;
  }
  if (workBudget) {
    recordReferenceLookupStarted(workBudget);
  }

  const def: SymbolDef = {
    file: changedSymbol.file,
    localName: changedSymbol.name,
    kind: changedSymbol.kind,
    range: changedSymbol.range,
  };

  const referenceOptions = options.refContext
    ? {
        context: options.refContext,
        ...(options.refContextLines !== undefined && {
          lines: options.refContextLines,
        }),
        ...(options.refBlockMaxLines !== undefined && {
          blockMaxLines: options.refBlockMaxLines,
        }),
        maxReferences: referenceScanLimitForKeptRefs(options.maxRefs),
      }
    : { maxReferences: referenceScanLimitForKeptRefs(options.maxRefs) };
  const refs = options.referenceCache
    ? await options.referenceCache.get(index, def, referenceOptions)
    : await findReferences(index, { def }, referenceOptions);

  if (refs.status !== "ok") {
    syncBudgetDiagnostics(options.diagnostics, workBudget);
    return;
  }

  let keptRefs = 0;
  for (let refIndex = 0; refIndex < refs.references.length; refIndex += 1) {
    const ref = refs.references[refIndex]!;
    const diagnostics = options.diagnostics;
    if (diagnostics) diagnostics.refsScanned += 1;
    if (!options.includeTests && context.isIndexTestFile(ref.file)) {
      if (diagnostics) diagnostics.refsFilteredTests += 1;
      continue;
    }
    if (context.isIgnored(ref.file)) {
      if (diagnostics) diagnostics.refsFilteredIgnored += 1;
      continue;
    }
    if (keptRefs >= options.maxRefs) {
      const remaining = refs.references.length - refIndex;
      if (diagnostics) diagnostics.refsDroppedByMaxRefs += remaining;
      if (workBudget) recordReferencesOmitted(workBudget, remaining);
      break;
    }
    if (workBudget && remainingReferenceRetainBudget(workBudget) === 0) {
      recordReferencesOmitted(workBudget, refs.references.length - refIndex);
      break;
    }
    keptRefs += 1;
    if (workBudget) {
      recordReferencesRetained(workBudget, 1);
    }

    let reason: ImpactReason = "directRef";
    if (ref.via?.namespaceMember) {
      reason = "namespaceMember";
    } else if (ref.via?.import) {
      reason = "importAlias";
    }

    const severityResult = calculateSeverity(changedSymbol, ref, [reason], 0, index, context.fanInByFile);
    const existing = context.impacted.get(ref.file);
    const reasons: ImpactReason[] = existing?.reasons ? [...existing.reasons] : [];
    if (!reasons.includes(reason)) {
      reasons.push(reason);
      reasons.sort();
    }

    const symbols = existing?.symbols ? [...existing.symbols] : [];
    if (!symbols.includes(changedSymbol.name)) {
      symbols.push(changedSymbol.name);
      symbols.sort();
    }

    const existingRefs = existing?.refs ? [...existing.refs] : [];
    if (options.refContext && ref.context !== undefined) {
      existingRefs.push({ range: ref.range, context: ref.context });
      existingRefs.sort(compareReferenceContexts);
    }

    const existingHints = existing?.explain?.hints ?? [];
    const newHints = severityResult.explain.hints ?? [];
    const mergedHints =
      !existingHints.length && !newHints.length ? undefined : [...new Set([...existingHints, ...newHints])].sort();
    const bestReason = selectStrongerImpactReason(existing?.explain?.reason, severityResult.explain.reason);
    const replacesExistingEvidence = isStrongerImpactEvidence(
      existing,
      severityResult.severity,
      severityResult.confidence,
    );
    const rankedSeverity = replacesExistingEvidence ? severityResult.severity : existing!.severity;
    const rankedConfidence = replacesExistingEvidence ? severityResult.confidence : (existing!.confidence ?? 0);
    const rankedExplain = replacesExistingEvidence
      ? severityResult.explain
      : (existing!.explain ?? severityResult.explain);
    let resolutionConfidence: "medium" | "low" | undefined;
    if (existing?.explain?.resolutionConfidence === "low" || severityResult.explain.resolutionConfidence === "low") {
      resolutionConfidence = "low";
    } else if (
      existing?.explain?.resolutionConfidence === "medium" ||
      severityResult.explain.resolutionConfidence === "medium"
    ) {
      resolutionConfidence = "medium";
    }
    const { resolutionConfidence: _rankedResolutionConfidence, ...rankedExplainDetails } = rankedExplain;

    const impactItem: ImpactItem = {
      file: ref.file,
      symbols,
      reasons,
      severity: rankedSeverity,
      depth: 0,
      ...(options.refContext && existingRefs.length ? { refs: existingRefs } : {}),
      explain: {
        ...rankedExplainDetails,
        ...(resolutionConfidence !== undefined ? { resolutionConfidence } : {}),
        refsCount: (existing?.explain?.refsCount ?? 0) + 1,
      },
      confidence: rankedConfidence,
    };

    if (replacesExistingEvidence && changedSymbol.typeOnly !== undefined) {
      impactItem.typeOnly = changedSymbol.typeOnly;
    } else if (existing?.typeOnly !== undefined) {
      impactItem.typeOnly = existing.typeOnly;
    }

    context.impacted.set(ref.file, impactItem);
    context.emitImpactItem(impactItem, "partial");
  }

  syncBudgetDiagnostics(options.diagnostics, workBudget);
}
