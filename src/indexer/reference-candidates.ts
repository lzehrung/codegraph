import type { FileId } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import type { ModuleIndex } from "./types.js";
import type { ReferenceCandidateIndex } from "./reference-candidate-types.js";

export function buildReferenceCandidateIndex(modules: ReadonlyMap<FileId, ModuleIndex>): ReferenceCandidateIndex {
  const byTargetFile = new Map<FileId, Set<FileId>>();
  for (const moduleIndex of modules.values()) {
    const fileId = moduleIndex.file;
    const recordTarget = (targetFile: FileId): void => {
      if (fileIdentityKey(targetFile) === fileIdentityKey(fileId)) return;
      const targetKey = fileIdentityKey(targetFile);
      const files = byTargetFile.get(targetKey);
      if (files) files.add(fileId);
      else byTargetFile.set(targetKey, new Set([fileId]));
    };
    for (const imp of moduleIndex.imports) {
      if (imp.kind === "star" && imp.jvmPackageFiles) {
        for (const targetFile of imp.jvmPackageFiles) recordTarget(targetFile);
      } else if (typeof imp.resolved === "string") {
        recordTarget(imp.resolved);
      }
    }
  }
  return { byTargetFile };
}

export function candidateFilesImportingTarget(
  candidateIndex: ReferenceCandidateIndex | undefined,
  targetFile: FileId,
): ReadonlySet<FileId> | undefined {
  const files = candidateIndex?.byTargetFile.get(fileIdentityKey(targetFile));
  if (!files) return undefined;
  return files;
}
