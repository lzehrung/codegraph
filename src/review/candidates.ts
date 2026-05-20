import { performance } from "node:perf_hooks";
import { listCandidateTestFiles, type CandidateTestFile } from "../impact/context.js";
import { type ProjectIndex } from "../indexer/types.js";
import { REVIEW_DEFAULT_CANDIDATE_TEST_LIMIT } from "../presentation/bounds.js";
import type { FileId } from "../types.js";
import { normalizePath, toProjectRelativePath } from "../util/paths.js";
import type { ReviewOptions, ReviewTimingReport } from "../review.js";
import { listDirectDeletedFileTestImporters } from "./deleted.js";

function relativePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(file);
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

function confidenceRank(confidence: CandidateTestFile["confidence"]): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

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
    if (confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)) {
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
  const maxCandidates = input.appliedOptions.maxCandidates ?? REVIEW_DEFAULT_CANDIDATE_TEST_LIMIT;
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
    ),
  )
    .map((candidate) => ({
      ...candidate,
      file: relativePath(input.projectRoot, candidate.file),
    }))
    .sort((left, right) => {
      const confidenceCompare = confidenceRank(right.confidence) - confidenceRank(left.confidence);
      if (confidenceCompare !== 0) return confidenceCompare;
      const fileCompare = comparePaths(left.file, right.file);
      if (fileCompare !== 0) return fileCompare;
      return left.reason.localeCompare(right.reason);
    })
    .slice(0, maxCandidates);
  if (input.reviewTimings) {
    input.reviewTimings.candidatesMs = Math.round(performance.now() - candidateStart);
  }
  return candidateTests;
}
