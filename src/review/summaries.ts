import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isSymbolHandleExported } from "../indexer/declarations.js";
import { findReferences } from "../indexer/navigation.js";
import { type ExportEntry, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../indexer/types.js";
import { symbolId } from "../indexer/symbols.js";
import { attachCallCompatibilityHints } from "../impact/callCompatibility.js";
import { computeMemberResolutionCoverage } from "../impact/memberResolutionCoverage.js";
import { locateChangedSymbolsWithLines, mapChangedLinesToSymbols } from "../impact/map.js";
import type { CallCompatibilityHint, ChangedSymbol, FileChange, Hunk } from "../impact/types.js";
import type { FileId, Range } from "../types.js";
import { mapLimit } from "../util/concurrency.js";
import { fileIdentityKey, toProjectDisplayPath } from "../util/paths.js";
import type { DeletedFileSnapshot } from "./deleted.js";
import { isRiskRelevantSymbolMappingFile } from "./risk.js";
import { createReferenceLookupCache } from "../impact/referenceCache.js";
import type {
  ReviewChangedFileSummaries,
  ReviewDiagnostics,
  ReviewDiffMetadata,
  ReviewFileSummary,
  ReviewSymbolCallsite,
  ReviewSymbolSummary,
  ReviewTimingReport,
} from "./types.js";

type ReviewableExportEntry = Exclude<ExportEntry, { type: "local" }>;

function relativePath(root: string, file: string): string {
  return toProjectDisplayPath(root, file);
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

function exportSummaryName(entry: ReviewableExportEntry): string {
  return entry.type === "exportStar" ? "*" : entry.exportedAs;
}

function buildExportSummary(
  file: string,
  kind: ReviewableExportEntry["type"],
  name: string,
  fromModule: string,
): ReviewSymbolSummary {
  return {
    name,
    kind,
    handle: `${file}::export::${kind}::${name}::${fromModule}`,
    exported: true,
  };
}

function parseExportSummaries(file: string, source: string): ReviewSymbolSummary[] {
  const fromMatch = source.match(/\bfrom\s+(['"])([^'"]+)\1/);
  const fromModule = fromMatch?.[2];
  if (!fromModule) return [];

  if (/^export\s*\*\s+from\b/.test(source)) {
    return [buildExportSummary(file, "exportStar", "*", fromModule)];
  }
  const namespaceMatch = source.match(/^export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/);
  if (namespaceMatch?.[1]) {
    return [buildExportSummary(file, "namespaceReexport", namespaceMatch[1], fromModule)];
  }

  const namedMatch = source.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s+from\b/);
  if (!namedMatch?.[1]) return [];
  return namedMatch[1].split(",").flatMap((specifier) => {
    const specifierMatch = specifier
      .trim()
      .replace(/^type\s+/, "")
      .match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    const sourceSpecifier = specifierMatch?.[1];
    if (!sourceSpecifier) return [];
    const exportedAs = specifierMatch[2] ?? sourceSpecifier;
    return [buildExportSummary(file, "reexport", exportedAs, fromModule)];
  });
}

function uniqueExportSummaries(summaries: readonly ReviewSymbolSummary[]): ReviewSymbolSummary[] {
  const summariesByHandle = new Map<string, ReviewSymbolSummary>();
  for (const summary of summaries) {
    summariesByHandle.set(summary.handle, summary);
  }
  return Array.from(summariesByHandle.values());
}

function buildExportSummaries(file: string, entries: readonly ReviewableExportEntry[]): ReviewSymbolSummary[] {
  return entries.map((entry) => {
    const name = exportSummaryName(entry);
    return buildExportSummary(file, entry.type, name, entry.fromModule);
  });
}

function buildExportSummaryGroups(
  file: string,
  source: string,
  hunks: Hunk[] | undefined,
): { changed: ReviewSymbolSummary[]; context: ReviewSymbolSummary[] } {
  if (!hunks) return { changed: [], context: [] };
  const changed = uniqueExportSummaries(
    hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => (line.startsWith("+") ? parseExportSummaries(file, line.slice(1).trim()) : [])),
    ),
  );
  if (!changed.length) return { changed: [], context: [] };
  const changedHandles = new Set(changed.map((summary) => summary.handle));
  const context = uniqueExportSummaries(
    source.split(/\r?\n/).flatMap((line) => parseExportSummaries(file, line.trim())),
  ).filter((summary) => !changedHandles.has(summary.handle));
  return { changed, context };
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

function reviewFileDiffMetadata(projectRoot: string, diffChange: FileChange | undefined): ReviewDiffMetadata {
  if (!diffChange) return {};
  return {
    ...(diffChange.oldPath ? { oldFile: relativePath(projectRoot, diffChange.oldPath) } : {}),
    ...(diffChange.similarityIndex !== undefined ? { similarityIndex: diffChange.similarityIndex } : {}),
  };
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
  diffChangesByFile: ReadonlyMap<string, FileChange>;
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
    diffChangesByFile,
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
    const key = fileIdentityKey(file);
    const cached = sourceCache.get(key);
    if (cached !== undefined) return cached;
    const parsed = index.parsed?.get(key);
    const source = parsed?.source ?? (await fsp.readFile(file, "utf8"));
    sourceCache.set(key, source);
    return source;
  };

  const filesWithModules = changedFileList.map((file) => ({
    file,
    mod: index.byFile.get(fileIdentityKey(file)),
    hunks: diffHunksByFile.get(fileIdentityKey(file)) ?? diffHunksByFile.get(file),
  }));

  const fileEntries = await Promise.all(
    filesWithModules.map(async ({ file, mod, hunks }) => {
      const isBinary = diffChangesByFile.get(file)?.isBinary ?? false;
      if (isBinary) {
        return {
          file,
          mod,
          hunks,
          locals: [] as SymbolDef[],
          handles: [] as string[],
          changedSymbols: [] as ChangedSymbol[],
          diffLinesByHandle: new Map<string, Set<number>>(),
          parseFailed: false,
        };
      }
      if (!mod) {
        return {
          file,
          mod,
          hunks,
          locals: [] as SymbolDef[],
          handles: [] as string[],
          changedSymbols: [] as ChangedSymbol[],
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
          changedSymbols: [] as ChangedSymbol[],
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
        changedSymbols,
        diffLinesByHandle: await mapChangedLinesToSymbols(index, file, hunks, changedLines),
        parseFailed,
      };
    }),
  );

  const changedSymbolsForCompatibility = fileEntries.flatMap((entry) => entry.changedSymbols);
  const memberResolutionCoverage = computeMemberResolutionCoverage(changedSymbolsForCompatibility, index);
  if (memberResolutionCoverage.limitedLanguages.length) {
    diagnostics.memberResolutionCoverage = memberResolutionCoverage;
  }
  const referenceCache = createReferenceLookupCache();
  if (changedSymbolsForCompatibility.length) {
    await attachCallCompatibilityHints(index, changedSymbolsForCompatibility, {
      maxRefs: maxCallsites,
      projectRoot,
      referenceCache,
    });
  }
  const compatibilityByHandle = new Map<string, CallCompatibilityHint[]>();
  for (const symbol of changedSymbolsForCompatibility) {
    if (symbol.callCompatibility?.length) {
      compatibilityByHandle.set(symbol.id, symbol.callCompatibility);
    }
  }

  const defsToResolve = fileEntries.flatMap((entry) => entry.locals);
  const referencesStart = performance.now();
  const referenceResults =
    includeSymbolDetails && maxCallsites > 0
      ? await mapLimit(defsToResolve, referenceConcurrency, async (def) => {
          const refs = await referenceCache.get(index, def, {
            maxReferences: maxCallsites + 1,
          });
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
    const callCompatibility = compatibilityByHandle.get(handle);
    if (callCompatibility?.length) {
      base.callCompatibility = callCompatibility;
    }
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
      const diffChange = diffChangesByFile.get(file);
      const diffMetadata = reviewFileDiffMetadata(projectRoot, diffChange);
      const deletedSnapshot = deletedSnapshots.get(file);
      if (diffChange?.isBinary) {
        const isDeletedByDiff = diffKindsByFile.get(file) === "deleted";
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: isDeletedByDiff ? "deleted" : "updated",
            ...diffMetadata,
            isBinary: true,
            symbols: [],
          } satisfies ReviewFileSummary,
          handles: [] as string[],
        };
      }
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
        const exportSymbols = buildExportSummaries(file, listReviewableExports(deletedSnapshot.module));
        const symbols = [...localSymbols, ...exportSymbols];
        const handles = [
          ...deletedLocals.map((local) => symbolId(local)),
          ...exportSymbols.map((symbol) => symbol.handle),
        ];
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: "deleted",
            ...diffMetadata,
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
        // Existing non-indexed files (scripts, docs, extensionless) are still updates.
        // Only report deleted when the diff/disk evidence says the path is gone.
        let status: ReviewFileSummary["status"] = "updated";
        if (isMissingExplicitInput) {
          status = "missing";
        } else if (isDeletedByDiff || !fileExistsOnDisk) {
          status = "deleted";
        }
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status,
            ...diffMetadata,
            symbols: [],
          } satisfies ReviewFileSummary,
          handles: [] as string[],
        };
      }
      const localSymbols: ReviewSymbolSummary[] = await Promise.all(
        locals.map((local) => buildSymbolSummary(local, mod, diffLinesByHandle)),
      );
      const exportSummaryGroups = buildExportSummaryGroups(file, await loadSource(file), hunks);
      const symbols = [...localSymbols, ...exportSummaryGroups.changed];
      return {
        summary: {
          file: relativePath(projectRoot, file),
          status: "updated",
          ...diffMetadata,
          symbols,
          ...(exportSummaryGroups.context.length ? { apiContext: exportSummaryGroups.context } : {}),
        } satisfies ReviewFileSummary,
        handles: [...handles, ...exportSummaryGroups.changed.map((symbol) => symbol.handle)],
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
