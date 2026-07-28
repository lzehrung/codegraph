import { createHash } from "node:crypto";
import path from "node:path";
import { assertFilePathWithinRoot, isAbsoluteFilePath, isFilePathWithinRoot, normalizePath } from "../../util/paths.js";

export const QUERY_INDEX_FILENAME = "search-v1.sqlite";
export const QUERY_INDEX_CORRUPT_FILENAME = "search-v1.corrupt.sqlite";

export type QueryIndexPaths = {
  cacheRoot: string;
  sidecar: string;
  corrupt: string;
};

export function resolveQueryIndexPaths(cacheRootDir: string): QueryIndexPaths {
  const cacheRoot = path.resolve(cacheRootDir);
  const sidecar = path.resolve(cacheRoot, QUERY_INDEX_FILENAME);
  const corrupt = path.resolve(cacheRoot, QUERY_INDEX_CORRUPT_FILENAME);
  if (!isFilePathWithinRoot(cacheRoot, sidecar) || !isFilePathWithinRoot(cacheRoot, corrupt)) {
    throw new Error("Query index paths escaped the configured cache root.");
  }
  return { cacheRoot, sidecar, corrupt };
}

export function normalizeQueryIndexRelativePath(projectRoot: string, filePath: string): string {
  if (filePath.includes("\0")) throw new Error("Query index path contains a NUL byte.");
  const confined = assertFilePathWithinRoot(projectRoot, filePath, "Query index source");
  const relative = normalizePath(path.relative(path.resolve(projectRoot), path.resolve(confined)));
  if (!relative || relative === "." || relative.startsWith("../") || isAbsoluteFilePath(relative)) {
    throw new Error(`Query index source path is not a confined project-relative file: ${filePath}`);
  }
  return relative;
}

export function resolveQueryIndexSourcePath(projectRoot: string, relativePath: string): string {
  if (relativePath.includes("\0") || isAbsoluteFilePath(relativePath)) {
    throw new Error(`Invalid query index relative path: ${relativePath}`);
  }
  const normalized = normalizePath(relativePath);
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || isAbsoluteFilePath(normalized) || segments.includes("..")) {
    throw new Error(`Invalid query index relative path: ${relativePath}`);
  }
  return assertFilePathWithinRoot(projectRoot, path.resolve(projectRoot, ...segments), "Query index row");
}

export function createProjectRootIdentity(projectRoot: string): string {
  const normalized = normalizePath(path.resolve(projectRoot));
  const comparable = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update("query-root-v1\0").update(comparable).digest("hex");
}
