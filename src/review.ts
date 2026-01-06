import path from "node:path";
import fsp from "node:fs/promises";
import type { Edge, Range } from "./types.js";
import {
  buildProjectIndexIncremental,
  type ExportEntry,
  findReferences,
  type IncrementalBuildOptions,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
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
  symbols: ReviewSymbolSummary[];
};

type ReviewSymbolCallsite = {
  file: string;
  range: Range;
};

type ReviewSymbolSummary = {
  name: string;
  kind: string;
  handle: string;
  exported: boolean;
  definitionSnippet?: string;
  callsites?: ReviewSymbolCallsite[];
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
  includeSymbolDetails?: boolean;
  maxCallsites?: number;
};

function relativePath(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

function isExported(mod: { exports: ExportEntry[] }, handle: string): boolean {
  return mod.exports.some(
    (e) => e.type === "local" && symbolId(e.target) === handle,
  );
}

function rangeSnippet(source: string, range: Range): string {
  const startLine = range.start.line;
  const endLine = range.end.line;
  if (typeof startLine === "number") {
    const lines = source.split(/\r?\n/);
    const safeStart = Math.max(1, startLine);
    const safeEnd =
      typeof endLine === "number" ? Math.max(safeStart, endLine) : safeStart;
    return lines.slice(safeStart - 1, safeEnd).join("\n");
  }
  const startIndex = range.start.index;
  const endIndex = range.end.index;
  if (
    typeof startIndex === "number" &&
    typeof endIndex === "number" &&
    endIndex >= startIndex
  ) {
    return source.slice(startIndex, endIndex);
  }
  return "";
}

function sameRange(left: Range, right: Range): boolean {
  const leftStart = left.start.index;
  const rightStart = right.start.index;
  const leftEnd = left.end.index;
  const rightEnd = right.end.index;
  if (typeof leftStart === "number" && typeof rightStart === "number") {
    if (leftStart !== rightStart) return false;
    if (typeof leftEnd === "number" && typeof rightEnd === "number") {
      return leftEnd === rightEnd;
    }
    return true;
  }
  return (
    left.start.line === right.start.line &&
    left.start.column === right.start.column
  );
}

// Review entry point: programmatic review report builder.
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
  const fastGraphRequested = opts.graph?.fast ?? false;
  const graphOptions = opts.graph
    ? { ...opts.graph, fast: fastGraphRequested }
    : { fast: false };
  const includeSymbolDetails = opts.includeSymbolDetails ?? false;
  const maxCallsites =
    typeof opts.maxCallsites === "number" && opts.maxCallsites >= 0
      ? opts.maxCallsites
      : 5;
  const sourceCache = new Map<string, string>();
  const loadSource = async (file: string): Promise<string> => {
    const cached = sourceCache.get(file);
    if (cached !== undefined) return cached;
    const parsed = index.parsed?.get(file);
    const source = parsed?.source ?? (await fsp.readFile(file, "utf8"));
    sourceCache.set(file, source);
    return source;
  };
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
      scopeCache: new Map(),
      parsed: new Map(),
    };
  } else {
    const indexOpts: IncrementalBuildOptions = {
      ...(opts ?? {}),
      files: filesToIndex,
      graph: graphOptions,
    };
    index = await buildProjectIndexIncremental(projectRoot, indexOpts);
  }

  const buildSymbolSummary = async (
    local: SymbolDef,
    moduleIndex: ModuleIndex,
  ): Promise<ReviewSymbolSummary> => {
    const handle = symbolId(local);
    const base: ReviewSymbolSummary = {
      name: local.localName,
      kind: local.kind,
      handle,
      exported: isExported(moduleIndex, handle),
    };
    if (!includeSymbolDetails) return base;

    const source = await loadSource(local.file);
    const snippet = rangeSnippet(source, local.range);
    const definitionSnippet = snippet ? { definitionSnippet: snippet } : {};

    let callsites: ReviewSymbolCallsite[] | undefined;
    if (maxCallsites > 0) {
      const refs = await findReferences(index, { def: local });
      if (refs.status === "ok") {
        const candidates = refs.references.filter(
          (ref) =>
            !(ref.file === local.file && sameRange(ref.range, local.range)),
        );
        const limited = candidates.slice(0, maxCallsites).map((ref) => ({
          file: relativePath(projectRoot, ref.file),
          range: ref.range,
        }));
        if (limited.length > 0) callsites = limited;
      }
    }

    return {
      ...base,
      ...definitionSnippet,
      ...(callsites ? { callsites } : {}),
    };
  };

  const summariesWithHandles = await Promise.all(
    changedFileList.map(async (file) => {
      const mod = index.byFile.get(file);
      if (!mod) {
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: "deleted",
            symbols: [],
          } satisfies ReviewFileSummary,
          handles: [] as string[],
        };
      }
      const handles = mod.locals.map((local) => symbolId(local));
      const symbols = includeSymbolDetails
        ? await Promise.all(
            mod.locals.map((local) => buildSymbolSummary(local, mod)),
          )
        : mod.locals.map((local) => {
            const handle = symbolId(local);
            return {
              name: local.localName,
              kind: local.kind,
              handle,
              exported: isExported(mod, handle),
            };
          });
      return {
        summary: {
          file: relativePath(projectRoot, file),
          status: "updated",
          symbols,
        },
        handles,
      };
    }),
  );
  const summaries = summariesWithHandles.map((entry) => entry.summary);
  const changedSymbolIds = summariesWithHandles.flatMap(
    (entry) => entry.handles,
  );

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
