import type { FileId, Edge } from "../types.js";
import { type ProjectIndex } from "../indexer/types.js";
import { fileIdentityKey } from "../util/paths.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./testPatterns.js";
import type { FileChange, ImpactItem, ImpactOptions, ImpactReason } from "./types.js";
import { createImpactIgnoreMatcher } from "./path.js";
import { calculateTransitiveSeverity, selectStrongerImpactReason } from "./severity.js";

type ImpactEmitter = (item: ImpactItem, phase: "partial" | "final") => void;

function getDependentFiles(index: ProjectIndex, filePath: FileId, reverseDeps?: Map<FileId, Edge[]>): FileId[] {
  if (reverseDeps) {
    return reverseDeps.get(fileIdentityKey(filePath))?.map((edge) => edge.from) ?? [];
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
  reverseDeps?: Map<FileId, Edge[]>,
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
  reverseDeps: Map<FileId, Edge[]>,
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

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth, reason } = queue[qi++]!;
    if (depth >= maxDepth) continue;
    const edgesIn = reverseDeps.get(fileIdentityKey(file)) || [];
    for (const edge of edgesIn) {
      const dependentFile = edge.from;
      if ((!options.includeTests && isIndexTestFile(dependentFile)) || isIgnored(dependentFile)) {
        continue;
      }

      const nextDepth = depth + 1;
      const knownDepth = bestDepth.get(dependentFile);
      const existing = impacted.get(dependentFile);
      const reasons = [...(existing?.reasons ?? [])];
      const addsReason = !reasons.includes(reason);
      if (addsReason) {
        reasons.push(reason);
      }

      const severity = calculateTransitiveSeverity(edge, nextDepth);
      const upstreamConfidence = impacted.get(file)?.confidence ?? 0.6;
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
      const fanIn = reverseDeps.get(fileIdentityKey(dependentFile))?.length || 0;
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

      if (edge.typeOnly !== undefined) {
        transitiveItem.typeOnly = edge.typeOnly;
        if (transitiveItem.explain) {
          transitiveItem.explain.typeOnly = edge.typeOnly;
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
          reason: "exportChain",
        });
      }
    }
  }
}
