import { listCandidateTestFiles } from "../impact/index.js";
import type { ProjectIndex, SymbolHandle } from "../indexer/types.js";
import { normalizeAgentFilePath } from "./normalize.js";

export type RenameCandidateTest = {
  file: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type CandidateTestShapingResult = {
  candidateTests: RenameCandidateTest[];
  omittedCandidateTests: number;
};

export function shapeCandidateTests(
  index: ProjectIndex,
  projectRoot: string,
  files: readonly string[],
  definitionHandles: readonly (SymbolHandle | string)[],
  limit = 100,
): CandidateTestShapingResult {
  const allCandidateTests = listCandidateTestFiles(index, [...files], definitionHandles.map(String), {
    maxCandidates: limit + 1,
    projectRoot,
  });
  const omittedCandidateTests = Math.max(0, allCandidateTests.length - limit);
  const candidateTests = allCandidateTests.slice(0, limit).map(
    (candidate): RenameCandidateTest => ({
      file: normalizeAgentFilePath(projectRoot, candidate.file),
      confidence: candidate.confidence,
      reason: candidate.reason,
    }),
  );
  return { candidateTests, omittedCandidateTests };
}
