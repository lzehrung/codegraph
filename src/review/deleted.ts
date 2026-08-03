import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CandidateTestFile } from "../impact/context.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "../impact/testPatterns.js";
import type { FileChange } from "../impact/types.js";
import { collectImportsForFile } from "../indexer/imports.js";
import { collectLocalsAndExportsFromSource } from "../indexer/locals-and-exports.js";
import { type ExportEntry, type ImportBinding, type ModuleIndex, type ProjectIndex } from "../indexer/types.js";
import { supportForFile } from "../languages.js";
import type { Edge, FileId } from "../types.js";
import { edgeKey, toRelativeEdge } from "../util/graphEdges.js";
import { listResolutionCandidates, loadNearestTsconfigFor } from "../util/resolution.js";
import {
  listWorkspacePackageResolutionCandidates,
  loadWorkspaceConfig,
  type WorkspaceConfig,
} from "../util/workspace.js";
import { normalizePath } from "../util/paths.js";
import { assertSafeRevision } from "../util/git.js";
import type { GraphBuildOptions } from "../graphs/types.js";
const UNSAFE_BATCH_REQUEST_CHARACTERS = /[\0\r\n]/;
const MAX_GIT_BATCH_OUTPUT_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_GIT_BATCH_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_BATCH_STDERR_CHARACTERS = 64 * 1024;

export type DeletedFileSnapshot = {
  source: string;
  module: ModuleIndex;
};

type ReviewableExportEntry = Exclude<ExportEntry, { type: "local" }>;

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

async function readGitFilesAtRevision(
  projectRoot: string,
  revision: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const safeRevision = assertSafeRevision(revision, "revision");
  const requests: { file: string; object: string }[] = [];
  for (const file of files) {
    const relativeFile = normalizePath(path.relative(projectRoot, file));
    if (!relativeFile || relativeFile.startsWith("..") || UNSAFE_BATCH_REQUEST_CHARACTERS.test(relativeFile)) continue;
    requests.push({ file, object: `${safeRevision}:${relativeFile}` });
  }
  if (!requests.length) return new Map();
  const maxOutputBytes = Math.min(MAX_GIT_BATCH_OUTPUT_BYTES_PER_FILE * requests.length, MAX_GIT_BATCH_OUTPUT_BYTES);

  try {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: projectRoot });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error(`git cat-file output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const remaining = MAX_GIT_BATCH_STDERR_CHARACTERS - stderr.length;
      if (remaining > 0) stderr += chunk.slice(0, remaining);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`git cat-file failed with code ${code}: ${stderr}`));
        return;
      }
      settled = true;
      resolve(Buffer.concat(stdoutChunks, stdoutBytes));
    });
    child.stdin.end(`${requests.map((request) => request.object).join("\n")}\n`);
    const output = await promise;

    const sources = new Map<string, string>();
    let cursor = 0;
    for (const request of requests) {
      const headerEnd = output.indexOf(0x0a, cursor);
      if (headerEnd < 0) return new Map();
      const header = output.subarray(cursor, headerEnd).toString("utf8").replace(/\r$/, "");
      cursor = headerEnd + 1;
      if (header.endsWith(" missing")) continue;
      const sizeMatch = header.match(/^[0-9a-f]+ blob ([0-9]+)$/);
      if (!sizeMatch) return new Map();
      const size = Number(sizeMatch[1]);
      if (!Number.isSafeInteger(size) || size > MAX_GIT_BATCH_OUTPUT_BYTES_PER_FILE) return new Map();
      const contentEnd = cursor + size;
      if (!Number.isSafeInteger(contentEnd) || contentEnd > output.length) return new Map();
      sources.set(request.file, output.subarray(cursor, contentEnd).toString("utf8"));
      cursor = contentEnd;
      if (output[cursor] === 0x0a) cursor++;
    }
    return sources;
  } catch {
    return new Map();
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
  const revisionSources = opts.revision
    ? await readGitFilesAtRevision(projectRoot, opts.revision, deletedFiles)
    : new Map<string, string>();

  for (const file of deletedFiles) {
    const support = supportForFile(file);
    if (!support) continue;
    const source = revisionSources.get(file) ?? reconstructDeletedSourceFromDiff(opts.diffChangesByFile?.get(file));
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
