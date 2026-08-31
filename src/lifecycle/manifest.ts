import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { createAgentSession, listAgentSessionFiles } from "../agent/session.js";
import { computeConfigHash } from "../indexer/build-cache/manifest.js";
import { logWithLevel } from "../logging.js";
import { mapLimit } from "../util/concurrency.js";
import { normalizeGraphOptions, summarizeBuildOptions } from "../indexer/build-cache/options.js";
import type { BuildOptions } from "../indexer/types.js";
import type { AnalysisSummary } from "../analysisSummary.js";
import { CodegraphLifecycleUserError } from "./errors.js";
import { prepareCodegraphLifecycleGitignore, type CodegraphLifecycleGitignoreResult } from "./gitignore.js";

export type CodegraphLifecycleManifest = {
  schemaVersion: 1;
  root: ".";
  createdAt: string;
  lastSyncAt: string;
  configHash: string;
  buildOptionsHash: string;
  fileCount: number;
  fileSignatureHash: string;
  /** Sorted, root-relative file paths as of the last sync. Absent on manifests written before this field existed. */
  files?: string[];
  analysis: AnalysisSummary;
};

export type CodegraphLifecycleStatus = {
  schemaVersion: 1;
  root: string;
  initialized: boolean;
  manifestPath: string;
  lastSyncAt?: string;
  fileCount?: {
    then: number;
    current: number;
  };
  configChanged: boolean;
  buildOptionsChanged: boolean;
  filesChanged: boolean;
  analysis?: AnalysisSummary;
  suggestedNextCommand: string;
};

export type { CodegraphLifecycleGitignoreResult } from "./gitignore.js";
export { CodegraphLifecycleUserError } from "./errors.js";

export type CodegraphLifecycleSyncResult = {
  schemaVersion: 1;
  root: string;
  initialized: true;
  manifestPath: string;
  manifest: CodegraphLifecycleManifest;
  changedFiles: {
    added: number;
    removed: number;
    totalDelta: number;
  };
  gitignore?: CodegraphLifecycleGitignoreResult;
};

export type CodegraphLifecycleUninitResult = {
  schemaVersion: 1;
  root: string;
  removed: boolean;
  manifestPath: string;
};

const MANIFEST_SCHEMA_VERSION = 1;
const CODEGRAPH_DIR = ".codegraph";
const MANIFEST_FILE = "manifest.json";
const SERVER_REGISTRY_FILE = "server.json";
const SERVER_LOG_FILE = "server.log";
const CACHE_DIRECTORY = "cache";
const KNOWN_CODEGRAPH_FILES: Record<string, true> = {
  [MANIFEST_FILE]: true,
  [SERVER_REGISTRY_FILE]: true,
  [SERVER_LOG_FILE]: true,
  [CACHE_DIRECTORY]: true,
};

export function codegraphLifecycleManifestPath(root: string): string {
  return path.join(root, CODEGRAPH_DIR, MANIFEST_FILE);
}

export async function initCodegraphLifecycle(
  root: string,
  options: { buildOptions?: BuildOptions; force?: boolean; updateGitignore?: boolean } = {},
): Promise<CodegraphLifecycleSyncResult> {
  const gitignore = await prepareCodegraphLifecycleGitignore(root, {
    updateGitignore: options.updateGitignore ?? true,
  });
  const existing = await readLifecycleManifest(root, options.force ? { allowInvalid: true } : {});
  if (existing && !options.force) {
    const status = await getCodegraphLifecycleStatus(root, options);
    if (!status.configChanged && !status.buildOptionsChanged && !status.filesChanged) {
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        root,
        initialized: true,
        manifestPath: codegraphLifecycleManifestPath(root),
        manifest: existing,
        changedFiles: { added: 0, removed: 0, totalDelta: 0 },
        gitignore,
      };
    }
  }
  return await syncCodegraphLifecycleCore(root, { ...options, init: true }, existing, gitignore);
}

export async function syncCodegraphLifecycle(
  root: string,
  options: { buildOptions?: BuildOptions; init?: boolean; force?: boolean; updateGitignore?: boolean } = {},
): Promise<CodegraphLifecycleSyncResult> {
  const gitignore = options.init
    ? await prepareCodegraphLifecycleGitignore(root, {
        updateGitignore: options.updateGitignore ?? true,
      })
    : undefined;
  const existing = await readLifecycleManifest(root, { allowInvalid: Boolean(options.init && options.force) });
  return await syncCodegraphLifecycleCore(root, options, existing, gitignore);
}

async function syncCodegraphLifecycleCore(
  root: string,
  options: { buildOptions?: BuildOptions; init?: boolean; force?: boolean },
  existing: CodegraphLifecycleManifest | null,
  gitignore?: CodegraphLifecycleGitignoreResult,
): Promise<CodegraphLifecycleSyncResult> {
  if (!existing && !options.init) {
    throw new CodegraphLifecycleUserError(
      "Codegraph is not initialized for this project. Run codegraph init or codegraph sync --init.",
    );
  }
  const manifest = await buildLifecycleManifest(
    root,
    options.buildOptions,
    existing,
    options.force ? { force: true } : {},
  );
  await writeLifecycleManifest(root, manifest);
  const thenCount = existing?.fileCount ?? 0;
  const fallbackTotalDelta = manifest.fileCount - thenCount;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root,
    initialized: true,
    manifestPath: codegraphLifecycleManifestPath(root),
    manifest,
    changedFiles: diffLifecycleFileCounts(existing?.files, manifest.files, fallbackTotalDelta),
    ...(gitignore ? { gitignore } : {}),
  };
}

export async function getCodegraphLifecycleStatus(
  root: string,
  options: { buildOptions?: BuildOptions } = {},
): Promise<CodegraphLifecycleStatus> {
  const manifestPath = codegraphLifecycleManifestPath(root);
  const manifest = await readLifecycleManifest(root);
  if (!manifest) {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      root,
      initialized: false,
      manifestPath,
      configChanged: false,
      buildOptionsChanged: false,
      filesChanged: false,
      suggestedNextCommand: "codegraph init",
    };
  }
  const configHash = await hashConfig(root, options.buildOptions?.logLevel);
  const buildOptionsHash = hashBuildOptions(options.buildOptions);
  const files = await listAgentSessionFiles({
    root,
    ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
  });
  const fileSignatureHash = await hashDiscoveredFiles(files, root);
  const configChanged = manifest.configHash !== configHash;
  const buildOptionsChanged = manifest.buildOptionsHash !== buildOptionsHash;
  const filesChanged = manifest.fileSignatureHash !== fileSignatureHash;
  const changed = configChanged || buildOptionsChanged || filesChanged;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root,
    initialized: true,
    manifestPath,
    lastSyncAt: manifest.lastSyncAt,
    fileCount: {
      then: manifest.fileCount,
      current: files.length,
    },
    configChanged,
    buildOptionsChanged,
    filesChanged,
    analysis: manifest.analysis,
    suggestedNextCommand: changed ? "codegraph sync" : "codegraph status",
  };
}

export async function uninitCodegraphLifecycle(
  root: string,
  options: { force?: boolean } = {},
): Promise<CodegraphLifecycleUninitResult> {
  const dir = path.join(root, CODEGRAPH_DIR);
  const manifestPath = codegraphLifecycleManifestPath(root);
  const entries = await readCodegraphDirEntries(dir);
  if (!entries.length) {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, root, removed: false, manifestPath };
  }
  const unknownEntries = entries.filter((entry) => !Object.hasOwn(KNOWN_CODEGRAPH_FILES, entry));
  if (unknownEntries.length && !options.force) {
    throw new CodegraphLifecycleUserError(
      `Refusing to remove .codegraph with unknown entries: ${unknownEntries.join(", ")}. Use --force to remove them.`,
    );
  }
  const removableEntries = entries.filter(
    (entry) => entry !== SERVER_REGISTRY_FILE && entry !== SERVER_LOG_FILE && entry !== CACHE_DIRECTORY,
  );
  if (options.force) {
    for (const entry of removableEntries) {
      await removeCodegraphPath(path.join(dir, entry), { recursive: true });
    }
    await removeDirIfEmpty(dir);
  } else if (removableEntries.includes(MANIFEST_FILE)) {
    await removeCodegraphPath(manifestPath, {});
    await removeDirIfEmpty(dir);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root,
    removed: options.force ? Boolean(removableEntries.length) : removableEntries.includes(MANIFEST_FILE),
    manifestPath,
  };
}

async function buildLifecycleManifest(
  root: string,
  buildOptions: BuildOptions | undefined,
  existing: CodegraphLifecycleManifest | null,
  options: { force?: boolean } = {},
): Promise<CodegraphLifecycleManifest> {
  const now = new Date().toISOString();
  const sessionBuildOptions = { ...(buildOptions ?? {}), cache: "disk" as const };
  const forcedSessionBuildOptions = options.force
    ? { ...sessionBuildOptions, cacheStrict: true, cacheVerify: true }
    : sessionBuildOptions;
  const session = createAgentSession({ root, buildOptions: forcedSessionBuildOptions });
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root: ".",
    createdAt: existing?.createdAt ?? now,
    lastSyncAt: now,
    configHash: await hashConfig(root, buildOptions?.logLevel),
    buildOptionsHash: hashBuildOptions(buildOptions),
    fileCount: snapshot.files.length,
    fileSignatureHash:
      hashManifestEntries(
        snapshot.files,
        root,
        snapshot.index.manifestEntries,
        snapshot.index.manifestSignaturesFresh,
      ) ?? (await hashDiscoveredFiles(snapshot.files, root)),
    files: discoveredFileRelativePaths(snapshot.files, root),
    analysis: snapshot.analysis,
  };
}

async function readLifecycleManifest(
  root: string,
  options: { allowInvalid?: boolean } = {},
): Promise<CodegraphLifecycleManifest | null> {
  const manifestPath = codegraphLifecycleManifestPath(root);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new CodegraphLifecycleUserError(
      `Unable to read Codegraph lifecycle manifest at ${manifestPath}: ${stringifyError(error)}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isLifecycleManifest(parsed)) return parsed;
    throw new Error("Invalid Codegraph lifecycle manifest schema.");
  } catch (error) {
    if (options.allowInvalid) return null;
    throw new CodegraphLifecycleUserError(
      `Unable to read Codegraph lifecycle manifest at ${manifestPath}: ${stringifyError(error)}`,
    );
  }
}

function lifecycleManifestTempFilePath(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

async function writeLifecycleManifest(root: string, manifest: CodegraphLifecycleManifest): Promise<void> {
  const manifestPath = codegraphLifecycleManifestPath(root);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = lifecycleManifestTempFilePath(manifestPath);
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, manifestPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {
      // Cleanup is best-effort; surfacing the original error matters more.
    });
    throw new CodegraphLifecycleUserError(
      `Unable to write Codegraph lifecycle manifest at ${manifestPath}: ${stringifyError(error)}`,
    );
  }
}

async function hashConfig(root: string, logLevel: BuildOptions["logLevel"]): Promise<string> {
  const result = await computeConfigHash(root, logLevel);
  if (result.error) {
    logWithLevel(logLevel, "warn", `Warning: Codegraph lifecycle config drift check: ${result.error}`);
  }
  return result.hash;
}

function discoveredFileRelativePaths(files: readonly string[], root: string): string[] {
  return [...files]
    .map((file) => path.relative(root, file).replace(/\\/g, "/"))
    .sort((left, right) => left.localeCompare(right));
}

function diffLifecycleFileCounts(
  previous: readonly string[] | undefined,
  current: readonly string[] | undefined,
  fallbackTotalDelta: number,
): { added: number; removed: number; totalDelta: number } {
  if (previous === undefined || current === undefined) {
    // Legacy manifest predates per-file tracking; approximate from the net file-count delta.
    return {
      added: Math.max(0, fallbackTotalDelta),
      removed: Math.max(0, -fallbackTotalDelta),
      totalDelta: fallbackTotalDelta,
    };
  }
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const added = current.filter((file) => !previousSet.has(file)).length;
  const removed = previous.filter((file) => !currentSet.has(file)).length;
  // Derive totalDelta from the file lists themselves (not the caller-supplied fileCount delta) so
  // it can never disagree with added/removed, even if a manifest's fileCount and files.length have
  // diverged (hand edits, partial/corrupt manifests, legacy migration edge cases).
  return { added, removed, totalDelta: current.length - previous.length };
}

const FILE_SIGNATURE_STAT_CONCURRENCY = 64;

function isMissingStatRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function hashManifestEntries(
  files: readonly string[],
  root: string,
  entries: ReadonlyMap<string, { sig: string }> | undefined,
  signaturesFresh: boolean | undefined,
): string | undefined {
  if (!signaturesFresh || !entries || entries.size !== files.length) return undefined;
  const sorted = [...files].sort((left, right) => left.localeCompare(right));
  const signatures = new Map<string, { size: string; mtimeMs: string }>();
  for (const file of sorted) {
    const entry = entries.get(file);
    const signature = parseLifecycleFileSignature(entry?.sig);
    if (!signature) return undefined;
    signatures.set(file, signature);
  }
  const hash = createHash("sha256");
  for (const file of sorted) {
    const signature = signatures.get(file);
    if (!signature) return undefined;
    const relative = path.relative(root, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(signature.size);
    hash.update("\0");
    hash.update(signature.mtimeMs);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseLifecycleFileSignature(value: unknown): { size: string; mtimeMs: string } | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "0:0") return undefined;
  const parts = value.split(":");
  if (parts.length !== 2) return undefined;
  const [mtimeMs, size] = parts;
  if (!mtimeMs || !size) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(mtimeMs)) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(size)) return undefined;
  const numericMtimeMs = Number(mtimeMs);
  const numericSize = Number(size);
  if (!Number.isFinite(numericMtimeMs) || String(numericMtimeMs) !== mtimeMs) return undefined;
  if (!Number.isSafeInteger(numericSize) || String(numericSize) !== size) return undefined;
  return { size, mtimeMs };
}

async function hashDiscoveredFiles(files: readonly string[], root: string): Promise<string> {
  const sorted = [...files].sort((left, right) => left.localeCompare(right));
  const signatures = new Map<string, { size: number; mtimeMs: number }>();
  await mapLimit(sorted, FILE_SIGNATURE_STAT_CONCURRENCY, async (file) => {
    try {
      const stat = await fsp.stat(file);
      signatures.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (isMissingStatRace(error)) return;
      throw new CodegraphLifecycleUserError(`Unable to verify file signature for ${file}: ${stringifyError(error)}`);
    }
  });
  const hash = createHash("sha256");
  for (const file of sorted) {
    const signature = signatures.get(file);
    if (!signature) continue;
    const relative = path.relative(root, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(String(signature.size));
    hash.update("\0");
    hash.update(String(signature.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function hashBuildOptions(buildOptions: BuildOptions | undefined): string {
  return sha256(stableStringify(summarizeLifecycleBuildOptions(buildOptions)));
}

function summarizeLifecycleBuildOptions(buildOptions: BuildOptions | undefined) {
  return {
    ...summarizeBuildOptions(buildOptions),
    graph: normalizeGraphOptions(buildOptions?.graph),
    native: buildOptions?.native ?? "auto",
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      items.push(item === undefined ? "null" : stableStringify(item));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object" || value === null) {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function removeCodegraphPath(target: string, options: { recursive?: boolean }): Promise<void> {
  try {
    await fsp.rm(target, { ...(options.recursive ? { recursive: true } : {}), force: true });
  } catch (error) {
    throw new CodegraphLifecycleUserError(`Unable to remove ${target}: ${stringifyError(error)}`);
  }
}

async function readCodegraphDirEntries(dir: string): Promise<string[]> {
  try {
    const stats = await fsp.lstat(dir);
    if (stats.isSymbolicLink()) {
      throw new CodegraphLifecycleUserError(
        `Refusing to traverse symbolic link as .codegraph lifecycle directory: ${dir}`,
      );
    }
    return await fsp.readdir(dir);
  } catch (error) {
    if (error instanceof CodegraphLifecycleUserError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new CodegraphLifecycleUserError(`Unable to read ${dir}: ${stringifyError(error)}`);
  }
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fsp.rmdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTEMPTY") return;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new CodegraphLifecycleUserError(`Unable to remove ${dir}: ${stringifyError(error)}`);
  }
}

function isLifecycleManifest(value: unknown): value is CodegraphLifecycleManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fileCount = record.fileCount;
  const files = record.files;
  return (
    record.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    record.root === "." &&
    typeof record.createdAt === "string" &&
    typeof record.lastSyncAt === "string" &&
    typeof record.configHash === "string" &&
    typeof record.buildOptionsHash === "string" &&
    typeof fileCount === "number" &&
    Number.isInteger(fileCount) &&
    fileCount >= 0 &&
    typeof record.fileSignatureHash === "string" &&
    isOptionalStringArray(files) &&
    typeof record.analysis === "object" &&
    record.analysis !== null
  );
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
