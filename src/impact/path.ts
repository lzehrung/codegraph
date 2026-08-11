import type { FileId } from "../types.js";
import type { FileChange } from "./types.js";
import pm from "picomatch";
import {
  fileIdentityKey,
  isAbsoluteFilePath,
  isFilePathWithinRoot,
  normalizePath,
  resolveFilePathFromRoot,
  toProjectDisplayPath,
} from "../util/paths.js";

export function normalizeImpactFilePath(projectRoot: string, filePath: string): string {
  return normalizePath(resolveFilePathFromRoot(projectRoot, filePath));
}

export function assertImpactFilePathWithinRoot(
  projectRoot: string,
  filePath: string,
  label: string = "Impact file",
): string {
  const normalized = normalizeImpactFilePath(projectRoot, filePath);
  if (!isFilePathWithinRoot(projectRoot, normalized)) {
    throw new Error(`${label} is outside project root: ${normalized} (root: ${normalizePath(projectRoot)})`);
  }
  return normalized;
}

export function normalizeImpactFileChange(projectRoot: string, change: FileChange): FileChange {
  const { oldPath, ...rest } = change;
  const normalizedPath = assertImpactFilePathWithinRoot(projectRoot, change.path, "Impact diff file");
  return {
    ...rest,
    path: normalizedPath,
    ...(oldPath
      ? {
          oldPath: assertImpactFilePathWithinRoot(projectRoot, oldPath, "Impact old diff file"),
        }
      : {}),
  };
}

export function toImpactReportFilePath(projectRoot: string, filePath: string): string {
  return toProjectDisplayPath(projectRoot, filePath);
}

export function createImpactIncludeMatcher(
  projectRoot: string,
  includeGlobs: readonly string[],
): (filePath: string) => boolean {
  const normalizedIncludeGlobs = includeGlobs
    .map((globPattern) => globPattern.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  if (!normalizedIncludeGlobs.length) {
    return () => true;
  }
  const matchesGlob = pm(normalizedIncludeGlobs, { dot: true });
  return (filePath: string): boolean => {
    const normalizedFile = normalizePath(filePath);
    const displayPath = toImpactReportFilePath(projectRoot, normalizedFile);
    return matchesGlob(displayPath) || (!isAbsoluteFilePath(normalizedFile) && matchesGlob(normalizedFile));
  };
}

export function createImpactIgnoreMatcher(
  projectRoot: string,
  ignoreGlobs: readonly string[],
): (filePath: string) => boolean {
  const normalizedIgnoreGlobs = ignoreGlobs
    .map((globPattern) => globPattern.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  if (!normalizedIgnoreGlobs.length) {
    return () => false;
  }
  const matchesGlob = pm(normalizedIgnoreGlobs, { dot: true });
  return (filePath: string): boolean => {
    const normalizedFile = normalizePath(filePath);
    return matchesGlob(toImpactReportFilePath(projectRoot, normalizedFile)) || matchesGlob(normalizedFile);
  };
}

export function normalizeImpactDiffFiles(
  projectRoot: string,
  diffFiles: readonly FileChange[],
  isIgnored: (filePath: string) => boolean,
): { files: FileChange[]; ignoredCount: number } {
  const normalizedFiles: FileChange[] = [];
  let ignoredCount = 0;

  for (const change of diffFiles) {
    const normalizedChange = normalizeImpactFileChange(projectRoot, change);
    if (isIgnored(normalizedChange.path)) {
      ignoredCount += 1;
      continue;
    }
    normalizedFiles.push(normalizedChange);
  }

  return { files: normalizedFiles, ignoredCount };
}

export function createGraphFileResolver(graphNodes: Iterable<FileId>): (filePath: string) => FileId {
  const nodesByIdentity = new Map<string, FileId>();
  for (const node of graphNodes) {
    const normalizedNode = normalizePath(node);
    nodesByIdentity.set(fileIdentityKey(normalizedNode), normalizedNode);
  }
  const cache = new Map<string, FileId>();

  return (filePath: string): FileId => {
    const normalized = normalizePath(filePath);
    const identity = fileIdentityKey(normalized);
    const cached = cache.get(identity);
    if (cached) return cached;
    const exact = nodesByIdentity.get(identity);
    if (exact) {
      cache.set(identity, exact);
      return exact;
    }

    const suffix = identity.startsWith("/") ? identity.slice(1) : identity;
    let match: FileId | null = null;
    for (const [nodeIdentity, node] of nodesByIdentity) {
      if (!nodeIdentity.endsWith(`/${suffix}`)) continue;
      if (match && match !== node) {
        cache.set(identity, normalized);
        return normalized;
      }
      match = node;
    }

    const resolved = match ?? normalized;
    cache.set(identity, resolved);
    return resolved;
  };
}
