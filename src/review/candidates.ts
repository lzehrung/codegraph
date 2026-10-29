import { performance } from "node:perf_hooks";
import {
  candidateConfidenceRank,
  compareCandidateTests,
  listCandidateTestFiles,
  type CandidateTestFile,
} from "../impact/context.js";
import { type ProjectIndex } from "../indexer/types.js";
import { REVIEW_DEFAULT_CANDIDATE_TEST_LIMIT } from "../presentation/bounds.js";
import type { FileId } from "../types.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { listDirectDeletedFileTestImporters } from "./deleted.js";
import type { ReviewOptions, ReviewTimingReport } from "./types.js";

function mergeCandidateTestEntries(
  baseCandidates: CandidateTestFile[],
  additionalCandidates: CandidateTestFile[],
): CandidateTestFile[] {
  const merged = new Map<FileId, CandidateTestFile>();
  const upsert = (candidate: CandidateTestFile) => {
    const existing = merged.get(candidate.file);
    if (!existing) {
      merged.set(candidate.file, candidate);
      return;
    }
    if (candidateConfidenceRank(candidate.confidence) > candidateConfidenceRank(existing.confidence)) {
      merged.set(candidate.file, candidate);
    }
  };
  for (const candidate of baseCandidates) upsert(candidate);
  for (const candidate of additionalCandidates) upsert(candidate);
  return Array.from(merged.values());
}

export async function collectReviewCandidateTests(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFileList: string[];
  changedSymbolIds: string[];
  deletedFiles: readonly string[];
  appliedOptions: ReviewOptions;
  reviewTimings?: ReviewTimingReport;
}): Promise<CandidateTestFile[]> {
  const candidateStart = performance.now();
  const configuredMaxCandidates = input.appliedOptions.maxCandidates;
  const maxCandidates =
    typeof configuredMaxCandidates === "number" && Number.isFinite(configuredMaxCandidates)
      ? Math.max(0, Math.floor(configuredMaxCandidates))
      : REVIEW_DEFAULT_CANDIDATE_TEST_LIMIT;
  const candidateTests = mergeCandidateTestEntries(
    listCandidateTestFiles(input.index, input.changedFileList, input.changedSymbolIds, {
      maxCandidates,
      ...(input.appliedOptions.testPatterns ? { testPatterns: input.appliedOptions.testPatterns } : {}),
      projectRoot: input.projectRoot,
    }),
    await listDirectDeletedFileTestImporters(
      input.index,
      input.deletedFiles,
      input.appliedOptions.testPatterns,
      input.projectRoot,
      input.appliedOptions.graph?.resolutionHints,
    ),
  )
    .map((candidate) => ({
      ...candidate,
      file: toProjectDisplayPath(input.projectRoot, candidate.file),
    }))
    .sort(compareCandidateTests)
    .slice(0, maxCandidates);
  if (input.reviewTimings) {
    input.reviewTimings.candidatesMs = Math.round(performance.now() - candidateStart);
  }
  return candidateTests;
}
