import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CandidateTestFile } from "../impact/context.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "../impact/testPatterns.js";
import type { FileChange } from "../impact/types.js";
import { collectImportsForFile } from "../indexer/imports.js";
import { collectLocalsAndExportsFromSource } from "../indexer/locals-and-exports.js";
import { type ExportEntry, type ImportBinding, type ModuleIndex, type ProjectIndex } from "../indexer/types.js";
import { supportForFile } from "../languages.js";
import type { Edge, FileId } from "../types.js";
import { listResolutionCandidates, loadNearestTsconfigFor } from "../util/resolution.js";
import {
  listWorkspacePackageResolutionCandidates,
  loadWorkspaceConfig,
  type WorkspaceConfig,
} from "../util/workspace.js";
import { normalizePath, toProjectRelativePath } from "../util/paths.js";
import type { GraphBuildOptions } from "../graphs/types.js";

const execFileAsync = promisify(execFile);

export type DeletedFileSnapshot = {
  source: string;
  module: ModuleIndex;
};

type ReviewableExportEntry = Exclude<ExportEntry, { type: "local" }>;

function relativePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(file);
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

export async function listDirectDeletedFileTestImporters(
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

export async function buildDeletedFileSnapshots(
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

export function edgeKey(edge: Edge): string {
  const toKey = edge.to.type === "file" ? `file:${edge.to.path}` : `external:${edge.to.name}`;
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${edge.from}|${toKey}|${edge.raw}|${typeOnly}`;
}

export function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
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

export async function collectDeletedImporterEdges(
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

function listReviewableExports(mod: ModuleIndex): ReviewableExportEntry[] {
  return mod.exports.filter((entry): entry is ReviewableExportEntry => entry.type !== "local");
}

export async function collectDeletedSnapshotEdges(
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
