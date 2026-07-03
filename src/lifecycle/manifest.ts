import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { createAgentSession, listAgentSessionFiles } from "../agent/session.js";
import { computeConfigHash } from "../indexer/build-cache/manifest.js";
import type { BuildOptions } from "../indexer/types.js";
import type { AnalysisSummary } from "../analysisSummary.js";

export type CodegraphLifecycleManifest = {
  schemaVersion: 1;
  root: ".";
  createdAt: string;
  lastSyncAt: string;
  configHash: string;
  buildOptionsHash: string;
  fileCount: number;
  fileSignatureHash: string;
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
const KNOWN_CODEGRAPH_FILES = new Set([MANIFEST_FILE]);

export function codegraphLifecycleManifestPath(root: string): string {
  return path.join(root, CODEGRAPH_DIR, MANIFEST_FILE);
}

export async function initCodegraphLifecycle(
  root: string,
  options: { buildOptions?: BuildOptions; force?: boolean } = {},
): Promise<CodegraphLifecycleSyncResult> {
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
      };
    }
  }
  return await syncCodegraphLifecycle(root, { ...options, init: true });
}

export async function syncCodegraphLifecycle(
  root: string,
  options: { buildOptions?: BuildOptions; init?: boolean; force?: boolean } = {},
): Promise<CodegraphLifecycleSyncResult> {
  const existing = await readLifecycleManifest(root, { allowInvalid: Boolean(options.init && options.force) });
  if (!existing && !options.init) {
    throw new Error("Codegraph is not initialized for this project. Run codegraph init or codegraph sync --init.");
  }
  const manifest = await buildLifecycleManifest(
    root,
    options.buildOptions,
    existing,
    options.force ? { force: true } : {},
  );
  await writeLifecycleManifest(root, manifest);
  const thenCount = existing?.fileCount ?? 0;
  const totalDelta = manifest.fileCount - thenCount;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root,
    initialized: true,
    manifestPath: codegraphLifecycleManifestPath(root),
    manifest,
    changedFiles: {
      added: Math.max(0, totalDelta),
      removed: Math.max(0, -totalDelta),
      totalDelta,
    },
  };
}

export async function getCodegraphLifecycleStatus(
  root: string,
  options: { buildOptions?: BuildOptions } = {},
): Promise<CodegraphLifecycleStatus> {
  const manifestPath = codegraphLifecycleManifestPath(root);
  const manifest = await readLifecycleManifest(root);
  const configHash = await hashConfig(root);
  const buildOptionsHash = hashBuildOptions(options.buildOptions);
  const files = await listAgentSessionFiles({
    root,
    ...(options.buildOptions ? { buildOptions: options.buildOptions } : {}),
  });
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
  const unknownEntries = entries.filter((entry) => !KNOWN_CODEGRAPH_FILES.has(entry));
  if (unknownEntries.length && !options.force) {
    throw new Error(
      `Refusing to remove .codegraph with unknown entries: ${unknownEntries.join(", ")}. Use --force to remove them.`,
    );
  }
  if (options.force) {
    await fsp.rm(dir, { recursive: true, force: true });
  } else {
    await fsp.rm(manifestPath, { force: true });
    await removeDirIfEmpty(dir);
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, root, removed: true, manifestPath };
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
    configHash: await hashConfig(root),
    buildOptionsHash: hashBuildOptions(buildOptions),
    fileCount: snapshot.files.length,
    fileSignatureHash: await hashDiscoveredFiles(snapshot.files, root),
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
    throw new Error(`Unable to read Codegraph lifecycle manifest at ${manifestPath}: ${stringifyError(error)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isLifecycleManifest(parsed)) return parsed;
    throw new Error("Invalid Codegraph lifecycle manifest schema.");
  } catch (error) {
    if (options.allowInvalid) return null;
    throw new Error(`Unable to read Codegraph lifecycle manifest at ${manifestPath}: ${stringifyError(error)}`);
  }
}

async function writeLifecycleManifest(root: string, manifest: CodegraphLifecycleManifest): Promise<void> {
  const manifestPath = codegraphLifecycleManifestPath(root);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, manifestPath);
}

async function hashConfig(root: string): Promise<string> {
  const result = await computeConfigHash(root);
  return result.hash;
}

async function hashDiscoveredFiles(files: readonly string[], root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await fsp.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function hashBuildOptions(buildOptions: BuildOptions | undefined): string {
  return sha256(stableStringify(stripUnhashableBuildOptions(buildOptions ?? {})));
}

function stripUnhashableBuildOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnhashableBuildOptions);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "function") continue;
    out[key] = stripUnhashableBuildOptions(nested);
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readCodegraphDirEntries(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fsp.rmdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTEMPTY") return;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function isLifecycleManifest(value: unknown): value is CodegraphLifecycleManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    record.root === "." &&
    typeof record.createdAt === "string" &&
    typeof record.lastSyncAt === "string" &&
    typeof record.configHash === "string" &&
    typeof record.buildOptionsHash === "string" &&
    typeof record.fileCount === "number" &&
    typeof record.fileSignatureHash === "string" &&
    typeof record.analysis === "object" &&
    record.analysis !== null
  );
}
