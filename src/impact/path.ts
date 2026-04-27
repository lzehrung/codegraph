import { normalizePath, resolveFilePathFromRoot } from "../util.js";

export function normalizeImpactFilePath(
  projectRoot: string,
  filePath: string,
): string {
  return normalizePath(resolveFilePathFromRoot(projectRoot, filePath));
}
