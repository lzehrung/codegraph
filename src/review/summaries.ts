import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isSymbolHandleExported } from "../indexer/declarations.js";
import { findReferences } from "../indexer/navigation.js";
import { type ExportEntry, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../indexer/types.js";
import { symbolId } from "../indexer/symbols.js";
import { locateChangedSymbolsWithLines, mapChangedLinesToSymbols } from "../impact/map.js";
import type { Hunk } from "../impact/types.js";
import type { FileId, Range } from "../types.js";
import { mapLimit } from "../util/concurrency.js";
import { normalizePath, toProjectRelativePath } from "../util/paths.js";
import type { ReviewDiagnostics, ReviewTimingReport } from "../review.js";
import type { DeletedFileSnapshot } from "./deleted.js";
import { isRiskRelevantSymbolMappingFile } from "./risk.js";

export type ReviewFileSummary = {
  file: string;
  status: "updated" | "deleted" | "missing";
  symbols: ReviewSymbolSummary[];
};

type ReviewSymbolCallsite = {
  file: string;
  range: Range;
};

export type ReviewSymbolSummary = {
  name: string;
  kind: string;
  handle: string;
  exported: boolean;
  definitionSnippet?: string;
  diffSnippets?: string[];
  callsites?: ReviewSymbolCallsite[];
};

export type ReviewChangedFileSummaries = {
  summaries: ReviewFileSummary[];
  changedSymbolIds: string[];
  exportedChangedCount: number;
  riskRelevantParseFailures: number;
};

type ReviewableExportEntry = Exclude<ExportEntry, { type: "local" }>;

function relativePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(file);
}

function sortSymbols(symbols: SymbolDef[]): SymbolDef[] {
  return symbols.slice().sort((left, right) => symbolId(left).localeCompare(symbolId(right)));
}

function isExported(mod: { exports: ExportEntry[] }, handle: string): boolean {
  return isSymbolHandleExported(mod.exports, handle);
}

function listReviewableExports(mod: ModuleIndex): ReviewableExportEntry[] {
  return mod.exports.filter((entry): entry is ReviewableExportEntry => entry.type !== "local");
}

function exportSummaryHandle(file: string, entry: ReviewableExportEntry): string {
  const exportedAs = entry.type === "exportStar" ? "*" : entry.exportedAs;
  return `${file}::export::${entry.type}::${exportedAs}::${entry.fromModule}`;
}

function exportSummaryName(entry: ReviewableExportEntry): string {
  return entry.type === "exportStar" ? "*" : entry.exportedAs;
}

function exportSummaryKind(entry: ReviewableExportEntry): string {
  return entry.type;
}

function diffLineLooksExportLike(line: string): boolean {
  const prefix = line[0];
  if (prefix !== "+" && prefix !== "-") return false;
  const trimmed = line.slice(1).trimStart();
  return trimmed.startsWith("export ") || trimmed.startsWith("module.exports") || trimmed.startsWith("exports.");
}

function shouldIncludeExportSummaries(
  mod: ModuleIndex,
  hunks: Hunk[] | undefined,
  locals: readonly SymbolDef[],
): boolean {
  if (!listReviewableExports(mod).length) return false;
  if (!hunks) return true;
  if (!locals.length) return true;
  return hunks.some((hunk) => hunk.lines.some(diffLineLooksExportLike));
}

function buildExportSummaries(file: string, mod: ModuleIndex): ReviewSymbolSummary[] {
  return listReviewableExports(mod).map((entry) => ({
    name: exportSummaryName(entry),
    kind: exportSummaryKind(entry),
    handle: exportSummaryHandle(file, entry),
    exported: true,
  }));
}

function rangeSnippet(source: string, range: Range): string {
  const startLine = range.start.line;
  const endLine = range.end.line;
  if (typeof startLine === "number") {
    const lines = source.split(/\r?\n/);
    const safeStart = Math.max(1, startLine);
    const safeEnd = typeof endLine === "number" ? Math.max(safeStart, endLine) : safeStart;
    return lines.slice(safeStart - 1, safeEnd).join("\n");
  }
  const startIndex = range.start.index;
  const endIndex = range.end.index;
  if (typeof startIndex === "number" && typeof endIndex === "number" && endIndex >= startIndex) {
    return source.slice(startIndex, endIndex);
  }
  return "";
}

function collectDiffSnippets(source: string, range: Range, changedLines: Set<number>, contextLines: number): string[] {
  const startLine = range.start.line ?? 0;
  const endLine = range.end.line ?? startLine;
  if (startLine <= 0) return [];
  const safeEnd = endLine >= startLine ? endLine : startLine;

  const sortedChangedLines = [...changedLines].sort((a, b) => a - b);
  if (!sortedChangedLines.length) return [];

  const lines = source.split(/\r?\n/);
  const matching: number[] = [];
  for (const line of sortedChangedLines) {
    if (line >= startLine && line <= safeEnd) matching.push(line);
  }
  const matchingLines = matching.length ? matching : sortedChangedLines;

  const snippets: string[] = [];
  let groupStart = matchingLines[0]!;
  let groupEnd = matchingLines[0]!;

  const pushGroup = (start: number, end: number) => {
    const snippetStart = Math.max(1, start - contextLines);
    const snippetEnd = Math.min(lines.length, end + contextLines);
    const snippet = lines.slice(snippetStart - 1, snippetEnd).join("\n");
    if (snippet) snippets.push(snippet);
  };

  for (let i = 1; i < matchingLines.length; i += 1) {
    const line = matchingLines[i]!;
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
  return left.start.line === right.start.line && left.start.column === right.start.column;
}

export async function summarizeChangedFiles(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFileList: string[];
  diffHunksByFile: ReadonlyMap<string, Hunk[]>;
  diffKindsByFile: ReadonlyMap<string, string>;
  explicitFiles: ReadonlySet<string>;
  existenceByFile: ReadonlyMap<string, boolean>;
  deletedSnapshots: ReadonlyMap<FileId, DeletedFileSnapshot>;
  includeSymbolDetails: boolean;
  includeDiffContext: boolean;
  diffContextLines: number;
  maxCallsites: number;
  referenceConcurrency: number;
  diagnostics: ReviewDiagnostics;
  reviewTimings?: ReviewTimingReport;
}): Promise<ReviewChangedFileSummaries> {
  const {
    projectRoot,
    index,
    changedFileList,
    diffHunksByFile,
    diffKindsByFile,
    explicitFiles,
    existenceByFile,
    deletedSnapshots,
    includeSymbolDetails,
    includeDiffContext,
    diffContextLines,
    maxCallsites,
    referenceConcurrency,
    diagnostics,
    reviewTimings,
  } = input;
  const sourceCache = new Map<string, string>();
  const loadSource = async (file: string): Promise<string> => {
    const cached = sourceCache.get(file);
    if (cached !== undefined) return cached;
    const parsed = index.parsed?.get(file);
    const source = parsed?.source ?? (await fsp.readFile(file, "utf8"));
    sourceCache.set(file, source);
    return source;
  };

  const filesWithModules = changedFileList.map((file) => ({
    file,
    mod: index.byFile.get(file),
    hunks: diffHunksByFile.get(file),
  }));

  const fileEntries = await Promise.all(
    filesWithModules.map(async ({ file, mod, hunks }) => {
      if (!mod) {
        return {
          file,
          mod,
          hunks,
          locals: [] as SymbolDef[],
          handles: [] as string[],
          diffLinesByHandle: new Map<string, Set<number>>(),
          parseFailed: false,
        };
      }
      if (!hunks) {
        const locals = sortSymbols(mod.locals);
        return {
          file,
          mod,
          hunks,
          locals,
          handles: locals.map((local) => symbolId(local)),
          diffLinesByHandle: new Map<string, Set<number>>(),
          parseFailed: false,
        };
      }
      const { changedSymbols, changedLines, parseFailed } = await locateChangedSymbolsWithLines(index, file, hunks);
      if (parseFailed) {
        diagnostics.symbolMappingParseFailures.push(relativePath(projectRoot, file));
      }
      const uniqueSymbols = new Map<string, SymbolDef>();
      for (const symbol of changedSymbols) {
        uniqueSymbols.set(symbol.id, {
          file: symbol.file,
          localName: symbol.name,
          kind: symbol.kind,
          range: symbol.range,
        });
      }
      const locals = sortSymbols(Array.from(uniqueSymbols.values()));
      const handles = locals.map((local) => symbolId(local));
      return {
        file,
        mod,
        hunks,
        locals,
        handles,
        diffLinesByHandle: await mapChangedLinesToSymbols(index, file, hunks, changedLines),
        parseFailed,
      };
    }),
  );

  const defsToResolve = fileEntries.flatMap((entry) => entry.locals);
  const referencesStart = performance.now();
  const referenceResults =
    includeSymbolDetails && maxCallsites > 0
      ? await mapLimit(defsToResolve, referenceConcurrency, async (def) => {
          const refs = await findReferences(
            index,
            { def },
            {
              maxReferences: maxCallsites + 1,
            },
          );
          return { def, refs };
        })
      : [];
  if (reviewTimings) {
    reviewTimings.referencesMs = Math.round(performance.now() - referencesStart);
  }
  const referencesByHandle = new Map<string, { def: SymbolDef; refs: Awaited<ReturnType<typeof findReferences>> }>();
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
      includeDiffContext && diffLines.size ? collectDiffSnippets(source, local.range, diffLines, diffContextLines) : [];

    let callsites: ReviewSymbolCallsite[] | undefined;
    if (maxCallsites > 0) {
      const entry = referencesByHandle.get(handle);
      const refs = entry?.refs;
      if (refs?.status === "ok") {
        const candidates = refs.references.filter(
          (ref) => !(ref.file === local.file && sameRange(ref.range, local.range)),
        );
        const limited = candidates.slice(0, maxCallsites).map((ref) => ({
          file: relativePath(projectRoot, ref.file),
          range: ref.range,
        }));
        if (limited.length) callsites = limited;
      }
    }

    return {
      ...base,
      ...definitionSnippet,
      ...(diffSnippets.length ? { diffSnippets } : {}),
      ...(callsites ? { callsites } : {}),
    };
  };

  const summariesWithHandles = await Promise.all(
    fileEntries.map(async ({ file, mod, hunks, locals, handles, diffLinesByHandle }) => {
      const deletedSnapshot = deletedSnapshots.get(file);
      if (!mod && deletedSnapshot) {
        const deletedLocals = sortSymbols(deletedSnapshot.module.locals);
        const localSymbols: ReviewSymbolSummary[] = includeSymbolDetails
          ? deletedLocals.map((local) => {
              const handle = symbolId(local);
              const definitionSnippet = rangeSnippet(deletedSnapshot.source, local.range);
              return {
                name: local.localName,
                kind: local.kind,
                handle,
                exported: isExported(deletedSnapshot.module, handle),
                ...(definitionSnippet ? { definitionSnippet } : {}),
              };
            })
          : deletedLocals.map((local) => {
              const handle = symbolId(local);
              return {
                name: local.localName,
                kind: local.kind,
                handle,
                exported: isExported(deletedSnapshot.module, handle),
              };
            });
        const exportSymbols = buildExportSummaries(file, deletedSnapshot.module);
        const symbols = [...localSymbols, ...exportSymbols];
        const handles = [
          ...deletedLocals.map((local) => symbolId(local)),
          ...exportSymbols.map((symbol) => symbol.handle),
        ];
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: "deleted",
            symbols,
          } satisfies ReviewFileSummary,
          handles,
        };
      }
      if (!mod) {
        const fileExistsOnDisk = existenceByFile.get(file) ?? false;
        const isDeletedByDiff = diffKindsByFile.get(file) === "deleted";
        const isMissingExplicitInput = !fileExistsOnDisk && explicitFiles.has(file) && !isDeletedByDiff;
        if (isMissingExplicitInput) {
          diagnostics.missingFiles.push(relativePath(projectRoot, file));
        }
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: isMissingExplicitInput ? "missing" : "deleted",
            symbols: [],
          } satisfies ReviewFileSummary,
          handles: [] as string[],
        };
      }
      const localSymbols: ReviewSymbolSummary[] = includeSymbolDetails
        ? await Promise.all(locals.map((local) => buildSymbolSummary(local, mod, diffLinesByHandle)))
        : locals.map((local) => {
            const handle = symbolId(local);
            return {
              name: local.localName,
              kind: local.kind,
              handle,
              exported: isExported(mod, handle),
            };
          });
      const exportSymbols = shouldIncludeExportSummaries(mod, hunks, locals) ? buildExportSummaries(file, mod) : [];
      const symbols = [...localSymbols, ...exportSymbols];
      return {
        summary: {
          file: relativePath(projectRoot, file),
          status: "updated",
          symbols,
        } satisfies ReviewFileSummary,
        handles: [...handles, ...exportSymbols.map((symbol) => symbol.handle)],
      };
    }),
  );

  const summaries = summariesWithHandles.map((entry) => entry.summary);
  const changedSymbolIds = summariesWithHandles.flatMap((entry) => entry.handles);
  const exportedChangedCount = summaries.reduce((count, summary) => {
    const exportedInFile = summary.symbols.filter((symbol) => symbol.exported);
    return count + exportedInFile.length;
  }, 0);
  const riskRelevantParseFailures = diagnostics.symbolMappingParseFailures.filter((file) =>
    isRiskRelevantSymbolMappingFile(path.join(projectRoot, file)),
  ).length;

  return {
    summaries,
    changedSymbolIds,
    exportedChangedCount,
    riskRelevantParseFailures,
  };
}
