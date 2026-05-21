import type { FileId } from "../types.js";
import type { FileChange } from "./types.js";
import pm from "picomatch";
import { isFilePathWithinRoot, normalizePath, resolveFilePathFromRoot, toProjectDisplayPath } from "../util/paths.js";

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
  const normalizedPath = assertImpactFilePathWithinRoot(projectRoot, change.path, "Impact diff file");
  return {
    ...change,
    path: normalizedPath,
    ...(change.oldPath
      ? {
          oldPath: assertImpactFilePathWithinRoot(projectRoot, change.oldPath, "Impact old diff file"),
        }
      : {}),
  };
}

export function toImpactReportFilePath(projectRoot: string, filePath: string): string {
  return toProjectDisplayPath(projectRoot, filePath);
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
  const matchesGlob = pm(normalizedIgnoreGlobs);
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
  const normalizedNodes = Array.from(new Set(Array.from(graphNodes, (node) => normalizePath(node))));
  const exactNodes = new Set(normalizedNodes);
  const cache = new Map<string, FileId>();

  return (filePath: string): FileId => {
    const normalized = normalizePath(filePath);
    const cached = cache.get(normalized);
    if (cached) return cached;
    if (exactNodes.has(normalized)) {
      cache.set(normalized, normalized);
      return normalized;
    }

    const suffix = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    let match: FileId | null = null;
    for (const node of normalizedNodes) {
      if (!node.endsWith(`/${suffix}`)) continue;
      if (match && match !== node) {
        cache.set(normalized, normalized);
        return normalized;
      }
      match = node;
    }

    const resolved = match ?? normalized;
    cache.set(normalized, resolved);
    return resolved;
  };
}
