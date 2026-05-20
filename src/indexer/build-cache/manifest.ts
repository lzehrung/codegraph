import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { GraphCacheEntry, GraphBuildOptions } from "../../graphs/types.js";
import { logWithLevel, type LogLevel } from "../../logging.js";
import type { Edge } from "../../types.js";
import {
  DEFAULT_PROJECT_MANIFESTS,
  listProjectFiles,
  type ProjectFileDiscoveryOptions,
} from "../../util/projectFiles.js";
import { assertFilePathWithinRoot, isFilePathWithinRoot } from "../../util/paths.js";
import { getGitBlobHashes } from "../../util/git.js";
import { stringifyUnknown } from "../../util/ast.js";
import type { BuildOptions } from "../types.js";
import { cacheRoot, fileSignature } from "./module-cache.js";
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
  const manifestPaths = await listProjectFiles(projectRoot, ["**/package.json"], {
    ...discovery,
    ...(logLevel ? { logLevel } : {}),
  });
  const scopedManifestPaths = allowedManifestFiles
    ? manifestPaths.filter((manifestPath) => allowedManifestFiles.has(manifestPath))
    : manifestPaths;
  if (!scopedManifestPaths.length) return [];

  const manifestByPackageName = new Map<string, string>();
  const parsedByPath = new Map<string, PackageJsonDependencyInfo>();

  for (const manifestPath of scopedManifestPaths) {
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

export const MANIFEST_VERSION = 2;

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
};

type ConfigHashResult = {
  hash: string;
  error?: string;
};

export function normalizeIndexedFileInputs(projectRoot: string, files: readonly string[], label: string): string[] {
  return Array.from(new Set(files.filter(Boolean).map((file) => assertFilePathWithinRoot(projectRoot, file, label))));
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

export async function computeConfigHash(projectRoot: string, logLevel?: LogLevel): Promise<ConfigHashResult> {
  try {
    const configFiles = await fg([...DEFAULT_PROJECT_MANIFESTS, "**/.gitignore"], {
      cwd: projectRoot,
      absolute: true,
      dot: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/.venv/**",
        "**/__pycache__/**",
      ],
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
    if (parsed.version !== MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeManifest(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifest: IndexManifest,
): Promise<void> {
  try {
    const manifestPath = manifestFilePath(projectRoot, opts);
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await writeManifestAtomically(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (error) {
    logWithLevel(opts?.logLevel, "warn", "Warning: Failed to write manifest:", error);
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
