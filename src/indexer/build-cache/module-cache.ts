import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { supportForFile } from "../../languages.js";
import { getNativeRuntimeFingerprint } from "../../native/treeSitterNative.js";
import { logWithLevel } from "../../logging.js";
import { SqliteDatabase, type SqliteStatement, isNodeSqliteUnavailableError } from "../../sqlite-driver.js";
import { buildBloomFilterFromSource } from "../../util/bloomFilter.js";
import {
  createSqliteTableIfMissing,
  ensureSqliteVersionedTableSchema,
  recreateSqliteTable,
  sqliteTableColumns,
  type SqliteTableColumn,
} from "../../util/sqliteSchema.js";
import type { BuildOptions, BuildReport, ModuleIndex } from "../types.js";
import { fileIdentityKey, normalizePath } from "../../util/paths.js";
import { lruMapGet, lruMapSet } from "../../util/lruMap.js";
import { initCacheReport } from "./reports.js";
import { getImplementationFingerprint } from "./options.js";

// v4: relative file keys and explicit cache-anchor policy.
const PARSED_CACHE_VERSION = 4;
const MODULE_CACHE_SCHEMA_VERSION = 2;
const MODULE_CACHE_TABLE = "module_cache";
const MODULE_CACHE_SCHEMA_VERSION_KEY = "module_cache.schema_version";
const MODULE_CACHE_COLUMNS: readonly SqliteTableColumn[] = [
  { name: "file", definition: "TEXT PRIMARY KEY" },
  { name: "sig", definition: "TEXT NOT NULL" },
  { name: "version", definition: "INTEGER NOT NULL" },
  { name: "payload", definition: "BLOB NOT NULL" },
  { name: "updated_at", definition: "INTEGER NOT NULL" },
];

type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};

const MAX_MEMORY_CACHE_ENTRIES = 5000;
const memoryCache = new Map<string, ModuleCacheEntry>();
let cachedExecutionFingerprint: string | undefined;
let cachedExecutionHash: string | undefined;

type DiskModuleCache = {
  db: SqliteDatabase;
  load: SqliteStatement;
  write: SqliteStatement;
  clearLiveFiles: SqliteStatement;
  insertLiveFile: SqliteStatement;
  pruneStaleFiles: SqliteStatement;
};

function memoryCacheKey(projectRoot: string, file: string): string {
  return `${normalizePath(projectRoot)}::${file}`;
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}

function clearMemoryCacheForProject(projectRoot: string): void {
  const prefix = `${normalizePath(projectRoot)}::`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
    }
  }
}
const diskModuleCaches = new Map<string, DiskModuleCache>();
let warnedMissingNodeSqlite = false;

function reportMissingNodeSqlite(logLevel: import("../../logging.js").LogLevel | undefined, error: unknown): void {
  if (warnedMissingNodeSqlite) return;
  warnedMissingNodeSqlite = true;
  logWithLevel(
    logLevel,
    "error",
    "Disk cache requires the Node.js built-in node:sqlite module. Use Node.js >= 22.16, or set --cache off/memory.",
    error,
  );
}
export function projectCacheNamespace(projectRoot: string): string {
  const rootIdentity = fileIdentityKey(path.resolve(projectRoot));
  const hash = crypto.createHash("sha256").update(rootIdentity).digest("hex");
  return `project-${hash}`;
}

export type CacheAnchorResolution = {
  anchor: string;
  layer: "explicit" | "environment" | "manifest" | "git" | "project" | "user";
};

function isWritableDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory() && fs.accessSync(candidate, fs.constants.W_OK) === undefined;
  } catch {
    return false;
  }
}

function isForbiddenAnchor(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const home = path.resolve(os.homedir());
  const parsed = path.parse(resolved);
  return (
    fileIdentityKey(resolved) === fileIdentityKey(home) || fileIdentityKey(resolved) === fileIdentityKey(parsed.root)
  );
}

function findRepositoryAnchor(projectRoot: string): CacheAnchorResolution {
  const start = path.resolve(projectRoot);
  let current = start;
  while (true) {
    const manifest = path.join(current, ".codegraph", "manifest.json");
    if (fs.existsSync(manifest) && isWritableDirectory(current) && !isForbiddenAnchor(current)) {
      return { anchor: current, layer: "manifest" };
    }
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && isWritableDirectory(current) && !isForbiddenAnchor(current)) {
      return { anchor: current, layer: "git" };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { anchor: start, layer: "project" };
}

function resolveCodegraphUserCacheRoot(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(base, "codegraph");
}
export function resolveCacheAnchor(projectRoot: string, opts?: BuildOptions): CacheAnchorResolution {
  const explicit = opts?.cacheDir?.trim();
  if (explicit) return { anchor: path.resolve(explicit), layer: "explicit" };
  const environment = process.env.CODEGRAPH_CACHE_DIR?.trim();
  if (environment) return { anchor: path.resolve(environment), layer: "environment" };
  const location = opts?.cacheLocation;
  if (location === "project") return { anchor: path.resolve(projectRoot), layer: "project" };
  if (location === "user") return { anchor: resolveCodegraphUserCacheRoot(), layer: "user" };
  if (location && location !== "repo") return { anchor: path.resolve(location), layer: "explicit" };
  return findRepositoryAnchor(projectRoot);
}

export function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  const root = path.resolve(projectRoot);
  const resolution = resolveCacheAnchor(root, opts);
  const anchor = isWritableDirectory(resolution.anchor) ? resolution.anchor : root;
  const sameRoot = fileIdentityKey(anchor) === fileIdentityKey(root);
  if (
    sameRoot &&
    !opts?.cacheDir &&
    !process.env.CODEGRAPH_CACHE_DIR?.trim() &&
    (!opts?.cacheLocation || opts.cacheLocation === "project")
  ) {
    return path.join(root, ".codegraph-cache", "index-v1");
  }
  const namespace = projectCacheNamespace(root);
  const explicitBase = opts?.cacheDir?.trim() || process.env.CODEGRAPH_CACHE_DIR?.trim();
  if (explicitBase) {
    const configured = path.resolve(explicitBase);
    if (path.basename(configured) === namespace) return configured;
    return path.join(configured, namespace);
  }
  const base = opts?.cacheLocation === "user" ? resolveCodegraphUserCacheRoot() : path.join(anchor, ".codegraph-cache");
  const candidate = path.join(path.resolve(base), "index-v1", namespace);
  if (!sameRoot && !opts?.cacheLocation) {
    const legacy = path.join(root, ".codegraph-cache", "index-v1");
    if (!fs.existsSync(candidate) && fs.existsSync(legacy)) return legacy;
  }
  return candidate;
}
export function cacheRelativePath(projectRoot: string, file: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  return relative || ".";
}

export function cacheAbsolutePath(projectRoot: string, file: string): string {
  return path.isAbsolute(file) ? normalizePath(file) : normalizePath(path.resolve(projectRoot, file));
}
export function cacheDatabasePath(projectRoot: string, opts: BuildOptions | undefined, filename: string): string {
  return path.join(cacheRoot(projectRoot, opts), filename).replace(/\\/g, "/");
}

function diskCacheDatabasePath(projectRoot: string, opts?: BuildOptions): string {
  return cacheDatabasePath(projectRoot, opts, "index-cache.sqlite");
}

function createModuleCacheTable(db: SqliteDatabase): void {
  createSqliteTableIfMissing(db, MODULE_CACHE_TABLE, MODULE_CACHE_COLUMNS);
}

function recreateModuleCacheTable(db: SqliteDatabase): void {
  recreateSqliteTable(db, MODULE_CACHE_TABLE, createModuleCacheTable);
}

function migrateModuleCacheTable(db: SqliteDatabase, projectRoot: string): void {
  const columns = sqliteTableColumns(db, MODULE_CACHE_TABLE);
  if (!columns.size) {
    createModuleCacheTable(db);
    return;
  }
  if (!columns.has("file")) {
    recreateModuleCacheTable(db);
    return;
  }
  if (!columns.has("sig")) db.exec("ALTER TABLE module_cache ADD COLUMN sig TEXT NOT NULL DEFAULT '';");
  if (!columns.has("version")) db.exec("ALTER TABLE module_cache ADD COLUMN version INTEGER NOT NULL DEFAULT 0;");
  if (!columns.has("payload")) db.exec("ALTER TABLE module_cache ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';");
  if (!columns.has("updated_at")) db.exec("ALTER TABLE module_cache ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
  const rows = db.prepare("SELECT file FROM module_cache").all() as Array<{ file: string }>;
  const update = db.prepare("UPDATE module_cache SET file = ? WHERE file = ?");
  for (const row of rows) {
    const relative = cacheRelativePath(projectRoot, row.file);
    if (relative !== row.file) update.run(relative, row.file);
  }
}

function ensureModuleCacheSchema(db: SqliteDatabase, projectRoot: string): void {
  ensureSqliteVersionedTableSchema({
    db,
    tableName: MODULE_CACHE_TABLE,
    schemaVersionKey: MODULE_CACHE_SCHEMA_VERSION_KEY,
    schemaVersion: MODULE_CACHE_SCHEMA_VERSION,
    createTable: createModuleCacheTable,
    migrateTable: (database) => migrateModuleCacheTable(database, projectRoot),
  });
  db.exec("CREATE INDEX IF NOT EXISTS idx_module_cache_sig ON module_cache(sig);");
}

export function getDiskModuleCache(projectRoot: string, opts?: BuildOptions): DiskModuleCache {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskModuleCaches.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: SqliteDatabase;
  try {
    db = new SqliteDatabase(dbPath);
  } catch (error) {
    if (isNodeSqliteUnavailableError(error)) {
      reportMissingNodeSqlite(opts?.logLevel, error);
    }
    throw error;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  ensureModuleCacheSchema(db, projectRoot);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS live_module_cache_files(file TEXT PRIMARY KEY) WITHOUT ROWID;");
  const cache: DiskModuleCache = {
    db,
    load: db.prepare("SELECT sig, version, payload FROM module_cache WHERE file = ?"),
    write: db.prepare(
      `INSERT INTO module_cache (file, sig, version, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file) DO UPDATE SET
         sig = excluded.sig,
         version = excluded.version,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
    ),
    clearLiveFiles: db.prepare("DELETE FROM live_module_cache_files"),
    insertLiveFile: db.prepare("INSERT OR IGNORE INTO live_module_cache_files(file) VALUES (?)"),
    pruneStaleFiles: db.prepare(
      "DELETE FROM module_cache WHERE NOT EXISTS (SELECT 1 FROM live_module_cache_files WHERE file = module_cache.file)",
    ),
  };
  diskModuleCaches.set(dbPath, cache);
  return cache;
}

export function closeDiskCacheDatabase(projectRoot: string, opts?: BuildOptions): void {
  clearMemoryCacheForProject(projectRoot);
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const cache = diskModuleCaches.get(dbPath);
  if (!cache) return;
  try {
    cache.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint best-effort
  }
  try {
    cache.db.close();
    diskModuleCaches.delete(dbPath);
  } catch {
    // Keep handle for later retry if close fails.
  }
}

export function pruneDiskModuleCache(projectRoot: string, liveFiles: Iterable<string>, opts?: BuildOptions): number {
  if ((opts?.cache ?? "off") !== "disk") return 0;
  try {
    const cache = getDiskModuleCache(projectRoot, opts);
    const deleted = cache.db.transaction(() => {
      cache.clearLiveFiles.run();
      for (const file of liveFiles) cache.insertLiveFile.run(cacheRelativePath(projectRoot, file));
      const result = cache.pruneStaleFiles.run();
      cache.clearLiveFiles.run();
      return Number(result.changes);
    })();
    if (deleted >= 100) {
      cache.db.exec("VACUUM;");
    }
    return deleted;
  } catch (error) {
    logWithLevel(opts?.logLevel, "warn", "Warning: Failed to prune module cache:", error);
    return 0;
  }
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

export type FileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig: string;
  contentHash?: string;
};

export async function fileSignature(
  file: string,
  strict?: boolean,
  gitSig?: string,
  opts?: { forceContentHash?: boolean },
): Promise<FileSignature> {
  const hasGitSignature = !!gitSig;
  const includeContentHash = !hasGitSignature && !!opts?.forceContentHash;
  const statOpts = includeContentHash ? { includeContentHash: true } : undefined;
  const signatureStrict = hasGitSignature ? strict === true : strict;
  const { sig, contentHash } = await fileStatSignature(file, signatureStrict, statOpts);
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

export async function cacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
  opts?: BuildOptions,
): Promise<string> {
  let contentSignature = sigInfo.gitSig ?? sigInfo.contentHash;
  if (!contentSignature) {
    contentSignature = await fileContentHash(file);
    sigInfo.contentHash = contentSignature;
  }
  const runtimeFingerprint = getNativeRuntimeFingerprint(opts?.native);
  const implementationFingerprint = getImplementationFingerprint();
  const executionFingerprint = `${runtimeFingerprint}\0${implementationFingerprint}`;
  if (executionFingerprint !== cachedExecutionFingerprint || !cachedExecutionHash) {
    cachedExecutionFingerprint = executionFingerprint;
    cachedExecutionHash = crypto.createHash("sha256").update(executionFingerprint).digest("hex");
  }
  return `${contentSignature}:${cachedExecutionHash}`;
}

export async function buildBloomFilterForFile(
  file: string,
  opts?: Pick<BuildOptions, "languageExtensions">,
): Promise<import("../../util/bloomFilter.js").BloomFilter | null> {
  try {
    const source = await fsp.readFile(file, "utf8");
    const support = supportForFile(file, opts?.languageExtensions);
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

function transformModulePaths(projectRoot: string, module: ModuleIndex, toRelative: boolean): ModuleIndex {
  const copy = structuredClone(module);
  const transform = (file: string): string =>
    toRelative ? cacheRelativePath(projectRoot, file) : cacheAbsolutePath(projectRoot, file);
  copy.file = transform(copy.file);
  for (const local of copy.locals) local.file = transform(local.file);
  for (const entry of copy.exports) {
    if (entry.type === "local") entry.target.file = transform(entry.target.file);
  }
  for (const binding of copy.imports) {
    if (typeof binding.resolved === "string") binding.resolved = transform(binding.resolved);
  }
  return copy;
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
    const key = memoryCacheKey(projectRoot, file);
    const entry = memoryCache.get(key);
    if (entry) {
      if (entry.sig === sig) {
        lruMapGet(memoryCache, key);
        if (cacheEnabled && cacheReport) cacheReport.hits += 1;
        return entry.mod;
      }
      memoryCache.delete(key);
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
    return null;
  }
  if (mode === "disk") {
    try {
      const cache = getDiskModuleCache(projectRoot, opts);
      const row = cache.load.get(cacheRelativePath(projectRoot, file)) as
        | { sig: string; version: number; payload: Uint8Array }
        | undefined;
      if (row && row.sig === sig && row.version === PARSED_CACHE_VERSION) {
        const parsed: unknown = JSON.parse(brotliDecompressSync(row.payload).toString("utf8"));
        if (isModuleIndex(parsed)) {
          if (cacheEnabled && cacheReport) cacheReport.hits += 1;
          return transformModulePaths(projectRoot, parsed, false);
        }
      }
    } catch (error) {
      if (isNodeSqliteUnavailableError(error)) {
        reportMissingNodeSqlite(opts?.logLevel, error);
        return null;
      }
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
  }
  return null;
}

export type PendingModuleCacheWrite = {
  file: string;
  sig: string;
  mod: ModuleIndex;
};

export function writeModulesToCache(
  projectRoot: string,
  writes: readonly PendingModuleCacheWrite[],
  opts?: BuildOptions,
): void {
  if (!writes.length) return;
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    for (const write of writes) {
      lruMapSet(
        memoryCache,
        memoryCacheKey(projectRoot, write.file),
        { version: PARSED_CACHE_VERSION, sig: write.sig, mod: write.mod },
        MAX_MEMORY_CACHE_ENTRIES,
      );
    }
  } else if (mode === "disk") {
    try {
      const cache = getDiskModuleCache(projectRoot, opts);
      const now = Date.now();
      const preparedWrites: Array<{ file: string; sig: string; payload: Buffer }> = [];
      for (const write of writes) {
        const payload = brotliCompressSync(JSON.stringify(transformModulePaths(projectRoot, write.mod, true)), {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        });
        preparedWrites.push({
          file: cacheRelativePath(projectRoot, write.file),
          sig: write.sig,
          payload,
        });
      }
      cache.db.transaction(() => {
        for (const item of preparedWrites) {
          cache.write.run(item.file, item.sig, PARSED_CACHE_VERSION, item.payload, now);
        }
      })();
    } catch (error) {
      if (isNodeSqliteUnavailableError(error)) {
        reportMissingNodeSqlite(opts?.logLevel, error);
        return;
      }
      logWithLevel(opts?.logLevel, "warn", "Warning: Failed to write to cache:", error);
    }
  }
}

export function writeToCache(
  projectRoot: string,
  file: string,
  sig: string,
  mod: ModuleIndex,
  opts?: BuildOptions,
): void {
  writeModulesToCache(projectRoot, [{ file, sig, mod }], opts);
}
