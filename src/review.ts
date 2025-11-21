import path from "node:path";
import type { Edge } from "./types.js";
import {
  buildProjectIndexIncremental,
  type IncrementalBuildOptions,
  symbolId,
} from "./indexer.js";
import { listCandidateTestFiles, type CandidateTestFile } from "./impact/context.js";
import { normalizePath, listChangedFiles } from "./util.js";

type ReviewFileSummary = {
  file: string;
  status: "updated" | "deleted";
  symbols: Array<{
    name: string;
    kind: string;
    handle: string;
    exported: boolean;
  }>;
};

export type ReviewReport = {
  status: "ok" | "no_changes";
  base?: string;
  head?: string;
  summary: {
    filesChanged: number;
    symbolsChanged: number;
    candidateTests: number;
  };
  changedFiles: ReviewFileSummary[];
  graphDelta: Edge[];
  candidateTests: CandidateTestFile[];
};

export type ReviewOptions = IncrementalBuildOptions & {
  maxCandidates?: number;
};

function relativePath(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

function isExported(mod: { exports: any[] }, handle: string): boolean {
  return mod.exports.some(
    (e: any) =>
      e.type === "local" &&
      symbolId(e.target) === handle
  );
}

export async function buildReviewReport(
  projectRoot: string,
  opts: ReviewOptions = {}
): Promise<ReviewReport> {
  const normalizeFile = (file: string) =>
    normalizePath(path.isAbsolute(file) ? file : path.resolve(projectRoot, file));

  const changedFiles = new Set<string>();
  for (const file of opts.files ?? []) {
    const normalized = normalizeFile(file);
    changedFiles.add(normalized);
  }

  if (opts.gitBase || opts.changedSince) {
    const gitList = await listChangedFiles(projectRoot, {
      base: opts.gitBase,
      head: opts.gitHead,
      changedSince: opts.gitBase ? undefined : opts.changedSince,
    });
    for (const file of gitList) changedFiles.add(file);
  }

  if (changedFiles.size === 0) {
    return {
      status: "no_changes",
      base: opts.gitBase,
      head: opts.gitHead,
      summary: { filesChanged: 0, symbolsChanged: 0, candidateTests: 0 },
      changedFiles: [],
      graphDelta: [],
      candidateTests: [],
    };
  }

  const index = await buildProjectIndexIncremental(projectRoot, {
    ...opts,
    files: Array.from(changedFiles),
  });

  const summaries: ReviewFileSummary[] = [];
  const changedSymbolIds: string[] = [];
  for (const file of changedFiles) {
    const mod = index.byFile.get(file);
    if (!mod) {
      summaries.push({
        file: relativePath(projectRoot, file),
        status: "deleted",
        symbols: [],
      });
      continue;
    }
    const symbols = mod.locals.map((local) => {
      const handle = symbolId(local);
      changedSymbolIds.push(handle);
      return {
        name: local.localName,
        kind: local.kind,
        handle,
        exported: isExported(mod, handle),
      };
    });
    summaries.push({
      file: relativePath(projectRoot, file),
      status: "updated",
      symbols,
    });
  }

  const graphDelta: Edge[] = index.graph.edges
    .filter((edge) => changedFiles.has(edge.from))
    .map((edge) => ({
      from: relativePath(projectRoot, edge.from),
      to:
        edge.to.type === "file"
          ? { type: "file", path: relativePath(projectRoot, edge.to.path) }
          : edge.to,
      raw: edge.raw,
      ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
    }));

  const candidateTests = listCandidateTestFiles(
    index,
    Array.from(changedFiles),
    changedSymbolIds,
    { maxCandidates: opts.maxCandidates ?? 50 }
  ).map((candidate) => ({
    ...candidate,
    file: relativePath(projectRoot, candidate.file),
  }));

  return {
    status: "ok",
    base: opts.gitBase,
    head: opts.gitHead ?? "HEAD",
    summary: {
      filesChanged: summaries.length,
      symbolsChanged: changedSymbolIds.length,
      candidateTests: candidateTests.length,
    },
    changedFiles: summaries,
    graphDelta,
    candidateTests,
  };
}

