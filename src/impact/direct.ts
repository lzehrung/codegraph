import type { FileId } from "../types.js";
import type { ProjectIndex, SymbolDef } from "../indexer.js";
import { findReferences } from "../indexer.js";
import { Semaphore } from "../util/semaphore.js";
import type { ChangedSymbol, ImpactItem, ImpactOptions, ImpactReason } from "./types.js";
import { calculateSeverity, selectStrongerImpactReason } from "./severity.js";

type ImpactEmitter = (item: ImpactItem, phase: "partial" | "final") => void;

export type DirectImpactOptions = Pick<
  ImpactOptions,
  "refContext" | "refContextLines" | "refBlockMaxLines" | "diagnostics"
> & {
  maxRefs: number;
  includeTests: boolean;
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

export async function analyzeDirectReferences(context: DirectImpactContext): Promise<void> {
  const semaphore = new Semaphore(8);
  const tasks: Array<Promise<void>> = [];

  for (const changedSymbol of context.changedSymbols) {
    if (context.processedSymbols.has(changedSymbol.id)) continue;
    context.processedSymbols.add(changedSymbol.id);

    tasks.push(semaphore.withPermit(async () => analyzeChangedSymbolReferences(context, changedSymbol)));
  }

  await Promise.all(tasks);
}

async function analyzeChangedSymbolReferences(
  context: DirectImpactContext,
  changedSymbol: ChangedSymbol,
): Promise<void> {
  const { index, options } = context;
  const refs = await findReferences(
    index,
    {
      def: {
        file: changedSymbol.file,
        localName: changedSymbol.name,
        kind: changedSymbol.kind,
        range: changedSymbol.range,
      } as SymbolDef,
    },
    options.refContext
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
      : { maxReferences: referenceScanLimitForKeptRefs(options.maxRefs) },
  );

  if (refs.status !== "ok") return;

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
      if (diagnostics) {
        diagnostics.refsDroppedByMaxRefs += refs.references.length - refIndex;
      }
      break;
    }
    keptRefs += 1;

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
    }

    const symbols = existing?.symbols ? [...existing.symbols] : [];
    if (!symbols.includes(changedSymbol.name)) {
      symbols.push(changedSymbol.name);
    }

    const existingRefs = existing?.refs ? [...existing.refs] : [];
    if (options.refContext && ref.context !== undefined) {
      existingRefs.push({ range: ref.range, context: ref.context });
    }

    const existingHints = existing?.explain?.hints ?? [];
    const newHints = severityResult.explain.hints ?? [];
    const mergedHints =
      !existingHints.length && !newHints.length ? undefined : [...new Set([...existingHints, ...newHints])];
    const bestReason = selectStrongerImpactReason(existing?.explain?.reason, severityResult.explain.reason);

    const impactItem: ImpactItem = {
      file: ref.file,
      symbols,
      reasons,
      severity: Math.max(existing?.severity ?? 0, severityResult.severity),
      depth: 0,
      ...(options.refContext && existingRefs.length ? { refs: existingRefs } : {}),
      explain: {
        ...existing?.explain,
        ...severityResult.explain,
        ...(bestReason !== undefined && { reason: bestReason }),
        ...(mergedHints && { hints: mergedHints }),
        refsCount: (existing?.explain?.refsCount ?? 0) + 1,
      },
      confidence: Math.max(existing?.confidence ?? 0, severityResult.confidence),
    };

    if (changedSymbol.typeOnly !== undefined) {
      impactItem.typeOnly = changedSymbol.typeOnly;
    }

    context.impacted.set(ref.file, impactItem);
    context.emitImpactItem(impactItem, "partial");
  }
}
