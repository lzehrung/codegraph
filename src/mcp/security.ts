import fs from "node:fs/promises";
import path from "node:path";

import { isFilePathWithinRoot, normalizePath } from "../util/paths.js";

export function resolveArtifactSqlitePathCandidate(root: string, artifactPath: string): string {
  const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(root, artifactPath);
  const sqlitePath =
    resolved.toLowerCase().endsWith(".sqlite") || resolved.toLowerCase().endsWith(".db")
      ? resolved
      : path.join(resolved, "codegraph.sqlite");
  return normalizePath(sqlitePath);
}
export async function assertWritableDirectoryRealPathWithinRoot(
  realRoot: string,
  root: string,
  requestedPath: string,
  label: string,
): Promise<string> {
  const lexicalPath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
  const existingPath = await nearestExistingPath(lexicalPath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, lexicalPath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return normalizePath(realTargetPath);
}

async function nearestExistingPath(filePath: string): Promise<string> {
  let current = filePath;
  while (current !== path.dirname(current)) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = path.dirname(current);
    }
  }
  return current;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
