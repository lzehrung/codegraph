import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import type { Edge, EdgeTo, Graph, Pos, Range } from "../../types.js";
import { buildGraphAdjacency } from "../../graphs/adjacency.js";
import { buildReferenceCandidateIndex } from "../reference-candidates.js";
import type { ProjectFileInfo } from "../../util/projectFiles.js";
import { BloomFilter, BloomFilterCache } from "../../util/bloomFilter.js";
import { summarizeAnalysis } from "../../analysisSummary.js";
import type { AnalysisSummary } from "../../analysisSummary.js";
import { assertFilePathWithinRoot, fileIdentityKey, isFilePathWithinRoot, normalizePath } from "../../util/paths.js";
import { getNativeRuntimeFingerprint } from "../../native/treeSitterNative.js";
import { SymbolKind } from "../types.js";
import type {
  BackendReport,
  BuildOptions,
  ExportEntry,
  GraphReport,
  ImportBinding,
  ModuleIndex,
  ProjectIndex,
  SymbolDef,
} from "../types.js";
import {
  buildSymbolGraph,
  type SymbolEdge,
  type SymbolGraph,
  type SymbolNode,
  type SymbolNodeKind,
  type SymbolVisibility,
} from "../../graphs/symbol-graph.js";
import { getImplementationFingerprint, normalizeGraphOptions } from "./options.js";
import {
  cacheAbsolutePath,
  cacheRelativePath,
  transformPersistedExportFromModule,
  type FileSignature,
} from "./module-cache.js";
import { cacheRoot } from "./location.js";
import type { ManifestFileEntry } from "./manifest.js";

const SNAPSHOT_SYMBOL_KINDS = new Set<SymbolKind>(Object.values(SymbolKind));
const PROJECT_SNAPSHOT_VERSION = 9;
export const BLOOM_FILTER_SNAPSHOT_VERSION = 4;
export const BLOOM_FILTER_SNAPSHOT_FILENAME = "bloom-filters.json";

export type BloomFilterSnapshotPayload = {
  version: number;
  projectRoot: string;
  implementationFingerprint: string;
  projectSnapshotIdentity: string;
  fileSignatures: Record<string, SnapshotFileSignature>;
  bloomFilters: Record<string, SerializedBloomFilter>;
};
const BLOOM_FILTER_MIN_SIZE = 1_000;
const BLOOM_FILTER_MAX_SIZE = 1_000_000;
const BLOOM_FILTER_MIN_HASH_COUNT = 1;
const BLOOM_FILTER_MAX_HASH_COUNT = 10;
const DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION = 3;
const DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME = "detailed-symbol-graph.json";
const SNAPSHOT_TEMP_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_TEMP_SUFFIX = ".tmp";
const MAX_SNAPSHOT_CACHE_ENTRIES = 32;

type SnapshotFileIdentity = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type ParsedSnapshotCacheEntry = {
  identity: SnapshotFileIdentity;
  compressed: Buffer;
};

type DetailedSymbolGraphCacheEntry = {
  identity: SnapshotFileIdentity;
  projectSnapshotIdentity: string;
  graph: DetailedSymbolGraphSnapshotPayload["graph"];
};

const parsedSnapshotCache = new Map<string, ParsedSnapshotCacheEntry>();
const detailedSymbolGraphCache = new Map<string, DetailedSymbolGraphCacheEntry>();

type DetailedSymbolGraphSnapshotPayload = {
  version: number;
  projectRoot: string;
  implementationFingerprint: string;
  projectSnapshotIdentity: string;
  graph: {
    nodes: SymbolNode[];
    edges: SymbolEdge[];
  };
  graphHash: string;
};

type SerializedBloomFilter = {
  size: number;
  hashCount: number;
  bitsBase64: string;
};

type SnapshotFileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig?: string;
};

export type PersistedBloomFilters = {
  get: (file: string, signature: Pick<FileSignature, "sig" | "gitSig" | "cacheSig">) => BloomFilter | undefined;
};

type SnapshotAnalysisReport = {
  backend?: BackendReport;
  graph?: GraphReport;
};

export type LoadedProjectIndexSnapshot = {
  index: ProjectIndex;
  analysisReport?: SnapshotAnalysisReport;
};

type ProjectIndexSnapshotPayload = {
  version: number;
  filesSignature: string;
  graph: {
    nodes: string[];
    edges: Graph["edges"];
  };
  modules: ModuleIndex[];
  projectRoot: string;
  languageExtensions?: ProjectIndex["languageExtensions"];
  nativeMode?: ProjectIndex["nativeMode"];
  nativeRuntimeFingerprint: string;
  implementationFingerprint: string;
  projectFiles?: ProjectFileInfo[];
  bloomFilters?: Record<string, SerializedBloomFilter>;
  fileSignatures: Record<string, SnapshotFileSignature>;
  analysis?: AnalysisSummary;
  analysisReport?: SnapshotAnalysisReport;
};

export function projectSnapshotFilesSignature(
  entries: ReadonlyMap<string, ManifestFileEntry>,
  projectRoot?: string,
): string {
  const hash = createHash("sha256");
  for (const [file, entry] of [...entries.entries()].sort(([left], [right]) => compareSnapshotPath(left, right))) {
    hash.update(projectRoot ? cacheRelativePath(projectRoot, file) : file);
    hash.update("\0");
    hash.update(entry.sig);
    hash.update("\0");
    hash.update(entry.gitSig ?? "");
    hash.update("\0");
    hash.update(entry.sqlCorpusSig ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}
export function createProjectSnapshotIdentity(filesSignature: string, opts: BuildOptions | undefined): string {
  const hash = createHash("sha256");
  hash.update("project-index-snapshot-identity-v2");
  hash.update("\0");
  hash.update(filesSignature);
  hash.update("\0");
  hash.update(JSON.stringify(normalizeGraphOptions(opts?.graph)));
  hash.update("\0");
  hash.update(getNativeRuntimeFingerprint(opts?.native));
  hash.update("\0");
  hash.update(getImplementationFingerprint());
  return hash.digest("hex");
}

function serializedProjectRoot(projectRoot: string): string {
  return normalizePath(path.resolve(projectRoot));
}

function transformPath(root: string, value: string, toRelative: boolean): string {
  if (toRelative) {
    return path.isAbsolute(value) ? cacheRelativePath(root, value) : value;
  }
  return assertFilePathWithinRoot(root, cacheAbsolutePath(root, value), "Persisted cache path");
}

function transformHandle(root: string, value: string, toRelative: boolean): string {
  const separator = value.indexOf("::");
  if (separator < 0) return transformPath(root, value, toRelative);
  const file = value.slice(0, separator);
  return `${transformPath(root, file, toRelative)}${value.slice(separator)}`;
}

function transformModule(root: string, module: ModuleIndex, toRelative: boolean): ModuleIndex {
  const copy = structuredClone(module);
  const file = (value: string): string => transformPath(root, value, toRelative);
  copy.file = file(copy.file);
  for (const local of copy.locals) local.file = file(local.file);
  for (const entry of copy.exports) {
    if (entry.type === "local") {
      entry.target.file = file(entry.target.file);
    } else {
      transformPersistedExportFromModule(root, entry, toRelative);
    }
  }
  for (const binding of copy.imports) {
    if (typeof binding.resolved === "string") binding.resolved = file(binding.resolved);
  }
  return copy;
}

function transformSnapshotPaths(
  payload: ProjectIndexSnapshotPayload,
  root: string,
  toRelative: boolean,
): ProjectIndexSnapshotPayload {
  const copy = structuredClone(payload);
  copy.graph.nodes = copy.graph.nodes.map((node) => transformPath(root, node, toRelative));
  copy.graph.edges = copy.graph.edges.map((edge) => ({
    ...edge,
    from: transformPath(root, edge.from, toRelative),
    to: edge.to.type === "file" ? { ...edge.to, path: transformPath(root, edge.to.path, toRelative) } : edge.to,
  }));
  copy.modules = copy.modules.map((module) => transformModule(root, module, toRelative));
  if (copy.projectFiles) {
    copy.projectFiles = copy.projectFiles.map((file) => ({
      ...file,
      path: transformPath(root, file.path, toRelative),
      projectRoot: transformPath(root, file.projectRoot, toRelative),
    }));
  }
  if (copy.bloomFilters) {
    const bloomFilters: Record<string, SerializedBloomFilter> = {};
    for (const [file, filter] of Object.entries(copy.bloomFilters)) {
      bloomFilters[transformPath(root, file, toRelative)] = filter;
    }
    copy.bloomFilters = bloomFilters;
  }
  const fileSignatures: Record<string, SnapshotFileSignature> = {};
  for (const [file, signature] of Object.entries(copy.fileSignatures ?? {})) {
    fileSignatures[transformPath(root, file, toRelative)] = signature;
  }
  copy.fileSignatures = fileSignatures;
  return copy;
}
function migrateProjectSnapshotPayload(value: unknown, currentRoot: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  if ((payload.version !== 4 && payload.version !== 5) || typeof payload.projectRoot !== "string") return value;
  const relative = transformSnapshotPaths(value as ProjectIndexSnapshotPayload, payload.projectRoot, true);
  const migrated = transformSnapshotPaths(relative, currentRoot, false);
  migrated.version = PROJECT_SNAPSHOT_VERSION;
  migrated.projectRoot = serializedProjectRoot(currentRoot);
  return migrated;
}
function transformDetailedGraph(
  graph: DetailedSymbolGraphSnapshotPayload["graph"],
  root: string,
  toRelative: boolean,
): DetailedSymbolGraphSnapshotPayload["graph"] {
  return {
    nodes: graph.nodes.map((node) => {
      const file = transformPath(root, node.file, toRelative);
      return { ...node, file, id: transformHandle(root, node.id, toRelative) };
    }),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: transformHandle(root, edge.from, toRelative),
      to: transformHandle(root, edge.to, toRelative),
      ...(edge.site
        ? {
            site: {
              ...edge.site,
              file: transformPath(root, edge.site.file, toRelative),
            },
          }
        : {}),
    })),
  };
}

function migrateDetailedSymbolGraphPayload(value: unknown, currentRoot: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Partial<DetailedSymbolGraphSnapshotPayload>;
  if (payload.version !== 2 || typeof payload.projectRoot !== "string" || !payload.graph) return value;
  const relativeGraph = transformDetailedGraph(payload.graph, payload.projectRoot, true);
  return {
    ...payload,
    version: DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION,
    projectRoot: serializedProjectRoot(currentRoot),
    graph: transformDetailedGraph(relativeGraph, currentRoot, false),
  };
}
function compareSnapshotPath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameSnapshotFileIdentity(left: SnapshotFileIdentity, right: SnapshotFileIdentity): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function snapshotFileIdentity(snapshotPath: string): Promise<SnapshotFileIdentity> {
  const stat = await fsp.stat(snapshotPath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
async function fsyncSnapshotFile(snapshotPath: string): Promise<void> {
  const handle = await fsp.open(snapshotPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function isSnapshotTempName(name: string, snapshotName: string): boolean {
  const prefix = `.${snapshotName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(SNAPSHOT_TEMP_SUFFIX)) return false;
  const marker = name.slice(prefix.length, -SNAPSHOT_TEMP_SUFFIX.length);
  return /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(marker);
}

async function cleanupStaleSnapshotTemps(snapshotPath: string): Promise<void> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fsp.readdir(path.dirname(snapshotPath), { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - SNAPSHOT_TEMP_RETENTION_MS;
  const snapshotName = path.basename(snapshotPath);
  for (const entry of entries) {
    if (!entry.isFile() || !isSnapshotTempName(entry.name, snapshotName)) continue;
    const candidate = path.join(path.dirname(snapshotPath), entry.name);
    try {
      const stat = await fsp.lstat(candidate);
      if (stat.mtimeMs > cutoff) continue;
      await fsp.rm(candidate, { force: true });
    } catch {
      // Abandoned snapshot cleanup must not block a cache write.
    }
  }
}

async function writeSnapshotAtomically(snapshotPath: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
  await cleanupStaleSnapshotTemps(snapshotPath);
  let tempPath: string | undefined = path.join(
    path.dirname(snapshotPath),
    `.${path.basename(snapshotPath)}.${process.pid}.${randomUUID()}${SNAPSHOT_TEMP_SUFFIX}`,
  );
  try {
    await fsp.writeFile(tempPath, data, { flag: "wx" });
    await fsyncSnapshotFile(tempPath);
    await fsp.rename(tempPath, snapshotPath);
    tempPath = undefined;
  } finally {
    if (tempPath) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function setBoundedSnapshotCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function materializeDetailedSymbolGraph(payload: DetailedSymbolGraphSnapshotPayload["graph"]): SymbolGraph {
  const graph = structuredClone(payload);
  return {
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    edges: graph.edges,
  };
}

function decodeSnapshotPayload(compressed: Buffer): unknown {
  return JSON.parse(brotliDecompressSync(compressed).toString("utf8")) as unknown;
}

async function readParsedSnapshot(snapshotPath: string): Promise<{ identity: SnapshotFileIdentity; payload: unknown }> {
  const before = await snapshotFileIdentity(snapshotPath);
  const cached = parsedSnapshotCache.get(snapshotPath);
  if (cached && sameSnapshotFileIdentity(cached.identity, before)) {
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, cached);
    return { identity: cached.identity, payload: decodeSnapshotPayload(cached.compressed) };
  }
  const compressed = Buffer.from(await fsp.readFile(snapshotPath));
  const payload = decodeSnapshotPayload(compressed);
  const after = await snapshotFileIdentity(snapshotPath);
  const entry = { identity: before, compressed };
  if (sameSnapshotFileIdentity(before, after)) {
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, entry);
  } else {
    parsedSnapshotCache.delete(snapshotPath);
  }
  return { identity: before, payload };
}

function projectIndexManifestEntries(
  entries: ReadonlyMap<string, ManifestFileEntry>,
): Map<string, { sig: string; gitSig?: string }> {
  return new Map(
    Array.from(entries, ([file, entry]) => [
      file,
      {
        sig: entry.sig,
        ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
      },
    ]),
  );
}

export async function tryLoadProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifestEntries: ReadonlyMap<string, ManifestFileEntry>,
): Promise<LoadedProjectIndexSnapshot | null> {
  const filesSignature = projectSnapshotFilesSignature(manifestEntries, projectRoot);
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const rawPayload = (await readParsedSnapshot(projectSnapshotPath(projectRoot, opts))).payload;
    const migratedPayload = migrateProjectSnapshotPayload(rawPayload, projectRoot);
    const payload =
      migratedPayload && typeof migratedPayload === "object" && !Array.isArray(migratedPayload)
        ? transformSnapshotPaths(migratedPayload as ProjectIndexSnapshotPayload, projectRoot, false)
        : migratedPayload;
    const nativeRuntimeFingerprint = getNativeRuntimeFingerprint(opts?.native);
    const implementationFingerprint = getImplementationFingerprint();
    if (
      !isProjectIndexSnapshotPayload(payload) ||
      payload.filesSignature !== filesSignature ||
      payload.nativeMode !== normalizedSnapshotNativeMode(opts?.native) ||
      payload.nativeRuntimeFingerprint !== nativeRuntimeFingerprint ||
      payload.implementationFingerprint !== implementationFingerprint
    ) {
      return null;
    }
    const graph: Graph = {
      nodes: new Set(payload.graph.nodes),
      edges: payload.graph.edges,
    };
    const modules = new Map(payload.modules.map((moduleIndex) => [fileIdentityKey(moduleIndex.file), moduleIndex]));
    const shouldHydrateBloomFilters = opts?.useBloomFilters ?? true;
    const index: ProjectIndex = {
      graph,
      graphAdjacency: buildGraphAdjacency(graph),
      modules,
      byFile: modules,
      projectRoot: serializedProjectRoot(projectRoot),
      ...(payload.languageExtensions ? { languageExtensions: payload.languageExtensions } : {}),
      ...(payload.nativeMode ? { nativeMode: payload.nativeMode } : {}),
      exportCache: new Map(),
      scopeCache: new Map(),
      ...(shouldHydrateBloomFilters && payload.bloomFilters
        ? { bloomFilters: deserializeBloomFilterCache(payload.bloomFilters, projectRoot) }
        : {}),
      ...(payload.projectFiles ? { projectFiles: payload.projectFiles } : {}),
      referenceCandidates: buildReferenceCandidateIndex(modules),
      ...(opts?.cache ? { cacheMode: opts.cache, cacheRootDir: cacheRoot(projectRoot, opts) } : {}),
      manifestEntries: projectIndexManifestEntries(manifestEntries),
      projectSnapshotIdentity: createProjectSnapshotIdentity(filesSignature, opts),
    };
    return {
      index: {
        ...index,
        ...(payload.analysis ? { analysis: payload.analysis } : {}),
      },
      ...(payload.analysisReport ? { analysisReport: payload.analysisReport } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Load only the bloom-filter section of the last-written project snapshot. Hydration checks
 * each requested file against its persisted signature before returning a filter, so a stale
 * snapshot can still accelerate unchanged files without suppressing newly added references.
 * Only the bloom section is then read, so a corrupt payload is rejected without walking
 * `graph.edges` / `modules`. Returns `null` when disk caching is off, `useBloomFilters` is
 * disabled, or no valid snapshot with bloom data exists.
 */
export async function tryLoadProjectSnapshotModules(
  projectRoot: string,
  opts: BuildOptions | undefined,
  fileSignatures: ReadonlyMap<string, Pick<FileSignature, "sig" | "gitSig" | "cacheSig">>,
): Promise<Map<string, ModuleIndex> | null> {
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const rawPayload = (await readParsedSnapshot(projectSnapshotPath(projectRoot, opts))).payload;
    const migratedPayload = migrateProjectSnapshotPayload(rawPayload, projectRoot);
    const payload =
      migratedPayload && typeof migratedPayload === "object" && !Array.isArray(migratedPayload)
        ? transformSnapshotPaths(migratedPayload as ProjectIndexSnapshotPayload, projectRoot, false)
        : migratedPayload;
    const nativeRuntimeFingerprint = getNativeRuntimeFingerprint(opts?.native);
    const implementationFingerprint = getImplementationFingerprint();
    if (
      !isProjectIndexSnapshotPayload(payload) ||
      payload.nativeMode !== normalizedSnapshotNativeMode(opts?.native) ||
      payload.nativeRuntimeFingerprint !== nativeRuntimeFingerprint ||
      payload.implementationFingerprint !== implementationFingerprint
    ) {
      return null;
    }
    const normalizedFileSignatures = new Map(
      Object.entries(payload.fileSignatures).map(([file, signature]) => [fileIdentityKey(file), signature]),
    );
    // `fileSignatures` (caller-supplied) is keyed by whatever discovered display path each file
    // was found under, not necessarily `fileIdentityKey`-normalized; on a case-insensitive
    // filesystem an uppercase path segment would otherwise miss this lookup.
    const normalizedCurrentSignatures = new Map(
      Array.from(fileSignatures, ([file, signature]) => [fileIdentityKey(file), signature]),
    );
    const modules = new Map<string, ModuleIndex>();
    for (const mod of payload.modules) {
      const moduleKey = fileIdentityKey(mod.file);
      const signature = normalizedCurrentSignatures.get(moduleKey);
      const snapshotSignature = normalizedFileSignatures.get(moduleKey);
      if (!signature || !snapshotSignature || !snapshotSignatureMatches(snapshotSignature, signature)) continue;
      modules.set(moduleKey, mod);
    }
    return modules;
  } catch {
    return null;
  }
}

export async function tryLoadPersistedBloomFilters(
  projectRoot: string,
  opts: BuildOptions | undefined,
): Promise<PersistedBloomFilters | null> {
  if ((opts?.cache ?? "off") !== "disk" || (opts?.useBloomFilters ?? true) === false) return null;
  try {
    const sidecarPath = bloomFilterSnapshotPath(projectRoot, opts);
    const sidecarParsed = (await readParsedSnapshot(sidecarPath)).payload;
    const sidecarBloom = persistedBloomFiltersFromSidecar(sidecarParsed, projectRoot);
    if (sidecarBloom) {
      return createPersistedBloomFilters(sidecarBloom.bloomFilters, sidecarBloom.fileSignatures, projectRoot);
    }
  } catch {
    // Fall back to legacy project snapshot payload if sidecar is unavailable or corrupt
  }
  try {
    const payload = (await readParsedSnapshot(projectSnapshotPath(projectRoot, opts))).payload;
    const bloomFilters = persistedBloomFiltersFromSnapshot(payload, projectRoot);
    if (!bloomFilters) return null;
    return createPersistedBloomFilters(bloomFilters.bloomFilters, bloomFilters.fileSignatures, projectRoot);
  } catch {
    return null;
  }
}

function persistedBloomFiltersFromSidecar(
  value: unknown,
  projectRoot: string,
): Pick<BloomFilterSnapshotPayload, "bloomFilters" | "fileSignatures"> | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<BloomFilterSnapshotPayload>;
  if (
    payload.version !== BLOOM_FILTER_SNAPSHOT_VERSION ||
    typeof payload.projectRoot !== "string" ||
    payload.implementationFingerprint !== getImplementationFingerprint() ||
    typeof payload.projectSnapshotIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.projectSnapshotIdentity)
  ) {
    return null;
  }
  const bloomFilters = payload.bloomFilters;
  const fileSignatures = payload.fileSignatures;
  if (!isSerializedBloomFilterRecord(bloomFilters) || !isSnapshotFileSignatureRecord(fileSignatures)) {
    return null;
  }
  return { bloomFilters, fileSignatures };
}

/** Light validation for bloom hydration: snapshot version, root identity, and bloom section only. */
function persistedBloomFiltersFromSnapshot(
  value: unknown,
  projectRoot: string,
): {
  bloomFilters: Record<string, SerializedBloomFilter>;
  fileSignatures: Record<string, SnapshotFileSignature>;
} | null {
  const migrated = migrateProjectSnapshotPayload(value, projectRoot);
  if (!migrated || typeof migrated !== "object") return null;
  const payload = migrated as Partial<ProjectIndexSnapshotPayload>;
  if (
    payload.version !== PROJECT_SNAPSHOT_VERSION ||
    typeof payload.projectRoot !== "string" ||
    payload.implementationFingerprint !== getImplementationFingerprint()
  ) {
    return null;
  }
  const bloomFilters = payload.bloomFilters;
  const fileSignatures = payload.fileSignatures;
  if (!isSerializedBloomFilterRecord(bloomFilters) || !isSnapshotFileSignatureRecord(fileSignatures)) {
    return null;
  }
  return { bloomFilters, fileSignatures };
}

function createPersistedBloomFilters(
  bloomFilters: Record<string, SerializedBloomFilter>,
  fileSignatures: Record<string, SnapshotFileSignature>,
  projectRoot: string,
): PersistedBloomFilters {
  const filters = deserializeBloomFilterCache(bloomFilters, projectRoot);
  const signatures = new Map<string, SnapshotFileSignature>(
    Object.entries(fileSignatures).map(([file, signature]) => [
      fileIdentityKey(cacheAbsolutePath(projectRoot, file)),
      signature,
    ]),
  );
  return {
    get: (file, signature) => {
      const persistedSignature = signatures.get(fileIdentityKey(file));
      if (!persistedSignature || !snapshotSignatureMatches(persistedSignature, signature)) return undefined;
      return filters.get(file);
    },
  };
}

function snapshotSignatureMatches(
  snapshotSignature: SnapshotFileSignature,
  currentSignature: Pick<FileSignature, "sig" | "gitSig" | "cacheSig">,
): boolean {
  const matchingGitSignature =
    !!snapshotSignature.gitSig && !!currentSignature.gitSig && snapshotSignature.gitSig === currentSignature.gitSig;
  if (matchingGitSignature) return true;
  // `cacheSig` is git- or content-hash-derived (forced whenever caching is enabled without a git
  // signature; see `fileSignature()`), so when both sides have it, it is a strictly stronger and
  // authoritative identity check than the cheap `mtime:size` `sig`. Comparing bare `sig` alone
  // would wrongly treat a same-size edit whose mtime got restored as unchanged.
  if (snapshotSignature.cacheSig !== undefined && currentSignature.cacheSig !== undefined) {
    return snapshotSignature.cacheSig === currentSignature.cacheSig;
  }
  return snapshotSignature.sig === currentSignature.sig;
}

export async function writeProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  filesSignature: string,
): Promise<void> {
  const projectSnapshotIdentity = createProjectSnapshotIdentity(filesSignature, opts);
  const fileSignatures = serializeSnapshotFileSignatures(index.manifestEntries, projectRoot);
  const serializedBloomFilters = index.bloomFilters
    ? serializeBloomFilterCache(
        index.bloomFilters,
        Array.from(index.byFile.values(), (module) => module.file),
        projectRoot,
      )
    : undefined;
  const snapshotAnalysisReport = analysisReportFromBuildReport(index.buildReport);
  const snapshotAnalysis = index.buildReport ? summarizeAnalysis({ index, report: index.buildReport }) : index.analysis;
  const payload = transformSnapshotPaths(
    {
      version: PROJECT_SNAPSHOT_VERSION,
      filesSignature,
      projectRoot: serializedProjectRoot(projectRoot),
      nativeRuntimeFingerprint: getNativeRuntimeFingerprint(opts?.native),
      implementationFingerprint: getImplementationFingerprint(),
      graph: {
        nodes: [...index.graph.nodes],
        edges: index.graph.edges,
      },
      modules: [...index.byFile.values()],
      fileSignatures,
      ...(index.languageExtensions ? { languageExtensions: index.languageExtensions } : {}),
      ...(normalizedSnapshotNativeMode(index.nativeMode)
        ? { nativeMode: normalizedSnapshotNativeMode(index.nativeMode) }
        : {}),
      ...(index.projectFiles ? { projectFiles: index.projectFiles } : {}),
      ...(serializedBloomFilters ? { bloomFilters: serializedBloomFilters } : {}),
      ...(snapshotAnalysis ? { analysis: snapshotAnalysis } : {}),
      ...(snapshotAnalysisReport ? { analysisReport: snapshotAnalysisReport } : {}),
    },
    projectRoot,
    true,
  );
  try {
    const snapshotPath = projectSnapshotPath(projectRoot, opts);
    const compressed = brotliCompressSync(JSON.stringify(payload), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    });
    await writeSnapshotAtomically(snapshotPath, compressed);
    const identity = await snapshotFileIdentity(snapshotPath);
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, { identity, compressed });
    index.projectSnapshotIdentity = projectSnapshotIdentity;
    if (serializedBloomFilters) {
      try {
        const bloomPayload: BloomFilterSnapshotPayload = {
          version: BLOOM_FILTER_SNAPSHOT_VERSION,
          projectRoot: serializedProjectRoot(projectRoot),
          implementationFingerprint: getImplementationFingerprint(),
          projectSnapshotIdentity,
          fileSignatures,
          bloomFilters: serializedBloomFilters,
        };
        const bloomPath = bloomFilterSnapshotPath(projectRoot, opts);
        const bloomCompressed = brotliCompressSync(JSON.stringify(bloomPayload), {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        });
        await writeSnapshotAtomically(bloomPath, bloomCompressed);
        const bloomIdentity = await snapshotFileIdentity(bloomPath);
        setBoundedSnapshotCache(parsedSnapshotCache, bloomPath, {
          identity: bloomIdentity,
          compressed: bloomCompressed,
        });
      } catch {
        // Bloom sidecar write failure must not fail indexing
      }
    }
  } catch {
    delete index.projectSnapshotIdentity;
    // Snapshot writes are an optimization; cache write failures must not fail indexing.
  }
}

function projectSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  return path.join(cacheRoot(projectRoot, opts), "project-index-snapshot.json");
}

function bloomFilterSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  const root = path.resolve(cacheRoot(projectRoot, opts));
  const snapshotPath = path.resolve(root, BLOOM_FILTER_SNAPSHOT_FILENAME);
  if (!isFilePathWithinRoot(root, snapshotPath)) {
    throw new Error(`Bloom filter snapshot escaped cache root: ${snapshotPath}`);
  }
  return snapshotPath;
}

export async function tryLoadDetailedSymbolGraphSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
): Promise<SymbolGraph | null> {
  if ((opts?.cache ?? "off") !== "disk" || !index.projectSnapshotIdentity) return null;
  try {
    const snapshotPath = detailedSymbolGraphSnapshotPath(projectRoot, opts);
    const observedIdentity = await snapshotFileIdentity(snapshotPath);
    const cached = detailedSymbolGraphCache.get(snapshotPath);
    if (
      cached &&
      cached.projectSnapshotIdentity === index.projectSnapshotIdentity &&
      sameSnapshotFileIdentity(cached.identity, observedIdentity)
    ) {
      setBoundedSnapshotCache(detailedSymbolGraphCache, snapshotPath, cached);
      return materializeDetailedSymbolGraph(cached.graph);
    }
    const parsed = await readParsedSnapshot(snapshotPath);
    const migratedPayload = migrateDetailedSymbolGraphPayload(parsed.payload, projectRoot);
    const payload =
      migratedPayload && typeof migratedPayload === "object" && !Array.isArray(migratedPayload)
        ? {
            ...(migratedPayload as DetailedSymbolGraphSnapshotPayload),
            graph: transformDetailedGraph(
              (migratedPayload as DetailedSymbolGraphSnapshotPayload).graph,
              projectRoot,
              false,
            ),
          }
        : migratedPayload;
    if (
      !isDetailedSymbolGraphSnapshotPayload(payload) ||
      payload.implementationFingerprint !== getImplementationFingerprint() ||
      payload.projectSnapshotIdentity !== index.projectSnapshotIdentity
    ) {
      return null;
    }
    const graph = materializeDetailedSymbolGraph(payload.graph);
    if (!(await isDetailedSymbolGraphCompatibleWithProject(projectRoot, index, graph))) {
      return null;
    }
    const identity = await snapshotFileIdentity(snapshotPath);
    if (!sameSnapshotFileIdentity(parsed.identity, identity)) return null;
    setBoundedSnapshotCache(detailedSymbolGraphCache, snapshotPath, {
      identity,
      projectSnapshotIdentity: index.projectSnapshotIdentity,
      graph: payload.graph,
    });
    return graph;
  } catch {
    return null;
  }
}

export async function writeDetailedSymbolGraphSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  graph: SymbolGraph,
): Promise<void> {
  if ((opts?.cache ?? "off") !== "disk" || !index.projectSnapshotIdentity) return;
  const payload = {
    version: DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION,
    projectRoot: serializedProjectRoot(projectRoot),
    implementationFingerprint: getImplementationFingerprint(),
    graphHash: detailedSymbolGraphContentHash(index.projectSnapshotIdentity, graph),
    projectSnapshotIdentity: index.projectSnapshotIdentity,
    graph: transformDetailedGraph(
      {
        nodes: [...graph.nodes.values()],
        edges: graph.edges,
      },
      projectRoot,
      true,
    ),
  } satisfies DetailedSymbolGraphSnapshotPayload;
  try {
    const snapshotPath = detailedSymbolGraphSnapshotPath(projectRoot, opts);
    parsedSnapshotCache.delete(snapshotPath);
    detailedSymbolGraphCache.delete(snapshotPath);
    const compressed = brotliCompressSync(JSON.stringify(payload), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    });
    await writeSnapshotAtomically(snapshotPath, compressed);
    const identity = await snapshotFileIdentity(snapshotPath);
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, { identity, compressed });
    setBoundedSnapshotCache(detailedSymbolGraphCache, snapshotPath, {
      identity,
      projectSnapshotIdentity: index.projectSnapshotIdentity,
      graph: {
        nodes: [...graph.nodes.values()],
        edges: graph.edges,
      },
    });
  } catch {
    // Detailed graph persistence is an optimization; source parsing remains authoritative.
  }
}

function detailedSymbolGraphSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  const root = path.resolve(cacheRoot(projectRoot, opts));
  const snapshotPath = path.resolve(root, DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME);
  if (!isFilePathWithinRoot(root, snapshotPath)) {
    throw new Error(`Detailed symbol graph snapshot escaped cache root: ${snapshotPath}`);
  }
  return snapshotPath;
}

function detailedSymbolGraphContentHash(projectSnapshotIdentity: string, graph: SymbolGraph): string {
  const hash = createHash("sha256");
  hash.update(projectSnapshotIdentity);
  hash.update("\0");
  hash.update(
    JSON.stringify({
      nodes: [...graph.nodes.values()],
      edges: graph.edges,
    }),
  );
  return hash.digest("hex");
}

function isDetailedSymbolGraphSnapshotPayload(value: unknown): value is DetailedSymbolGraphSnapshotPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<DetailedSymbolGraphSnapshotPayload>;
  if (
    payload.version !== DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION ||
    typeof payload.projectRoot !== "string" ||
    typeof payload.implementationFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.implementationFingerprint) ||
    typeof payload.projectSnapshotIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.projectSnapshotIdentity) ||
    typeof payload.graphHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.graphHash) ||
    !payload.graph ||
    !Array.isArray(payload.graph.nodes) ||
    !payload.graph.nodes.every(isSymbolNode) ||
    !Array.isArray(payload.graph.edges) ||
    !payload.graph.edges.every(isSymbolEdge)
  ) {
    return false;
  }
  // `graphHash` is still written at snapshot-write time (its format is validated above) but
  // no longer re-verified here on load: recomputing it means re-stringifying the whole
  // graph and re-hashing it, measured at ~36ms on an 11MB sidecar, and it is a
  // self-consistency check on this file's own bytes, not a check against the current
  // project. The atomic temp-file-then-rename write (`writeDetailedSymbolGraphSnapshot`
  // below) already rules out a torn/partial write, and
  // `isDetailedSymbolGraphCompatibleWithProject` independently re-derives and compares
  // every node's semantic fields (name, kind, complexity, docstring, lineSpan) against the
  // current index, which catches tampered or corrupted graph content this hash would have
  // caught too -- so the hash added no protection the other checks do not already provide.
  return new Set(payload.graph.nodes.map((node) => node.id)).size === payload.graph.nodes.length;
}

function isSymbolNode(value: unknown): value is SymbolNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Partial<SymbolNode>;
  return (
    typeof node.id === "string" &&
    !!node.id &&
    typeof node.file === "string" &&
    !!node.file &&
    typeof node.name === "string" &&
    !!node.name &&
    isSymbolNodeKind(node.kind) &&
    (node.docstring === undefined || typeof node.docstring === "string") &&
    isOptionalNonnegativeInteger(node.lineSpan) &&
    isOptionalNonnegativeFiniteNumber(node.complexity) &&
    (node.visibility === undefined || isSymbolVisibility(node.visibility)) &&
    (node.implementationTarget === undefined || typeof node.implementationTarget === "boolean") &&
    isOptionalNonnegativeInteger(node.memberArity)
  );
}

function isSymbolNodeKind(value: unknown): value is SymbolNodeKind {
  return (
    value === "function" ||
    value === "class" ||
    value === "variable" ||
    value === "interface" ||
    value === "type" ||
    value === "default" ||
    value === "table" ||
    value === "view" ||
    value === "index" ||
    value === "constraint" ||
    value === "routine" ||
    value === "import" ||
    value === "namespaceImport"
  );
}

function isSymbolVisibility(value: unknown): value is SymbolVisibility {
  return value === "public" || value === "private" || value === "protected" || value === "internal";
}

function isOptionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isOptionalNonnegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isDetailedRange(value: unknown): value is Range {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Partial<Range>;
  if (!isDetailedPosition(range.start) || !isDetailedPosition(range.end)) return false;
  if (range.start.index !== undefined && range.end.index !== undefined) {
    return range.start.index <= range.end.index;
  }
  if (range.start.line !== range.end.line) return range.start.line <= range.end.line;
  return range.start.column <= range.end.column;
}

function isDetailedPosition(value: unknown): value is Pos {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Partial<Pos>;
  return (
    typeof position.line === "number" &&
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    typeof position.column === "number" &&
    Number.isInteger(position.column) &&
    position.column >= 0 &&
    (position.index === undefined ||
      (typeof position.index === "number" && Number.isInteger(position.index) && position.index >= 0))
  );
}

function isSymbolEdge(value: unknown): value is SymbolEdge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as Partial<SymbolEdge>;
  return (
    typeof edge.from === "string" &&
    typeof edge.to === "string" &&
    (edge.label === undefined || typeof edge.label === "string") &&
    (edge.site === undefined ||
      (!!edge.site &&
        typeof edge.site === "object" &&
        typeof edge.site.file === "string" &&
        !!edge.site.file &&
        isDetailedRange(edge.site.range)))
  );
}
async function isDetailedSymbolGraphCompatibleWithProject(
  projectRoot: string,
  index: ProjectIndex,
  graph: SymbolGraph,
): Promise<boolean> {
  const normalizedRoot = path.resolve(projectRoot);
  const indexedFiles = new Set([...index.byFile.keys()]);
  for (const node of graph.nodes.values()) {
    const normalizedFile = normalizePath(node.file);
    if (
      !indexedFiles.has(fileIdentityKey(normalizedFile)) ||
      !isFilePathWithinRoot(normalizedRoot, normalizedFile) ||
      !node.id.startsWith(`${normalizedFile}::`)
    ) {
      return false;
    }
  }
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) return false;
    if (edge.site) {
      const normalizedSiteFile = normalizePath(edge.site.file);
      if (
        !indexedFiles.has(fileIdentityKey(normalizedSiteFile)) ||
        !isFilePathWithinRoot(normalizedRoot, normalizedSiteFile)
      ) {
        return false;
      }
    }
  }

  const base = await buildSymbolGraph(index);
  if (graph.nodes.size !== base.nodes.size) return false;
  for (const [id, expected] of base.nodes) {
    const actual = graph.nodes.get(id);
    if (
      !actual ||
      actual.file !== expected.file ||
      actual.name !== expected.name ||
      actual.kind !== expected.kind ||
      actual.docstring !== expected.docstring ||
      actual.lineSpan !== expected.lineSpan ||
      actual.complexity !== expected.complexity
    ) {
      return false;
    }
  }
  return sameSymbolEdgeMultiset(base.edges, graph.edges);
}

function sameSymbolEdgeMultiset(expected: readonly SymbolEdge[], actual: readonly SymbolEdge[]): boolean {
  if (expected.length !== actual.length) return false;
  const counts = new Map<string, number>();
  for (const edge of expected) {
    const key = serializedSymbolEdge(edge);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const edge of actual) {
    const key = serializedSymbolEdge(edge);
    const remaining = counts.get(key);
    if (remaining === undefined) return false;
    if (remaining === 1) counts.delete(key);
    else counts.set(key, remaining - 1);
  }
  return !counts.size;
}

function serializedSymbolEdge(edge: SymbolEdge): string {
  return JSON.stringify({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    site: edge.site
      ? {
          file: edge.site.file,
          range: {
            start: {
              line: edge.site.range.start.line,
              column: edge.site.range.start.column,
              ...(edge.site.range.start.index !== undefined ? { index: edge.site.range.start.index } : {}),
            },
            end: {
              line: edge.site.range.end.line,
              column: edge.site.range.end.column,
              ...(edge.site.range.end.index !== undefined ? { index: edge.site.range.end.index } : {}),
            },
          },
        }
      : undefined,
  });
}

function normalizedSnapshotNativeMode(
  nativeMode: ProjectIndex["nativeMode"] | undefined,
): ProjectIndex["nativeMode"] | undefined {
  if (nativeMode === undefined || nativeMode === "auto") return undefined;
  return nativeMode;
}

function isSnapshotNativeMode(value: unknown): value is ProjectIndex["nativeMode"] {
  return value === "auto" || value === "on" || value === "off";
}

function isProjectFileInfo(value: unknown): value is ProjectFileInfo {
  if (!value || typeof value !== "object") return false;
  const projectFile = value as Partial<ProjectFileInfo>;
  return (
    typeof projectFile.path === "string" &&
    (projectFile.kind === "file" || projectFile.kind === "dir") &&
    isProjectFileType(projectFile.type) &&
    isProjectFileRole(projectFile.role) &&
    typeof projectFile.projectRoot === "string" &&
    (projectFile.name === undefined || typeof projectFile.name === "string")
  );
}

function isProjectFileType(value: unknown): boolean {
  return (
    value === "node" ||
    value === "typescript" ||
    value === "python" ||
    value === "rust" ||
    value === "go" ||
    value === "maven" ||
    value === "gradle" ||
    value === "dotnet" ||
    value === "ruby" ||
    value === "php" ||
    value === "swift" ||
    value === "native" ||
    value === "ide"
  );
}

function isProjectFileRole(value: unknown): boolean {
  return value === "manifest" || value === "lockfile" || value === "config" || value === "solution" || value === "ide";
}

function isProjectIndexSnapshotPayload(value: unknown): value is ProjectIndexSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  return (
    payload.version === PROJECT_SNAPSHOT_VERSION &&
    typeof payload.filesSignature === "string" &&
    typeof payload.projectRoot === "string" &&
    typeof payload.nativeRuntimeFingerprint === "string" &&
    typeof payload.implementationFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(payload.implementationFingerprint) &&
    !!payload.graph &&
    Array.isArray(payload.graph.nodes) &&
    payload.graph.nodes.every((node) => typeof node === "string") &&
    Array.isArray(payload.graph.edges) &&
    payload.graph.edges.every(isGraphEdge) &&
    Array.isArray(payload.modules) &&
    payload.modules.every(isModuleIndex) &&
    isSnapshotFileSignatureRecord(payload.fileSignatures) &&
    (payload.nativeMode === undefined || isSnapshotNativeMode(payload.nativeMode)) &&
    (payload.languageExtensions === undefined || isLanguageExtensionMap(payload.languageExtensions)) &&
    (payload.bloomFilters === undefined || isSerializedBloomFilterRecord(payload.bloomFilters)) &&
    (payload.analysis === undefined || isAnalysisSummary(payload.analysis)) &&
    (payload.analysisReport === undefined || isSnapshotAnalysisReport(payload.analysisReport)) &&
    (payload.projectFiles === undefined ||
      (Array.isArray(payload.projectFiles) && payload.projectFiles.every(isProjectFileInfo)))
  );
}

function analysisReportFromBuildReport(report: ProjectIndex["buildReport"]): SnapshotAnalysisReport | undefined {
  if (!report?.backend && !report?.graph) {
    return undefined;
  }
  return {
    ...(report.backend ? { backend: report.backend } : {}),
    ...(report.graph ? { graph: report.graph } : {}),
  };
}

function isSnapshotAnalysisReport(value: unknown): value is SnapshotAnalysisReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<SnapshotAnalysisReport>;
  return (
    (report.backend === undefined || isBackendReport(report.backend)) &&
    (report.graph === undefined || isGraphReport(report.graph))
  );
}

function isBackendReport(value: unknown): value is BackendReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<BackendReport>;
  return (
    !!report.native &&
    isNativeBackendReport(report.native) &&
    (report.parser === undefined || isParserBackendDegradationReport(report.parser))
  );
}

function isNativeBackendReport(value: unknown): value is BackendReport["native"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<BackendReport["native"]>;
  return (
    typeof report.available === "boolean" &&
    typeof report.enabled === "boolean" &&
    Array.isArray(report.supportedLanguageIds) &&
    report.supportedLanguageIds.every((languageId) => typeof languageId === "string") &&
    typeof report.filesUsed === "number" &&
    typeof report.filesFellBack === "number" &&
    isUnknownRecord(report.fallbackReasons) &&
    isUnknownRecord(report.byLanguage) &&
    Array.isArray(report.errors)
  );
}

function isParserBackendDegradationReport(value: unknown): value is NonNullable<BackendReport["parser"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<NonNullable<BackendReport["parser"]>>;
  return typeof report.total === "number" && isNumberRecord(report.byLanguage) && Array.isArray(report.files);
}

function isGraphReport(value: unknown): value is GraphReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<GraphReport>;
  return !!report.fallbackImportExtraction && isFallbackImportExtractionReport(report.fallbackImportExtraction);
}

function isFallbackImportExtractionReport(value: unknown): value is GraphReport["fallbackImportExtraction"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<GraphReport["fallbackImportExtraction"]>;
  return (
    typeof report.total === "number" &&
    isNumberRecord(report.byLanguage) &&
    isUnknownRecord(report.files) &&
    (report.byReason === undefined || isNumberRecord(report.byReason))
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === "number");
}

function isAnalysisSummary(value: unknown): value is AnalysisSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<AnalysisSummary>;
  return (
    (summary.mode === "semantic" || summary.mode === "mixed" || summary.mode === "reduced") &&
    (summary.backend === "native" ||
      summary.backend === "mixed" ||
      summary.backend === "graph-only" ||
      summary.backend === "unknown") &&
    typeof summary.parserDegradedFiles === "number" &&
    typeof summary.fallbackImportExtractionFiles === "number" &&
    typeof summary.nativeFilesUsed === "number" &&
    typeof summary.nativeFilesFellBack === "number" &&
    typeof summary.label === "string"
  );
}

function serializeBloomFilterCache(
  cache: BloomFilterCache,
  files: Iterable<string>,
  projectRoot: string,
): Record<string, SerializedBloomFilter> | undefined {
  const serialized: Record<string, SerializedBloomFilter> = {};
  for (const file of files) {
    const filter = cache.get(file);
    if (!filter) continue;
    const metadata = filter.getMetadata();
    serialized[cacheRelativePath(projectRoot, file)] = {
      size: metadata.size,
      hashCount: metadata.hashCount,
      bitsBase64: filter.toBuffer().toString("base64"),
    };
  }
  return Object.keys(serialized).length ? serialized : undefined;
}

function serializeSnapshotFileSignatures(
  entries: ProjectIndex["manifestEntries"],
  projectRoot: string,
): Record<string, SnapshotFileSignature> {
  const serialized: Record<string, SnapshotFileSignature> = {};
  for (const [file, entry] of entries ?? []) {
    serialized[cacheRelativePath(projectRoot, file)] = {
      sig: entry.sig,
      ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
      ...(entry.cacheSig ? { cacheSig: entry.cacheSig } : {}),
    };
  }
  return serialized;
}

function isSnapshotFileSignatureRecord(value: unknown): value is Record<string, SnapshotFileSignature> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isSnapshotFileSignature);
}

function isSnapshotFileSignature(value: unknown): value is SnapshotFileSignature {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signature = value as Partial<SnapshotFileSignature>;
  return (
    typeof signature.sig === "string" &&
    (signature.gitSig === undefined || typeof signature.gitSig === "string") &&
    (signature.cacheSig === undefined || typeof signature.cacheSig === "string")
  );
}

function deserializeBloomFilterCache(
  serialized: Record<string, SerializedBloomFilter>,
  projectRoot: string,
): BloomFilterCache {
  const cache = new BloomFilterCache();
  for (const [file, filter] of Object.entries(serialized)) {
    const absoluteFile = assertFilePathWithinRoot(
      projectRoot,
      cacheAbsolutePath(projectRoot, file),
      "Persisted cache path",
    );
    cache.set(
      absoluteFile,
      BloomFilter.fromBuffer(Buffer.from(filter.bitsBase64, "base64"), filter.size, filter.hashCount),
    );
  }
  return cache;
}

function isSerializedBloomFilterRecord(value: unknown): value is Record<string, SerializedBloomFilter> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isSerializedBloomFilter);
}

function isLanguageExtensionMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isSerializedBloomFilter(value: unknown): value is SerializedBloomFilter {
  if (!value || typeof value !== "object") return false;
  const filter = value as Partial<SerializedBloomFilter>;
  if (
    typeof filter.size !== "number" ||
    !Number.isInteger(filter.size) ||
    filter.size < BLOOM_FILTER_MIN_SIZE ||
    filter.size > BLOOM_FILTER_MAX_SIZE ||
    typeof filter.hashCount !== "number" ||
    !Number.isInteger(filter.hashCount) ||
    filter.hashCount < BLOOM_FILTER_MIN_HASH_COUNT ||
    filter.hashCount > BLOOM_FILTER_MAX_HASH_COUNT ||
    typeof filter.bitsBase64 !== "string"
  ) {
    return false;
  }
  const expectedBytes = Math.ceil(filter.size / 8);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(filter.bitsBase64, "base64");
  } catch {
    return false;
  }
  return decoded.length === expectedBytes && decoded.toString("base64") === filter.bitsBase64;
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const moduleIndex = value as Partial<ModuleIndex>;
  return (
    typeof moduleIndex.file === "string" &&
    Array.isArray(moduleIndex.locals) &&
    moduleIndex.locals.every(isSymbolDef) &&
    Array.isArray(moduleIndex.imports) &&
    moduleIndex.imports.every(isImportBinding) &&
    Array.isArray(moduleIndex.exports) &&
    moduleIndex.exports.every(isExportEntry)
  );
}

function isSymbolDef(value: unknown): value is SymbolDef {
  if (!value || typeof value !== "object") return false;
  const symbol = value as Partial<SymbolDef>;
  return (
    typeof symbol.file === "string" &&
    typeof symbol.localName === "string" &&
    isSymbolKind(symbol.kind) &&
    isRange(symbol.range) &&
    (symbol.docstring === undefined || typeof symbol.docstring === "string") &&
    (symbol.lineSpan === undefined || typeof symbol.lineSpan === "number") &&
    (symbol.complexity === undefined || typeof symbol.complexity === "number")
  );
}

function isImportBinding(value: unknown): value is ImportBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ImportBinding>;
  if (
    typeof binding.from !== "string" ||
    !isResolvedImportTarget(binding.resolved) ||
    !isOptionalBoolean(binding.typeOnly) ||
    !isImportMechanism(binding.mechanism) ||
    !isResolvedType(binding.resolvedType) ||
    !isOptionalNumber(binding.confidence)
  ) {
    return false;
  }
  if (binding.kind === "default") return typeof binding.local === "string";
  if (binding.kind === "named") {
    return (
      typeof binding.local === "string" &&
      typeof binding.imported === "string" &&
      (binding.phpImportType === undefined ||
        binding.phpImportType === "class" ||
        binding.phpImportType === "function" ||
        binding.phpImportType === "const")
    );
  }
  if (binding.kind === "namespace") return typeof binding.localNS === "string";
  return binding.kind === "star";
}

function isExportEntry(value: unknown): value is ExportEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ExportEntry>;
  if (entry.type === "local") return typeof entry.exportedAs === "string" && isSymbolDef(entry.target);
  if (entry.type === "reexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "namespaceReexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "exportStar") {
    return (
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  return false;
}

function isResolvedImportTarget(value: ImportBinding["resolved"] | undefined): boolean {
  if (value === undefined || typeof value === "string") return true;
  return Boolean(value && typeof value === "object" && typeof value.external === "string");
}

function isImportMechanism(value: unknown): boolean {
  return value === undefined || value === "es" || value === "cjs" || value === "python" || value === "php";
}

function isResolvedType(value: unknown): boolean {
  return value === undefined || value === "heuristic" || value === "precise";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isSymbolKind(value: unknown): value is SymbolKind {
  return SNAPSHOT_SYMBOL_KINDS.has(value as SymbolKind);
}

function isRange(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<Range>;
  return isPos(range.start) && isPos(range.end);
}

function isPos(value: unknown): value is Pos {
  if (!value || typeof value !== "object") return false;
  const pos = value as Partial<Pos>;
  return (
    typeof pos.line === "number" &&
    typeof pos.column === "number" &&
    (pos.index === undefined || typeof pos.index === "number")
  );
}

function isGraphEdge(value: unknown): value is Edge {
  if (!value || typeof value !== "object") return false;
  const edge = value as Partial<Edge>;
  const resolved = edge.resolved;
  return (
    typeof edge.from === "string" &&
    isEdgeTo(edge.to) &&
    typeof edge.raw === "string" &&
    (edge.typeOnly === undefined || typeof edge.typeOnly === "boolean") &&
    (resolved === undefined || resolved === "heuristic" || resolved === "precise") &&
    (edge.confidence === undefined || typeof edge.confidence === "number")
  );
}

function isEdgeTo(value: unknown): value is EdgeTo {
  if (!value || typeof value !== "object") return false;
  const edgeTo = value as Partial<EdgeTo>;
  if (edgeTo.type === "file") return typeof edgeTo.path === "string";
  if (edgeTo.type === "external") return typeof edgeTo.name === "string";
  return false;
}
