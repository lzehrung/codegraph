import type { FileId, Edge } from "../types.js";
import type { ProjectIndex } from "../indexer.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./testPatterns.js";
import type { FileChange, ImpactItem, ImpactOptions, ImpactReason } from "./types.js";
import { createImpactIgnoreMatcher } from "./path.js";
import { calculateTransitiveSeverity } from "./severity.js";

type ImpactEmitter = (item: ImpactItem, phase: "partial" | "final") => void;

function getDependentFiles(index: ProjectIndex, filePath: FileId, reverseDeps?: Map<FileId, Edge[]>): FileId[] {
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

    const shouldSeedModifiedFallback =
      fileChange.kind === "modified" &&
      options.fileLevelFallback &&
      (fallbackPathSet.has(fileChange.path) ||
        fileChange.isBinary ||
        fileChange.modeChanged ||
        !fileChange.hunks.length);

    if (shouldSeedModifiedFallback) {
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

  const visited = new Set<FileId>();
  const queue: Array<{ file: FileId; depth: number; reason: ImpactReason }> = [];

  for (const [file] of impacted) {
    if (isIgnored(file)) continue;
    visited.add(file);
    queue.push({ file, depth: 0, reason: "transitive" });
  }

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth, reason } = queue[qi++]!;
    if (depth >= maxDepth) continue;

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
        Math.min(1, upstreamConfidence * (edge.typeOnly ? 0.75 : 0.85) * Math.pow(0.95, depth)),
      );

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
