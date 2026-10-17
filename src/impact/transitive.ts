import type { FileId, Edge } from "../types.js";
import { type ProjectIndex } from "../indexer/types.js";
import { fileIdentityKey } from "../util/paths.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./test-patterns.js";
import type { FileChange, ImpactItem, ImpactOptions, ImpactReason } from "./types.js";
import { createImpactIgnoreMatcher } from "./path.js";
import { calculateTransitiveSeverity, selectStrongerImpactReason } from "./severity.js";

type ImpactEmitter = (item: ImpactItem, phase: "partial" | "final") => void;

/** Incoming file edges by `fileIdentityKey`; impact may derive some edges lazily. */
export type ReverseDependencyLookup = { get(fileKey: string): readonly Edge[] | undefined };

function getDependentFiles(index: ProjectIndex, filePath: FileId, reverseDeps?: ReverseDependencyLookup): FileId[] {
  if (reverseDeps) {
    const key = fileIdentityKey(filePath);
    return (reverseDeps.get(key) ?? []).flatMap((edge) => (fileIdentityKey(edge.from) === key ? [] : [edge.from]));
  }
  return index.graph.edges
    .filter((edge) => edge.to.type === "file" && fileIdentityKey(edge.to.path) === fileIdentityKey(filePath))
    .map((edge) => edge.from);
}

export function seedTransitiveFromFiles(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  changedFiles: FileChange[],
  options: Partial<ImpactOptions> & { projectRoot?: string },
  reverseDeps?: ReverseDependencyLookup,
  emitImpactItem?: ImpactEmitter,
): void {
  const { includeTests = false, testPatterns, ignoreGlobs = [] } = options;
  const projectRoot =
    options.projectRoot ?? index.projectRoot ?? index.projectFiles?.find((entry) => entry.projectRoot)?.projectRoot;
  const patternMatchers = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, patternMatchers, projectRoot);
  const fallbackPathSet = new Set(options.fileLevelFallbackPaths ?? []);
  const diagnostics = options.diagnostics;
  const isIgnored = projectRoot ? createImpactIgnoreMatcher(projectRoot, ignoreGlobs) : () => false;

  for (const fileChange of changedFiles) {
    if (isIgnored(fileChange.path)) continue;

    const isAddedOrModified = fileChange.kind === "added" || fileChange.kind === "modified";
    const shouldSeedFileLevelFallback =
      isAddedOrModified &&
      options.fileLevelFallback &&
      (fallbackPathSet.has(fileChange.path) ||
        fileChange.isBinary ||
        fileChange.modeChanged ||
        !fileChange.hunks.length);

    if (shouldSeedFileLevelFallback) {
      if (impacted.has(fileChange.path)) continue;
      const dependents = getDependentFiles(index, fileChange.path, reverseDeps);
      if (dependents.length) {
        if (diagnostics) diagnostics.fallbackSeededFiles += 1;
      }

      for (const dependent of dependents) {
        if (!includeTests && isIndexTestFile(dependent)) continue;
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
      continue;
    }

    // Deleted and renamed files have no reliable changed-symbol seed, so their old/current
    // importers are always seeded independently of fileLevelFallback, including binary changes.
    if (fileChange.kind !== "deleted" && fileChange.kind !== "renamed") continue;

    const lookupPaths =
      fileChange.kind === "renamed" && fileChange.oldPath ? [fileChange.oldPath, fileChange.path] : [fileChange.path];
    const dependentSet = new Set<FileId>();
    for (const lookupPath of lookupPaths) {
      for (const dependent of getDependentFiles(index, lookupPath, reverseDeps)) {
        dependentSet.add(dependent);
      }
    }
    const dependents = [...dependentSet];
    if (dependents.length) {
      if (diagnostics) diagnostics.fallbackSeededFiles += 1;
    }

    for (const dependent of dependents) {
      if (!includeTests && isIndexTestFile(dependent)) continue;
      if (impacted.has(dependent) || isIgnored(dependent)) continue;

      const hints = ["fileDeleted"];
      if (fileChange.kind === "renamed") {
        hints.push("fileRenamed");
      }

      const impactItem: ImpactItem = {
        file: dependent,
        symbols: [],
        reasons: ["transitive"],
        severity: 0.6,
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

export function analyzeTransitiveImpact(
  impacted: Map<FileId, ImpactItem>,
  maxDepth: number,
  options: Partial<ImpactOptions> & { projectRoot?: string },
  isIndexTestFile: (file: FileId) => boolean,
  reverseDeps: ReverseDependencyLookup,
  emitImpactItem?: ImpactEmitter,
): void {
  const { ignoreGlobs = [] } = options;
  const isIgnored = options.projectRoot ? createImpactIgnoreMatcher(options.projectRoot, ignoreGlobs) : () => false;

  const bestDepth = new Map<FileId, number>();
  const queue: Array<{ file: FileId; depth: number; reason: ImpactReason }> = [];

  for (const [file, item] of impacted) {
    if (isIgnored(file)) continue;
    const seedDepth = item.depth ?? 0;
    bestDepth.set(file, seedDepth);
    queue.push({ file, depth: seedDepth, reason: "transitive" });
  }

  // Dependents repeat across edges (a Terraform module is a clique), so decide exclusion once per file.
  const excludedByFile = new Map<string, boolean>();
  const isExcluded = (file: FileId, fileKey: string): boolean => {
    let excluded = excludedByFile.get(fileKey);
    if (excluded === undefined) {
      excluded = (!options.includeTests && isIndexTestFile(file)) || isIgnored(file);
      excludedByFile.set(fileKey, excluded);
    }
    return excluded;
  };

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth, reason } = queue[qi++]!;
    if (depth >= maxDepth) continue;
    const fileKey = fileIdentityKey(file);
    const edgesIn = reverseDeps.get(fileKey) || [];
    const upstreamConfidence = impacted.get(file)?.confidence ?? 0.6;
    for (const edge of edgesIn) {
      const dependentFile = edge.from;
      const dependentKey = fileIdentityKey(dependentFile);
      if (dependentKey === fileKey || isExcluded(dependentFile, dependentKey)) continue;

      const nextDepth = depth + 1;
      const knownDepth = bestDepth.get(dependentFile);
      const existing = impacted.get(dependentFile);
      const addsReason = !existing?.reasons.includes(reason);

      const severity = calculateTransitiveSeverity(edge, nextDepth, options.severityWeights);
      const nextConfidence = Math.max(
        0.2,
        Math.min(1, upstreamConfidence * (edge.typeOnly ? 0.75 : 0.85) * Math.pow(0.95, depth)),
      );
      const existingSeverity = existing?.severity ?? 0;
      const existingConfidence = existing?.confidence ?? 0;
      const improvesDepth = knownDepth === undefined || nextDepth < knownDepth;
      const improvesStrength = severity > existingSeverity || nextConfidence > existingConfidence || addsReason;
      if (!improvesDepth && !improvesStrength) {
        continue;
      }
      const reasons = [...(existing?.reasons ?? [])];
      if (addsReason) reasons.push(reason);
      const incoming = reverseDeps.get(dependentKey) ?? [];
      const fanIn = incoming.length - (incoming.some((incomingEdge) => incomingEdge.from === dependentFile) ? 1 : 0);
      const resolvedDepth = improvesDepth ? nextDepth : Math.min(existing?.depth ?? nextDepth, nextDepth);

      const bestReason = selectStrongerImpactReason(existing?.explain?.reason, reason);
      const transitiveItem: ImpactItem = {
        file: dependentFile,
        symbols: existing?.symbols || [],
        reasons,
        severity: Math.max(existingSeverity, severity),
        depth: resolvedDepth,
        explain: {
          ...existing?.explain,
          ...(bestReason !== undefined && { reason: bestReason }),
          depth: resolvedDepth,
          ...(fanIn > 0 && { fanIn }),
        },
        confidence: Math.max(existingConfidence, nextConfidence),
      };

      const edgeIsTypeOnly = edge.typeOnly ?? false;
      let evidenceIsTypeOnly: boolean | undefined;
      if (existing?.typeOnly !== undefined) {
        evidenceIsTypeOnly = existing.typeOnly && edgeIsTypeOnly;
      } else if (edge.typeOnly !== undefined) {
        evidenceIsTypeOnly = edgeIsTypeOnly;
      }
      if (evidenceIsTypeOnly !== undefined) {
        transitiveItem.typeOnly = evidenceIsTypeOnly;
        if (transitiveItem.explain) {
          transitiveItem.explain.typeOnly = evidenceIsTypeOnly;
        }
      }

      impacted.set(dependentFile, transitiveItem);
      emitImpactItem?.(transitiveItem, "partial");

      if (improvesDepth || improvesStrength) {
        if (improvesDepth) {
          bestDepth.set(dependentFile, nextDepth);
        }
        queue.push({
          file: dependentFile,
          depth: nextDepth,
          reason: "transitive",
        });
      }
    }
  }
}
