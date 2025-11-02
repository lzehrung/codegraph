import type { FileId } from "../types.js";
import type { ProjectIndex, SymbolDef } from "../indexer.js";
import type { ChangedSymbol, ImpactItem, ImpactReason, ImpactOptions } from "./types.js";
import { findReferences } from "../indexer.js";

export async function analyzeImpact(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  options: Partial<ImpactOptions> = {}
): Promise<ImpactItem[]> {
  const {
    maxRefs = 1000,
    depth = 3,
    includeTests = false,
    membersOnly = false
  } = options;

  const impacted = new Map<FileId, ImpactItem>();
  const processedSymbols = new Set<string>();

  // Direct impact analysis with parallelization
  const concurrency = 8;
  const tasks = [];

  for (const changedSymbol of changedSymbols) {
    if (processedSymbols.has(changedSymbol.id)) continue;
    processedSymbols.add(changedSymbol.id);

    tasks.push(async () => {
      const refs = await findReferences(index, { def: {
        file: changedSymbol.file,
        localName: changedSymbol.name,
        kind: changedSymbol.kind,
        range: changedSymbol.range
      } as SymbolDef });

      if (refs.status === "ok") {
        for (const ref of refs.references.slice(0, maxRefs)) {
          if (!includeTests && isTestFile(ref.file)) continue;

          const existing = impacted.get(ref.file);
          const reasons: ImpactReason[] = existing?.reasons || [];

          // Determine the reason for this reference
          let reason: ImpactReason = "directRef";
          if (ref.via?.namespaceMember) {
            reason = "namespaceMember";
          } else if (ref.via?.import) {
            reason = "importAlias";
          }

          if (!reasons.includes(reason)) {
            reasons.push(reason);
          }

        const severityResult = calculateSeverity(changedSymbol, ref, reasons, 0, index);
        const symbols = existing?.symbols || [];
        if (!symbols.includes(changedSymbol.name)) {
          symbols.push(changedSymbol.name);
        }

        const impactItem: ImpactItem = {
          file: ref.file,
          symbols,
          reasons,
          severity: Math.max(existing?.severity || 0, severityResult.severity),
          depth: 0,
          explain: {
            ...existing?.explain,
            ...severityResult.explain,
            refsCount: (existing?.explain?.refsCount || 0) + 1
          }
        };

        if (changedSymbol.typeOnly !== undefined) {
          impactItem.typeOnly = changedSymbol.typeOnly;
        }

        impacted.set(ref.file, impactItem);
        }
      }
    });
  }

  // Execute in batches with concurrency control
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
  }

  // Transitive impact via graph traversal (skip if membersOnly)
  if (!options.membersOnly) {
    await analyzeTransitiveImpact(index, impacted, depth, options);
  }

  return Array.from(impacted.values()).sort((a, b) => b.severity - a.severity);
}

async function analyzeTransitiveImpact(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  maxDepth: number,
  options: Partial<ImpactOptions>
): Promise<void> {
  // Precompute reverse dependency index for efficient traversal
  const reverseDeps = new Map<FileId, any[]>();
  for (const e of index.graph.edges) {
    if (e.to.type === "file") {
      const arr = reverseDeps.get(e.to.path) || [];
      arr.push(e);
      reverseDeps.set(e.to.path, arr);
    }
  }

  const visited = new Set<FileId>();
  const queue: Array<{ file: FileId; depth: number; reason: ImpactReason }> = [];

  // Initialize queue with directly impacted files
  for (const [file, item] of impacted) {
    visited.add(file);
    queue.push({ file, depth: 0, reason: "transitive" });
  }

  while (queue.length > 0) {
    const { file, depth, reason } = queue.shift()!;
    if (depth >= maxDepth) continue;

    // Find files that depend on this file using reverse index
    const edgesIn = reverseDeps.get(file) || [];
    for (const edge of edgesIn) {
      const dependentFile = edge.from;
      if (visited.has(dependentFile) || (!options.includeTests && isTestFile(dependentFile))) continue;

      visited.add(dependentFile);

        const existing = impacted.get(dependentFile);
        const reasons = existing?.reasons || [];
        if (!reasons.includes(reason)) {
          reasons.push(reason);
        }

        const severity = calculateTransitiveSeverity(edge, depth + 1);

        // Calculate fan-in for transitive items too
        const fanIn = reverseDeps.get(dependentFile)?.length || 0;

        const transitiveItem: ImpactItem = {
          file: dependentFile,
          symbols: existing?.symbols || [],
          reasons,
          severity: Math.max(existing?.severity || 0, severity),
          depth: depth + 1,
          explain: {
            ...existing?.explain,
            reason,
            depth: depth + 1,
            ...(fanIn > 0 && { fanIn })
          }
        };

        if (edge.typeOnly !== undefined) {
          transitiveItem.typeOnly = edge.typeOnly;
          if (transitiveItem.explain) {
            transitiveItem.explain.typeOnly = edge.typeOnly;
          }
        }

        impacted.set(dependentFile, transitiveItem);

      queue.push({ file: dependentFile, depth: depth + 1, reason: "exportChain" });
    }
  }
}

function calculateSeverity(
  changedSymbol: ChangedSymbol,
  ref: any,
  reasons: ImpactReason[],
  depth: number,
  index: ProjectIndex
): { severity: number; explain: any } {
  let score = 1.0;
  const explain: any = {};

  // Primary reason
  if (reasons.includes("directRef")) {
    score *= 1.0;
    explain.reason = "directRef";
  } else if (reasons.includes("namespaceMember")) {
    score *= 0.8;
    explain.reason = "namespaceMember";
  } else if (reasons.includes("importAlias")) {
    score *= 0.6;
    explain.reason = "importAlias";
  } else {
    score *= 0.4; // transitive
    explain.reason = "transitive";
  }

  // Exported symbols are more important
  if (changedSymbol.exported) {
    score *= 1.2;
    explain.exported = true;
  }

  // Calculate fan-in (how many files depend on the impacted file)
  const fanIn = [...index.graph.edges].filter(e => e.to.type === "file" && e.to.path === ref.file).length;
  if (fanIn > 0) {
    const fanInFactor = 1 + Math.min(Math.log10(fanIn + 1), 1); // Cap at doubling
    score *= fanInFactor;
    explain.fanIn = fanIn;
  }

  // Same-file references are more important
  if (ref.file === changedSymbol.file) {
    score *= 1.2;
    explain.sameFile = true;
  }

  // Type-only changes are less severe
  if (changedSymbol.typeOnly) {
    score *= 0.7;
    explain.typeOnly = true;
  }

  // Depth decay
  score *= Math.pow(0.8, depth);
  explain.depth = depth;

  return {
    severity: Math.min(1.0, Math.max(0.0, score)),
    explain
  };
}

function calculateTransitiveSeverity(edge: any, depth: number): number {
  let score = 0.3; // Base transitive score

  // Type-only edges are less severe
  if (edge.typeOnly) {
    score *= 0.6;
  }

  // Depth decay
  score *= Math.pow(0.7, depth);

  return score;
}

function isTestFile(file: FileId): boolean {
  const lower = file.toLowerCase();
  return lower.includes("test") ||
         lower.includes("spec") ||
         lower.includes("__tests__") ||
         lower.includes(".test.") ||
         lower.includes(".spec.");
}
