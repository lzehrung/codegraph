import fs from "node:fs/promises";
import path from "node:path";

import { isFilePathWithinRoot, normalizePath, toProjectRelativePath } from "./paths.js";

export async function resolveReadableFile(
  realRoot: string,
  root: string,
  filePath: string,
): Promise<{ realPath: string; displayPath: string }> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const displayPath =
    toProjectRelativePath(root, candidatePath) ?? toProjectRelativePath(realRoot, realPath) ?? normalizePath(realPath);
  return { realPath, displayPath };
}

export async function resolveProjectFile(realRoot: string, root: string, filePath: string): Promise<string> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const lexicalRelativePath = toProjectRelativePath(root, candidatePath);
  if (lexicalRelativePath) return normalizePath(candidatePath);
  const realRelativePath = toProjectRelativePath(realRoot, realPath);
  if (realRelativePath) return normalizePath(path.resolve(root, realRelativePath));
  throw new Error(`File is outside project root: ${normalizePath(realPath)} (root: ${normalizePath(realRoot)})`);
}

export async function assertRealPathCandidateWithinRoot(
  realRoot: string,
  filePath: string,
  label: string,
): Promise<string> {
  const existingPath = await findNearestExistingPath(filePath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, filePath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  const finalRealPath = await fs.realpath(filePath);
  if (!isFilePathWithinRoot(realRoot, finalRealPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(finalRealPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return finalRealPath;
}

export async function findNearestExistingPath(filePath: string): Promise<string> {
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
