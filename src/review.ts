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
  collectImportsForFile,
  collectLocalsAndExportsFromSource,
  type ExportEntry,
  findReferences,
  type ImportBinding,
  type IncrementalBuildOptions,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
  symbolId,
} from "./indexer.js";
import { isSymbolHandleExported } from "./indexer/declarations.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import { locateChangedSymbolsWithLines, mapChangedLinesToSymbols } from "./impact/map.js";
import { parseUnifiedDiff } from "./impact/parse.js";
import { createImpactIgnoreMatcher } from "./impact/path.js";
import type { FileChange, Hunk } from "./impact/types.js";
import { listCandidateTestFiles, type CandidateTestFile } from "./impact/context.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./impact/testPatterns.js";
import {
  assertFilePathWithinRoot,
  normalizePath,
  listChangedFiles,
  fileExists,
  getUnifiedDiff,
  discoverProjectFiles,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  listResolutionCandidates,
  listWorkspacePackageResolutionCandidates,
  toProjectRelativePath,
  type ProjectFileInfo,
  type WorkspaceConfig,
} from "./util.js";
import { supportForFile } from "./languages.js";
import { collectSqlReviewContext, type SqlReviewContext } from "./sql/review.js";

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

/**
 * Structured review bundle for downstream review agents.
 *
 * This is the programmatic counterpart to CLI review output. It keeps risk,
 * tasks, changed symbols, graph deltas, candidate tests, diagnostics, and
 * snippets as data so callers can build deterministic file packs or prompts.
 */
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
  sqlContext?: SqlReviewContext;
  diagnostics?: ReviewDiagnostics;
};

/**
 * Options for `buildReviewReport()`.
 *
 * Most review agents use a git range (`gitBase`/`gitHead`) or `diffText`, choose
 * a `reviewDepth`, and preserve the returned structured fields instead of
 * re-parsing terminal summaries.
 */
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
    includeSymbolDetails: opts.includeSymbolDetails ?? preset.includeSymbolDetails,
    maxCallsites: opts.maxCallsites ?? preset.maxCallsites,
    maxCandidates: opts.maxCandidates ?? preset.maxCandidates,
    ...(mergedGraph ? { graph: mergedGraph } : {}),
  };
}

function relativePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(file);
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
    if (confidenceRank(candidate.confidence) > confidenceRank(existing.confidence)) {
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

function buildDeletedImportCandidates(fromFile: string, spec: string, targetFile: string): Set<string> {
  const normalizedSpec = spec.replace(/\\/g, "/");
  const basePath = normalizeSpecifierBase(fromFile, normalizedSpec);
  const resolutionExtensions = deletedImportResolutionExtensions(targetFile);
  const candidates = listResolutionCandidates(basePath, resolutionExtensions).map((candidate) =>
    normalizePath(candidate),
  );
  return new Set(candidates);
}

function matchesDeletedImportTarget(
  fromFile: string,
  spec: string,
  resolved: string | undefined,
  deletedFile: string,
): boolean {
  if (resolved && normalizePath(resolved) === deletedFile) {
    return true;
  }
  if (!spec.startsWith(".")) {
    return false;
  }
  return buildDeletedImportCandidates(fromFile, spec, deletedFile).has(deletedFile);
}

function getImportResolvedPath(entry: Pick<ImportBinding, "resolved">): string | undefined {
  return typeof entry.resolved === "string" ? entry.resolved : undefined;
}

function buildDeletedAliasCandidates(candidate: string, targetFile: string): Set<string> {
  const normalizedCandidate = normalizePath(candidate);
  const resolutionExtensions = deletedImportResolutionExtensions(targetFile);
  const resolutionCandidates = listResolutionCandidates(normalizedCandidate, resolutionExtensions);
  const resolvedCandidates = resolutionCandidates.map((resolvedCandidate) => normalizePath(resolvedCandidate));
  return new Set(resolvedCandidates);
}

function deletedImportResolutionExtensions(targetFile: string): string[] {
  const targetExt = path.extname(targetFile);
  return targetExt ? [targetExt] : [];
}

async function resolveDeletedAliasImportTarget(
  projectRoot: string | undefined,
  workspaceConfig: WorkspaceConfig | undefined,
  fromFile: string,
  spec: string,
  deletedFile: string,
): Promise<string | undefined> {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) {
    return undefined;
  }
  const deletedTarget = normalizePath(deletedFile);
  const resolutionExtensions = deletedImportResolutionExtensions(deletedFile);
  const { matchPath } = await loadNearestTsconfigFor(fromFile);
  if (matchPath) {
    const matched = matchPath(
      spec,
      undefined,
      (candidate) => buildDeletedAliasCandidates(candidate, deletedFile).has(deletedTarget),
      resolutionExtensions,
    );
    if (matched) {
      const resolvedMatch = Array.from(buildDeletedAliasCandidates(matched, deletedFile)).find(
        (candidate) => candidate === deletedTarget,
      );
      if (resolvedMatch) {
        return resolvedMatch;
      }
    }
  }

  if (!projectRoot) {
    return undefined;
  }

  return listWorkspacePackageResolutionCandidates(spec, workspaceConfig, resolutionExtensions)
    .map((candidate) => normalizePath(candidate))
    .find((candidate) => candidate === deletedTarget);
}

async function listDirectDeletedFileTestImporters(
  index: ProjectIndex,
  deletedFiles: readonly string[],
  testPatterns: string[] = [],
  projectRoot?: string,
): Promise<CandidateTestFile[]> {
  if (!deletedFiles.length) return [];

  const deletedFileSet = new Set(deletedFiles.map((file) => normalizePath(file)));
  const compiledPatterns = compileTestPatterns(testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, compiledPatterns, projectRoot);
  const candidates = new Map<FileId, CandidateTestFile>();
  const importsByFile = new Map<FileId, Array<{ spec: string; resolved?: string }>>();
  const workspaceConfig = projectRoot ? await loadWorkspaceConfig(projectRoot) : undefined;

  for (const edge of index.graph.edges) {
    let imports = importsByFile.get(edge.from);
    if (!imports) {
      imports = [];
      importsByFile.set(edge.from, imports);
    }
    imports.push({
      spec: edge.raw,
      ...(edge.to.type === "file" ? { resolved: edge.to.path } : {}),
    });
  }

  for (const mod of index.byFile.values()) {
    if (!isIndexTestFile(mod.file)) continue;
    const uniqueImports = new Map<string, { spec: string; resolved?: string }>();
    for (const entry of importsByFile.get(mod.file) ?? []) {
      uniqueImports.set(`${entry.spec}::${entry.resolved ?? ""}`, entry);
    }
    for (const imp of mod.imports) {
      const resolved = getImportResolvedPath(imp);
      uniqueImports.set(`${imp.from}::${resolved ?? ""}`, {
        spec: imp.from,
        ...(resolved ? { resolved } : {}),
      });
    }
    for (const entry of uniqueImports.values()) {
      for (const deletedFile of deletedFileSet) {
        const resolvedImportPath = entry.resolved ? normalizePath(entry.resolved) : undefined;
        const resolvedAliasTarget =
          resolvedImportPath === deletedFile
            ? resolvedImportPath
            : await resolveDeletedAliasImportTarget(projectRoot, workspaceConfig, mod.file, entry.spec, deletedFile);
        if (!matchesDeletedImportTarget(mod.file, entry.spec, resolvedAliasTarget, deletedFile)) {
          continue;
        }
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
async function readGitFileAtRevision(projectRoot: string, revision: string, file: string): Promise<string | null> {
  const relativeFile = normalizePath(path.relative(projectRoot, file));
  if (!relativeFile || relativeFile.startsWith("..")) return null;
  try {
    const { stdout } = await execFileAsync("git", ["show", `${revision}:${relativeFile}`], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
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
    graphOptions?: GraphBuildOptions;
  },
): Promise<Map<FileId, DeletedFileSnapshot>> {
  const snapshots = new Map<FileId, DeletedFileSnapshot>();
  if (!deletedFiles.length) return snapshots;

  for (const file of deletedFiles) {
    const support = supportForFile(file);
    if (!support) continue;
    const source =
      (opts.revision ? await readGitFileAtRevision(projectRoot, opts.revision, file) : null) ??
      reconstructDeletedSourceFromDiff(opts.diffChangesByFile?.get(file));
    if (source === null) continue;
    const normalizedFile = normalizePath(file);
    const imports = await collectImportsForFile(normalizedFile, projectRoot, {
      source,
      sup: support,
      ...(opts.graphOptions ? { graphOptions: opts.graphOptions } : {}),
    });
    const module = collectLocalsAndExportsFromSource(normalizedFile, source, support, undefined, imports);
    snapshots.set(normalizedFile, {
      source,
      module,
    });
  }

  return snapshots;
}

function reconstructDeletedSourceFromDiff(change: FileChange | undefined): string | null {
  if (!change || change.kind !== "deleted" || !change.hunks.length) {
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
  return oldLines.length ? oldLines.join("\n") : null;
}

function sortSymbols(symbols: SymbolDef[]): SymbolDef[] {
  return symbols.slice().sort((left, right) => symbolId(left).localeCompare(symbolId(right)));
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
      description: "Scan the changed symbols and confirm behavioral changes align with intent.",
      priority: "medium",
      reason: "baseline-review",
    },
  ];

  if (input.exportedChanged > 0) {
    tasks.push({
      id: "api-compat",
      title: "Verify API compatibility",
      description: "Check exported symbols for breaking changes, migration notes, and versioning implications.",
      priority: "high",
      reason: "exported-symbols-changed",
    });
  }

  if (input.candidateTests === 0) {
    tasks.push({
      id: "tests-missing",
      title: "Validate test coverage",
      description: "No candidate tests were detected. Confirm existing coverage or add targeted tests.",
      priority: "medium",
      reason: "no-candidate-tests",
    });
  }

  if (input.filesChanged >= 10 || input.symbolsChanged >= 20) {
    tasks.push({
      id: "high-change-volume",
      title: "Assess change scope",
      description: "Large change set detected. Double-check impacted files and coordination needs.",
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
  return !!(diagnostics.missingFiles.length || diagnostics.symbolMappingParseFailures.length);
}

function isRiskRelevantSymbolMappingFile(file: string): boolean {
  return supportForFile(file)?.supportsCrossModuleSymbols ?? false;
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

function resolveReviewSpecifierTarget(fromFile: string, spec: string, knownDeletedFiles?: ReadonlySet<FileId>): string {
  const normalizedSpec = spec.replace(/\\/g, "/");
  const basePath = normalizeSpecifierBase(fromFile, normalizedSpec);
  const candidates = listResolutionCandidates(basePath).map((candidate) => normalizePath(candidate));
  if (knownDeletedFiles) {
    for (const candidate of candidates) {
      if (knownDeletedFiles.has(candidate)) return candidate;
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? basePath;
}

async function resolveDeletedSnapshotBareTarget(
  projectRoot: string | undefined,
  workspaceConfig: WorkspaceConfig | undefined,
  fromFile: string,
  spec: string,
  knownDeletedFiles: readonly FileId[],
): Promise<string | undefined> {
  for (const deletedFile of knownDeletedFiles) {
    const resolved = await resolveDeletedAliasImportTarget(projectRoot, workspaceConfig, fromFile, spec, deletedFile);
    if (resolved === deletedFile) {
      return deletedFile;
    }
  }
  return undefined;
}

async function resolveDeletedSnapshotTarget(input: {
  projectRoot: string | undefined;
  workspaceConfig: WorkspaceConfig | undefined;
  fromFile: string;
  spec: string;
  knownDeletedFiles: readonly FileId[];
  knownDeletedFileSet: ReadonlySet<FileId>;
  resolved?: FileId | { external: string };
}): Promise<{ type: "file"; path: string } | { type: "external"; name: string }> {
  const { projectRoot, workspaceConfig, fromFile, spec, knownDeletedFiles, knownDeletedFileSet, resolved } = input;

  if (typeof resolved === "string") {
    const normalizedResolved = normalizePath(resolved);
    if (knownDeletedFileSet.has(normalizedResolved)) {
      return { type: "file", path: normalizedResolved };
    }
  }

  if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) {
    const targetPath = spec.startsWith(".")
      ? resolveReviewSpecifierTarget(fromFile, spec, knownDeletedFileSet)
      : normalizePath(spec);
    return { type: "file", path: targetPath };
  }

  const resolvedDeletedTarget = await resolveDeletedSnapshotBareTarget(
    projectRoot,
    workspaceConfig,
    fromFile,
    spec,
    knownDeletedFiles,
  );
  if (resolvedDeletedTarget) {
    return { type: "file", path: resolvedDeletedTarget };
  }

  if (typeof resolved === "string") {
    return { type: "file", path: normalizePath(resolved) };
  }

  if (resolved && "external" in resolved) {
    return { type: "external", name: resolved.external };
  }

  return { type: "external", name: spec };
}

function edgeKey(edge: Edge): string {
  const toKey = edge.to.type === "file" ? `file:${edge.to.path}` : `external:${edge.to.name}`;
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

async function collectDeletedImporterEdges(
  index: ProjectIndex,
  deletedFiles: readonly string[],
  projectRoot?: string,
): Promise<Edge[]> {
  if (!deletedFiles.length) return [];
  const deletedFileSet = new Set(deletedFiles.map((file) => normalizePath(file)));
  const edges = new Map<string, Edge>();
  const workspaceConfig = projectRoot ? await loadWorkspaceConfig(projectRoot) : undefined;
  for (const mod of index.byFile.values()) {
    for (const imp of mod.imports) {
      for (const deletedFile of deletedFileSet) {
        const resolvedImportPath = getImportResolvedPath(imp);
        const normalizedResolvedImportPath = resolvedImportPath ? normalizePath(resolvedImportPath) : undefined;
        const resolvedAliasTarget =
          normalizedResolvedImportPath === deletedFile
            ? normalizedResolvedImportPath
            : await resolveDeletedAliasImportTarget(projectRoot, workspaceConfig, mod.file, imp.from, deletedFile);
        const matchesDeletedFile = matchesDeletedImportTarget(mod.file, imp.from, resolvedAliasTarget, deletedFile);
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

async function collectDeletedSnapshotEdges(
  deletedSnapshots: ReadonlyMap<FileId, DeletedFileSnapshot>,
  projectRoot?: string,
): Promise<Edge[]> {
  const edges = new Map<string, Edge>();
  const deletedSnapshotFiles = Array.from(deletedSnapshots.keys());
  const deletedSnapshotFileSet = new Set(deletedSnapshotFiles);
  const workspaceConfig = projectRoot ? await loadWorkspaceConfig(projectRoot) : undefined;
  for (const [file, snapshot] of deletedSnapshots.entries()) {
    for (const imp of snapshot.module.imports) {
      const to = await resolveDeletedSnapshotTarget({
        projectRoot,
        workspaceConfig,
        fromFile: file,
        spec: imp.from,
        knownDeletedFiles: deletedSnapshotFiles,
        knownDeletedFileSet: deletedSnapshotFileSet,
        ...(imp.resolved ? { resolved: imp.resolved } : {}),
      });
      const edge: Edge = {
        from: file,
        to,
        raw: imp.from,
        ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
      };
      edges.set(edgeKey(edge), edge);
    }
    for (const entry of listReviewableExports(snapshot.module)) {
      const to = await resolveDeletedSnapshotTarget({
        projectRoot,
        workspaceConfig,
        fromFile: file,
        spec: entry.fromModule,
        knownDeletedFiles: deletedSnapshotFiles,
        knownDeletedFileSet: deletedSnapshotFileSet,
      });
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

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const safeLimit = Math.max(1, limit);
  const runners = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) break;
      const item = items[current]!;
      results[current] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

type ReviewChangeCollection = {
  changedFiles: Set<string>;
  explicitFiles: Set<string>;
  diffHunksByFile: Map<string, Hunk[]>;
  diffKindsByFile: Map<string, string>;
  diffChangesByFile: Map<string, FileChange>;
};

async function collectReviewChanges(
  projectRoot: string,
  appliedOptions: ReviewOptions,
  reviewTimings?: ReviewTimingReport,
): Promise<ReviewChangeCollection> {
  const normalizeFile = (file: string, label: string) => assertFilePathWithinRoot(projectRoot, file, label);
  const discoveryIgnoreGlobs = appliedOptions.discovery?.ignoreGlobs ?? [];
  const discoveryGlobRoot = appliedOptions.discovery?.globRoot ?? projectRoot;
  const isIgnoredReviewFile = createImpactIgnoreMatcher(discoveryGlobRoot, discoveryIgnoreGlobs);

  const changedFiles = new Set<string>();
  const explicitFiles = new Set<string>();
  const changesStart = performance.now();
  for (const file of appliedOptions.files ?? []) {
    const normalized = normalizeFile(file, "Review file");
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
    for (const file of gitList) {
      if (!isIgnoredReviewFile(file)) changedFiles.add(file);
    }
  }
  if (reviewTimings) {
    reviewTimings.changesMs = Math.round(performance.now() - changesStart);
  }

  const diffStart = performance.now();
  const shouldLoadGitDiff = (appliedOptions.gitBase || appliedOptions.changedSince) && changedFiles.size;
  const diffText =
    appliedOptions.diffText ??
    (shouldLoadGitDiff
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
      const absPath = normalizeFile(fileChange.path, "Review diff file");
      const normalizedChange: FileChange = {
        ...fileChange,
        path: absPath,
        ...(fileChange.oldPath
          ? {
              oldPath: normalizeFile(fileChange.oldPath, "Review old diff file"),
            }
          : {}),
      };
      if (isIgnoredReviewFile(absPath)) {
        changedFiles.delete(absPath);
        continue;
      }
      changedFiles.add(absPath);
      diffHunksByFile.set(absPath, normalizedChange.hunks);
      diffKindsByFile.set(absPath, normalizedChange.kind);
      diffChangesByFile.set(absPath, normalizedChange);
    }
  }

  return {
    changedFiles,
    explicitFiles,
    diffHunksByFile,
    diffKindsByFile,
    diffChangesByFile,
  };
}

type ReviewIndexStage = {
  index: ProjectIndex;
  existenceByFile: Map<string, boolean>;
  deletedFiles: string[];
  deletedSnapshots: Map<FileId, DeletedFileSnapshot>;
  graphOptions: GraphBuildOptions;
};

async function buildReviewIndex(input: {
  projectRoot: string;
  appliedOptions: ReviewOptions;
  changedFileList: string[];
  diffKindsByFile: ReadonlyMap<string, string>;
  diffChangesByFile: ReadonlyMap<string, FileChange>;
  includeSymbolDetails: boolean;
  maxCallsites: number;
  reviewReport?: ReviewBuildReport;
  reviewTimings?: ReviewTimingReport;
}): Promise<ReviewIndexStage> {
  const {
    projectRoot,
    appliedOptions,
    changedFileList,
    diffKindsByFile,
    diffChangesByFile,
    includeSymbolDetails,
    maxCallsites,
    reviewReport,
    reviewTimings,
  } = input;
  const fastGraphRequested = appliedOptions.graph?.fast ?? false;
  const graphOptions = appliedOptions.graph ? { ...appliedOptions.graph, fast: fastGraphRequested } : { fast: false };
  const existenceChecks = await Promise.all(
    changedFileList.map(async (file) => ({
      file,
      exists: await fileExists(file),
    })),
  );
  const existenceByFile = new Map(existenceChecks.map((entry) => [entry.file, entry.exists] as const));
  const filesToIndex = existenceChecks.filter((entry) => entry.exists).map((entry) => entry.file);
  const hasUnavailableChangedFiles = existenceChecks.some((entry) => !entry.exists);
  const deletedFiles = changedFileList.filter((file) => diffKindsByFile.get(file) === "deleted");
  const deletedSnapshots = await buildDeletedFileSnapshots(projectRoot, deletedFiles, {
    ...((appliedOptions.gitBase ?? appliedOptions.changedSince)
      ? { revision: appliedOptions.gitBase ?? appliedOptions.changedSince }
      : {}),
    diffChangesByFile,
    graphOptions,
  });

  const indexStart = performance.now();
  const indexReport = reviewReport?.indexReport ?? (reviewReport ? { timings: {} } : undefined);
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

  return {
    index,
    existenceByFile,
    deletedFiles,
    deletedSnapshots,
    graphOptions,
  };
}

async function collectReviewGraphDelta(input: {
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

async function collectReviewCandidateTests(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFileList: string[];
  changedSymbolIds: string[];
  deletedFiles: readonly string[];
  appliedOptions: ReviewOptions;
  reviewTimings?: ReviewTimingReport;
}): Promise<CandidateTestFile[]> {
  const candidateStart = performance.now();
  const candidateTests = mergeCandidateTestEntries(
    listCandidateTestFiles(input.index, input.changedFileList, input.changedSymbolIds, {
      maxCandidates: input.appliedOptions.maxCandidates ?? 50,
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
    .slice(0, input.appliedOptions.maxCandidates ?? 50);
  if (input.reviewTimings) {
    input.reviewTimings.candidatesMs = Math.round(performance.now() - candidateStart);
  }
  return candidateTests;
}

async function collectReviewSqlContext(input: {
  projectRoot: string;
  index: ProjectIndex;
  changedFileList: string[];
}): Promise<SqlReviewContext | undefined> {
  const indexedFiles = Array.from(input.index.byFile.keys());
  const normalizedChangedFiles = new Set(input.changedFileList.map(normalizePath));
  const indexedFilesCoverMoreThanReviewSet = indexedFiles.some((file) => !normalizedChangedFiles.has(normalizePath(file)));
  const sqlContextProjectFiles =
    indexedFilesCoverMoreThanReviewSet && indexedFiles.some((file) => path.extname(file).toLowerCase() === ".sql")
      ? indexedFiles
      : undefined;
  return await collectSqlReviewContext(input.projectRoot, {
    changedFiles: input.changedFileList,
    ...(sqlContextProjectFiles ? { projectFiles: sqlContextProjectFiles } : {}),
  });
}

function assembleReviewReport(input: {
  appliedOptions: ReviewOptions;
  projectFiles: ProjectFileInfo[];
  summaries: ReviewFileSummary[];
  changedSymbolIds: string[];
  candidateTests: CandidateTestFile[];
  graphDelta: Edge[];
  sqlContext?: SqlReviewContext;
  diagnostics: ReviewDiagnostics;
  riskRelevantParseFailures: number;
  exportedChangedCount: number;
}): ReviewReport {
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: "ok",
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

type ReviewChangedFileSummaries = {
  summaries: ReviewFileSummary[];
  changedSymbolIds: string[];
  exportedChangedCount: number;
  riskRelevantParseFailures: number;
};

async function summarizeChangedFiles(input: {
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
      ? await runWithConcurrency(defsToResolve, referenceConcurrency, async (def) => {
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
      includeDiffContext && diffLines.size
        ? collectDiffSnippets(source, local.range, diffLines, diffContextLines)
        : [];

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

/**
 * Build the structured review report used by programmatic review agents.
 *
 * The report keeps changed files, changed symbols, graph deltas, candidate tests,
 * risk signals, review tasks, diagnostics, and optional snippets as data instead
 * of terminal prose. Prefer this API over CLI summary output when composing
 * deterministic model context or review file packs.
 */
export async function buildReviewReport(projectRoot: string, opts: ReviewOptions = {}): Promise<ReviewReport> {
  const appliedOptions = applyReviewPresetOptions(opts);
  const reviewReport = appliedOptions.report;
  const reviewTimings = reviewReport?.timings;
  const totalStart = performance.now();
  const { changedFiles, explicitFiles, diffHunksByFile, diffKindsByFile, diffChangesByFile } =
    await collectReviewChanges(projectRoot, appliedOptions, reviewTimings);

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
    if (appliedOptions.gitBase !== undefined) report.base = appliedOptions.gitBase;
    if (appliedOptions.gitHead !== undefined) report.head = appliedOptions.gitHead;
    if (reviewTimings) reviewTimings.totalMs = Math.round(performance.now() - totalStart);
    return report;
  }

  const changedFileList = Array.from(changedFiles).sort(comparePaths);
  const diagnostics: ReviewDiagnostics = {
    missingFiles: [],
    symbolMappingParseFailures: [],
  };
  const includeSymbolDetails = appliedOptions.includeSymbolDetails ?? false;
  const diffContextLines =
    typeof appliedOptions.diffContextLines === "number" && appliedOptions.diffContextLines >= 0
      ? appliedOptions.diffContextLines
      : 2;
  const maxCallsites =
    typeof appliedOptions.maxCallsites === "number" && appliedOptions.maxCallsites >= 0
      ? appliedOptions.maxCallsites
      : 5;
  const referenceConcurrency =
    typeof appliedOptions.referenceConcurrency === "number" && appliedOptions.referenceConcurrency > 0
      ? appliedOptions.referenceConcurrency
      : 8;
  const { index, existenceByFile, deletedFiles, deletedSnapshots } = await buildReviewIndex({
    projectRoot,
    appliedOptions,
    changedFileList,
    diffKindsByFile,
    diffChangesByFile,
    includeSymbolDetails,
    maxCallsites,
    ...(reviewReport ? { reviewReport } : {}),
    ...(reviewTimings ? { reviewTimings } : {}),
  });
  const includeDiffContext = appliedOptions.includeDiffContext ?? (includeSymbolDetails && diffHunksByFile.size > 0);

  const { summaries, changedSymbolIds, exportedChangedCount, riskRelevantParseFailures } = await summarizeChangedFiles({
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
    ...(reviewTimings ? { reviewTimings } : {}),
  });

  const graphDelta = await collectReviewGraphDelta({
    projectRoot,
    index,
    changedFiles,
    deletedFiles,
    deletedSnapshots,
  });

  const candidateTests = await collectReviewCandidateTests({
    projectRoot,
    index,
    changedFileList,
    changedSymbolIds,
    deletedFiles,
    appliedOptions,
    ...(reviewTimings ? { reviewTimings } : {}),
  });

  const projectFiles = index.projectFiles ?? (await discoverProjectFiles(projectRoot));
  const sqlContext = await collectReviewSqlContext({ projectRoot, index, changedFileList });
  const report = assembleReviewReport({
    appliedOptions,
    projectFiles,
    summaries,
    changedSymbolIds,
    candidateTests,
    graphDelta,
    ...(sqlContext ? { sqlContext } : {}),
    diagnostics,
    riskRelevantParseFailures,
    exportedChangedCount,
  });
  if (reviewTimings) reviewTimings.totalMs = Math.round(performance.now() - totalStart);
  return report;
}
