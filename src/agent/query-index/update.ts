import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentProjectSnapshot } from "../session.js";
import type { ProjectIndexManifestEntry, QueryIndexDiagnostics } from "../../indexer/types.js";
import { getCodegraphVersion } from "../../util/packageInfo.js";
import { fileIdentityKey, normalizePath } from "../../util/paths.js";
import { errorMessage } from "../../util/errors.js";
import type { PreparedQueryIndexFile } from "./content.js";
import {
  createProjectRootIdentity,
  normalizeQueryIndexRelativePath,
  resolveQueryIndexPaths,
  resolveQueryIndexSourcePath,
  type QueryIndexPaths,
} from "./paths.js";
import { createQuerySourceIdentity } from "./sourceIdentity.js";
import {
  expectedQueryIndexVersionMetadata,
  QueryIndexFutureSchemaError,
  QueryIndexSchemaError,
  QUERY_INDEX_SCHEMA_VERSION,
  type QueryIndexMetadata,
} from "./schema.js";
import { isSqliteBusyError, isSqliteCorruptionError, QueryIndexStore } from "./store.js";

const QUERY_INDEX_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUERY_INDEX_TEMP_PATTERN = /^search-v1(?:\.v\d+)?\.tmp-\d+-[0-9a-f-]+\.sqlite$/u;

export type QueryIndexHandle = {
  store: QueryIndexStore | null;
  diagnostics: QueryIndexDiagnostics;
};

type CurrentQueryFile = {
  path: string;
  sourceIdentity: string;
};

type QueryIndexCurrentState = {
  files: CurrentQueryFile[];
  identities: Map<string, string>;
  projectSnapshotIdentity: string;
  projectRootIdentity: string;
};

function emptyDiagnostics(sidecarState: QueryIndexDiagnostics["sidecarState"]): QueryIndexDiagnostics {
  return {
    sidecarState,
    filesRead: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    fileCandidates: 0,
    chunkCandidates: 0,
    openMs: 0,
    updateMs: 0,
    candidateMs: 0,
    scoringMs: 0,
  };
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function currentQueryState(snapshot: AgentProjectSnapshot): QueryIndexCurrentState | null {
  const projectSnapshotIdentity = snapshot.index.projectSnapshotIdentity;
  const files: CurrentQueryFile[] = [];
  const manifestEntries = snapshot.index.manifestEntries;
  if (!projectSnapshotIdentity || !manifestEntries?.size) return null;
  const normalizedManifestEntries = new Map<string, ProjectIndexManifestEntry>();
  for (const [candidate, entry] of manifestEntries) {
    const normalizedCandidate = fileIdentityKey(candidate);
    if (!normalizedManifestEntries.has(normalizedCandidate)) {
      normalizedManifestEntries.set(normalizedCandidate, entry);
    }
  }
  const identities = new Map<string, string>();
  for (const file of snapshot.files) {
    const relativePath = normalizeQueryIndexRelativePath(snapshot.root, file);
    const entry =
      manifestEntries.get(file) ??
      manifestEntries.get(normalizePath(file)) ??
      normalizedManifestEntries.get(fileIdentityKey(file));
    if (!entry) return null;
    const sourceIdentity = createQuerySourceIdentity(relativePath, entry);
    files.push({ path: relativePath, sourceIdentity });
    identities.set(relativePath, sourceIdentity);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    identities,
    projectSnapshotIdentity,
    projectRootIdentity: createProjectRootIdentity(snapshot.root),
  };
}

function metadataMatchesCurrent(metadata: Partial<QueryIndexMetadata>, current: QueryIndexCurrentState): boolean {
  const versions = expectedQueryIndexVersionMetadata();
  return (
    metadata.schemaVersion === versions.schemaVersion &&
    metadata.normalizerVersion === versions.normalizerVersion &&
    metadata.chunkerVersion === versions.chunkerVersion &&
    metadata.projectRootIdentity === current.projectRootIdentity &&
    metadata.projectSnapshotIdentity === current.projectSnapshotIdentity
  );
}

function sourceIdentitiesMatch(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [file, identity] of left) {
    if (right.get(file) !== identity) return false;
  }
  return true;
}

function assertStoredPaths(snapshot: AgentProjectSnapshot, identities: ReadonlyMap<string, string>): void {
  for (const relativePath of identities.keys()) resolveQueryIndexSourcePath(snapshot.root, relativePath);
}

function buildMetadata(current: QueryIndexCurrentState): QueryIndexMetadata {
  return {
    ...expectedQueryIndexVersionMetadata(),
    projectSnapshotIdentity: current.projectSnapshotIdentity,
    projectRootIdentity: current.projectRootIdentity,
    createdByCodegraphVersion: getCodegraphVersion(),
    updatedAt: new Date().toISOString(),
  };
}

async function prepareFiles(
  projectRoot: string,
  files: readonly CurrentQueryFile[],
  diagnostics: QueryIndexDiagnostics,
): Promise<PreparedQueryIndexFile[] | null> {
  try {
    // Loaded lazily on purpose: importing the worker pool pulls in Piscina, and CLI startup
    // time is asserted by tests/cli-startup-eager-modules.test.ts.
    const { prepareQueryIndexFilesInWorker } = await import("./workerPool.js");
    const prepared = await prepareQueryIndexFilesInWorker(
      projectRoot,
      files.map((file) => ({
        relativePath: file.path,
        sourceIdentity: file.sourceIdentity,
      })),
    );
    if (prepared && prepared.length < files.length) {
      diagnostics.filesSkipped = files.length - prepared.length;
    }
    return prepared;
  } catch (error) {
    diagnostics.fallbackReason = errorMessage(error);
    return null;
  }
}

async function pathIsSymlink(filePath: string): Promise<boolean> {
  try {
    return (await fs.lstat(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeSqliteCompanions(filePath: string): Promise<void> {
  await Promise.all([fs.rm(`${filePath}-wal`, { force: true }), fs.rm(`${filePath}-shm`, { force: true })]);
}

async function cleanupAbandonedQueryIndexFiles(paths: QueryIndexPaths): Promise<void> {
  let entries: Array<{ name: string }>;
  try {
    entries = await fs.readdir(paths.cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - QUERY_INDEX_TEMP_RETENTION_MS;
  for (const entry of entries) {
    if (!QUERY_INDEX_TEMP_PATTERN.test(entry.name)) continue;
    const candidate = path.join(paths.cacheRoot, entry.name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.mtimeMs > cutoff) continue;
      await fs.rm(candidate, { force: true });
      await removeSqliteCompanions(candidate);
    } catch {
      // Abandoned artifact cleanup must not block a query.
    }
  }
}

async function rebuildCorruptSidecar(
  paths: QueryIndexPaths,
  current: QueryIndexCurrentState,
  prepared: readonly PreparedQueryIndexFile[],
): Promise<QueryIndexStore> {
  const temporary = path.join(
    paths.cacheRoot,
    `search-v1.v${QUERY_INDEX_SCHEMA_VERSION}.tmp-${process.pid}-${randomUUID()}.sqlite`,
  );
  await fs.rm(paths.corrupt, { force: true });
  await removeSqliteCompanions(paths.corrupt);
  if (await fileExists(paths.sidecar)) await fs.rename(paths.sidecar, paths.corrupt);
  await removeSqliteCompanions(paths.sidecar);

  let temporaryStore: QueryIndexStore | undefined;
  try {
    temporaryStore = new QueryIndexStore(temporary);
    temporaryStore.replaceFiles(prepared, [], buildMetadata(current));
    temporaryStore.checkpoint();
    temporaryStore.close();
    temporaryStore = undefined;
    await fsyncFile(temporary);
    await fs.rename(temporary, paths.sidecar);
    return new QueryIndexStore(paths.sidecar);
  } catch (error) {
    temporaryStore?.close();
    await fs.rm(temporary, { force: true });
    await removeSqliteCompanions(temporary);
    throw error;
  }
}

function safeClose(store: QueryIndexStore | undefined): void {
  try {
    store?.close();
  } catch {
    // Closing is best effort on a fallback path.
  }
}

export async function ensureQueryIndex(snapshot: AgentProjectSnapshot): Promise<QueryIndexHandle> {
  const diagnostics = emptyDiagnostics("unavailable");
  if (process.env.CODEGRAPH_DISABLE_QUERY_SIDECAR === "1") return { store: null, diagnostics };
  if (snapshot.index.cacheMode !== "disk" || !snapshot.index.cacheRootDir) return { store: null, diagnostics };
  const current = currentQueryState(snapshot);
  if (!current) return { store: null, diagnostics };
  const requestedPaths = resolveQueryIndexPaths(snapshot.index.cacheRootDir);
  await fs.mkdir(requestedPaths.cacheRoot, { recursive: true });
  const paths = resolveQueryIndexPaths(await fs.realpath(requestedPaths.cacheRoot));
  await cleanupAbandonedQueryIndexFiles(paths);

  if (await pathIsSymlink(paths.sidecar)) return { store: null, diagnostics };
  const existedBefore = await fileExists(paths.sidecar);
  const openStarted = performance.now();
  let store: QueryIndexStore | undefined;
  try {
    store = new QueryIndexStore(paths.sidecar);
    store.assertReadable();
    diagnostics.openMs = elapsedMs(openStarted);
  } catch (error) {
    diagnostics.openMs = elapsedMs(openStarted);
    safeClose(store);
    if (error instanceof QueryIndexFutureSchemaError) {
      diagnostics.fallbackReason = errorMessage(error);
      return { store: null, diagnostics };
    }
    if (!(error instanceof QueryIndexSchemaError) && !isSqliteCorruptionError(error)) {
      diagnostics.fallbackReason = errorMessage(error);
      return { store: null, diagnostics };
    }

    const prepared = await prepareFiles(snapshot.root, current.files, diagnostics);
    if (!prepared) return { store: null, diagnostics };
    diagnostics.filesRead = prepared.filter((file) => file.sourceRead).length;
    diagnostics.filesAdded = prepared.length;
    const rebuildStarted = performance.now();
    try {
      const rebuilt = await rebuildCorruptSidecar(paths, current, prepared);
      diagnostics.sidecarState = "rebuilt-corrupt";
      diagnostics.updateMs = elapsedMs(rebuildStarted);
      return { store: rebuilt, diagnostics };
    } catch (rebuildError) {
      diagnostics.fallbackReason = errorMessage(rebuildError);
      return { store: null, diagnostics };
    }
  }

  const storedIdentities = store.sourceIdentities();
  try {
    assertStoredPaths(snapshot, storedIdentities);
  } catch {
    safeClose(store);
    const prepared = await prepareFiles(snapshot.root, current.files, diagnostics);
    if (!prepared) return { store: null, diagnostics };
    diagnostics.filesRead = prepared.filter((file) => file.sourceRead).length;
    diagnostics.filesAdded = prepared.length;
    const rebuildStarted = performance.now();
    try {
      const rebuilt = await rebuildCorruptSidecar(paths, current, prepared);
      diagnostics.sidecarState = "rebuilt-corrupt";
      diagnostics.updateMs = elapsedMs(rebuildStarted);
      return { store: rebuilt, diagnostics };
    } catch (rebuildError) {
      diagnostics.fallbackReason = errorMessage(rebuildError);
      return { store: null, diagnostics };
    }
  }

  if (
    metadataMatchesCurrent(store.metadata(), current) &&
    sourceIdentitiesMatch(storedIdentities, current.identities)
  ) {
    diagnostics.sidecarState = "hit";
    return { store, diagnostics };
  }

  const versions = expectedQueryIndexVersionMetadata();
  const metadata = store.metadata();
  const contentVersionsMatch =
    metadata.schemaVersion === versions.schemaVersion &&
    metadata.normalizerVersion === versions.normalizerVersion &&
    metadata.chunkerVersion === versions.chunkerVersion &&
    metadata.projectRootIdentity === current.projectRootIdentity;
  const changed = contentVersionsMatch
    ? current.files.filter((file) => storedIdentities.get(file.path) !== file.sourceIdentity)
    : current.files;
  const deleted = contentVersionsMatch
    ? [...storedIdentities.keys()].filter((file) => !current.identities.has(file))
    : [...storedIdentities.keys()];
  const prepared = await prepareFiles(snapshot.root, changed, diagnostics);
  if (!prepared) {
    store.close();
    return { store: null, diagnostics };
  }

  diagnostics.filesRead = prepared.filter((file) => file.sourceRead).length;
  diagnostics.filesAdded = prepared.filter((file) => !storedIdentities.has(file.path)).length;
  diagnostics.filesUpdated = prepared.length - diagnostics.filesAdded;
  diagnostics.filesDeleted = deleted.length;
  const updateStarted = performance.now();
  try {
    store.replaceFiles(prepared, deleted, buildMetadata(current));
    diagnostics.updateMs = elapsedMs(updateStarted);
    diagnostics.sidecarState = existedBefore ? "updated" : "created";
    return { store, diagnostics };
  } catch (error) {
    diagnostics.updateMs = elapsedMs(updateStarted);
    store.close();
    diagnostics.sidecarState = isSqliteBusyError(error) ? "writer-busy" : "unavailable";
    diagnostics.fallbackReason = errorMessage(error);
    return { store: null, diagnostics };
  }
}
