import path from "node:path";
import type { Edge } from "./types.js";
import {
  buildProjectIndexIncremental,
  type IncrementalBuildOptions,
  type ProjectIndex,
  symbolId,
} from "./indexer.js";
import {
  listCandidateTestFiles,
  type CandidateTestFile,
} from "./impact/context.js";
import { normalizePath, listChangedFiles, fileExists } from "./util.js";

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
    (e: any) => e.type === "local" && symbolId(e.target) === handle,
  );
}

export async function buildReviewReport(
  projectRoot: string,
  opts: ReviewOptions = {},
): Promise<ReviewReport> {
  const normalizeFile = (file: string) =>
    normalizePath(
      path.isAbsolute(file) ? file : path.resolve(projectRoot, file),
    );

  const changedFiles = new Set<string>();
  for (const file of opts.files ?? []) {
    const normalized = normalizeFile(file);
    changedFiles.add(normalized);
  }

  if (opts.gitBase || opts.changedSince) {
    const gitDiffOpts: {
      base?: string | undefined;
      head?: string | undefined;
      changedSince?: string | undefined;
    } = {
      base: opts.gitBase,
      head: opts.gitHead,
    };
    if (!opts.gitBase && opts.changedSince) {
      gitDiffOpts.changedSince = opts.changedSince;
    }
    const gitList = await listChangedFiles(projectRoot, gitDiffOpts);
    for (const file of gitList) changedFiles.add(file);
  }

  if (changedFiles.size === 0) {
    const report: ReviewReport = {
      status: "no_changes",
      summary: { filesChanged: 0, symbolsChanged: 0, candidateTests: 0 },
      changedFiles: [],
      graphDelta: [],
      candidateTests: [],
    };
    if (opts.gitBase !== undefined) report.base = opts.gitBase;
    if (opts.gitHead !== undefined) report.head = opts.gitHead;
    return report;
  }

  const changedFileList = Array.from(changedFiles);
  const existenceChecks = await Promise.all(
    changedFileList.map(async (file) => ({
      file,
      exists: await fileExists(file),
    })),
  );
  const filesToIndex = existenceChecks
    .filter((entry) => entry.exists)
    .map((entry) => entry.file);

  let index: ProjectIndex;
  if (filesToIndex.length === 0) {
    index = {
      graph: { nodes: new Set(), edges: [] },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      parsed: new Map(),
    };
  } else {
    const indexOpts: IncrementalBuildOptions = {
      ...(opts ?? {}),
      files: filesToIndex,
    };
    index = await buildProjectIndexIncremental(projectRoot, indexOpts);
  }

  const summaries: ReviewFileSummary[] = [];
  const changedSymbolIds: string[] = [];
  for (const file of changedFileList) {
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
    changedFileList,
    changedSymbolIds,
    { maxCandidates: opts.maxCandidates ?? 50 },
  ).map((candidate) => ({
    ...candidate,
    file: relativePath(projectRoot, candidate.file),
  }));

  const report: ReviewReport = {
    status: "ok",
    summary: {
      filesChanged: summaries.length,
      symbolsChanged: changedSymbolIds.length,
      candidateTests: candidateTests.length,
    },
    changedFiles: summaries,
    graphDelta,
    candidateTests,
  };
  if (opts.gitBase !== undefined) report.base = opts.gitBase;
  report.head = opts.gitHead ?? "HEAD";
  return report;
}
