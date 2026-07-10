import fs from "node:fs/promises";
import path from "node:path";

import { findNearestExistingPath } from "../util/confinedFile.js";
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
  const existingPath = await findNearestExistingPath(lexicalPath);
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
