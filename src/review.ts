import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { Edge, FileId, Range } from "./types.js";
import {
  buildProjectIndexIncremental,
  type BuildReport,
  collectLocalsAndExportsFromSource,
  type ExportEntry,
  findReferences,
  type IncrementalBuildOptions,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
  symbolId,
} from "./indexer.js";
import {
  locateChangedSymbolsWithLines,
  mapChangedLinesToSymbols,
} from "./impact/map.js";
import { parseUnifiedDiff } from "./impact/parse.js";
import type { FileChange, Hunk } from "./impact/types.js";
import {
  listCandidateTestFiles,
  type CandidateTestFile,
} from "./impact/context.js";
import { compileTestPatterns, isTestFilePath } from "./impact/testPatterns.js";
import {
  normalizePath,
  listChangedFiles,
  fileExists,
  getUnifiedDiff,
  discoverProjectFiles,
  resolveFilePathFromRoot,
  type ProjectFileInfo,
} from "./util.js";
import { supportForFile } from "./languages.js";

const execFileAsync = promisify(execFile);

type ReviewFileSummary = {
  file: string;
  status: "updated" | "deleted" | "missing";
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
  schemaVersion: number;
  status: "ok" | "no_changes";
  base?: string;
  head?: string;
  projectFiles?: ProjectFileInfo[];
  summary: {
    filesChanged: number;
    symbolsChanged: number;
    candidateTests: number;
  };
  riskSummary: ReviewRiskSummary;
  reviewTasks: ReviewTask[];
  changedFiles: ReviewFileSummary[];
  graphDelta: Edge[];
  candidateTests: CandidateTestFile[];
  diagnostics?: ReviewDiagnostics;
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
  referenceConcurrency?: number;
  report?: ReviewBuildReport;
};

export type ReviewDepth = "minimal" | "standard" | "deep";

export type ReviewRiskLevel = "low" | "medium" | "high";

export type ReviewRiskSummary = {
  level: ReviewRiskLevel;
  score: number;
  signals: string[];
};

export type ReviewTaskPriority = "low" | "medium" | "high";

export type ReviewTask = {
  id: string;
  title: string;
  description: string;
  priority: ReviewTaskPriority;
  reason: string;
};

export type ReviewDiagnostics = {
  missingFiles: string[];
  symbolMappingParseFailures: string[];
};

export type ReviewTimingReport = {
  totalMs?: number;
  changesMs?: number;
  diffMs?: number;
  indexMs?: number;
  referencesMs?: number;
  candidatesMs?: number;
};

export type ReviewBuildReport = {
  timings: ReviewTimingReport;
  indexReport?: BuildReport;
};

type ReviewPreset = {
  includeSymbolDetails: boolean;
  maxCallsites: number;
  maxCandidates: number;
  graph: { fast: boolean };
};

type DeletedFileSnapshot = {
  source: string;
  module: ModuleIndex;
};

type ReviewableExportEntry = Exclude<ExportEntry, { type: "local" }>;

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

const REVIEW_SCHEMA_VERSION = 2;

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

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareEdges(left: Edge, right: Edge): number {
  const fromCompare = comparePaths(left.from, right.from);
  if (fromCompare !== 0) return fromCompare;
  if (left.to.type !== right.to.type) {
    return left.to.type === "file" ? -1 : 1;
  }
  const leftTarget = left.to.type === "file" ? left.to.path : left.to.name;
  const rightTarget = right.to.type === "file" ? right.to.path : right.to.name;
  const toCompare = comparePaths(leftTarget, rightTarget);
  if (toCompare !== 0) return toCompare;
  const rawCompare = left.raw.localeCompare(right.raw);
  if (rawCompare !== 0) return rawCompare;
  const leftTypeOnly = left.typeOnly ? 1 : 0;
  const rightTypeOnly = right.typeOnly ? 1 : 0;
  return leftTypeOnly - rightTypeOnly;
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
    if (
      confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)
    ) {
      merged.set(candidate.file, candidate);
    }
  };
  for (const candidate of baseCandidates) upsert(candidate);
  for (const candidate of additionalCandidates) upsert(candidate);
  return Array.from(merged.values());
}

function normalizeSpecifierBase(fromFile: string, spec: string): string {
  return normalizePath(path.resolve(path.dirname(fromFile), spec));
}

function buildDeletedImportCandidates(
  fromFile: string,
  spec: string,
  targetFile: string,
): Set<string> {
  const normalizedTarget = normalizePath(targetFile);
  const normalizedSpec = spec.replace(/\\/g, "/");
  const basePath = normalizeSpecifierBase(fromFile, normalizedSpec);
  const candidates = new Set<string>([basePath]);
  const specExt = path.extname(normalizedSpec);
  const targetExt = path.extname(normalizedTarget);

  if (!targetExt) return candidates;

  if (!specExt) {
    candidates.add(`${basePath}${targetExt}`);
    candidates.add(normalizePath(path.join(basePath, `index${targetExt}`)));
    return candidates;
  }

  const baseWithoutExt = basePath.slice(0, -specExt.length);
  const isJsTsPair =
    (specExt === ".js" && targetExt === ".ts") ||
    (specExt === ".mjs" && targetExt === ".mts") ||
    (specExt === ".cjs" && targetExt === ".cts");

  if (isJsTsPair) {
    candidates.add(`${baseWithoutExt}${targetExt}`);
  }

  return candidates;
}

function listDirectDeletedFileTestImporters(
  index: ProjectIndex,
  deletedFiles: readonly string[],
  testPatterns: string[] = [],
): CandidateTestFile[] {
  if (deletedFiles.length === 0) return [];

  const deletedFileSet = new Set(
    deletedFiles.map((file) => normalizePath(file)),
  );
  const compiledPatterns = compileTestPatterns(testPatterns);
  const candidates = new Map<FileId, CandidateTestFile>();
  const relativeSpecsByFile = new Map<FileId, Set<string>>();

  for (const edge of index.graph.edges) {
    if (!edge.raw.startsWith(".")) continue;
    let specs = relativeSpecsByFile.get(edge.from);
    if (!specs) {
      specs = new Set<string>();
      relativeSpecsByFile.set(edge.from, specs);
    }
    specs.add(edge.raw);
  }

  for (const mod of index.byFile.values()) {
    if (!isTestFilePath(mod.file, compiledPatterns)) continue;
    const relativeSpecs = new Set(relativeSpecsByFile.get(mod.file) ?? []);
    for (const imp of mod.imports) {
      if (!imp.from.startsWith(".")) continue;
      relativeSpecs.add(imp.from);
    }
    for (const spec of relativeSpecs) {
      for (const deletedFile of deletedFileSet) {
        const resolvedCandidates = buildDeletedImportCandidates(
          mod.file,
          spec,
          deletedFile,
        );
        if (!resolvedCandidates.has(deletedFile)) continue;
        candidates.set(mod.file, {
          file: mod.file,
          confidence: "high",
          reason: "importsChanged",
        });
      }
    }
  }

  return Array.from(candidates.values());
}

async function readGitFileAtRevision(
  projectRoot: string,
  revision: string,
  file: string,
): Promise<string | null> {
  const relativeFile = normalizePath(path.relative(projectRoot, file));
  if (!relativeFile || relativeFile.startsWith("..")) return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${revision}:${relativeFile}`],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return stdout;
  } catch {
    return null;
  }
}

async function buildDeletedFileSnapshots(
  projectRoot: string,
  deletedFiles: readonly string[],
  opts: {
    revision?: string;
    diffChangesByFile?: ReadonlyMap<FileId, FileChange>;
  },
): Promise<Map<FileId, DeletedFileSnapshot>> {
  const snapshots = new Map<FileId, DeletedFileSnapshot>();
  if (deletedFiles.length === 0) return snapshots;

  for (const file of deletedFiles) {
    const support = supportForFile(file);
    if (!support) continue;
    const source =
      (opts.revision
        ? await readGitFileAtRevision(projectRoot, opts.revision, file)
        : null) ??
      reconstructDeletedSourceFromDiff(opts.diffChangesByFile?.get(file));
    if (source === null) continue;
    const normalizedFile = normalizePath(file);
    const module = collectLocalsAndExportsFromSource(
      normalizedFile,
      source,
      support,
    );
    snapshots.set(normalizedFile, {
      source,
      module,
    });
  }

  return snapshots;
}

function reconstructDeletedSourceFromDiff(
  change: FileChange | undefined,
): string | null {
  if (!change || change.kind !== "deleted" || change.hunks.length === 0) {
    return null;
  }
  const oldLines: string[] = [];
  for (const hunk of change.hunks) {
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === "+") continue;
      if (prefix !== " " && prefix !== "-") continue;
      while (oldLines.length < oldLine - 1) {
        oldLines.push("");
      }
      oldLines[oldLine - 1] = line.slice(1);
      oldLine += 1;
    }
  }
  return oldLines.length > 0 ? oldLines.join("\n") : null;
}

function sortSymbols(symbols: SymbolDef[]): SymbolDef[] {
  return symbols
    .slice()
    .sort((left, right) => symbolId(left).localeCompare(symbolId(right)));
}

function computeRiskSummary(input: {
  filesChanged: number;
  symbolsChanged: number;
  exportedChanged: number;
  missingFiles: number;
  parseFailures: number;
}): ReviewRiskSummary {
  const signals: string[] = [];
  let score = 0;
  if (input.exportedChanged > 0) {
    score += 60;
    signals.push("exported-symbols-changed");
  } else {
    score += 20;
  }
  if (input.symbolsChanged >= 20) {
    score += 20;
    signals.push("many-symbols-changed");
  }
  if (input.filesChanged >= 10) {
    score += 20;
    signals.push("many-files-changed");
  }
  if (input.missingFiles > 0) {
    score += 30;
    signals.push("missing-files");
  }
  if (input.parseFailures > 0) {
    score += 25;
    signals.push("symbol-mapping-degraded");
  }
  const normalizedScore = Math.min(100, score);
  let level: ReviewRiskLevel = "low";
  if (normalizedScore >= 70) level = "high";
  else if (normalizedScore >= 40) level = "medium";
  return {
    level,
    score: normalizedScore,
    signals,
  };
}

function buildReviewTasks(input: {
  filesChanged: number;
  symbolsChanged: number;
  exportedChanged: number;
  candidateTests: number;
  missingFiles: number;
  parseFailures: number;
}): ReviewTask[] {
  const tasks: ReviewTask[] = [
    {
      id: "review-summary",
      title: "Review changed symbols",
      description:
        "Scan the changed symbols and confirm behavioral changes align with intent.",
      priority: "medium",
      reason: "baseline-review",
    },
  ];

  if (input.exportedChanged > 0) {
    tasks.push({
      id: "api-compat",
      title: "Verify API compatibility",
      description:
        "Check exported symbols for breaking changes, migration notes, and versioning implications.",
      priority: "high",
      reason: "exported-symbols-changed",
    });
  }

  if (input.candidateTests === 0) {
    tasks.push({
      id: "tests-missing",
      title: "Validate test coverage",
      description:
        "No candidate tests were detected. Confirm existing coverage or add targeted tests.",
      priority: "medium",
      reason: "no-candidate-tests",
    });
  }

  if (input.filesChanged >= 10 || input.symbolsChanged >= 20) {
    tasks.push({
      id: "high-change-volume",
      title: "Assess change scope",
      description:
        "Large change set detected. Double-check impacted files and coordination needs.",
      priority: "high",
      reason: "large-change-set",
    });
  }

  if (input.parseFailures > 0) {
    tasks.push({
      id: "analysis-degraded",
      title: "Validate degraded symbol mapping",
      description:
        "Some changed files could not be mapped cleanly to symbols. Review syntax errors, parser support, or fall back to file-level inspection.",
      priority: "high",
      reason: "symbol-mapping-degraded",
    });
  }

  if (input.missingFiles > 0) {
    tasks.push({
      id: "missing-input-files",
      title: "Validate missing review inputs",
      description:
        "Some explicitly requested files were missing on disk. Confirm paths and whether the intended change was a real deletion.",
      priority: "high",
      reason: "missing-files",
    });
  }

  return tasks;
}

function hasDiagnostics(diagnostics: ReviewDiagnostics): boolean {
  return (
    diagnostics.missingFiles.length > 0 ||
    diagnostics.symbolMappingParseFailures.length > 0
  );
}

function isExported(mod: { exports: ExportEntry[] }, handle: string): boolean {
  return mod.exports.some(
    (e) => e.type === "local" && symbolId(e.target) === handle,
  );
}

function listReviewableExports(mod: ModuleIndex): ReviewableExportEntry[] {
  return mod.exports.filter(
    (entry): entry is ReviewableExportEntry => entry.type !== "local",
  );
}

function exportSummaryHandle(
  file: string,
  entry: ReviewableExportEntry,
): string {
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
  return (
    trimmed.startsWith("export ") ||
    trimmed.startsWith("module.exports") ||
    trimmed.startsWith("exports.")
  );
}

function shouldIncludeExportSummaries(
  mod: ModuleIndex,
  hunks: Hunk[] | undefined,
  locals: readonly SymbolDef[],
): boolean {
  if (listReviewableExports(mod).length === 0) return false;
  if (!hunks) return true;
  if (locals.length === 0) return true;
  return hunks.some((hunk) => hunk.lines.some(diffLineLooksExportLike));
}

function buildExportSummaries(
  file: string,
  mod: ModuleIndex,
): ReviewSymbolSummary[] {
  return listReviewableExports(mod).map((entry) => ({
    name: exportSummaryName(entry),
    kind: exportSummaryKind(entry),
    handle: exportSummaryHandle(file, entry),
    exported: true,
  }));
}

function resolveReviewSpecifierTarget(fromFile: string, spec: string): string {
  const normalizedSpec = spec.replace(/\\/g, "/");
  const basePath = normalizeSpecifierBase(fromFile, normalizedSpec);
  const candidates = new Set<string>([basePath]);
  const specExt = path.extname(normalizedSpec);
  const fromExt = path.extname(fromFile);
  if (!specExt && fromExt) {
    candidates.add(`${basePath}${fromExt}`);
    candidates.add(normalizePath(path.join(basePath, `index${fromExt}`)));
  }
  if (specExt) {
    const baseWithoutExt = basePath.slice(0, -specExt.length);
    if (specExt === ".js") candidates.add(`${baseWithoutExt}.ts`);
    if (specExt === ".mjs") candidates.add(`${baseWithoutExt}.mts`);
    if (specExt === ".cjs") candidates.add(`${baseWithoutExt}.cts`);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return Array.from(candidates)[0] ?? basePath;
}

function edgeKey(edge: Edge): string {
  const toKey =
    edge.to.type === "file"
      ? `file:${edge.to.path}`
      : `external:${edge.to.name}`;
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${edge.from}|${toKey}|${edge.raw}|${typeOnly}`;
}

function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
  return {
    from: relativePath(projectRoot, edge.from),
    to:
      edge.to.type === "file"
        ? {
            type: "file",
            path: relativePath(projectRoot, edge.to.path),
          }
        : edge.to,
    raw: edge.raw,
    ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
  };
}

function collectDeletedImporterEdges(
  index: ProjectIndex,
  deletedFiles: readonly string[],
): Edge[] {
  if (deletedFiles.length === 0) return [];
  const deletedFileSet = new Set(deletedFiles.map((file) => normalizePath(file)));
  const edges = new Map<string, Edge>();
  for (const mod of index.byFile.values()) {
    for (const imp of mod.imports) {
      for (const deletedFile of deletedFileSet) {
        const matchesDeletedFile =
          typeof imp.resolved === "string"
            ? normalizePath(imp.resolved) === deletedFile
            : imp.from.startsWith(".") &&
              buildDeletedImportCandidates(mod.file, imp.from, deletedFile).has(
                deletedFile,
              );
        if (!matchesDeletedFile) continue;
        const edge: Edge = {
          from: mod.file,
          to: { type: "file", path: deletedFile },
          raw: imp.from,
          ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
        };
        edges.set(edgeKey(edge), edge);
      }
    }
  }
  return Array.from(edges.values());
}

function collectDeletedSnapshotEdges(
  deletedSnapshots: ReadonlyMap<FileId, DeletedFileSnapshot>,
): Edge[] {
  const edges = new Map<string, Edge>();
  for (const [file, snapshot] of deletedSnapshots.entries()) {
    for (const imp of snapshot.module.imports) {
      const to =
        typeof imp.resolved === "string"
          ? { type: "file" as const, path: normalizePath(imp.resolved) }
          : imp.resolved && "external" in imp.resolved
            ? { type: "external" as const, name: imp.resolved.external }
            : imp.from.startsWith(".")
              ? {
                  type: "file" as const,
                  path: resolveReviewSpecifierTarget(file, imp.from),
                }
              : { type: "external" as const, name: imp.from };
      const edge: Edge = {
        from: file,
        to,
        raw: imp.from,
        ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
      };
      edges.set(edgeKey(edge), edge);
    }
    for (const entry of listReviewableExports(snapshot.module)) {
      const to = entry.fromModule.startsWith(".")
        ? {
            type: "file" as const,
            path: resolveReviewSpecifierTarget(file, entry.fromModule),
          }
        : path.isAbsolute(entry.fromModule)
          ? {
              type: "file" as const,
              path: normalizePath(entry.fromModule),
            }
          : { type: "external" as const, name: entry.fromModule };
      const raw = entry.moduleSpecifier ?? entry.fromModule;
      const edge: Edge = {
        from: file,
        to,
        raw,
        ...(entry.typeOnly ? { typeOnly: entry.typeOnly } : {}),
      };
      edges.set(edgeKey(edge), edge);
    }
  }
  return Array.from(edges.values());
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

  const sortedChangedLines = [...changedLines].sort((a, b) => a - b);
  if (sortedChangedLines.length === 0) return [];

  const lines = source.split(/\r?\n/);
  const matching: number[] = [];
  for (const line of sortedChangedLines) {
    if (line >= startLine && line <= safeEnd) matching.push(line);
  }
  const matchingLines = matching.length > 0 ? matching : sortedChangedLines;

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
  return (
    left.start.line === right.start.line &&
    left.start.column === right.start.column
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const safeLimit = Math.max(1, limit);
  const runners = Array.from(
    { length: Math.min(safeLimit, items.length) },
    async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) break;
        const item = items[current]!;
        results[current] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// Review entry point: programmatic review report builder.
export async function buildReviewReport(
  projectRoot: string,
  opts: ReviewOptions = {},
): Promise<ReviewReport> {
  const appliedOptions = applyReviewPresetOptions(opts);
  const reviewReport = appliedOptions.report;
  const reviewTimings = reviewReport?.timings;
  const totalStart = performance.now();
  const normalizeFile = (file: string) =>
    normalizePath(resolveFilePathFromRoot(projectRoot, file));

  const changedFiles = new Set<string>();
  const explicitFiles = new Set<string>();
  const changesStart = performance.now();
  for (const file of appliedOptions.files ?? []) {
    const normalized = normalizeFile(file);
    changedFiles.add(normalized);
    explicitFiles.add(normalized);
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
  if (reviewTimings) {
    reviewTimings.changesMs = Math.round(performance.now() - changesStart);
  }

  if (changedFiles.size === 0) {
    const riskSummary = computeRiskSummary({
      filesChanged: 0,
      symbolsChanged: 0,
      exportedChanged: 0,
      missingFiles: 0,
      parseFailures: 0,
    });
    const projectFiles = await discoverProjectFiles(projectRoot);
    const report: ReviewReport = {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      status: "no_changes",
      projectFiles,
      summary: { filesChanged: 0, symbolsChanged: 0, candidateTests: 0 },
      riskSummary,
      reviewTasks: buildReviewTasks({
        filesChanged: 0,
        symbolsChanged: 0,
        exportedChanged: 0,
        candidateTests: 0,
        missingFiles: 0,
        parseFailures: 0,
      }),
      changedFiles: [],
      graphDelta: [],
      candidateTests: [],
    };
    if (appliedOptions.gitBase !== undefined)
      report.base = appliedOptions.gitBase;
    if (appliedOptions.gitHead !== undefined)
      report.head = appliedOptions.gitHead;
    if (reviewTimings)
      reviewTimings.totalMs = Math.round(performance.now() - totalStart);
    return report;
  }

  const changedFileList = Array.from(changedFiles).sort(comparePaths);
  const diagnostics: ReviewDiagnostics = {
    missingFiles: [],
    symbolMappingParseFailures: [],
  };
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
  const referenceConcurrency =
    typeof appliedOptions.referenceConcurrency === "number" &&
    appliedOptions.referenceConcurrency > 0
      ? appliedOptions.referenceConcurrency
      : 8;
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
  const existenceByFile = new Map(
    existenceChecks.map((entry) => [entry.file, entry.exists] as const),
  );
  const filesToIndex = existenceChecks
    .filter((entry) => entry.exists)
    .map((entry) => entry.file);
  const hasUnavailableChangedFiles = existenceChecks.some(
    (entry) => !entry.exists,
  );

  const diffStart = performance.now();
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
  if (reviewTimings) {
    reviewTimings.diffMs = Math.round(performance.now() - diffStart);
  }
  const diffHunksByFile = new Map<string, Hunk[]>();
  const diffKindsByFile = new Map<string, string>();
  const diffChangesByFile = new Map<string, FileChange>();
  if (diff) {
    for (const fileChange of diff.files) {
      const absPath = normalizePath(path.resolve(projectRoot, fileChange.path));
      diffHunksByFile.set(absPath, fileChange.hunks);
      diffKindsByFile.set(absPath, fileChange.kind);
      diffChangesByFile.set(absPath, fileChange);
    }
  }
  const deletedFiles = changedFileList.filter(
    (file) => diffKindsByFile.get(file) === "deleted",
  );
  const deletedSnapshots = await buildDeletedFileSnapshots(
    projectRoot,
    deletedFiles,
    {
      ...(appliedOptions.gitBase ?? appliedOptions.changedSince
        ? { revision: appliedOptions.gitBase ?? appliedOptions.changedSince }
        : {}),
      diffChangesByFile,
    },
  );

  const indexStart = performance.now();
  const indexReport =
    reviewReport?.indexReport ?? (reviewReport ? { timings: {} } : undefined);
  if (reviewReport && !reviewReport.indexReport && indexReport) {
    reviewReport.indexReport = indexReport;
  }
  const indexOpts: IncrementalBuildOptions = {
    ...(appliedOptions ?? {}),
    graph: graphOptions,
    ...(includeSymbolDetails && maxCallsites > 0 ? { keepParsed: true } : {}),
    ...(indexReport ? { report: indexReport } : {}),
  };
  if (!hasUnavailableChangedFiles) {
    indexOpts.files = filesToIndex;
  }
  const index = await buildProjectIndexIncremental(projectRoot, indexOpts);
  if (reviewTimings) {
    reviewTimings.indexMs = Math.round(performance.now() - indexStart);
  }

  const filesWithModules = changedFileList.map((file) => ({
    file,
    mod: index.byFile.get(file),
    hunks: diffHunksByFile.get(file),
  }));
  const includeDiffContext =
    appliedOptions.includeDiffContext ??
    (includeSymbolDetails && diffHunksByFile.size > 0);

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
      const { changedSymbols, changedLines, parseFailed } =
        await locateChangedSymbolsWithLines(index, file, hunks);
      if (parseFailed) {
        diagnostics.symbolMappingParseFailures.push(
          relativePath(projectRoot, file),
        );
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
        diffLinesByHandle: await mapChangedLinesToSymbols(
          index,
          file,
          hunks,
          changedLines,
        ),
        parseFailed,
      };
    }),
  );

  const defsToResolve = fileEntries.flatMap((entry) => entry.locals);
  const referencesStart = performance.now();
  const referenceResults =
    includeSymbolDetails && maxCallsites > 0
      ? await runWithConcurrency(
          defsToResolve,
          referenceConcurrency,
          async (def) => {
            const refs = await findReferences(
              index,
              { def },
              {
                maxReferences: maxCallsites + 1,
              },
            );
            return { def, refs };
          },
        )
      : [];
  if (reviewTimings) {
    reviewTimings.referencesMs = Math.round(
      performance.now() - referencesStart,
    );
  }
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
      async ({ file, mod, hunks, locals, handles, diffLinesByHandle }) => {
        const deletedSnapshot = deletedSnapshots.get(file);
        if (!mod && deletedSnapshot) {
          const deletedLocals = sortSymbols(deletedSnapshot.module.locals);
          const localSymbols: ReviewSymbolSummary[] = includeSymbolDetails
            ? deletedLocals.map((local) => {
                const handle = symbolId(local);
                const definitionSnippet = rangeSnippet(
                  deletedSnapshot.source,
                  local.range,
                );
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
          const isMissingExplicitInput =
            !fileExistsOnDisk && explicitFiles.has(file) && !isDeletedByDiff;
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
        const exportSymbols = shouldIncludeExportSummaries(mod, hunks, locals)
          ? buildExportSummaries(file, mod)
          : [];
        const symbols = [...localSymbols, ...exportSymbols];
        return {
          summary: {
            file: relativePath(projectRoot, file),
            status: "updated",
            symbols,
          } satisfies ReviewFileSummary,
          handles: [...handles, ...exportSymbols.map((symbol) => symbol.handle)],
        };
      },
    ),
  );
  const summaries = summariesWithHandles.map((entry) => entry.summary);
  const changedSymbolIds = summariesWithHandles.flatMap(
    (entry) => entry.handles,
  );
  const exportedChangedCount = summaries.reduce((count, summary) => {
    const exportedInFile = summary.symbols.filter((symbol) => symbol.exported);
    return count + exportedInFile.length;
  }, 0);

  const graphEdges = new Map<string, Edge>();
  for (const edge of index.graph.edges.filter((entry) => changedFiles.has(entry.from))) {
    const relativeEdge = toRelativeEdge(projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  for (const edge of collectDeletedImporterEdges(index, deletedFiles)) {
    const relativeEdge = toRelativeEdge(projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  for (const edge of collectDeletedSnapshotEdges(deletedSnapshots)) {
    const relativeEdge = toRelativeEdge(projectRoot, edge);
    graphEdges.set(edgeKey(relativeEdge), relativeEdge);
  }
  const graphDelta = Array.from(graphEdges.values()).sort(compareEdges);

  const candidateStart = performance.now();
  const candidateTests = mergeCandidateTestEntries(
    listCandidateTestFiles(index, changedFileList, changedSymbolIds, {
      maxCandidates: appliedOptions.maxCandidates ?? 50,
      ...(appliedOptions.testPatterns
        ? { testPatterns: appliedOptions.testPatterns }
        : {}),
    }),
    listDirectDeletedFileTestImporters(
      index,
      deletedFiles,
      appliedOptions.testPatterns,
    ),
  )
    .map((candidate) => ({
      ...candidate,
      file: relativePath(projectRoot, candidate.file),
    }))
    .sort((left, right) => {
      const confidenceCompare =
        confidenceRank(right.confidence) - confidenceRank(left.confidence);
      if (confidenceCompare !== 0) return confidenceCompare;
      const fileCompare = comparePaths(left.file, right.file);
      if (fileCompare !== 0) return fileCompare;
      return left.reason.localeCompare(right.reason);
    })
    .slice(0, appliedOptions.maxCandidates ?? 50);
  if (reviewTimings) {
    reviewTimings.candidatesMs = Math.round(performance.now() - candidateStart);
  }

  const projectFiles =
    index.projectFiles ?? (await discoverProjectFiles(projectRoot));
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: "ok",
    projectFiles,
    summary: {
      filesChanged: summaries.length,
      symbolsChanged: changedSymbolIds.length,
      candidateTests: candidateTests.length,
    },
    riskSummary: computeRiskSummary({
      filesChanged: summaries.length,
      symbolsChanged: changedSymbolIds.length,
      exportedChanged: exportedChangedCount,
      missingFiles: diagnostics.missingFiles.length,
      parseFailures: diagnostics.symbolMappingParseFailures.length,
    }),
    reviewTasks: buildReviewTasks({
      filesChanged: summaries.length,
      symbolsChanged: changedSymbolIds.length,
      exportedChanged: exportedChangedCount,
      candidateTests: candidateTests.length,
      missingFiles: diagnostics.missingFiles.length,
      parseFailures: diagnostics.symbolMappingParseFailures.length,
    }),
    changedFiles: summaries,
    graphDelta,
    candidateTests,
    ...(hasDiagnostics(diagnostics) ? { diagnostics } : {}),
  };
  if (appliedOptions.gitBase !== undefined)
    report.base = appliedOptions.gitBase;
  report.head = appliedOptions.gitHead ?? "HEAD";
  if (reviewTimings)
    reviewTimings.totalMs = Math.round(performance.now() - totalStart);
  return report;
}
