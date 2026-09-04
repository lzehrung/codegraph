import crypto from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { GraphCacheEntry, GraphBuildOptions } from "../../graphs/types.js";
import { CODEGRAPH_CONFIG_FILE } from "../../config.js";
import { logWithLevel, type LogLevel } from "../../logging.js";
import type { Edge } from "../../types.js";
import {
  DEFAULT_PROJECT_FILE_IGNORES,
  DEFAULT_PROJECT_MANIFESTS,
  listProjectFiles,
  type ProjectFileDiscoveryOptions,
} from "../../util/projectFiles.js";
import {
  assertFilePathWithinRoot,
  fileIdentityKey,
  isFilePathWithinRoot,
  normalizePath,
  toProjectRelativePath,
} from "../../util/paths.js";
import { assertRealPathCandidateWithinRoot } from "../../util/confinedFile.js";
import {
  getGitRepositoryRoot,
  getGitBlobHashes,
  listGitExcludeFiles,
  listGitSubmoduleDirectories,
} from "../../util/git.js";
import { stringifyUnknown } from "../../util/ast.js";

import { cacheAbsolutePath, cacheRelativePath, fileSignature } from "./module-cache.js";
import { cacheRoot } from "./location.js";
import type { BuildOptions, BuildReport } from "../types.js";
import type { ManifestBuildOptions } from "./options.js";

type PackageJsonDependencyInfo = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export async function collectWorkspaceManifestDependencyEdges(
  projectRoot: string,
  manifestFiles?: readonly string[],
  discovery?: ProjectFileDiscoveryOptions,
  logLevel?: LogLevel,
): Promise<Edge[]> {
  const manifestPaths =
    manifestFiles ??
    (await listProjectFiles(projectRoot, ["**/package.json"], {
      ...discovery,
      ...(logLevel ? { logLevel } : {}),
    }));
  if (!manifestPaths.length) return [];
  const manifestByPackageName = new Map<string, string>();
  const parsedByPath = new Map<string, PackageJsonDependencyInfo>();

  for (const manifestPath of manifestPaths) {
    try {
      const raw = await fsp.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as PackageJsonDependencyInfo;
      parsedByPath.set(manifestPath, parsed);
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        manifestByPackageName.set(parsed.name, manifestPath);
      }
    } catch {
      continue;
    }
  }

  const edges: Edge[] = [];
  for (const [fromManifest, parsed] of parsedByPath.entries()) {
    const dependencySets = [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.peerDependencies,
      parsed.optionalDependencies,
    ];
    for (const dependencySet of dependencySets) {
      if (!dependencySet) continue;
      for (const dependencyName of Object.keys(dependencySet)) {
        const toManifest = manifestByPackageName.get(dependencyName);
        if (!toManifest) continue;
        edges.push({
          from: fromManifest,
          to: { type: "file", path: toManifest },
          raw: dependencyName,
        });
      }
    }
  }

  return edges;
}

export const MANIFEST_VERSION = 5;
export type ManifestFileEntry = GraphCacheEntry;

export type IndexManifest = {
  version: number;
  projectRoot: string;
  updatedAt: number;
  lastCommit?: string;
  configHash?: string;
  graphOptions?: GraphBuildOptions;
  buildOptions?: ManifestBuildOptions;
  files: Record<string, ManifestFileEntry>;
  /**
   * Node-module resolver inputs from the build that produced cached file edges.
   * Missing on older manifests; resolution-enabled builds treat that as stale.
   */
  resolverEnvironmentFingerprint?: string;
  /**
   * Files added only for a caller-scoped build. Missing on older manifests and treated
   * as empty; incremental builds prune entries once callers stop supplying them.
   */
  transientFiles?: string[];
  /**
   * Symlinked directories discovered under the project root as of the last full scan.
   * Absent on manifests written before this field existed, or whenever the set is not
   * yet known; discovery then probes the tree once and backfills it on the next write.
   * An empty array is meaningful (no symlinked directories) and lets discovery skip its
   * second full-tree walk entirely.
   */
  symlinkDirectories?: string[];
  symlinkDirectoriesRootMtimeMs?: number;
};

export function transformManifestEntries(
  projectRoot: string,
  files: Record<string, ManifestFileEntry>,
  toRelative: boolean,
): Record<string, ManifestFileEntry> {
  const transformed: Record<string, ManifestFileEntry> = {};
  for (const [file, entry] of Object.entries(files)) {
    const key = toRelative
      ? cacheRelativePath(projectRoot, file)
      : assertFilePathWithinRoot(projectRoot, cacheAbsolutePath(projectRoot, file), "Persisted manifest file key");
    transformed[key] = {
      ...entry,
      edges: entry.edges.map((edge) => ({
        ...edge,
        from: toRelative
          ? cacheRelativePath(projectRoot, edge.from)
          : assertFilePathWithinRoot(
              projectRoot,
              cacheAbsolutePath(projectRoot, edge.from),
              "Persisted manifest edge source",
            ),
        to:
          edge.to.type === "file"
            ? {
                ...edge.to,
                path: toRelative
                  ? cacheRelativePath(projectRoot, edge.to.path)
                  : assertFilePathWithinRoot(
                      projectRoot,
                      cacheAbsolutePath(projectRoot, edge.to.path),
                      "Persisted manifest edge target",
                    ),
              }
            : edge.to,
      })),
    };
  }
  return transformed;
}
type ConfigHashResult = {
  hash: string;
  error?: string;
};

export function normalizeIndexedFileInputs(
  projectRoot: string,
  files: readonly string[],
  label: string,
  realProjectRoot?: string,
): string[] {
  const filesByIdentity = new Map<string, string>();
  for (const input of files) {
    if (!input) continue;
    let inputRoot = projectRoot;
    if (!isFilePathWithinRoot(projectRoot, input) && realProjectRoot && isFilePathWithinRoot(realProjectRoot, input)) {
      inputRoot = realProjectRoot;
    }
    const file = assertFilePathWithinRoot(inputRoot, input, label);
    const relativeFile =
      toProjectRelativePath(projectRoot, file) ??
      (realProjectRoot ? toProjectRelativePath(realProjectRoot, file) : null);
    let canonicalFile = file;
    if (relativeFile !== null) {
      canonicalFile = normalizePath(path.resolve(projectRoot, relativeFile));
    }
    filesByIdentity.set(fileIdentityKey(canonicalFile), canonicalFile);
  }
  return [...filesByIdentity.values()];
}
export async function normalizeIndexedFileInputsWithinRoot(
  projectRoot: string,
  files: readonly string[],
  label: string,
): Promise<string[]> {
  const realRoot = await fsp.realpath(projectRoot);
  const normalized = normalizeIndexedFileInputs(projectRoot, files, label, realRoot);
  await Promise.all(
    normalized.map(async (file) => {
      try {
        await assertRealPathCandidateWithinRoot(realRoot, file, label);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }),
  );
  return normalized;
}

export function sanitizeManifestEntriesForRoot(
  projectRoot: string,
  files: Record<string, ManifestFileEntry> | undefined,
): Record<string, ManifestFileEntry> {
  const sanitizedEntries: Record<string, ManifestFileEntry> = {};
  for (const [file, entry] of Object.entries(files ?? {})) {
    if (!isFilePathWithinRoot(projectRoot, file)) continue;
    sanitizedEntries[file] = entry;
  }
  return sanitizedEntries;
}

export function sanitizeManifestTransientFilesForRoot(
  projectRoot: string,
  storedProjectRoot: string,
  files: unknown,
): string[] {
  if (!Array.isArray(files)) return [];
  const sanitizedFiles = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string") continue;
    const storedFile = cacheAbsolutePath(storedProjectRoot, value);
    if (!isFilePathWithinRoot(storedProjectRoot, storedFile)) continue;
    const relativeFile = cacheRelativePath(storedProjectRoot, storedFile);
    const file = cacheAbsolutePath(projectRoot, relativeFile);
    if (isFilePathWithinRoot(projectRoot, file)) sanitizedFiles.add(file);
  }
  return [...sanitizedFiles];
}

function resolveManifestSymlinkDirectories(
  projectRoot: string,
  storedProjectRoot: string,
  directories: unknown,
): string[] | undefined {
  if (directories === undefined) return undefined;
  if (!Array.isArray(directories)) return undefined;
  const resolvedDirectories = new Set<string>();
  for (const directory of directories) {
    if (typeof directory !== "string") continue;
    const storedDirectory = cacheAbsolutePath(storedProjectRoot, directory);
    if (!isFilePathWithinRoot(storedProjectRoot, storedDirectory)) continue;
    const relativeDirectory = cacheRelativePath(storedProjectRoot, storedDirectory);
    resolvedDirectories.add(cacheAbsolutePath(projectRoot, relativeDirectory));
  }
  return [...resolvedDirectories];
}

async function gitIgnoreConfigFiles(projectRoot: string): Promise<string[]> {
  const gitRoot = await getGitRepositoryRoot(projectRoot);
  if (!gitRoot) return [];
  const submoduleDirectories = await listGitSubmoduleDirectories(gitRoot, { recurse: true });
  const sourceRoots = [projectRoot, gitRoot, ...submoduleDirectories];
  const gitignoreFiles = await Promise.all(
    sourceRoots.map(
      async (root) =>
        await fg(["**/.gitignore"], {
          cwd: root,
          absolute: true,
          dot: true,
          ignore: DEFAULT_PROJECT_FILE_IGNORES,
        }),
    ),
  );
  const excludeFiles = await Promise.all(
    [gitRoot, ...submoduleDirectories].map(async (root) => await listGitExcludeFiles(root)),
  );
  return Array.from(new Set([...gitignoreFiles.flat(), ...excludeFiles.flat().map(({ file }) => file)])).sort();
}

export async function computeConfigHash(projectRoot: string, logLevel?: LogLevel): Promise<ConfigHashResult> {
  try {
    const configFiles = Array.from(
      new Set([
        ...(await fg([...DEFAULT_PROJECT_MANIFESTS, CODEGRAPH_CONFIG_FILE, "**/.gitignore"], {
          cwd: projectRoot,
          absolute: true,
          dot: true,
          ignore: DEFAULT_PROJECT_FILE_IGNORES,
        })),
        ...(await gitIgnoreConfigFiles(projectRoot)),
      ]),
    );
    configFiles.sort();
    const hash = crypto.createHash("sha1");
    let firstError: string | undefined;
    for (const file of configFiles) {
      try {
        const content = await fsp.readFile(file, "utf8");
        const relative = path.relative(projectRoot, file).replace(/\\/g, "/");
        hash.update(relative);
        hash.update(content);
      } catch (error) {
        const message = `Failed to read config file "${file}": ${stringifyUnknown(error)}`;
        if (!firstError) firstError = message;
        logWithLevel(logLevel, "debug", "computeConfigHash:", message);
      }
    }
    return {
      hash: hash.digest("hex"),
      ...(firstError ? { error: firstError } : {}),
    };
  } catch (error) {
    return {
      hash: "",
      error: `Failed to enumerate config files: ${stringifyUnknown(error)}`,
    };
  }
}

function manifestFilePath(projectRoot: string, opts?: BuildOptions): string {
  return path.join(cacheRoot(projectRoot, opts), "manifest.json");
}

function isTransientFileContentionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

function manifestTempFilePath(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath);
  return path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
}
const MANIFEST_TEMP_RETENTION_MS = 24 * 60 * 60 * 1_000;

function isManifestTempName(name: string, manifestName: string): boolean {
  const prefix = `.${manifestName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
  const marker = name.slice(prefix.length, -4);
  return /^\d+\.[0-9a-f-]{36}$/u.test(marker);
}

async function cleanupStaleManifestTemps(manifestPath: string): Promise<void> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fsp.readdir(path.dirname(manifestPath), { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - MANIFEST_TEMP_RETENTION_MS;
  const manifestName = path.basename(manifestPath);
  for (const entry of entries) {
    if (!entry.isFile() || !isManifestTempName(entry.name, manifestName)) continue;
    const candidate = path.join(path.dirname(manifestPath), entry.name);
    try {
      const stat = await fsp.lstat(candidate);
      if (stat.mtimeMs <= cutoff) await fsp.rm(candidate, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function fsyncManifestFile(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncManifestDirectory(directoryPath: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await fsp.open(directoryPath, "r");
    await directory.sync();
  } catch {
    // Directory fsync is not supported on every platform.
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // Directory fsync is best effort.
      }
    }
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeManifestAtomically(manifestPath: string, payload: string): Promise<void> {
  const retryDelays = [10, 25, 50, 100];
  await cleanupStaleManifestTemps(manifestPath);
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const tempPath = manifestTempFilePath(manifestPath);
    try {
      await fsp.writeFile(tempPath, payload, "utf8");
      await fsyncManifestFile(tempPath);
      await fsp.rename(tempPath, manifestPath);
      await syncManifestDirectory(path.dirname(manifestPath));
      return;
    } catch (error) {
      try {
        await fsp.rm(tempPath, { force: true });
      } catch {
        // Cleanup is best-effort; the next attempt uses a fresh temp path.
      }
      const canRetry = attempt < retryDelays.length && isTransientFileContentionError(error);
      if (!canRetry) throw error;
      await wait(retryDelays[attempt]!);
    }
  }
}
function recordManifestCorruption(
  report: BuildReport | undefined,
  artifact: string,
  reason: string,
  logLevel: LogLevel | undefined,
): void {
  if (report) {
    report.manifest ??= { used: true, reused: false };
    report.manifest.corruptions ??= [];
    if (!report.manifest.corruptions.some((entry) => entry.artifact === artifact)) {
      report.manifest.corruptions.push({ artifact, reason });
    }
  }
  logWithLevel(logLevel, "warn", `Warning: Corrupt cache artifact ${artifact}: ${reason}`);
}

export async function loadManifest(
  projectRoot: string,
  opts?: BuildOptions,
  report?: BuildReport,
): Promise<IndexManifest | null> {
  const manifestPath = manifestFilePath(projectRoot, opts);
  try {
    const raw = await fsp.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as IndexManifest;
    let invalidReason: string | undefined;
    if (parsed.version !== MANIFEST_VERSION && parsed.version !== 4 && parsed.version !== 3) {
      invalidReason = `unsupported manifest version ${String(parsed.version)}`;
    } else if (typeof parsed.projectRoot !== "string") {
      invalidReason = "missing project root";
    } else if (!/^[a-f0-9]{64}$/.test(parsed.buildOptions?.implementationFingerprint ?? "")) {
      invalidReason = "missing implementation fingerprint";
    }
    if (invalidReason) {
      recordManifestCorruption(report, manifestPath, invalidReason, opts?.logLevel);
      return null;
    }
    const oldFiles = parsed.files ?? {};
    const relativeFiles =
      parsed.version === 3 ? transformManifestEntries(parsed.projectRoot, oldFiles, true) : oldFiles;
    const symlinkDirectories = resolveManifestSymlinkDirectories(
      projectRoot,
      parsed.projectRoot,
      parsed.symlinkDirectories,
    );
    const migrated: IndexManifest = {
      ...parsed,
      version: MANIFEST_VERSION,
      projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
      files: transformManifestEntries(projectRoot, relativeFiles, false),
      transientFiles: sanitizeManifestTransientFilesForRoot(projectRoot, parsed.projectRoot, parsed.transientFiles),
      ...(symlinkDirectories !== undefined ? { symlinkDirectories } : {}),
    };
    return migrated;
  } catch (error) {
    const isMissing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!isMissing) recordManifestCorruption(report, manifestPath, stringifyUnknown(error), opts?.logLevel);
    return null;
  }
}

/**
 * Index manifests are compact JSON. Pretty-print only added indent bytes.
 * `loadManifest` uses `JSON.parse`, so pretty files from earlier versions still load.
 */
function serializeIndexManifest(manifest: IndexManifest): string {
  return JSON.stringify(manifest);
}

export async function writeManifest(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifest: IndexManifest,
): Promise<boolean> {
  try {
    const manifestPath = manifestFilePath(projectRoot, opts);
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await writeManifestAtomically(manifestPath, serializeIndexManifest(manifest));
    return true;
  } catch (error) {
    logWithLevel(opts?.logLevel, "warn", "Warning: Failed to write manifest:", error);
    return false;
  }
}

export async function verifyManifestEntries(
  projectRoot: string,
  manifest: IndexManifest,
  opts: BuildOptions | undefined,
  gitAvailable: boolean,
): Promise<{ mismatches: number; missing: number }> {
  const entries = manifest.files ?? {};
  const files = Object.keys(entries);
  const existingFiles = files.filter((file) => fs.existsSync(file));
  const missing = files.length - existingFiles.length;
  const gitSigMap = gitAvailable
    ? await getGitBlobHashes(projectRoot, existingFiles, { gitAvailable })
    : new Map<string, string>();
  let mismatches = 0;
  for (const file of existingFiles) {
    const entry = entries[file];
    if (!entry) continue;
    const sigInfo = await fileSignature(file, opts?.cacheStrict, gitSigMap.get(file));
    const matchesGitSig = !!entry.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
    const matchesSig = entry.sig === sigInfo.sig;
    if (!matchesGitSig && !matchesSig) mismatches += 1;
  }
  return { mismatches, missing };
}
