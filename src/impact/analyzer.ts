import type { FileId } from "../types.js";
import type { ProjectIndex, SymbolDef } from "../indexer.js";
import type { ChangedSymbol, ImpactItem, ImpactReason, ImpactOptions } from "./types.js";
import { findReferences } from "../indexer.js";

export async function analyzeImpact(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  options: ImpactOptions = {}
): Promise<ImpactItem[]> {
  const {
    maxRefs = 1000,
    depth = 3,
    includeTests = false,
    membersOnly = false
  } = options;

  const impacted = new Map<FileId, ImpactItem>();
  const processedSymbols = new Set<string>();

  // Direct impact analysis
  for (const changedSymbol of changedSymbols) {
    if (processedSymbols.has(changedSymbol.id)) continue;
    processedSymbols.add(changedSymbol.id);

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

        const severity = calculateSeverity(changedSymbol, ref, reasons, 0);
        const symbols = existing?.symbols || [];
        if (!symbols.includes(changedSymbol.name)) {
          symbols.push(changedSymbol.name);
        }

        impacted.set(ref.file, {
          file: ref.file,
          symbols,
          reasons,
          severity: Math.max(existing?.severity || 0, severity),
          depth: 0,
          typeOnly: changedSymbol.typeOnly
        });
      }
    }
  }

  // Transitive impact via graph traversal
  await analyzeTransitiveImpact(index, impacted, depth, options);

  return Array.from(impacted.values()).sort((a, b) => b.severity - a.severity);
}

async function analyzeTransitiveImpact(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  maxDepth: number,
  options: ImpactOptions
): Promise<void> {
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

    // Find files that depend on this file
    for (const edge of index.graph.edges) {
      if (edge.to.type === "file" && edge.to.path === file) {
        const dependentFile = edge.from;
        if (visited.has(dependentFile) || (!options.includeTests && isTestFile(dependentFile))) continue;

        visited.add(dependentFile);

        const existing = impacted.get(dependentFile);
        const reasons = existing?.reasons || [];
        if (!reasons.includes(reason)) {
          reasons.push(reason);
        }

        const severity = calculateTransitiveSeverity(edge, depth + 1);

        impacted.set(dependentFile, {
          file: dependentFile,
          symbols: existing?.symbols || [],
          reasons,
          severity: Math.max(existing?.severity || 0, severity),
          depth: depth + 1,
          typeOnly: edge.typeOnly
        });

        queue.push({ file: dependentFile, depth: depth + 1, reason: "exportChain" });
      }
    }
  }
}

function calculateSeverity(
  changedSymbol: ChangedSymbol,
  ref: any,
  reasons: ImpactReason[],
  depth: number
): number {
  let score = 1.0;

  // Direct references are highest priority
  if (reasons.includes("directRef")) {
    score *= 1.0;
  } else if (reasons.includes("namespaceMember")) {
    score *= 0.8;
  } else if (reasons.includes("importAlias")) {
    score *= 0.6;
  } else {
    score *= 0.4; // transitive
  }

  // Same-file references are more important
  if (ref.file === changedSymbol.file) {
    score *= 1.2;
  }

  // Type-only changes are less severe
  if (changedSymbol.typeOnly) {
    score *= 0.7;
  }

  // Depth decay
  score *= Math.pow(0.8, depth);

  return Math.min(1.0, Math.max(0.0, score));
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
