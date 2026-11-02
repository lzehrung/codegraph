import path from "node:path";
import { normalizePath } from "../paths.js";
import { iterateResolutionCandidates } from "../resolution-candidates.js";
import { fileExists } from "../workspace.js";

export async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of iterateResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return normalizePath(path.resolve(candidate));
    }
  }
  return null;
}
