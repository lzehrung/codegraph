import type { FileId } from "../types.js";
import type { ModuleIndex } from "./types.js";

export type ReferenceCandidateIndex = {
  byTargetFile: Map<FileId, Set<FileId>>;
};

export function buildReferenceCandidateIndex(modules: ReadonlyMap<FileId, ModuleIndex>): ReferenceCandidateIndex {
  const byTargetFile = new Map<FileId, Set<FileId>>();
  for (const [fileId, moduleIndex] of modules) {
    for (const imp of moduleIndex.imports) {
      const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!targetFile || targetFile === fileId) continue;
      const files = byTargetFile.get(targetFile);
      if (files) {
        files.add(fileId);
      } else {
        byTargetFile.set(targetFile, new Set([fileId]));
      }
    }
  }
  return { byTargetFile };
}

export function candidateFilesImportingTarget(
  candidateIndex: ReferenceCandidateIndex | undefined,
  targetFile: FileId,
): readonly FileId[] | undefined {
  const files = candidateIndex?.byTargetFile.get(targetFile);
  if (!files) return undefined;
  return [...files].sort((left, right) => left.localeCompare(right));
}
