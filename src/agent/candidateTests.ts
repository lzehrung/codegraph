import { boundList } from "../presentation/bounds.js";
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
  const bounded = boundList(allCandidateTests, limit);
  const candidateTests = bounded.items.map(
    (candidate): RenameCandidateTest => ({
      file: normalizeAgentFilePath(projectRoot, candidate.file),
      confidence: candidate.confidence,
      reason: candidate.reason,
    }),
  );
  return { candidateTests, omittedCandidateTests: bounded.omitted };
}
