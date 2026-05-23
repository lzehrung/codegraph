import path from "node:path";
import { listResolutionCandidates } from "../resolutionCandidates.js";
import { fileExists } from "../workspace.js";

export async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of listResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}
