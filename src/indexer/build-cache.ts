import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import crypto from "node:crypto";
import { supportForFile } from "../languages.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { shouldAvoidJsFallbackForLanguage } from "../native/treeSitterNative.js";
import { buildBloomFilterFromSource } from "../util/bloomFilter.js";
import { SqliteDatabase } from "../sqlite-driver.js";
import type { FallbackImportExtractionEvent } from "../graphs/specifiers.js";
import type { GraphCacheEntry, GraphBuildOptions } from "../graphs/types.js";
import type { Edge } from "../types.js";
import {
  DEFAULT_PROJECT_MANIFESTS,
  assertFilePathWithinRoot,
  getGitBlobHashes,
  isFilePathWithinRoot,
  listProjectFiles,
  normalizeResolutionHints,
  stringifyUnknown,
  type ProjectFileDiscoveryOptions,
} from "../util.js";
import type {
  BuildFileReport,
  BuildOptions,
  BuildReport,
  CacheReport,
  FallbackImportExtractionReport,
  ManifestReport,
  ModuleIndex,
} from "./types.js";

const PARSED_CACHE_VERSION = 1;
type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};
const memoryCache = new Map<string, ModuleCacheEntry>();

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

const diskCacheDatabases = new Map<string, SqliteDatabase>();

function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1");
}

function diskCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return path.join(cacheRoot(projectRoot, opts), "index-cache.sqlite").replace(/\\/g, "/");
}

function getDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): SqliteDatabase {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskCacheDatabases.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new SqliteDatabase(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_cache (
      file TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_module_cache_sig ON module_cache(sig);
  `);
  diskCacheDatabases.set(dbPath, db);
  return db;
}

export function closeDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): void {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const db = diskCacheDatabases.get(dbPath);
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint best-effort
  }
  try {
    db.close();
    diskCacheDatabases.delete(dbPath);
  } catch {
    // Keep handle for later retry if close fails.
  }
}

export const MANIFEST_VERSION = 1;

export type ManifestFileEntry = GraphCacheEntry;

type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  preset?: BuildOptions["preset"];
  incrementalStrict?: boolean;
  discovery?: {
    includeGlobs?: string[];
    ignoreGlobs?: string[];
    useGitignore: boolean;
  };
};

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

export function recordConfigHashResult(
  manifestReport: ManifestReport | undefined,
  configHashResult: { hash: string; error?: string },
  logLevel: LogLevel | undefined,
): string {
  if (!configHashResult.error) return configHashResult.hash;
  if (manifestReport) {
    manifestReport.configHashError = configHashResult.error;
  }
  logWithLevel(logLevel, "warn", `Warning: ${configHashResult.error}`);
  return configHashResult.hash;
}

export type FileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig: string;
  contentHash?: string;
};

export function initCacheReport(
  report: BuildReport | undefined,
  mode: BuildOptions["cache"] | undefined,
): CacheReport | undefined {
  if (!report) return undefined;
  if (!report.cache) {
    report.cache = { mode: mode ?? "off", hits: 0, misses: 0 };
  }
  return report.cache;
}

export function initFileReport(report: BuildReport | undefined): BuildFileReport | undefined {
  if (!report) return undefined;
  if (!report.files) {
    report.files = { total: 0, cached: 0, parsed: 0 };
  }
  return report.files;
}

export function recordFileFailure(report: BuildReport | undefined, file: string, error: unknown): void {
  const fileReport = initFileReport(report);
  if (!fileReport) return;
  fileReport.failed = (fileReport.failed ?? 0) + 1;
  const errors = fileReport.errors ?? [];
  if (errors.length < 20) {
    errors.push({
      file: file.replace(/\\/g, "/"),
      message: stringifyUnknown(error),
    });
  }
  fileReport.errors = errors;
}

function initFallbackImportExtractionReport(
  report: BuildReport | undefined,
): FallbackImportExtractionReport | undefined {
  if (!report) return undefined;
  if (!report.graph) {
    report.graph = {
      fallbackImportExtraction: {
        total: 0,
        byLanguage: {},
        byReason: {
          fast: 0,
          "js-fallback-unavailable": 0,
          "query-error": 0,
          "query-empty": 0,
        },
        files: {},
      },
    };
  } else if (!report.graph.fallbackImportExtraction) {
    report.graph.fallbackImportExtraction = {
      total: 0,
      byLanguage: {},
      byReason: {
        fast: 0,
        "js-fallback-unavailable": 0,
        "query-error": 0,
        "query-empty": 0,
      },
      files: {},
    };
  }
  return report.graph.fallbackImportExtraction;
}

export function createFallbackImportExtractionHandler(
  report: BuildReport | undefined,
  opts?: BuildOptions,
): ((event: FallbackImportExtractionEvent) => void) | undefined {
  const fallbackReport = initFallbackImportExtractionReport(report);
  const warned = new Set<string>();
  const logLevel = opts?.logLevel ?? "warn";
  const shouldLog = logLevel !== "silent" && logLevel !== "error";

  return (event: FallbackImportExtractionEvent) => {
    const filePath = event.file ? event.file.replace(/\\/g, "/") : "unknown";
    if (fallbackReport) {
      if (!fallbackReport.files[filePath]) {
        fallbackReport.total += 1;
        fallbackReport.byLanguage[event.language] = (fallbackReport.byLanguage[event.language] ?? 0) + 1;
        fallbackReport.byReason ??= {
          fast: 0,
          "js-fallback-unavailable": 0,
          "query-error": 0,
          "query-empty": 0,
        };
        fallbackReport.byReason[event.reason] += 1;
      }
      fallbackReport.files[filePath] = {
        language: event.language,
        reason: event.reason,
      };
    }
    if (!shouldLog) return;
    const warningKey = `${event.language}:${event.reason}`;
    if (warned.has(warningKey)) return;
    warned.add(warningKey);
    const severity =
      event.reason === "fast" ||
      event.reason === "js-fallback-unavailable" ||
      shouldAvoidJsFallbackForLanguage(event.language)
        ? "debug"
        : "warn";
    let message = "Regex fallback import extraction";
    if (event.reason === "js-fallback-unavailable") {
      message = `JS fallback unavailable for ${event.language} query recovery; using regex import extraction.`;
    } else if (shouldAvoidJsFallbackForLanguage(event.language)) {
      message = `Native import recovery degraded for ${event.language}; using native-owned fallback extraction.`;
    }
    logWithLevel(opts?.logLevel, severity, message, {
      language: event.language,
      reason: event.reason,
    });
  };
}

export function initManifestReport(
  report: BuildReport | undefined,
  used: boolean,
  reused: boolean,
): ManifestReport | undefined {
  if (!report) return undefined;
  if (!report.manifest) {
    report.manifest = { used, reused };
  } else {
    report.manifest.used = used;
    report.manifest.reused = reused;
  }
  return report.manifest;
}

async function fileContentHash(file: string): Promise<string> {
  const buffer = await fsp.readFile(file);
  const hash = crypto.createHash("sha1");
  hash.update(buffer);
  return hash.digest("hex");
}

async function fileStatSignature(
  file: string,
  strict?: boolean,
  opts?: { includeContentHash?: boolean },
): Promise<{ sig: string; contentHash?: string }> {
  try {
    const stat = await fsp.stat(file);
    const useStrict = strict ?? true;
    const shouldHash = useStrict || !!opts?.includeContentHash;
    const contentHash = shouldHash ? await fileContentHash(file) : undefined;
    if (!useStrict) {
      return contentHash
        ? { sig: `${stat.mtimeMs}:${stat.size}`, contentHash }
        : { sig: `${stat.mtimeMs}:${stat.size}` };
    }
    if (contentHash) {
      return {
        sig: `${stat.mtimeMs}:${stat.size}:${contentHash}`,
        contentHash,
      };
    }
    return { sig: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return { sig: "0:0" };
  }
}

export async function fileSignature(
  file: string,
  strict?: boolean,
  gitSig?: string,
  opts?: { forceContentHash?: boolean },
): Promise<FileSignature> {
  const includeContentHash = !!opts?.forceContentHash;
  const statOpts = includeContentHash ? { includeContentHash: true } : undefined;
  const { sig, contentHash } = await fileStatSignature(file, strict, statOpts);
  const cacheSig = gitSig ?? contentHash ?? sig;
  if (gitSig) {
    return {
      sig,
      gitSig,
      cacheSig,
      ...(contentHash ? { contentHash } : {}),
    };
  }
  return { sig, cacheSig, ...(contentHash ? { contentHash } : {}) };
}

export async function cacheSignatureForFile(file: string, sigInfo: FileSignature): Promise<string> {
  if (sigInfo.gitSig) return sigInfo.gitSig;
  if (sigInfo.contentHash) return sigInfo.contentHash;
  const contentHash = await fileContentHash(file);
  sigInfo.contentHash = contentHash;
  return contentHash;
}

export async function buildBloomFilterForFile(
  file: string,
): Promise<import("../util/bloomFilter.js").BloomFilter | null> {
  try {
    const source = await fsp.readFile(file, "utf8");
    const support = supportForFile(file);
    if (!support) return null;
    return buildBloomFilterFromSource(source, support.id);
  } catch {
    return null;
  }
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const mod = value as {
    file?: unknown;
    exports?: unknown;
    imports?: unknown;
    locals?: unknown;
  };
  return (
    typeof mod.file === "string" &&
    Array.isArray(mod.exports) &&
    Array.isArray(mod.imports) &&
    Array.isArray(mod.locals)
  );
}

export function tryLoadFromCache(
  projectRoot: string,
  file: string,
  sig: string,
  opts?: BuildOptions,
  report?: BuildReport,
): ModuleIndex | null {
  const mode = opts?.cache ?? "off";
  const cacheReport = initCacheReport(report, mode);
  const cacheEnabled = mode !== "off";
  if (mode === "memory") {
    const entry = memoryCache.get(file);
    if (entry && entry.sig === sig) {
      if (cacheEnabled && cacheReport) cacheReport.hits += 1;
      return entry.mod;
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
    return null;
  }
  if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      const row = db.prepare("SELECT sig, version, payload FROM module_cache WHERE file = ?").get(file) as
        | { sig: string; version: number; payload: string }
        | undefined;
      if (row && row.sig === sig && row.version === PARSED_CACHE_VERSION) {
        const parsed = JSON.parse(row.payload) as unknown;
        if (isModuleIndex(parsed)) {
          if (cacheEnabled && cacheReport) cacheReport.hits += 1;
          return parsed;
        }
      }
    } catch {
      // cache read failed
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
  }
  return null;
}

export function writeToCache(
  projectRoot: string,
  file: string,
  sig: string,
  mod: ModuleIndex,
  opts?: BuildOptions,
): void {
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    memoryCache.set(file, { version: PARSED_CACHE_VERSION, sig, mod });
  } else if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      db.prepare(
        `INSERT INTO module_cache (file, sig, version, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET
           sig = excluded.sig,
           version = excluded.version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      ).run(file, sig, PARSED_CACHE_VERSION, JSON.stringify(mod), Date.now());
    } catch (error) {
      logWithLevel(opts?.logLevel, "warn", "Warning: Failed to write to cache:", error);
    }
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

function normalizeManifestBuildOptions(opts?: ManifestBuildOptions): ManifestBuildOptions {
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
    ...(opts?.discovery ? { discovery: opts.discovery } : {}),
  };
}

function normalizeDiscoveryOptions(discovery?: ProjectFileDiscoveryOptions): ManifestBuildOptions["discovery"] {
  if (!discovery) return undefined;
  const includeGlobs = Array.from(
    new Set((discovery.includeGlobs ?? []).map((glob) => glob.trim()).filter(Boolean)),
  ).sort();
  const ignoreGlobs = Array.from(
    new Set((discovery.ignoreGlobs ?? []).map((glob) => glob.trim()).filter(Boolean)),
  ).sort();
  const useGitignore = discovery.useGitignore ?? true;
  if (!includeGlobs.length && !ignoreGlobs.length && useGitignore) {
    return undefined;
  }
  return {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(ignoreGlobs.length ? { ignoreGlobs } : {}),
    useGitignore,
  };
}

function normalizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  const discovery = normalizeDiscoveryOptions(opts?.discovery);
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
    ...(discovery ? { discovery } : {}),
  };
}

export function summarizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return normalizeBuildOptions(opts);
}

function normalizeLanguageList(list?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list ?? []) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort();
  return out;
}

function normalizedDiscoveryOptionsEqual(
  a: ManifestBuildOptions["discovery"],
  b: ManifestBuildOptions["discovery"],
): boolean {
  const normalizedA = a ?? { useGitignore: true };
  const normalizedB = b ?? { useGitignore: true };
  if (normalizedA.useGitignore !== normalizedB.useGitignore) return false;
  const includeA = normalizedA.includeGlobs ?? [];
  const includeB = normalizedB.includeGlobs ?? [];
  if (includeA.length !== includeB.length) return false;
  for (let i = 0; i < includeA.length; i++) {
    if (includeA[i] !== includeB[i]) return false;
  }
  const ignoreA = normalizedA.ignoreGlobs ?? [];
  const ignoreB = normalizedB.ignoreGlobs ?? [];
  if (ignoreA.length !== ignoreB.length) return false;
  for (let i = 0; i < ignoreA.length; i++) {
    if (ignoreA[i] !== ignoreB[i]) return false;
  }
  return true;
}

export function diffBuildOptions(
  manifestOpts: ManifestBuildOptions | undefined,
  currentOpts: BuildOptions | undefined,
): string[] {
  if (!manifestOpts) return [];
  const normalizedManifest = normalizeManifestBuildOptions(manifestOpts);
  const normalizedCurrent = normalizeBuildOptions(currentOpts);
  const diffs: string[] = [];
  if (normalizedManifest.cache !== normalizedCurrent.cache) diffs.push("cache");
  if (normalizedManifest.cacheStrict !== normalizedCurrent.cacheStrict) {
    diffs.push("cacheStrict");
  }
  if (normalizedManifest.useBloomFilters !== normalizedCurrent.useBloomFilters) {
    diffs.push("useBloomFilters");
  }
  if (normalizedManifest.preset !== normalizedCurrent.preset) diffs.push("preset");
  if (normalizedManifest.incrementalStrict !== normalizedCurrent.incrementalStrict) {
    diffs.push("incrementalStrict");
  }
  if (!normalizedDiscoveryOptionsEqual(normalizedManifest.discovery, normalizedCurrent.discovery)) {
    diffs.push("discovery");
  }
  return diffs;
}

export function normalizeGraphOptions(opts?: GraphBuildOptions): GraphBuildOptions {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const fastRegexDisabledLanguages = normalizeLanguageList(opts?.fastRegexDisabledLanguages);
  return {
    fast: !!opts?.fast,
    ...(fastRegexDisabledLanguages.length ? { fastRegexDisabledLanguages } : {}),
    resolveNodeModules: !!opts?.resolveNodeModules,
    dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
    ...(resolutionHints.length ? { resolutionHints } : {}),
  };
}

export function graphOptionsEqual(a?: GraphBuildOptions, b?: GraphBuildOptions): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeGraphOptions(a);
  const normalizedB = normalizeGraphOptions(b);
  if (!!normalizedA.fast !== !!normalizedB.fast) return false;
  if (!!normalizedA.resolveNodeModules !== !!normalizedB.resolveNodeModules) {
    return false;
  }
  if (!!normalizedA.dynamicImportHeuristics !== !!normalizedB.dynamicImportHeuristics) {
    return false;
  }
  const disabledA = normalizedA.fastRegexDisabledLanguages ?? [];
  const disabledB = normalizedB.fastRegexDisabledLanguages ?? [];
  if (disabledA.length !== disabledB.length) return false;
  for (let i = 0; i < disabledA.length; i++) {
    if (disabledA[i] !== disabledB[i]) return false;
  }
  const hintsA = normalizedA.resolutionHints ?? [];
  const hintsB = normalizedB.resolutionHints ?? [];
  if (hintsA.length !== hintsB.length) return false;
  for (let i = 0; i < hintsA.length; i++) {
    if (hintsA[i] !== hintsB[i]) return false;
  }
  return true;
}
