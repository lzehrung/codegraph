import path from "node:path";
import type { ProjectIndex } from "../indexer.js";
import type { FileId } from "../types.js";
import { normalizePath, toProjectRelativePath } from "../util.js";

const DEFAULT_TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)__tests__(\/|$)/i,
  /(^|\/)test(s)?(\/|$)/i,
  /(^|\/)spec(s)?(\/|$)/i,
  /\.(test|spec)\.[^./]+$/i,
  /(^|\/)[^/]*[-_.](test|spec)\.[^./]+$/i,
];

export function compileTestPatterns(
  patterns: string[] | undefined,
  onInvalidPattern?: (pattern: string, error: Error) => void,
): RegExp[] {
  const out = [...DEFAULT_TEST_PATTERNS];
  for (const pattern of patterns ?? []) {
    try {
      out.push(new RegExp(pattern));
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      onInvalidPattern?.(pattern, normalized);
    }
  }
  return out;
}

export function isTestFilePath(file: FileId, patterns: RegExp[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.test(normalized));
}

function inferIndexProjectRoot(index: ProjectIndex): string | null {
  const projectRoot = index.projectFiles?.find(
    (entry) => entry.projectRoot,
  )?.projectRoot;
  if (projectRoot) {
    return normalizePath(projectRoot);
  }

  const directories = Array.from(index.byFile.keys(), (file) =>
    path.posix.dirname(normalizePath(file)),
  );
  if (directories.length === 0) {
    return null;
  }

  const segmentLists = directories.map((directory) => directory.split("/"));
  const sharedSegments: string[] = [];
  const firstSegments = segmentLists[0] ?? [];

  for (let i = 0; i < firstSegments.length; i += 1) {
    const segment = firstSegments[i];
    if (!segment || !segmentLists.every((parts) => parts[i] === segment)) {
      break;
    }
    sharedSegments.push(segment);
  }

  if (sharedSegments.length === 0) {
    return null;
  }
  return sharedSegments.join("/");
}

export function createIndexTestFileMatcher(
  index: ProjectIndex,
  patterns: RegExp[],
): (file: FileId) => boolean {
  const projectRoot = inferIndexProjectRoot(index);

  return (file: FileId): boolean => {
    const normalized = normalizePath(file);
    const relativePath =
      projectRoot ? toProjectRelativePath(projectRoot, normalized) : null;
    return isTestFilePath(
      relativePath ?? normalized,
      patterns,
    );
  };
}
