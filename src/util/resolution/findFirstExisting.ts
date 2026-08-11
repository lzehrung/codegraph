import path from "node:path";
import { normalizePath } from "../paths.js";
import { listResolutionCandidates } from "../resolutionCandidates.js";
import { fileExists } from "../workspace.js";

export async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of listResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return normalizePath(path.resolve(candidate));
    }
  }
  return null;
}
