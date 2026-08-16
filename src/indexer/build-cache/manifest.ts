import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { assertFilePathWithinRoot, fileIdentityKey, isFilePathWithinRoot } from "../../util/paths.js";
import { getGitBlobHashes } from "../../util/git.js";
import { stringifyUnknown } from "../../util/ast.js";
import { cacheAbsolutePath, cacheRelativePath, fileSignature } from "./module-cache.js";
import { cacheRoot } from "./location.js";
import type { BuildOptions } from "../types.js";
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
  discovery?: ProjectFileDiscoveryOptions,
  allowedManifestFiles?: ReadonlySet<string>,
  logLevel?: LogLevel,
): Promise<Edge[]> {
  const discoveredManifestPaths = await listProjectFiles(projectRoot, ["**/package.json"], {
    ...discovery,
    ...(logLevel ? { logLevel } : {}),
  });
  const manifestPaths = allowedManifestFiles
    ? discoveredManifestPaths.filter((manifestPath) => allowedManifestFiles.has(manifestPath))
    : discoveredManifestPaths;
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

export const MANIFEST_VERSION = 4;
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

export function normalizeIndexedFileInputs(projectRoot: string, files: readonly string[], label: string): string[] {
  const filesByIdentity = new Map<string, string>();
  for (const input of files) {
    if (!input) continue;
    const file = assertFilePathWithinRoot(projectRoot, input, label);
    filesByIdentity.set(fileIdentityKey(file), file);
  }
  return [...filesByIdentity.values()];
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

export function sanitizeManifestTransientFilesForRoot(projectRoot: string, files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const sanitizedFiles = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string") continue;
    const file = path.resolve(projectRoot, value).replace(/\\/g, "/");
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

export async function computeConfigHash(projectRoot: string, logLevel?: LogLevel): Promise<ConfigHashResult> {
  try {
    const configFiles = await fg([...DEFAULT_PROJECT_MANIFESTS, CODEGRAPH_CONFIG_FILE, "**/.gitignore"], {
      cwd: projectRoot,
      absolute: true,
      dot: true,
      ignore: DEFAULT_PROJECT_FILE_IGNORES,
    });
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

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeManifestAtomically(manifestPath: string, payload: string): Promise<void> {
  const retryDelays = [10, 25, 50, 100];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const tempPath = manifestTempFilePath(manifestPath);
    try {
      await fsp.writeFile(tempPath, payload, "utf8");
      await fsp.rename(tempPath, manifestPath);
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

export async function loadManifest(projectRoot: string, opts?: BuildOptions): Promise<IndexManifest | null> {
  try {
    const manifestPath = manifestFilePath(projectRoot, opts);
    const raw = await fsp.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as IndexManifest;
    if (
      (parsed.version !== MANIFEST_VERSION && parsed.version !== 3) ||
      typeof parsed.projectRoot !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.buildOptions?.implementationFingerprint ?? "")
    ) {
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
      files: transformManifestEntries(projectRoot, relativeFiles, false),
      transientFiles: sanitizeManifestTransientFilesForRoot(projectRoot, parsed.transientFiles),
      ...(symlinkDirectories !== undefined ? { symlinkDirectories } : {}),
    };
    return migrated;
  } catch {
    return null;
  }
}

export async function writeManifest(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifest: IndexManifest,
): Promise<boolean> {
  try {
    const manifestPath = manifestFilePath(projectRoot, opts);
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await writeManifestAtomically(manifestPath, JSON.stringify(manifest, null, 2));
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
