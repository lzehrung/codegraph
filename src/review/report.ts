import path from "node:path";
import type { AnalysisSummary } from "../analysisSummary.js";
import type { CandidateTestFile } from "../impact/context.js";
import { type ProjectIndex } from "../indexer/types.js";
import { collectSqlReviewContext, type SqlReviewContext } from "../sql/review.js";
import type { Edge, FileId } from "../types.js";
import { compareEdges, edgeKey, toRelativeEdge } from "../util/graphEdges.js";
import { normalizePath } from "../util/paths.js";
import { type ProjectFileInfo } from "../util/projectFiles.js";
import { collectDeletedImporterEdges, collectDeletedSnapshotEdges, type DeletedFileSnapshot } from "./deleted.js";
import { buildReviewTasks, computeRiskSummary, hasDiagnostics } from "./risk.js";
import type { ReviewDiagnostics, ReviewFileSummary, ReviewOptions, ReviewReport } from "./types.js";

export const REVIEW_SCHEMA_VERSION = 2;

export async function collectReviewGraphDelta(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFiles: ReadonlySet<string>;
  deletedFiles: readonly string[];
  deletedSnapshots: ReadonlyMap<FileId, DeletedFileSnapshot>;
}): Promise<Edge[]> {
  const graphEdges = new Map<string, Edge>();
  for (const edge of input.index.graph.edges.filter((entry) => input.changedFiles.has(entry.from))) {
    const relativeEdge = toRelativeEdge(input.projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  for (const edge of await collectDeletedImporterEdges(input.index, input.deletedFiles, input.projectRoot)) {
    const relativeEdge = toRelativeEdge(input.projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  for (const edge of await collectDeletedSnapshotEdges(input.deletedSnapshots, input.projectRoot)) {
    const relativeEdge = toRelativeEdge(input.projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  return Array.from(graphEdges.values()).sort(compareEdges);
}

export async function collectReviewSqlContext(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFileList: string[];
}): Promise<SqlReviewContext | undefined> {
  const indexedFiles = Array.from(input.index.byFile.keys());
  const normalizedChangedFiles = new Set(input.changedFileList.map(normalizePath));
  const indexedFilesCoverMoreThanReviewSet = indexedFiles.some(
    (file) => !normalizedChangedFiles.has(normalizePath(file)),
  );
  const sqlContextProjectFiles =
    indexedFilesCoverMoreThanReviewSet && indexedFiles.some((file) => path.extname(file).toLowerCase() === ".sql")
      ? indexedFiles
      : undefined;
  return await collectSqlReviewContext(input.projectRoot, {
    changedFiles: input.changedFileList,
    ...(sqlContextProjectFiles ? { projectFiles: sqlContextProjectFiles } : {}),
  });
}

export function assembleReviewReport(input: {
  appliedOptions: ReviewOptions;
  projectFiles: ProjectFileInfo[];
  summaries: ReviewFileSummary[];
  changedSymbolIds: string[];
  candidateTests: CandidateTestFile[];
  graphDelta: Edge[];
  analysis?: AnalysisSummary;
  sqlContext?: SqlReviewContext;
  diagnostics: ReviewDiagnostics;
  riskRelevantParseFailures: number;
  exportedChangedCount: number;
}): ReviewReport {
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: "ok",
    ...(input.analysis ? { analysis: input.analysis } : {}),
    projectFiles: input.projectFiles,
    summary: {
      filesChanged: input.summaries.length,
      symbolsChanged: input.changedSymbolIds.length,
      candidateTests: input.candidateTests.length,
    },
    riskSummary: computeRiskSummary({
      filesChanged: input.summaries.length,
      symbolsChanged: input.changedSymbolIds.length,
      exportedChanged: input.exportedChangedCount,
      missingFiles: input.diagnostics.missingFiles.length,
      parseFailures: input.riskRelevantParseFailures,
    }),
    reviewTasks: buildReviewTasks({
      filesChanged: input.summaries.length,
      symbolsChanged: input.changedSymbolIds.length,
      exportedChanged: input.exportedChangedCount,
      candidateTests: input.candidateTests.length,
      missingFiles: input.diagnostics.missingFiles.length,
      parseFailures: input.riskRelevantParseFailures,
    }),
    changedFiles: input.summaries,
    graphDelta: input.graphDelta,
    candidateTests: input.candidateTests,
    ...(input.sqlContext ? { sqlContext: input.sqlContext } : {}),
    ...(hasDiagnostics(input.diagnostics) ? { diagnostics: input.diagnostics } : {}),
  };
  if (input.appliedOptions.gitBase !== undefined) report.base = input.appliedOptions.gitBase;
  report.head = input.appliedOptions.gitHead ?? "HEAD";
  return report;
}
