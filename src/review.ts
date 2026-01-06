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
import { locateChangedSymbols, mapChangedLinesToSymbols } from "./impact/map.js";
import { parseUnifiedDiff } from "./impact/parse.js";
import type { Hunk } from "./impact/types.js";
import {
  listCandidateTestFiles,
  type CandidateTestFile,
} from "./impact/context.js";
import {
  normalizePath,
  listChangedFiles,
  fileExists,
  getUnifiedDiff,
} from "./util.js";

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
  diffSnippets?: string[];
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
  reviewDepth?: ReviewDepth;
  maxCandidates?: number;
  includeSymbolDetails?: boolean;
  maxCallsites?: number;
  includeDiffContext?: boolean;
  diffContextLines?: number;
  diffText?: string;
  testPatterns?: string[];
};

export type ReviewDepth = "minimal" | "standard" | "deep";

type ReviewPreset = {
  includeSymbolDetails: boolean;
  maxCallsites: number;
  maxCandidates: number;
  graph: { fast: boolean };
};

const REVIEW_PRESETS: Record<ReviewDepth, ReviewPreset> = {
  minimal: {
    includeSymbolDetails: false,
    maxCallsites: 0,
    maxCandidates: 10,
    graph: { fast: true },
  },
  standard: {
    includeSymbolDetails: true,
    maxCallsites: 2,
    maxCandidates: 25,
    graph: { fast: false },
  },
  deep: {
    includeSymbolDetails: true,
    maxCallsites: 10,
    maxCandidates: 50,
    graph: { fast: false },
  },
};

function mergeGraphOptions(
  base: IncrementalBuildOptions["graph"] | undefined,
  override: IncrementalBuildOptions["graph"] | undefined,
): IncrementalBuildOptions["graph"] | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

function applyReviewPresetOptions(opts: ReviewOptions): ReviewOptions {
  if (!opts.reviewDepth) return opts;
  const preset = REVIEW_PRESETS[opts.reviewDepth];
  const mergedGraph = mergeGraphOptions(preset.graph, opts.graph);
  return {
    ...opts,
    includeSymbolDetails:
      opts.includeSymbolDetails ?? preset.includeSymbolDetails,
    maxCallsites: opts.maxCallsites ?? preset.maxCallsites,
    maxCandidates: opts.maxCandidates ?? preset.maxCandidates,
    ...(mergedGraph ? { graph: mergedGraph } : {}),
  };
}

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

function collectDiffSnippets(
  source: string,
  range: Range,
  changedLines: Set<number>,
  contextLines: number,
): string[] {
  const startLine = range.start.line ?? 0;
  const endLine = range.end.line ?? startLine;
  if (startLine <= 0) return [];
  const safeEnd = endLine >= startLine ? endLine : startLine;

  const lines = source.split(/\r?\n/);
  const filtered = Array.from(changedLines)
    .filter((line) => line >= startLine && line <= safeEnd)
    .sort((a, b) => a - b);
  const matching =
    filtered.length > 0
      ? filtered
      : Array.from(changedLines).sort((a, b) => a - b);
  if (matching.length === 0) return [];

  const snippets: string[] = [];
  let groupStart = matching[0]!;
  let groupEnd = matching[0]!;

  const pushGroup = (start: number, end: number) => {
    const snippetStart = Math.max(1, start - contextLines);
    const snippetEnd = Math.min(lines.length, end + contextLines);
    const snippet = lines.slice(snippetStart - 1, snippetEnd).join("\n");
    if (snippet) snippets.push(snippet);
  };

  for (let i = 1; i < matching.length; i += 1) {
    const line = matching[i]!;
    if (line <= groupEnd + 1) {
      groupEnd = line;
    } else {
      pushGroup(groupStart, groupEnd);
      groupStart = line;
      groupEnd = line;
    }
  }
  pushGroup(groupStart, groupEnd);

  return snippets;
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
  const appliedOptions = applyReviewPresetOptions(opts);
  const normalizeFile = (file: string) =>
    normalizePath(
      path.isAbsolute(file) ? file : path.resolve(projectRoot, file),
    );

  const changedFiles = new Set<string>();
  for (const file of appliedOptions.files ?? []) {
    const normalized = normalizeFile(file);
    changedFiles.add(normalized);
  }

  if (appliedOptions.gitBase || appliedOptions.changedSince) {
    const gitDiffOpts: {
      base?: string | undefined;
      head?: string | undefined;
      changedSince?: string | undefined;
    } = {
      base: appliedOptions.gitBase,
      head: appliedOptions.gitHead,
    };
    if (!appliedOptions.gitBase && appliedOptions.changedSince) {
      gitDiffOpts.changedSince = appliedOptions.changedSince;
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
    if (appliedOptions.gitBase !== undefined)
      report.base = appliedOptions.gitBase;
    if (appliedOptions.gitHead !== undefined)
      report.head = appliedOptions.gitHead;
    return report;
  }

  const changedFileList = Array.from(changedFiles);
  const fastGraphRequested = appliedOptions.graph?.fast ?? false;
  const graphOptions = appliedOptions.graph
    ? { ...appliedOptions.graph, fast: fastGraphRequested }
    : { fast: false };
  const includeSymbolDetails = appliedOptions.includeSymbolDetails ?? false;
  const diffContextLines =
    typeof appliedOptions.diffContextLines === "number" &&
    appliedOptions.diffContextLines >= 0
      ? appliedOptions.diffContextLines
      : 2;
  const maxCallsites =
    typeof appliedOptions.maxCallsites === "number" &&
    appliedOptions.maxCallsites >= 0
      ? appliedOptions.maxCallsites
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

  const diffText =
    appliedOptions.diffText ??
    ((appliedOptions.gitBase || appliedOptions.changedSince) &&
    changedFileList.length > 0
      ? await getUnifiedDiff(projectRoot, {
          base: appliedOptions.gitBase,
          head: appliedOptions.gitHead,
          changedSince: appliedOptions.changedSince,
        })
      : "");
  const diff = diffText ? parseUnifiedDiff(diffText) : null;
  const diffHunksByFile = new Map<string, Hunk[]>();
  if (diff) {
    for (const fileChange of diff.files) {
      const absPath = normalizePath(
        path.resolve(projectRoot, fileChange.path),
      );
      diffHunksByFile.set(absPath, fileChange.hunks);
    }
  }

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
      ...(appliedOptions ?? {}),
      files: filesToIndex,
      graph: graphOptions,
    };
    index = await buildProjectIndexIncremental(projectRoot, indexOpts);
  }

  const filesWithModules = changedFileList.map((file) => ({
    file,
    mod: index.byFile.get(file),
    hunks: diffHunksByFile.get(file),
  }));
  const includeDiffContext =
    appliedOptions.includeDiffContext ??
    (includeSymbolDetails && diffHunksByFile.size > 0);

  const fileEntries = filesWithModules.map(({ file, mod, hunks }) => {
    if (!mod) {
      return {
        file,
        mod,
        hunks,
        locals: [] as SymbolDef[],
        handles: [] as string[],
        diffLinesByHandle: new Map<string, Set<number>>(),
      };
    }
    if (!hunks) {
      return {
        file,
        mod,
        hunks,
        locals: mod.locals,
        handles: mod.locals.map((local) => symbolId(local)),
        diffLinesByHandle: new Map<string, Set<number>>(),
      };
    }
    const changedSymbols = locateChangedSymbols(index, file, hunks);
    const uniqueSymbols = new Map<string, SymbolDef>();
    for (const symbol of changedSymbols) {
      uniqueSymbols.set(symbol.id, {
        file: symbol.file,
        localName: symbol.name,
        kind: symbol.kind,
        range: symbol.range,
      });
    }
    const locals = Array.from(uniqueSymbols.values());
    const handles = Array.from(uniqueSymbols.keys());
    return {
      file,
      mod,
      hunks,
      locals,
      handles,
      diffLinesByHandle: mapChangedLinesToSymbols(index, file, hunks),
    };
  });

  const defsToResolve = fileEntries.flatMap((entry) => entry.locals);
  const referenceResults =
    includeSymbolDetails && maxCallsites > 0
      ? await Promise.all(
          defsToResolve.map(async (def) => {
            const refs = await findReferences(index, { def });
            return { def, refs };
          }),
        )
      : [];
  const referencesByHandle = new Map<
    string,
    { def: SymbolDef; refs: Awaited<ReturnType<typeof findReferences>> }
  >();
  for (const entry of referenceResults) {
    referencesByHandle.set(symbolId(entry.def), entry);
  }

  const buildSymbolSummary = async (
    local: SymbolDef,
    moduleIndex: ModuleIndex,
    diffLinesByHandle: Map<string, Set<number>>,
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
    const diffLines = diffLinesByHandle.get(handle) ?? new Set<number>();
    const diffSnippets =
      includeDiffContext && diffLines.size > 0
        ? collectDiffSnippets(source, local.range, diffLines, diffContextLines)
        : [];

    let callsites: ReviewSymbolCallsite[] | undefined;
    if (maxCallsites > 0) {
      const entry = referencesByHandle.get(handle);
      const refs = entry?.refs;
      if (refs?.status === "ok") {
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
      ...(diffSnippets.length > 0 ? { diffSnippets } : {}),
      ...(callsites ? { callsites } : {}),
    };
  };

  const summariesWithHandles = await Promise.all(
    fileEntries.map(
      async ({ file, mod, locals, handles, diffLinesByHandle }) => {
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
      const symbols: ReviewSymbolSummary[] = includeSymbolDetails
        ? await Promise.all(
            locals.map((local) =>
              buildSymbolSummary(local, mod, diffLinesByHandle),
            ),
          )
        : locals.map((local) => {
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
        } satisfies ReviewFileSummary,
        handles,
      };
    },
    ),
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
    {
      maxCandidates: appliedOptions.maxCandidates ?? 50,
      ...(appliedOptions.testPatterns
        ? { testPatterns: appliedOptions.testPatterns }
        : {}),
    },
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
  if (appliedOptions.gitBase !== undefined)
    report.base = appliedOptions.gitBase;
  report.head = appliedOptions.gitHead ?? "HEAD";
  return report;
}
