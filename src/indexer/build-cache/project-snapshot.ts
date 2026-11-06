import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { isRubyLoadForm } from "../../util/specifiers.js";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import type { Edge, EdgeTo, Graph } from "../../types.js";
import { buildGraphAdjacency } from "../../graphs/adjacency.js";
import { buildReferenceCandidateIndex } from "../reference-candidates.js";
import type { ProjectFileInfo } from "../../util/project-files.js";
import { BloomFilter, BloomFilterCache } from "../../util/bloom-filter.js";
import { summarizeAnalysis } from "../../analysis-summary.js";
import type { AnalysisSummary } from "../../analysis-summary.js";
import { assertFilePathWithinRoot, fileIdentityKey, isFilePathWithinRoot, normalizePath } from "../../util/paths.js";
import { removeStaleTempFiles, writeFileAtomically } from "../../util/atomic-file.js";
import { getNativeRuntimeFingerprint } from "../../native/tree-sitter-native.js";
import { logWithLevel } from "../../logging.js";
import { SymbolKind } from "../types.js";
import { callableIdentityWithFile, isCallableIdentity } from "../callable-identity.js";
import { isCsharpNamespaceFacts } from "../../util/csharp-tree.js";
import { isJvmFileFacts } from "../../util/jvm-tree.js";
import type {
  BackendReport,
  BuildOptions,
  ExportEntry,
  ImportBinding,
  ModuleIndex,
  ProjectIndex,
  SymbolDef,
  BuildReport,
} from "../types.js";
import { getImplementationFingerprint, normalizeGraphOptions } from "./options.js";
import {
  cacheAbsolutePath,
  cacheRelativePath,
  listDiskCachedModuleFiles,
  loadAllCachedModules,
  transformPersistedExportFromModule,
  type FileSignature,
  isOptionalNativeOutcome,
  isOptionalRange,
  isParseErrorRange,
  isRange,
} from "./module-cache.js";
import { cacheRoot } from "./location.js";
import { recordCacheCorruption } from "./reports.js";
import type { ManifestFileEntry } from "./manifest.js";
import { compareCodeUnits } from "../../util/collections.js";
import { expandStarImports } from "../expand-star-imports.js";

const SNAPSHOT_SYMBOL_KINDS = new Set<SymbolKind>(Object.values(SymbolKind));
// The project snapshot embeds the filters that the bloom sidecar also holds, so a change to how a filter tokenizes
// source bumps both versions and neither copy of a filter built the old way is reused.
// Snapshot v14 and bloom sidecar v5: identifier tokens are also stored split at Unicode whitespace.
export const PROJECT_SNAPSHOT_VERSION = 14;
const LEGACY_EMBEDDED_MODULE_SNAPSHOT_VERSION = 10;
export const BLOOM_FILTER_SNAPSHOT_VERSION = 5;
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
  payload: unknown;
};

type TransformedSnapshotCacheEntry = {
  identity: SnapshotFileIdentity;
  root: string;
  payload: unknown;
};
type TransformedSnapshotModulesCacheEntry = {
  identity: SnapshotFileIdentity;
  root: string;
  payload: unknown;
};

const parsedSnapshotCache = new Map<string, ParsedSnapshotCacheEntry>();
const transformedSnapshotCache = new Map<string, TransformedSnapshotCacheEntry>();
const transformedSnapshotModulesCache = new Map<string, TransformedSnapshotModulesCacheEntry>();
const hydratedSnapshotModulesCache = new Map<string, HydratedSnapshotModulesCacheEntry>();

type HydratedSnapshotModulesCacheEntry = {
  identity: SnapshotFileIdentity;
  root: string;
  modules: Map<string, ModuleIndex>;
};

type SerializedBloomFilter = {
  size: number;
  hashCount: number;
  bitsBase64: string;
};

type ProjectSnapshotModulesPayload = Pick<
  ProjectIndexSnapshotPayload,
  | "version"
  | "filesSignature"
  | "projectRoot"
  | "nativeRuntimeFingerprint"
  | "implementationFingerprint"
  | "modules"
  | "fileSignatures"
>;

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
  for (const [file, entry] of [...entries.entries()].sort(([left], [right]) => compareCodeUnits(left, right))) {
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
  hash.update(getNativeRuntimeFingerprint());
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

function transformModule(root: string, module: ModuleIndex, toRelative: boolean): ModuleIndex {
  const file = (value: string): string => transformPath(root, value, toRelative);
  const symbol = (local: SymbolDef): SymbolDef => {
    const nextFile = file(local.file);
    return {
      ...local,
      file: nextFile,
      ...(local.callable ? { callable: callableIdentityWithFile(local.callable, local.file, nextFile) } : {}),
    };
  };
  return {
    ...module,
    file: file(module.file),
    locals: module.locals.map(symbol),
    exports: module.exports.map((entry) => {
      if (entry.type === "local") {
        return { ...entry, target: symbol(entry.target) };
      }
      const copy = { ...entry };
      transformPersistedExportFromModule(root, copy, toRelative);
      return copy;
    }),
    imports: module.imports.map((binding) => ({
      ...binding,
      ...(typeof binding.resolved === "string" ? { resolved: file(binding.resolved) } : {}),
      ...(binding.kind === "star" && binding.jvmPackageFiles
        ? { jvmPackageFiles: binding.jvmPackageFiles.map(file) }
        : {}),
    })),
  };
}

function transformSnapshotAnalysisReport(
  root: string,
  persistedProjectRoot: string,
  report: SnapshotAnalysisReport,
  toRelative: boolean,
): SnapshotAnalysisReport {
  const reportFile = (file: string): string => {
    if (file === "unknown") return file;
    if (
      !toRelative &&
      path.isAbsolute(file) &&
      !isFilePathWithinRoot(root, file) &&
      isFilePathWithinRoot(persistedProjectRoot, file)
    ) {
      return transformPath(root, cacheRelativePath(persistedProjectRoot, file), false);
    }
    return transformPath(root, file, toRelative);
  };
  const transformed: SnapshotAnalysisReport = {};
  if (report.backend) {
    const backend: BackendReport = {
      ...report.backend,
      native: {
        ...report.backend.native,
        errors: report.backend.native.errors.map((error) => ({ ...error, file: reportFile(error.file) })),
      },
    };
    if (report.backend.parser) {
      backend.parser = {
        ...report.backend.parser,
        files: report.backend.parser.files.map((entry) => ({
          ...entry,
          file: reportFile(entry.file),
        })),
      };
    }
    transformed.backend = backend;
  }
  return transformed;
}

function transformSnapshotPaths(
  payload: ProjectIndexSnapshotPayload,
  root: string,
  toRelative: boolean,
): ProjectIndexSnapshotPayload {
  const bloomFilters = payload.bloomFilters
    ? Object.fromEntries(
        Object.entries(payload.bloomFilters).map(([file, filter]) => [transformPath(root, file, toRelative), filter]),
      )
    : undefined;
  const fileSignatures = Object.fromEntries(
    Object.entries(payload.fileSignatures ?? {}).map(([file, signature]) => [
      transformPath(root, file, toRelative),
      signature,
    ]),
  );
  const transformed: ProjectIndexSnapshotPayload = {
    ...payload,
    graph: {
      nodes: payload.graph.nodes.map((node) => transformPath(root, node, toRelative)),
      edges: payload.graph.edges.map((edge) => ({
        ...edge,
        from: transformPath(root, edge.from, toRelative),
        to: edge.to.type === "file" ? { ...edge.to, path: transformPath(root, edge.to.path, toRelative) } : edge.to,
      })),
    },
    modules: payload.modules.map((module) => transformModule(root, module, toRelative)),
    ...(payload.projectFiles
      ? {
          projectFiles: payload.projectFiles.map((file) => ({
            ...file,
            path: transformPath(root, file.path, toRelative),
            projectRoot: transformPath(root, file.projectRoot, toRelative),
          })),
        }
      : {}),
    ...(bloomFilters ? { bloomFilters } : {}),
    fileSignatures,
  };
  if (payload.analysisReport) {
    transformed.analysisReport = transformSnapshotAnalysisReport(
      root,
      payload.projectRoot,
      payload.analysisReport,
      toRelative,
    );
  }
  return transformed;
}
function migrateProjectSnapshotPayload(value: unknown, currentRoot: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  if ((payload.version !== 4 && payload.version !== 5) || typeof payload.projectRoot !== "string") return value;
  const relative = transformSnapshotPaths(value as ProjectIndexSnapshotPayload, payload.projectRoot, true);
  const migrated = transformSnapshotPaths(relative, currentRoot, false);
  migrated.version = PROJECT_SNAPSHOT_VERSION;
  migrated.projectRoot = serializedProjectRoot(currentRoot);
  // Git-aware metadata discovery changed after v5. Keep reusable graph data, but rebuild this
  // derived field under current ignore rules before the migrated snapshot is reused.
  delete migrated.projectFiles;
  return migrated;
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

function isSnapshotTempName(name: string, snapshotName: string): boolean {
  const prefix = `.${snapshotName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(SNAPSHOT_TEMP_SUFFIX)) return false;
  const marker = name.slice(prefix.length, -SNAPSHOT_TEMP_SUFFIX.length);
  return /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(marker);
}

export async function writeSnapshotAtomically(snapshotPath: string, data: Buffer): Promise<void> {
  const snapshotDirectory = path.dirname(snapshotPath);
  await fsp.mkdir(snapshotDirectory, { recursive: true });
  const snapshotName = path.basename(snapshotPath);
  await removeStaleTempFiles(
    snapshotDirectory,
    (entry) => entry.isFile() && isSnapshotTempName(entry.name, snapshotName),
  );
  await writeFileAtomically(snapshotPath, data);
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

function freezeSnapshotPayload<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeSnapshotPayload(child);
  return value;
}

function decodeSnapshotPayload(compressed: Buffer): unknown {
  return JSON.parse(brotliDecompressSync(compressed).toString("utf8")) as unknown;
}

export function recordSnapshotInvalidation(artifact: string, reason: string, logLevel: BuildOptions["logLevel"]): void {
  logWithLevel(logLevel, "debug", `Cache artifact invalidated ${artifact}: ${reason}`);
}
export function isMissingArtifactError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function readParsedSnapshot(snapshotPath: string): Promise<{ identity: SnapshotFileIdentity; payload: unknown }> {
  const before = await snapshotFileIdentity(snapshotPath);
  const cached = parsedSnapshotCache.get(snapshotPath);
  if (cached && sameSnapshotFileIdentity(cached.identity, before)) {
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, cached);
    return { identity: cached.identity, payload: cached.payload };
  }
  const compressed = Buffer.from(await fsp.readFile(snapshotPath));
  const payload = decodeSnapshotPayload(compressed);
  const after = await snapshotFileIdentity(snapshotPath);
  const entry = { identity: before, compressed, payload };
  if (sameSnapshotFileIdentity(before, after)) {
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, entry);
  } else {
    parsedSnapshotCache.delete(snapshotPath);
  }
  return { identity: before, payload };
}

function transformCachedProjectSnapshot(
  snapshotPath: string,
  identity: SnapshotFileIdentity,
  rawPayload: unknown,
  projectRoot: string,
): unknown {
  const cached = transformedSnapshotCache.get(snapshotPath);
  if (cached && cached.root === projectRoot && sameSnapshotFileIdentity(cached.identity, identity)) {
    setBoundedSnapshotCache(transformedSnapshotCache, snapshotPath, cached);
    return cached.payload;
  }
  const migratedPayload = migrateProjectSnapshotPayload(rawPayload, projectRoot);
  const payload =
    migratedPayload && typeof migratedPayload === "object" && !Array.isArray(migratedPayload)
      ? transformSnapshotPaths(migratedPayload as ProjectIndexSnapshotPayload, projectRoot, false)
      : migratedPayload;
  const immutablePayload = freezeSnapshotPayload(payload);
  setBoundedSnapshotCache(transformedSnapshotCache, snapshotPath, {
    identity,
    root: projectRoot,
    payload: immutablePayload,
  });
  return immutablePayload;
}

function transformCachedProjectSnapshotModules(
  snapshotPath: string,
  identity: SnapshotFileIdentity,
  rawPayload: unknown,
  projectRoot: string,
): unknown {
  const cached = transformedSnapshotModulesCache.get(snapshotPath);
  if (cached && cached.root === projectRoot && sameSnapshotFileIdentity(cached.identity, identity)) {
    setBoundedSnapshotCache(transformedSnapshotModulesCache, snapshotPath, cached);
    return cached.payload;
  }
  const migratedPayload = migrateProjectSnapshotPayload(rawPayload, projectRoot);
  if (!migratedPayload || typeof migratedPayload !== "object" || Array.isArray(migratedPayload)) {
    return migratedPayload;
  }
  const payload = migratedPayload as Partial<ProjectIndexSnapshotPayload>;
  if (!Array.isArray(payload.modules) || !payload.fileSignatures || typeof payload.fileSignatures !== "object") {
    return migratedPayload;
  }
  const modules = payload.modules.map((module) => transformModule(projectRoot, module, false));
  const fileSignatures: Record<string, SnapshotFileSignature> = {};
  for (const [file, signature] of Object.entries(payload.fileSignatures)) {
    fileSignatures[transformPath(projectRoot, file, false)] = signature;
  }
  const transformed: ProjectSnapshotModulesPayload = {
    version: payload.version ?? PROJECT_SNAPSHOT_VERSION,
    filesSignature: payload.filesSignature ?? "",
    projectRoot: serializedProjectRoot(projectRoot),
    nativeRuntimeFingerprint: payload.nativeRuntimeFingerprint ?? "",
    implementationFingerprint: payload.implementationFingerprint ?? "",
    modules,
    fileSignatures,
  };
  const immutablePayload = freezeSnapshotPayload(transformed);
  setBoundedSnapshotCache(transformedSnapshotModulesCache, snapshotPath, {
    identity,
    root: projectRoot,
    payload: immutablePayload,
  });
  return immutablePayload;
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
  report?: BuildReport,
): Promise<LoadedProjectIndexSnapshot | null> {
  const filesSignature = projectSnapshotFilesSignature(manifestEntries, projectRoot);
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const snapshotPath = projectSnapshotPath(projectRoot, opts);
    const parsedSnapshot = await readParsedSnapshot(snapshotPath);
    const payload = transformCachedProjectSnapshot(
      snapshotPath,
      parsedSnapshot.identity,
      parsedSnapshot.payload,
      projectRoot,
    );
    const nativeRuntimeFingerprint = getNativeRuntimeFingerprint();
    const implementationFingerprint = getImplementationFingerprint();
    if (!isProjectIndexSnapshotPayload(payload)) {
      recordCacheCorruption(
        report,
        projectSnapshotPath(projectRoot, opts),
        "invalid project snapshot payload",
        opts?.logLevel,
      );
      return null;
    }
    if (
      payload.filesSignature !== filesSignature ||
      payload.nativeRuntimeFingerprint !== nativeRuntimeFingerprint ||
      payload.implementationFingerprint !== implementationFingerprint
    ) {
      recordSnapshotInvalidation(
        projectSnapshotPath(projectRoot, opts),
        "project snapshot identity mismatch",
        opts?.logLevel,
      );
      return null;
    }
    const graph: Graph = {
      nodes: new Set(payload.graph.nodes),
      edges: payload.graph.edges,
    };
    const modules = collectSnapshotModules(projectRoot, opts, payload, snapshotPath, parsedSnapshot.identity);
    if (!modules || !thinSnapshotModulesComplete(payload, modules)) {
      recordSnapshotInvalidation(snapshotPath, "thin snapshot missing disk-cached modules", opts?.logLevel);
      return null;
    }
    const shouldHydrateBloomFilters = opts?.useBloomFilters ?? true;
    const index: ProjectIndex = {
      graph,
      graphAdjacency: buildGraphAdjacency(graph),
      modules,
      byFile: modules,
      projectRoot: serializedProjectRoot(projectRoot),
      ...(payload.languageExtensions ? { languageExtensions: payload.languageExtensions } : {}),
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
  } catch (error) {
    if (!isMissingArtifactError(error)) {
      recordCacheCorruption(report, projectSnapshotPath(projectRoot, opts), String(error), opts?.logLevel);
    }
    return null;
  }
}
/**
 * Load only modules and signatures from the last-written project snapshot. Path transforms avoid
 * cloning the graph and project metadata, while each returned module remains caller-owned.
 */
/**
 * The signature fields a snapshot comparison reads. `cacheSig` is optional here even
 * though `FileSignature` requires it: manifest entries can predate it, and
 * `snapshotSignatureMatches` already branches on its absence.
 */
export type SnapshotComparableSignature = Pick<FileSignature, "sig" | "gitSig"> & { cacheSig?: string | undefined };

export async function tryLoadProjectSnapshotModules(
  projectRoot: string,
  opts: BuildOptions | undefined,
  fileSignatures: ReadonlyMap<string, SnapshotComparableSignature>,
  report?: BuildReport,
): Promise<Map<string, ModuleIndex> | null> {
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const parsedSnapshot = await readParsedSnapshot(projectSnapshotPath(projectRoot, opts));
    const payload = transformCachedProjectSnapshotModules(
      projectSnapshotPath(projectRoot, opts),
      parsedSnapshot.identity,
      parsedSnapshot.payload,
      projectRoot,
    );
    const nativeRuntimeFingerprint = getNativeRuntimeFingerprint();
    const implementationFingerprint = getImplementationFingerprint();
    if (!isProjectSnapshotModulesPayload(payload)) {
      recordCacheCorruption(
        report,
        projectSnapshotPath(projectRoot, opts),
        "invalid project snapshot payload",
        opts?.logLevel,
      );
      return null;
    }
    if (
      payload.nativeRuntimeFingerprint !== nativeRuntimeFingerprint ||
      payload.implementationFingerprint !== implementationFingerprint
    ) {
      recordSnapshotInvalidation(
        projectSnapshotPath(projectRoot, opts),
        "project snapshot identity mismatch",
        opts?.logLevel,
      );
      return null;
    }
    const normalizedFileSignatures = new Map(
      Object.entries(payload.fileSignatures).map(([file, signature]) => [fileIdentityKey(file), signature]),
    );
    const normalizedCurrentSignatures = new Map(
      Array.from(fileSignatures, ([file, signature]) => [fileIdentityKey(file), signature]),
    );
    const snapshotPath = projectSnapshotPath(projectRoot, opts);
    const candidates = collectSnapshotModules(projectRoot, opts, payload, snapshotPath, parsedSnapshot.identity);
    if (!candidates) return new Map();
    const modules = new Map<string, ModuleIndex>();
    for (const [moduleKey, mod] of candidates) {
      const signature = normalizedCurrentSignatures.get(moduleKey);
      const snapshotSignature = normalizedFileSignatures.get(moduleKey);
      if (!signature || !snapshotSignature || !snapshotSignatureMatches(snapshotSignature, signature)) continue;
      modules.set(moduleKey, mod);
    }
    return modules;
  } catch (error) {
    if (!isMissingArtifactError(error)) {
      recordCacheCorruption(report, projectSnapshotPath(projectRoot, opts), String(error), opts?.logLevel);
    }
    return null;
  }
}

export async function tryLoadPersistedBloomFilters(
  projectRoot: string,
  opts: BuildOptions | undefined,
  report?: BuildReport,
): Promise<PersistedBloomFilters | null> {
  if ((opts?.cache ?? "off") !== "disk" || (opts?.useBloomFilters ?? true) === false) return null;
  try {
    const sidecarPath = bloomFilterSnapshotPath(projectRoot, opts);
    const sidecarParsed = (await readParsedSnapshot(sidecarPath)).payload;
    const sidecarBloom = persistedBloomFiltersFromSidecar(sidecarParsed, projectRoot);
    if (sidecarBloom) {
      return createPersistedBloomFilters(sidecarBloom.bloomFilters, sidecarBloom.fileSignatures, projectRoot);
    }
    const sidecar = sidecarParsed as Partial<BloomFilterSnapshotPayload>;
    const identityMismatch =
      isUnknownRecord(sidecarParsed) &&
      (sidecar.version !== BLOOM_FILTER_SNAPSHOT_VERSION ||
        sidecar.implementationFingerprint !== getImplementationFingerprint() ||
        typeof sidecar.projectSnapshotIdentity !== "string");
    if (identityMismatch) {
      recordSnapshotInvalidation(sidecarPath, "bloom filter identity mismatch", opts?.logLevel);
    } else {
      recordCacheCorruption(report, sidecarPath, "invalid bloom filter payload", opts?.logLevel);
    }
  } catch (error) {
    const isMissing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!isMissing) {
      recordCacheCorruption(report, bloomFilterSnapshotPath(projectRoot, opts), String(error), opts?.logLevel);
    }
  }
  try {
    const payload = (await readParsedSnapshot(projectSnapshotPath(projectRoot, opts))).payload;
    const bloomFilters = persistedBloomFiltersFromSnapshot(payload, projectRoot);
    if (!bloomFilters) return null;
    return createPersistedBloomFilters(bloomFilters.bloomFilters, bloomFilters.fileSignatures, projectRoot);
  } catch (error) {
    const isMissing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!isMissing) {
      recordCacheCorruption(report, projectSnapshotPath(projectRoot, opts), String(error), opts?.logLevel);
    }
    return null;
  }
}

function persistedBloomFiltersFromSidecar(
  value: unknown,
  _projectRoot: string,
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
    !isSupportedProjectSnapshotVersion(payload.version) ||
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

function isSupportedProjectSnapshotVersion(version: unknown): boolean {
  return version === PROJECT_SNAPSHOT_VERSION || version === LEGACY_EMBEDDED_MODULE_SNAPSHOT_VERSION;
}

function snapshotHydratesModulesFromDisk(version: number): boolean {
  return version === PROJECT_SNAPSHOT_VERSION;
}

function mutableModuleIndex(mod: ModuleIndex): ModuleIndex {
  if (
    !Object.isFrozen(mod) &&
    !Object.isFrozen(mod.imports) &&
    !Object.isFrozen(mod.exports) &&
    !Object.isFrozen(mod.locals)
  ) {
    return mod;
  }
  return {
    file: mod.file,
    exports: [...mod.exports],
    imports: [...mod.imports],
    locals: [...mod.locals],
    ...(mod.docstringsChecked ? { docstringsChecked: true } : {}),
    ...(mod.declaredContainers ? { declaredContainers: [...mod.declaredContainers] } : {}),
    ...(mod.csharpNamespaceFacts ? { csharpNamespaceFacts: mod.csharpNamespaceFacts } : {}),
    ...(mod.jvmFacts ? { jvmFacts: mod.jvmFacts } : {}),
    ...(mod.nativeOutcome ? { nativeOutcome: mod.nativeOutcome } : {}),
    ...(mod.parserDegraded ? { parserDegraded: true } : {}),
    ...(mod.importLookupIncomplete ? { importLookupIncomplete: true } : {}),
    ...(mod.parseErrorRanges ? { parseErrorRanges: mod.parseErrorRanges } : {}),
  };
}

/**
 * The modules the snapshot embeds. A module with a disk-cache row is left out, and a load restores it from that row.
 * A module native skipped, or whose parser degraded, may not be written to the cache: its row is then the stale one
 * from before the file changed, such as before it grew past the native size limit or began to fail processing. Embed
 * it: at load the snapshot's copy wins over the row.
 */
function modulesForThinSnapshot(
  index: ProjectIndex,
  projectRoot: string,
  opts: BuildOptions | undefined,
): ModuleIndex[] {
  const modules = [...index.byFile.values()];
  const cachedFiles = listDiskCachedModuleFiles(projectRoot, opts);
  if (!cachedFiles) return modules;
  return modules.filter(
    (module) =>
      module.nativeOutcome === "skipped" ||
      module.parserDegraded ||
      !cachedFiles.has(cacheRelativePath(projectRoot, module.file)),
  );
}

function collectSnapshotModules(
  projectRoot: string,
  opts: BuildOptions | undefined,
  payload: ProjectSnapshotModulesPayload,
  snapshotPath: string,
  identity: SnapshotFileIdentity,
): Map<string, ModuleIndex> | null {
  const cached = hydratedSnapshotModulesCache.get(snapshotPath);
  if (cached && cached.root === projectRoot && sameSnapshotFileIdentity(cached.identity, identity)) {
    setBoundedSnapshotCache(hydratedSnapshotModulesCache, snapshotPath, cached);
    return cached.modules;
  }
  const modules = new Map<string, ModuleIndex>();
  for (const mod of payload.modules) {
    modules.set(fileIdentityKey(mod.file), mod);
  }
  if (snapshotHydratesModulesFromDisk(payload.version)) {
    const cachedModules = loadAllCachedModules(projectRoot, opts);
    if (!cachedModules && modules.size === 0) return null;
    if (cachedModules) {
      for (const [key, row] of cachedModules) {
        if (modules.has(key)) continue;
        modules.set(key, row.mod);
      }
    }
    // expandStarImports only pushes onto star-import arrays. Snapshot-embedded
    // bodies are frozen; SQLite rows are not. Clone only the frozen star
    // importers, keep targets shared, then freeze whatever is still mutable.
    for (const [key, mod] of modules) {
      if (!mod.imports.some((binding) => binding.kind === "star")) continue;
      modules.set(key, mutableModuleIndex(mod));
    }
    expandStarImports(modules, opts);
    for (const [key, mod] of modules) {
      if (Object.isFrozen(mod)) continue;
      modules.set(key, freezeSnapshotPayload(mod));
    }
  }
  const entry = { identity, root: projectRoot, modules };
  setBoundedSnapshotCache(hydratedSnapshotModulesCache, snapshotPath, entry);
  return modules;
}

function thinSnapshotModulesComplete(
  payload: ProjectSnapshotModulesPayload,
  modules: Map<string, ModuleIndex>,
): boolean {
  if (!snapshotHydratesModulesFromDisk(payload.version)) return true;
  for (const file of Object.keys(payload.fileSignatures)) {
    if (!modules.has(fileIdentityKey(file))) return false;
  }
  return true;
}

function snapshotSignatureMatches(
  snapshotSignature: SnapshotFileSignature,
  currentSignature: SnapshotComparableSignature,
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
      nativeRuntimeFingerprint: getNativeRuntimeFingerprint(),
      implementationFingerprint: getImplementationFingerprint(),
      graph: {
        nodes: [...index.graph.nodes],
        edges: index.graph.edges,
      },
      modules: modulesForThinSnapshot(index, projectRoot, opts),
      fileSignatures,
      ...(index.languageExtensions ? { languageExtensions: index.languageExtensions } : {}),
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
    transformedSnapshotCache.delete(snapshotPath);
    transformedSnapshotModulesCache.delete(snapshotPath);
    hydratedSnapshotModulesCache.delete(snapshotPath);
    setBoundedSnapshotCache(parsedSnapshotCache, snapshotPath, { identity, compressed, payload });
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
          payload: bloomPayload,
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

function isProjectSnapshotModulesPayload(value: unknown): value is ProjectSnapshotModulesPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProjectSnapshotModulesPayload>;
  return (
    isSupportedProjectSnapshotVersion(payload.version) &&
    typeof payload.filesSignature === "string" &&
    typeof payload.projectRoot === "string" &&
    typeof payload.nativeRuntimeFingerprint === "string" &&
    typeof payload.implementationFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(payload.implementationFingerprint) &&
    Array.isArray(payload.modules) &&
    payload.modules.every(isModuleIndex) &&
    isSnapshotFileSignatureRecord(payload.fileSignatures)
  );
}

function isProjectIndexSnapshotPayload(value: unknown): value is ProjectIndexSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  return (
    isSupportedProjectSnapshotVersion(payload.version) &&
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
    (payload.languageExtensions === undefined || isLanguageExtensionMap(payload.languageExtensions)) &&
    (payload.bloomFilters === undefined || isSerializedBloomFilterRecord(payload.bloomFilters)) &&
    (payload.analysis === undefined || isAnalysisSummary(payload.analysis)) &&
    (payload.analysisReport === undefined || isSnapshotAnalysisReport(payload.analysisReport)) &&
    (payload.projectFiles === undefined ||
      (Array.isArray(payload.projectFiles) && payload.projectFiles.every(isProjectFileInfo)))
  );
}

function analysisReportFromBuildReport(report: ProjectIndex["buildReport"]): SnapshotAnalysisReport | undefined {
  if (!report?.backend) {
    return undefined;
  }
  return {
    ...(report.backend ? { backend: report.backend } : {}),
  };
}

function isSnapshotAnalysisReport(value: unknown): value is SnapshotAnalysisReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<SnapshotAnalysisReport>;
  return report.backend === undefined || isBackendReport(report.backend);
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
    summary.mode === "semantic" &&
    (summary.backend === "native" || summary.backend === "unknown") &&
    typeof summary.parserDegradedFiles === "number" &&
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
    isOptionalBoolean(moduleIndex.docstringsChecked) &&
    isOptionalNativeOutcome(moduleIndex.nativeOutcome) &&
    isOptionalBoolean(moduleIndex.parserDegraded) &&
    isOptionalBoolean(moduleIndex.importLookupIncomplete) &&
    Array.isArray(moduleIndex.locals) &&
    moduleIndex.locals.every(isSymbolDef) &&
    Array.isArray(moduleIndex.imports) &&
    moduleIndex.imports.every(isImportBinding) &&
    Array.isArray(moduleIndex.exports) &&
    moduleIndex.exports.every(isExportEntry) &&
    (moduleIndex.csharpNamespaceFacts === undefined || isCsharpNamespaceFacts(moduleIndex.csharpNamespaceFacts)) &&
    (moduleIndex.jvmFacts === undefined || isJvmFileFacts(moduleIndex.jvmFacts)) &&
    (moduleIndex.parseErrorRanges === undefined ||
      (Array.isArray(moduleIndex.parseErrorRanges) && moduleIndex.parseErrorRanges.every(isParseErrorRange)))
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
    (symbol.kind === SymbolKind.Function
      ? isCallableIdentity(symbol.callable)
      : symbol.callable === undefined || isCallableIdentity(symbol.callable)) &&
    (symbol.cTag === undefined ||
      symbol.cTag === "declaration" ||
      symbol.cTag === "forward" ||
      symbol.cTag === "reference") &&
    isOptionalBoolean(symbol.javaPackagePrivate) &&
    isOptionalBoolean(symbol.javaProtectedMember) &&
    (symbol.jvmTypeOwnerStartIndex === undefined || typeof symbol.jvmTypeOwnerStartIndex === "number") &&
    isOptionalBoolean(symbol.jvmStaticMember) &&
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
  if (binding.kind === "star" || binding.kind === "named") {
    if (
      (binding.jvmPackageLanguageId !== undefined &&
        binding.jvmPackageLanguageId !== "java" &&
        binding.jvmPackageLanguageId !== "kotlin") ||
      !isOptionalBoolean(binding.jvmPackageIncomplete)
    )
      return false;
  }
  if (binding.kind === "default") {
    return typeof binding.local === "string" && isOptionalRange(binding.localRange);
  }
  if (binding.kind === "named") {
    return (
      typeof binding.local === "string" &&
      typeof binding.imported === "string" &&
      isOptionalBoolean(binding.explicitAlias) &&
      isOptionalRange(binding.importedRange) &&
      isOptionalRange(binding.localRange) &&
      (binding.jvmTypeOwnerStartIndex === undefined || typeof binding.jvmTypeOwnerStartIndex === "number") &&
      (binding.jvmStaticWildcardName === undefined || typeof binding.jvmStaticWildcardName === "string") &&
      isOptionalBoolean(binding.jvmSamePackage) &&
      (binding.cNamespace === undefined || binding.cNamespace === "tag" || binding.cNamespace === "ordinary") &&
      (binding.phpImportType === undefined ||
        binding.phpImportType === "class" ||
        binding.phpImportType === "function" ||
        binding.phpImportType === "const")
    );
  }
  if (binding.kind === "namespace") {
    return typeof binding.localNS === "string" && isOptionalRange(binding.localRange);
  }
  return (
    binding.kind === "star" &&
    (binding.staticMembersOf === undefined || typeof binding.staticMembersOf === "string") &&
    (binding.csharpDirectiveStartIndex === undefined || typeof binding.csharpDirectiveStartIndex === "number") &&
    (binding.pythonStatementStartIndex === undefined || typeof binding.pythonStatementStartIndex === "number") &&
    (binding.jvmTypeWildcardName === undefined || typeof binding.jvmTypeWildcardName === "string") &&
    (binding.jvmStaticWildcardName === undefined || typeof binding.jvmStaticWildcardName === "string") &&
    (binding.jvmPackageFiles === undefined ||
      (Array.isArray(binding.jvmPackageFiles) && binding.jvmPackageFiles.every((file) => typeof file === "string"))) &&
    isOptionalBoolean(binding.jvmSamePackage) &&
    (binding.rubyLoadForm === undefined || isRubyLoadForm(binding.rubyLoadForm))
  );
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
