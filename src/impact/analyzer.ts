import type { FileId, Edge } from "../types.js";
import type { ProjectIndex, SymbolDef, Reference } from "../indexer.js";
import {
  compileTestPatterns,
  createIndexTestFileMatcher,
} from "./testPatterns.js";
import type {
  ChangedSymbol,
  ImpactItem,
  ImpactReason,
  ImpactOptions,
  FileChange,
  SeverityWeights,
} from "./types.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "./types.js";
import { findReferences } from "../indexer.js";
import { Semaphore } from "../util/semaphore.js";
import { createImpactIgnoreMatcher } from "./path.js";

/**
 * Priority order for ImpactReason — higher number wins when merging explain.reason.
 * Typed as Record<ImpactReason, number> so TypeScript enforces exhaustiveness:
 * adding a new ImpactReason value will cause a compile error here until it is listed.
 */
const REASON_PRIORITY: Readonly<Record<ImpactReason, number>> = {
  directRef: 4,
  namespaceMember: 3,
  importAlias: 2,
  exportChain: 1,
  transitive: 0,
  fileLevelChange: 0,
};

/** Explain object for impact severity calculation */
type SeverityExplain = {
  reason?: ImpactReason;
  exported?: boolean;
  fanIn?: number;
  sameFile?: boolean;
  typeOnly?: boolean;
  depth?: number;
  hints?: string[];
};

/** Result of severity calculation with confidence */
type SeverityResult = {
  severity: number;
  confidence: number;
  explain: SeverityExplain;
};

type DependencyStats = {
  fanInByFile: Map<FileId, number>;
  reverseDeps: Map<FileId, Edge[]>;
};

const cachedFanInByGraph = new WeakMap<object, Map<FileId, number>>();

const severityWeightKeys: ReadonlyArray<keyof SeverityWeights> = [
  "directRef",
  "namespaceMember",
  "importAlias",
  "transitive",
  "exported",
  "sameFile",
  "typeOnly",
  "depthDecay",
];

function normalizeSeverityWeights(
  weights: SeverityWeights,
): SeverityWeights {
  const normalized: SeverityWeights = { ...DEFAULT_SEVERITY_WEIGHTS };
  const invalidEntries: string[] = [];

  for (const key of severityWeightKeys) {
    const value = weights[key];
    if (!Number.isFinite(value) || value <= 0) {
      invalidEntries.push(`${key}=${String(value)}`);
      continue;
    }
    normalized[key] = value;
  }

  if (normalized.depthDecay >= 1) {
    invalidEntries.push(`depthDecay=${String(weights.depthDecay)}`);
  }

  if (invalidEntries.length > 0) {
    throw new RangeError(
      `Invalid severity weights: ${invalidEntries.join(", ")}`,
    );
  }

  return normalized;
}

function getCachedFanInByFile(index: ProjectIndex): Map<FileId, number> {
  const cached = cachedFanInByGraph.get(index.graph);
  if (cached) return cached;
  const { fanInByFile } = buildDependencyStats(index.graph.edges);
  cachedFanInByGraph.set(index.graph, fanInByFile);
  return fanInByFile;
}

function buildDependencyStats(edges: Edge[]): DependencyStats {
  const fanInByFile = new Map<FileId, number>();
  const reverseDeps = new Map<FileId, Edge[]>();

  for (const edge of edges) {
    if (edge.to.type !== "file") continue;

    const nextCount = (fanInByFile.get(edge.to.path) ?? 0) + 1;
    fanInByFile.set(edge.to.path, nextCount);

    const incoming = reverseDeps.get(edge.to.path);
    if (incoming) {
      incoming.push(edge);
      continue;
    }
    reverseDeps.set(edge.to.path, [edge]);
  }

  return { fanInByFile, reverseDeps };
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
  } = options;
  const diagnostics = options.diagnostics;
  const projectRoot =
    options.projectRoot ??
    index.projectRoot ??
    index.projectFiles?.find((entry) => entry.projectRoot)?.projectRoot;
  const normalizedOptions = {
    ...options,
    ...(projectRoot ? { projectRoot } : {}),
  };

  const patternMatchers = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(
    index,
    patternMatchers,
    projectRoot,
  );
  const isIgnored = projectRoot
    ? createImpactIgnoreMatcher(projectRoot, ignoreGlobs)
    : () => false;

  const impacted = new Map<FileId, ImpactItem>();
  const processedSymbols = new Set<string>();

  const { fanInByFile, reverseDeps } = buildDependencyStats(index.graph.edges);

  const emitImpactItem = (
    item: ImpactItem,
    phase: "partial" | "final",
  ): void => {
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
                ...(item.explain.hints
                  ? { hints: [...item.explain.hints] }
                  : {}),
              },
            }
          : {}),
      },
      phase,
    );
  };

  // Filter out changed symbols in ignored files
  const filteredChangedSymbols = changedSymbols.filter(
    (s) => !isIgnored(s.file),
  );

  // Direct impact analysis with bounded concurrency.
  // Use a Semaphore so that slow tasks release their slot immediately rather than
  // holding up a whole batch (which the old slice-based loop would do).
  const semaphore = new Semaphore(8);
  const tasks: Array<Promise<void>> = [];

  for (const changedSymbol of filteredChangedSymbols) {
    if (processedSymbols.has(changedSymbol.id)) continue;
    processedSymbols.add(changedSymbol.id);

    tasks.push(
      semaphore.withPermit(async () => {
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
          refContext
            ? {
                context: refContext,
                ...(refContextLines !== undefined && {
                  lines: refContextLines,
                }),
                ...(refBlockMaxLines !== undefined && {
                  blockMaxLines: refBlockMaxLines,
                }),
              }
            : undefined,
        );

        if (refs.status === "ok") {
          let keptRefs = 0;
          for (
            let refIndex = 0;
            refIndex < refs.references.length;
            refIndex += 1
          ) {
            const ref = refs.references[refIndex]!;
            if (diagnostics) diagnostics.refsScanned += 1;
            if (!includeTests && isIndexTestFile(ref.file)) {
              if (diagnostics) diagnostics.refsFilteredTests += 1;
              continue;
            }
            if (isIgnored(ref.file)) {
              if (diagnostics) diagnostics.refsFilteredIgnored += 1;
              continue;
            }
            if (keptRefs >= maxRefs) {
              if (diagnostics) {
                diagnostics.refsDroppedByMaxRefs +=
                  refs.references.length - refIndex;
              }
              break;
            }
            keptRefs += 1;

            // Determine the reason for this reference (sync, before await)
            let reason: ImpactReason = "directRef";
            if (ref.via?.namespaceMember) {
              reason = "namespaceMember";
            } else if (ref.via?.import) {
              reason = "importAlias";
            }

            const severityResult = calculateSeverity(
              changedSymbol,
              ref,
              [reason],
              0,
              index,
              fanInByFile,
            );

            // Re-read existing AFTER the await: concurrent semaphore tasks may
            // have written to the same file entry while we were awaiting above.
            const existing = impacted.get(ref.file);
            const reasons: ImpactReason[] = existing?.reasons
              ? [...existing.reasons]
              : [];
            if (!reasons.includes(reason)) {
              reasons.push(reason);
            }

            const symbols = existing?.symbols ? [...existing.symbols] : [];
            if (!symbols.includes(changedSymbol.name)) {
              symbols.push(changedSymbol.name);
            }

            const existingRefs = existing?.refs ? [...existing.refs] : [];
            if (refContext && ref.context !== undefined) {
              existingRefs.push({ range: ref.range, context: ref.context });
            }

            // Merge hints from existing explain with new hints so no
            // accumulated hint is lost when multiple symbols impact the same file.
            const existingHints = existing?.explain?.hints ?? [];
            const newHints = severityResult.explain.hints ?? [];
            const mergedHints =
              existingHints.length === 0 && newHints.length === 0
                ? undefined
                : [...new Set([...existingHints, ...newHints])];

            // Preserve the strongest explain.reason seen so far.  Spreading
            // severityResult.explain unconditionally could downgrade a prior
            // directRef reason to importAlias when a weaker ref is processed later.
            const existingReason = existing?.explain?.reason;
            const newReason = severityResult.explain.reason;
            const bestReason =
              existingReason === undefined
                ? newReason
                : newReason === undefined
                  ? existingReason
                  : REASON_PRIORITY[existingReason] >=
                      REASON_PRIORITY[newReason]
                    ? existingReason
                    : newReason;

            const impactItem: ImpactItem = {
              file: ref.file,
              symbols,
              reasons,
              severity: Math.max(
                existing?.severity ?? 0,
                severityResult.severity,
              ),
              depth: 0,
              ...(refContext &&
                existingRefs.length > 0 && { refs: existingRefs }),
              explain: {
                ...existing?.explain,
                ...severityResult.explain,
                ...(bestReason !== undefined && { reason: bestReason }),
                ...(mergedHints && { hints: mergedHints }),
                refsCount: (existing?.explain?.refsCount ?? 0) + 1,
              },
              confidence: Math.max(
                existing?.confidence ?? 0,
                severityResult.confidence,
              ),
            };

            if (changedSymbol.typeOnly !== undefined) {
              impactItem.typeOnly = changedSymbol.typeOnly;
            }

            impacted.set(ref.file, impactItem);
            emitImpactItem(impactItem, "partial");
          }
        }
      }),
    );
  }

  await Promise.all(tasks);

  // Seed transitive impact from changed files.  This is NOT redundant with
  // analyzeTransitiveImpact below: deleted/renamed files produce no changedSymbols
  // (they no longer exist), so they would never enter `impacted` through the symbol
  // loop above.  seedTransitiveFromFiles plants them directly so the transitive pass
  // can propagate their impact to dependents.
  if (!options.membersOnly) {
    seedTransitiveFromFiles(
      index,
      impacted,
      changedFiles,
      normalizedOptions,
      reverseDeps,
      emitImpactItem,
    );
  }

  // Transitive impact via graph traversal (skip if membersOnly)
  if (!options.membersOnly) {
    analyzeTransitiveImpact(
      impacted,
      depth,
      normalizedOptions,
      isIndexTestFile,
      reverseDeps,
      emitImpactItem,
    );
  }

  const sorted = Array.from(impacted.values()).sort(
    (a, b) => b.severity - a.severity,
  );
  for (const item of sorted) {
    emitImpactItem(item, "final");
  }
  return sorted;
}

function getDependentFiles(
  index: ProjectIndex,
  filePath: FileId,
  reverseDeps?: Map<FileId, Edge[]>,
): FileId[] {
  if (reverseDeps) {
    return reverseDeps.get(filePath)?.map((edge) => edge.from) ?? [];
  }
  return index.graph.edges
    .filter((edge) => edge.to.type === "file" && edge.to.path === filePath)
    .map((edge) => edge.from);
}

export function seedTransitiveFromFiles(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  changedFiles: FileChange[],
  options: Partial<ImpactOptions> & { projectRoot?: string },
  reverseDeps?: Map<FileId, Edge[]>,
  emitImpactItem?: (item: ImpactItem, phase: "partial" | "final") => void,
): void {
  const { includeTests = false, testPatterns, ignoreGlobs = [] } = options;
  const projectRoot =
    options.projectRoot ??
    index.projectRoot ??
    index.projectFiles?.find((entry) => entry.projectRoot)?.projectRoot;
  const patternMatchers = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(
    index,
    patternMatchers,
    projectRoot,
  );
  const fallbackPathSet = new Set(options.fileLevelFallbackPaths ?? []);
  const diagnostics = options.diagnostics;
  const isIgnored = projectRoot
    ? createImpactIgnoreMatcher(projectRoot, ignoreGlobs)
    : () => false;

  for (const fileChange of changedFiles) {
    if (isIgnored(fileChange.path)) continue;

    // Seed impact for modified (file-level fallback), deleted, and renamed files based on dependents

    const shouldSeedModifiedFallback =
      fileChange.kind === "modified" &&
      options.fileLevelFallback &&
      (fallbackPathSet.has(fileChange.path) ||
        fileChange.isBinary ||
        fileChange.modeChanged ||
        fileChange.hunks.length === 0);

    if (shouldSeedModifiedFallback) {
      if (impacted.has(fileChange.path)) continue;
      const dependents = getDependentFiles(index, fileChange.path, reverseDeps);
      if (dependents.length > 0) {
        if (diagnostics) diagnostics.fallbackSeededFiles += 1;
      }

      for (const dependent of dependents) {
        if (!includeTests && isIndexTestFile(dependent))
          continue;
        if (impacted.has(dependent) || isIgnored(dependent)) continue;

        impacted.set(dependent, {
          file: dependent,
          symbols: [],
          reasons: ["fileLevelChange"],
          severity: 0.45,
          depth: 1,
          explain: {
            reason: "fileLevelChange",
            depth: 1,
            hints: ["changedFileNoSymbols"],
          },
          confidence: 0.5,
        });
        emitImpactItem?.(impacted.get(dependent)!, "partial");
        if (diagnostics) diagnostics.fallbackSeededDependents += 1;
      }
    } else if (fileChange.kind === "deleted" || fileChange.kind === "renamed") {
      const lookupPaths =
        fileChange.kind === "renamed" && fileChange.oldPath
          ? [fileChange.oldPath, fileChange.path]
          : [fileChange.path];
      const dependentSet = new Set<FileId>();
      for (const lookupPath of lookupPaths) {
        for (const dependent of getDependentFiles(
          index,
          lookupPath,
          reverseDeps,
        )) {
          dependentSet.add(dependent);
        }
      }
      const dependents = [...dependentSet];
      if (dependents.length > 0) {
        if (diagnostics) diagnostics.fallbackSeededFiles += 1;
      }

      for (const dependent of dependents) {
        if (!includeTests && isIndexTestFile(dependent))
          continue;
        if (impacted.has(dependent) || isIgnored(dependent)) continue;

        const hints = ["fileDeleted"];
        if (fileChange.kind === "renamed") {
          hints.push("fileRenamed");
        }

        const impactItem: ImpactItem = {
          file: dependent,
          symbols: [],
          reasons: ["transitive"],
          severity: 0.6, // Moderate severity for file-level changes
          depth: 1,
          explain: {
            reason: "transitive",
            depth: 1,
            hints,
          },
          confidence: 0.5,
        };

        impacted.set(dependent, impactItem);
        emitImpactItem?.(impactItem, "partial");
        if (diagnostics) diagnostics.fallbackSeededDependents += 1;
      }
    }
  }
}

function analyzeTransitiveImpact(
  impacted: Map<FileId, ImpactItem>,
  maxDepth: number,
  options: Partial<ImpactOptions> & { projectRoot?: string },
  isIndexTestFile: (file: FileId) => boolean,
  reverseDeps: Map<FileId, Edge[]>,
  emitImpactItem?: (item: ImpactItem, phase: "partial" | "final") => void,
): void {
  const { ignoreGlobs = [] } = options;
  const isIgnored = options.projectRoot
    ? createImpactIgnoreMatcher(options.projectRoot, ignoreGlobs)
    : () => false;

  const visited = new Set<FileId>();
  const queue: Array<{ file: FileId; depth: number; reason: ImpactReason }> =
    [];

  // Initialize queue with directly impacted files
  for (const [file] of impacted) {
    if (isIgnored(file)) continue;
    visited.add(file);
    queue.push({ file, depth: 0, reason: "transitive" });
  }

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth, reason } = queue[qi++]!;
    if (depth >= maxDepth) continue;

    // Find files that depend on this file using reverse index
    const edgesIn = reverseDeps.get(file) || [];
    for (const edge of edgesIn) {
      const dependentFile = edge.from;
      if (
        visited.has(dependentFile) ||
        (!options.includeTests && isIndexTestFile(dependentFile)) ||
        isIgnored(dependentFile)
      )
        continue;

      visited.add(dependentFile);

      const existing = impacted.get(dependentFile);
      const reasons = existing?.reasons || [];
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }

      const severity = calculateTransitiveSeverity(edge, depth + 1);
      const upstreamConfidence = impacted.get(file)?.confidence ?? 0.6;
      const nextConfidence = Math.max(
        0.2,
        Math.min(
          1,
          upstreamConfidence *
            (edge.typeOnly ? 0.75 : 0.85) *
            Math.pow(0.95, depth),
        ),
      );

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
          ...(fanIn > 0 && { fanIn }),
        },
        confidence: Math.max(existing?.confidence ?? 0, nextConfidence),
      };

      if (edge.typeOnly !== undefined) {
        transitiveItem.typeOnly = edge.typeOnly;
        if (transitiveItem.explain) {
          transitiveItem.explain.typeOnly = edge.typeOnly;
        }
      }

      impacted.set(dependentFile, transitiveItem);
      emitImpactItem?.(transitiveItem, "partial");

      queue.push({
        file: dependentFile,
        depth: depth + 1,
        reason: "exportChain",
      });
    }
  }
}

export function calculateSeverity(
  changedSymbol: ChangedSymbol,
  ref: Reference,
  reasons: ImpactReason[],
  depth: number,
  index: ProjectIndex,
  fanInByFile?: Map<FileId, number>,
  weights: SeverityWeights = DEFAULT_SEVERITY_WEIGHTS,
): SeverityResult {
  const validatedWeights = normalizeSeverityWeights(weights);

  let score = 1.0;
  let confidence = 1.0; // Start with high confidence
  const explain: SeverityExplain = {};
  const hints: string[] = [];

  // Primary reason (use configurable weights)
  if (reasons.includes("directRef")) {
    score *= validatedWeights.directRef;
    explain.reason = "directRef";
    confidence = 1.0; // Direct reference = highest confidence
  } else if (reasons.includes("namespaceMember")) {
    score *= validatedWeights.namespaceMember;
    explain.reason = "namespaceMember";
    confidence = 0.9; // Namespace access is fairly reliable
  } else if (reasons.includes("importAlias")) {
    score *= validatedWeights.importAlias;
    explain.reason = "importAlias";
    confidence = 0.85; // Import alias tracking is reliable
  } else if (reasons.includes("fileLevelChange")) {
    score *= validatedWeights.transitive * 0.9;
    explain.reason = "fileLevelChange";
    confidence = 0.5;
  } else {
    score *= validatedWeights.transitive;
    explain.reason = "transitive";
    confidence = 0.6; // Transitive impact is less certain
  }

  // Exported symbols are more important (configurable)
  if (changedSymbol.exported) {
    score *= validatedWeights.exported;
    explain.exported = true;
  }

  // Calculate fan-in (how many files depend on the impacted file)
  const fanInCounts = fanInByFile ?? getCachedFanInByFile(index);
  const fanIn = fanInCounts.get(ref.file) ?? 0;
  if (fanIn > 0) {
    const fanInFactor = 1 + Math.min(Math.log10(fanIn + 1), 1); // Cap at doubling
    score *= fanInFactor;
    explain.fanIn = fanIn;
  }

  // Same-file references are more important (configurable)
  if (ref.file === changedSymbol.file) {
    score *= validatedWeights.sameFile;
    explain.sameFile = true;
  }

  // Type-only changes are less severe (configurable)
  if (changedSymbol.typeOnly) {
    score *= validatedWeights.typeOnly;
    explain.typeOnly = true;
  }

  // Generate hints based on changed symbol characteristics
  if (changedSymbol.exported) {
    hints.push("exportChanged");
  }

  // signatureChanged is pre-computed once per symbol in locateChangedSymbolsWithLines
  // (via computeSignatureChanged) so we don't re-parse the AST for every reference.
  if (changedSymbol.signatureChanged) {
    hints.push("signatureChanged");
  }

  if (hints.length > 0) {
    explain.hints = hints;
  }

  // Depth decay (configurable)
  score *= Math.pow(validatedWeights.depthDecay, depth);
  explain.depth = depth;

  // Reduce confidence for deeper transitive impacts
  confidence *= Math.pow(0.9, depth);

  return {
    severity: Math.min(1.0, Math.max(0.0, score)),
    confidence: Math.min(1.0, Math.max(0.0, confidence)),
    explain,
  };
}

function calculateTransitiveSeverity(edge: Edge, depth: number): number {
  let score = 0.3; // Base transitive score

  // Type-only edges are less severe
  if (edge.typeOnly) {
    score *= 0.6;
  }

  // Depth decay
  score *= Math.pow(0.7, depth);

  return score;
}
