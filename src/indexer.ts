import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import Parser from "tree-sitter";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import {
  supportForFile,
  getCompiledQueries,
  type LanguageSupport,
} from "./languages.js";
import { buildBloomFilterFromSource } from "./util/bloomFilter.js";
import {
  isUnsupportedParserInputError,
  prepareParserInput,
} from "./languages/filePrep.js";
import {
  listProjectFiles,
  discoverProjectFiles,
  DEFAULT_PROJECT_MANIFESTS,
  sliceText,
  toRange,
  unquote,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveSpecifier,
  resolveImportSpecifier,
  resolvePythonModule,
  resolveWorkspacePackage,
  normalizeResolutionHints,
  normalizePath,
  acquireParser,
  releaseParser,
  getGitHead,
  isGitRepo,
  getGitBlobHashes,
  listChangedFiles,
  mapLimit,
  type ProjectFileInfo,
} from "./util.js";
import {
  collectGraph,
  collectEdgesForFile,
  type GraphCacheEntry,
  type GraphBuildOptions,
  type FallbackImportExtractionEvent,
  type FallbackImportExtractionReason,
  type SymbolGraph,
} from "./graphs.js";
import type { Edge, Range, FileId, Graph } from "./types.js";
import {
  getNativeQueryExecution,
  type NativeCapture,
  type NativeQueryResults,
} from "./native/treeSitterNative.js";
import {
  initNativeBackendReport,
  recordNativeBackendOutcome,
} from "./native/nativeBackendReport.js";
import {
  capturesByName,
  capturesNamed,
  rangeFromNativeCapture,
} from "./native/queryResults.js";

// Default number of lines to include around references for line context
const DEFAULT_REF_CONTEXT_LINES = 5;
const QUERY_DRIVEN_LOCALS_LANGUAGES = new Set([
  "python",
  "java",
  "csharp",
  "rust",
  "kotlin",
  "swift",
  "cpp",
]);

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Variable = "variable",
  Interface = "interface",
  TypeAlias = "type",
  Default = "default",
}

// Shared Pos, Range, FileId types imported from ./types

export type SymbolDef = {
  file: FileId;
  localName: string;
  kind: SymbolKind;
  range: Range;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
};

export type ExportEntry =
  | { type: "local"; exportedAs: string; target: SymbolDef }
  | {
      type: "reexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    }
  | {
      type: "namespaceReexport";
      exportedAs: string;
      fromModule: string;
      moduleSpecifier?: string;
      typeOnly?: boolean;
    }
  | {
      type: "exportStar";
      fromModule: string;
      moduleSpecifier?: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    };

export type ImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "star";
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    };

export type ModuleIndex = {
  file: FileId;
  exports: ExportEntry[];
  imports: ImportBinding[];
  locals: SymbolDef[];
};

export type ProjectIndex = {
  graph: Graph;
  modules: Map<FileId, ModuleIndex>;
  byFile: Map<FileId, ModuleIndex>;
  exportCache: Map<string, ResolvedExport | null>;
  scopeCache: Map<string, ScopeIndex>;
  parsed?:
    | Map<
        string,
        {
          source: string;
          tree: Parser.Tree;
          sup: LanguageSupport | undefined;
          lang: Parser.Language;
          nativeQueries?: NativeQueryResults | null;
        }
      >
    | undefined;
  bloomFilters?: import("./util/bloomFilter.js").BloomFilterCache;
  projectFiles?: ProjectFileInfo[];
};
export type ResolvedExport =
  | { kind: "resolved"; def: SymbolDef }
  | { kind: "namespace"; file: FileId };

type ParsedFileContext = {
  source: string;
  tree: Parser.Tree;
  sup: LanguageSupport;
  lang: Parser.Language;
  nativeQueries?: NativeQueryResults | null;
};

type PreparedFileContext = {
  source: string;
  sup: LanguageSupport;
  lang: Parser.Language;
  nativeQueries: NativeQueryResults | null;
  nativeFallbackReason?: NativeBackendFallbackReason;
  nativeError?: string;
};

function parsePreparedFileContext(context: PreparedFileContext): ParsedFileContext {
  const { source, sup, lang, nativeQueries } = context;
  const key = sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts";
  const parser = acquireParser(lang, key);
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    return { source, tree, sup, lang, nativeQueries };
  } finally {
    releaseParser(parser, key);
  }
}

/**
 * Options for building the project index
 */
export type BuildOptions = {
  /** Callback for progress tracking during parsing/indexing */
  onProgress?: ((progress: import("./types.js").ProgressUpdate) => void) | undefined;
  /** Number of threads for parallel processing (default: 8) */
  threads?: number;
  /** Cache mode: "off" (default), "memory", or "disk" */
  cache?: "off" | "memory" | "disk";
  /** Custom cache directory (default: .codegraph-cache/index-v1) */
  cacheDir?: string;
  /** Use content-hash for cache validation (default: true). Set to false to use mtime+size only */
  cacheStrict?: boolean;
  /** Build bloom filters for faster reference scanning (default: true) */
  useBloomFilters?: boolean;
  /** Preset configuration (overrides individual options if set) */
  preset?: "code-review" | "ci-fast" | "development" | "production";
  /** Graph building options */
  graph?: GraphBuildOptions;
  /** Verify manifest consistency before reuse (incremental builds only) */
  cacheVerify?: boolean;
  /** Force full parsing for changed files during incremental builds */
  incrementalStrict?: boolean;
  /** Optional build report data for observability */
  report?: BuildReport;
  /** Max parsed AST entries retained in memory (LRU-style), default 1024 */
  parsedCacheMaxEntries?: number;
  /** Log level for build warnings (default: "warn") */
  logLevel?: "error" | "warn" | "info" | "debug" | "silent";
  /** Keep parsed trees in memory (default: false). Set to true for faster subsequent lookups at the cost of memory. */
  keepParsed?: boolean;
};

export type IncrementalBuildOptions = BuildOptions & {
  files?: string[];
  changedSince?: string;
  gitBase?: string;
  gitHead?: string;
};

export type CacheReport = {
  mode: "off" | "memory" | "disk";
  hits: number;
  misses: number;
};

export type BuildTimingReport = {
  totalMs?: number;
  manifestMs?: number;
  parseMs?: number;
  graphMs?: number;
  writeManifestMs?: number;
};

export type BuildFileReport = {
  total: number;
  changed?: number;
  cached?: number;
  parsed?: number;
};

export type FallbackImportExtractionReport = {
  total: number;
  byLanguage: Record<string, number>;
  files: Record<
    string,
    {
      language: string;
      reason: FallbackImportExtractionReason;
    }
  >;
};

export type GraphReport = {
  fallbackImportExtraction: FallbackImportExtractionReport;
};

export type ManifestReport = {
  used: boolean;
  reused: boolean;
  reason?: string;
  mismatches?: number;
  missing?: number;
  optionsMismatch?: string[];
};

export type NativeBackendFallbackReason =
  | "unavailable"
  | "unsupportedLanguage"
  | "queryFailure";

export type NativeBackendLanguageReport = {
  filesSeen: number;
  filesUsed: number;
  filesFellBack: number;
  fallbackReasons: Record<NativeBackendFallbackReason, number>;
  normalizedQueryKinds?: string[];
  skippedQueryKinds?: string[];
};

export type NativeBackendReport = {
  available: boolean;
  enabled: boolean;
  supportedLanguageIds: string[];
  filesUsed: number;
  filesFellBack: number;
  fallbackReasons: Record<NativeBackendFallbackReason, number>;
  byLanguage: Record<string, NativeBackendLanguageReport>;
  errors: Array<{
    file: string;
    languageId: string;
    reason: NativeBackendFallbackReason;
    message: string;
  }>;
  loadError?: string;
};

export type BackendReport = {
  native: NativeBackendReport;
};

export type BuildReport = {
  timings: BuildTimingReport;
  cache?: CacheReport;
  files?: BuildFileReport;
  graph?: GraphReport;
  manifest?: ManifestReport;
  backend?: BackendReport;
};

export type GraphDeltaReport = {
  changedFiles: string[];
  added: Edge[];
  removed: Edge[];
};

// ---------------- Symbol handles (agent-friendly) ----------------
export type SymbolHandle = string;

export function symbolId(def: SymbolDef): SymbolHandle {
  const idx = def?.range?.start?.index ?? 0;
  return `${def.file}::${def.localName}::${idx}`;
}

export function defFromSymbolId(
  index: ProjectIndex,
  id: SymbolHandle,
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const rawFile = parts[0]!;
  const localName = parts[1]!;
  const startStr = parts[2]!;
  const file = rawFile.replace(/\\/g, "/");
  const startIndex = Number(startStr);
  const mod = index.byFile.get(file);
  if (!mod) return null;
  const exact = mod.locals.find(
    (d) =>
      d.localName === localName && (d.range?.start?.index ?? 0) === startIndex,
  );
  if (exact) return exact;
  const byName = mod.locals.find((d) => d.localName === localName);
  return byName ?? null;
}

export function resolveSymbolId(
  index: ProjectIndex,
  id: SymbolHandle,
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length === 3 && parts[2] === "import") {
    const rawFile = parts[0]!;
    const alias = parts[1]!;
    const file = rawFile.replace(/\\/g, "/");
    const mod = index.byFile.get(file);
    if (!mod) return null;

    // Prefer named, then default, then namespace
    const named = mod.imports.find(
      (i): i is ImportBinding & { kind: "named" } =>
        i.kind === "named" && i.local === alias,
    );
    if (named) {
      const res = resolveImported(index, named, named.imported);
      if (res && !("namespace" in res)) return res;
      const target =
        typeof named.resolved === "string" ? named.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, named.imported);
        if (hit?.kind === "resolved") return hit.def;
      }
    }

    const deflt = mod.imports.find(
      (i): i is ImportBinding & { kind: "default" } =>
        i.kind === "default" && i.local === alias,
    );
    if (deflt) {
      const res = resolveImported(index, deflt, "default");
      if (res && !("namespace" in res)) return res;
      const target =
        typeof deflt.resolved === "string" ? deflt.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, "default");
        if (hit?.kind === "resolved") return hit.def;
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find(
          (e): e is ExportEntry & { type: "local" } => e.type === "local",
        );
        if (first) return first.target;
      }
    }

    const ns = mod.imports.find(
      (i) => i.kind === "namespace" && i.localNS === alias,
    );
    if (ns) {
      const target = typeof ns.resolved === "string" ? ns.resolved : undefined;
      if (target) {
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find(
          (e): e is ExportEntry & { type: "local" } => e.type === "local",
        );
        if (first) return first.target;
        const firstLocal = tmod?.locals?.[0];
        if (firstLocal) return firstLocal;
      }
    }

    return null;
  }

  // Otherwise treat as direct definition handle
  return defFromSymbolId(index, id);
}

function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json");
}

function collectJsonDependencies(
  imports: ImportBinding[],
  bucket: Set<string>,
) {
  for (const imp of imports) {
    const resolved =
      typeof imp.resolved === "string"
        ? imp.resolved.replace(/\\/g, "/")
        : null;
    if (resolved && isJsonFile(resolved)) bucket.add(resolved);
  }
}

function ensureJsonModule(modules: Map<FileId, ModuleIndex>, filePath: string) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, "/");
  if (modules.has(normalized)) return;
  if (!fs.existsSync(resolved)) return;
  const pos = { line: 1, column: 1, index: 0 };
  const sym: SymbolDef = {
    file: normalized,
    localName: "default",
    kind: SymbolKind.Default,
    range: { start: pos, end: pos },
  };
  const mod: ModuleIndex = {
    file: normalized,
    exports: [{ type: "local", exportedAs: "default", target: sym }],
    imports: [],
    locals: [sym],
  };
  modules.set(normalized, mod);
}

export function goToDefinitionById(
  index: ProjectIndex,
  id: SymbolHandle,
): GoToResult {
  const def = resolveSymbolId(index, id);
  if (def) return { status: "ok", definition: def };
  return { status: "not_found", reason: "No matching definition for handle" };
}

export async function findReferencesById(
  index: ProjectIndex,
  id: SymbolHandle,
) {
  const def = resolveSymbolId(index, id);
  if (!def)
    return {
      status: "not_found",
      reason: "No matching definition for handle",
    } as const;
  return await findReferences(index, { def });
}

export type SymbolListItem = {
  id: SymbolHandle;
  file: FileId;
  name: string;
  kind: SymbolKind | "import" | "namespaceImport";
  range?: Range;
  docstring?: string;
};

export function listSymbols(
  index: ProjectIndex,
  opts?: { file?: FileId; includeImports?: boolean },
): SymbolListItem[] {
  const out: SymbolListItem[] = [];
  const files = opts?.file
    ? [opts.file.replace(/\\/g, "/")]
    : Array.from(index.byFile.keys());

  for (const f of files) {
    const mod = index.byFile.get(f);
    if (!mod) continue;
    for (const def of mod.locals) {
      out.push({
        id: symbolId(def),
        file: f,
        name: def.localName,
        kind: def.kind,
        range: def.range,
        ...(def.docstring ? { docstring: def.docstring } : {}),
      });
    }
    if (opts?.includeImports) {
      for (const imp of mod.imports) {
        if (imp.kind === "named")
          out.push({
            id: `${f}::${imp.local}::import`,
            file: f,
            name: imp.local,
            kind: "import",
          });
        else if (imp.kind === "default")
          out.push({
            id: `${f}::${imp.local}::import`,
            file: f,
            name: imp.local,
            kind: "import",
          });
        else if (imp.kind === "namespace")
          out.push({
            id: `${f}::${imp.localNS}::import`,
            file: f,
            name: imp.localNS,
            kind: "namespaceImport",
          });
      }
    }
  }

  return out;
}

export type ApiSurface = Array<{
  file: FileId;
  exports: Array<{
    name: string;
    kind: string;
    exportedAs: string;
    target?: { file: FileId; name: string };
  }>;
}>;

export function getApiSurface(index: ProjectIndex): ApiSurface {
  const out: ApiSurface = [];
  for (const [file, mod] of index.byFile) {
    const exports = mod.exports.map((e) => {
      if (e.type === "local") {
        return {
          name: e.target.localName,
          kind: e.target.kind,
          exportedAs: e.exportedAs,
        };
      } else if (e.type === "reexport") {
        return {
          name: e.sourceSpecifier,
          kind: "reexport",
          exportedAs: e.exportedAs,
          target: { file: e.fromModule, name: e.sourceSpecifier },
        };
      } else if (e.type === "namespaceReexport") {
        return {
          name: "*",
          kind: "namespaceReexport",
          exportedAs: e.exportedAs,
          target: { file: e.fromModule, name: "*" },
        };
      } else {
        return {
          name: "*",
          kind: "exportStar",
          exportedAs: "*",
          target: { file: e.fromModule, name: "*" },
        };
      }
    });
    if (exports.length > 0) {
      out.push({ file, exports });
    }
  }
  return out;
}

// ---------------- Incremental cache (memory/disk) ----------------
const PARSED_CACHE_VERSION = 1;
type ModuleCacheEntry = {
  version: number;
  sig: string;
  mod: ModuleIndex;
};
const memoryCache = new Map<string, ModuleCacheEntry>();

type BetterSqliteDatabase = import("better-sqlite3").Database;

type PackageJsonDependencyInfo = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function collectWorkspaceManifestDependencyEdges(
  projectRoot: string,
): Promise<Edge[]> {
  const manifestPaths = await listProjectFiles(projectRoot, [
    "**/package.json",
  ]);
  if (manifestPaths.length === 0) return [];

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

const loadBetterSqlite3 = () => {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof import("better-sqlite3");
};

const diskCacheDatabases = new Map<string, BetterSqliteDatabase>();

function diskCacheDatabasePath(
  projectRoot: string,
  opts?: BuildOptions,
): string {
  return normalizePath(
    path.join(cacheRoot(projectRoot, opts), "index-cache.sqlite"),
  );
}

function getDiskCacheDatabase(
  projectRoot: string,
  opts?: BuildOptions,
): BetterSqliteDatabase {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const existing = diskCacheDatabases.get(dbPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(dbPath);
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

function closeDiskCacheDatabase(
  projectRoot: string,
  opts?: BuildOptions,
): void {
  const dbPath = diskCacheDatabasePath(projectRoot, opts);
  const db = diskCacheDatabases.get(dbPath);
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* checkpoint best-effort */
  }
  try {
    db.close();
    diskCacheDatabases.delete(dbPath);
  } catch {
    // If close fails, keep the handle in the map so a later attempt can retry.
  }
}

const MANIFEST_VERSION = 1;

type ManifestFileEntry = GraphCacheEntry;

type ManifestBuildOptions = {
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  useBloomFilters?: boolean;
  preset?: BuildOptions["preset"];
  incrementalStrict?: boolean;
};

type IndexManifest = {
  version: number;
  projectRoot: string;
  updatedAt: number;
  lastCommit?: string;
  configHash?: string;
  graphOptions?: GraphBuildOptions;
  buildOptions?: ManifestBuildOptions;
  files: Record<string, ManifestFileEntry>;
};

async function computeConfigHash(projectRoot: string): Promise<string> {
  try {
    const configFiles = await fg(DEFAULT_PROJECT_MANIFESTS, {
      cwd: projectRoot,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**"],
    });
    configFiles.sort();
    const hash = crypto.createHash("sha1");
    for (const file of configFiles) {
      try {
        const content = await fsp.readFile(file, "utf8");
        const rel = path.relative(projectRoot, file).replace(/\\/g, "/");
        hash.update(rel);
        hash.update(content);
      } catch (err) {
        console.debug(
          `computeConfigHash: failed to read config file "${file}":`,
          err,
        );
      }
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
}

function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return (
    opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1")
  );
}

type FileSignature = {
  sig: string;
  gitSig?: string;
  cacheSig: string;
  contentHash?: string;
};

function initCacheReport(
  report: BuildReport | undefined,
  mode: BuildOptions["cache"] | undefined,
): CacheReport | undefined {
  if (!report) return undefined;
  if (!report.cache) {
    report.cache = { mode: mode ?? "off", hits: 0, misses: 0 };
  }
  return report.cache;
}

function initFileReport(
  report: BuildReport | undefined,
): BuildFileReport | undefined {
  if (!report) return undefined;
  if (!report.files) {
    report.files = { total: 0, cached: 0, parsed: 0 };
  }
  return report.files;
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
        files: {},
      },
    };
  } else if (!report.graph.fallbackImportExtraction) {
    report.graph.fallbackImportExtraction = {
      total: 0,
      byLanguage: {},
      files: {},
    };
  }
  return report.graph.fallbackImportExtraction;
}

function createFallbackImportExtractionHandler(
  report: BuildReport | undefined,
  opts?: BuildOptions,
): ((event: FallbackImportExtractionEvent) => void) | undefined {
  const fallbackReport = initFallbackImportExtractionReport(report);
  const warningLimit = 20;
  let warningCount = 0;
  const logLevel = opts?.logLevel ?? "warn";
  const shouldLog = logLevel !== "silent" && logLevel !== "error";

  return (event: FallbackImportExtractionEvent) => {
    const filePath = event.file ? event.file.replace(/\\/g, "/") : "unknown";
    if (fallbackReport) {
      if (!fallbackReport.files[filePath]) {
        fallbackReport.total += 1;
        fallbackReport.byLanguage[event.language] =
          (fallbackReport.byLanguage[event.language] ?? 0) + 1;
      }
      fallbackReport.files[filePath] = {
        language: event.language,
        reason: event.reason,
      };
    }
    if (!shouldLog) return;
    if (warningCount >= warningLimit) return;
    warningCount += 1;
    console.warn("Warning: Regex fallback import extraction", event);
  };
}

function initManifestReport(
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
  const buf = await fsp.readFile(file);
  const h = crypto.createHash("sha1");
  h.update(buf);
  return h.digest("hex");
}

async function fileStatSignature(
  file: string,
  strict?: boolean,
  opts?: { includeContentHash?: boolean },
): Promise<{ sig: string; contentHash?: string }> {
  try {
    const st = await fsp.stat(file);
    // Default to strict mode (content-hash) for reliability
    // This is more reliable than mtime, especially with git operations
    const useStrict = strict !== false; // True unless explicitly set to false
    const shouldHash = useStrict || opts?.includeContentHash === true;
    const contentHash = shouldHash ? await fileContentHash(file) : undefined;
    if (!useStrict) {
      return contentHash
        ? { sig: `${st.mtimeMs}:${st.size}`, contentHash }
        : { sig: `${st.mtimeMs}:${st.size}` };
    }
    if (contentHash) {
      return {
        sig: `${st.mtimeMs}:${st.size}:${contentHash}`,
        contentHash,
      };
    }
    return { sig: `${st.mtimeMs}:${st.size}` };
  } catch {
    return { sig: "0:0" };
  }
}

async function fileSignature(
  file: string,
  strict?: boolean,
  gitSig?: string,
  opts?: { forceContentHash?: boolean },
): Promise<FileSignature> {
  const includeContentHash = opts?.forceContentHash === true;
  const statOpts = includeContentHash
    ? { includeContentHash: true }
    : undefined;
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

async function cacheSignatureForFile(
  file: string,
  sigInfo: FileSignature,
): Promise<string> {
  if (sigInfo.gitSig) return sigInfo.gitSig;
  if (sigInfo.contentHash) return sigInfo.contentHash;
  const contentHash = await fileContentHash(file);
  sigInfo.contentHash = contentHash;
  return contentHash;
}

async function buildBloomFilterForFile(
  file: string,
): Promise<import("./util/bloomFilter.js").BloomFilter | null> {
  try {
    const source = await fsp.readFile(file, "utf8");
    const sup = supportForFile(file);
    if (!sup) return null;
    return buildBloomFilterFromSource(source, sup.id);
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

function tryLoadFromCache(
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
    const ent = memoryCache.get(file);
    if (ent && ent.sig === sig) {
      if (cacheEnabled && cacheReport) cacheReport.hits += 1;
      return ent.mod;
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
    return null;
  }
  if (mode === "disk") {
    try {
      const db = getDiskCacheDatabase(projectRoot, opts);
      const row = db
        .prepare(
          "SELECT sig, version, payload FROM module_cache WHERE file = ?",
        )
        .get(file) as
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
      /* cache read failed */
    }
    if (cacheEnabled && cacheReport) cacheReport.misses += 1;
  }
  return null;
}

function writeToCache(
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
      console.warn("Warning: Failed to write to cache:", error);
    }
  }
}

function manifestFilePath(projectRoot: string, opts?: BuildOptions): string {
  return path.join(cacheRoot(projectRoot, opts), "manifest.json");
}

async function loadManifest(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<IndexManifest | null> {
  try {
    const mf = manifestFilePath(projectRoot, opts);
    const raw = await fsp.readFile(mf, "utf8");
    const parsed = JSON.parse(raw) as IndexManifest;
    if (parsed.version !== MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(
  projectRoot: string,
  opts: BuildOptions | undefined,
  manifest: IndexManifest,
) {
  try {
    const mf = manifestFilePath(projectRoot, opts);
    await fsp.mkdir(path.dirname(mf), { recursive: true });
    await fsp.writeFile(mf, JSON.stringify(manifest, null, 2), "utf8");
  } catch (error) {
    console.warn("Warning: Failed to write manifest:", error);
  }
}

async function verifyManifestEntries(
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
    const sigInfo = await fileSignature(
      file,
      opts?.cacheStrict,
      gitSigMap.get(file),
    );
    const matchesGitSig =
      !!entry.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
    const matchesSig = entry.sig === sigInfo.sig;
    if (!matchesGitSig && !matchesSig) mismatches += 1;
  }
  return { mismatches, missing };
}

async function buildProjectIndexFromExport(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  return buildProjectIndex(projectRoot, opts);
}

function graphOptionsEqual(
  a?: GraphBuildOptions,
  b?: GraphBuildOptions,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normA = normalizeGraphOptions(a);
  const normB = normalizeGraphOptions(b);
  if (!!normA.fast !== !!normB.fast) return false;
  if (!!normA.resolveNodeModules !== !!normB.resolveNodeModules) return false;
  if (!!normA.dynamicImportHeuristics !== !!normB.dynamicImportHeuristics)
    return false;
  const disabledA = normA.fastRegexDisabledLanguages ?? [];
  const disabledB = normB.fastRegexDisabledLanguages ?? [];
  if (disabledA.length !== disabledB.length) return false;
  for (let i = 0; i < disabledA.length; i++) {
    if (disabledA[i] !== disabledB[i]) return false;
  }
  const hintsA = normA.resolutionHints ?? [];
  const hintsB = normB.resolutionHints ?? [];
  if (hintsA.length !== hintsB.length) return false;
  for (let i = 0; i < hintsA.length; i++) {
    if (hintsA[i] !== hintsB[i]) return false;
  }
  return true;
}

function normalizeManifestBuildOptions(
  opts?: ManifestBuildOptions,
): ManifestBuildOptions {
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
  };
}

function normalizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return {
    cache: opts?.cache ?? "off",
    cacheStrict: opts?.cacheStrict ?? true,
    useBloomFilters: opts?.useBloomFilters ?? true,
    preset: opts?.preset,
    incrementalStrict: opts?.incrementalStrict ?? false,
  };
}

function summarizeBuildOptions(opts?: BuildOptions): ManifestBuildOptions {
  return normalizeBuildOptions(opts);
}

function normalizeLanguageList(list?: string[]): string[] {
  // Normalize language IDs for stable comparisons (trim, lowercase, dedupe, sort).
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

function diffBuildOptions(
  manifestOpts: ManifestBuildOptions | undefined,
  currentOpts: BuildOptions | undefined,
): string[] {
  if (!manifestOpts) return [];
  const normalizedManifest = normalizeManifestBuildOptions(manifestOpts);
  const normalizedCurrent = normalizeBuildOptions(currentOpts);
  const diffs: string[] = [];
  if (normalizedManifest.cache !== normalizedCurrent.cache) diffs.push("cache");
  if (normalizedManifest.cacheStrict !== normalizedCurrent.cacheStrict)
    diffs.push("cacheStrict");
  if (normalizedManifest.useBloomFilters !== normalizedCurrent.useBloomFilters)
    diffs.push("useBloomFilters");
  if (normalizedManifest.preset !== normalizedCurrent.preset)
    diffs.push("preset");
  if (
    normalizedManifest.incrementalStrict !== normalizedCurrent.incrementalStrict
  )
    diffs.push("incrementalStrict");
  return diffs;
}

function normalizeGraphOptions(opts?: GraphBuildOptions): GraphBuildOptions {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const fastRegexDisabledLanguages = normalizeLanguageList(
    opts?.fastRegexDisabledLanguages,
  );
  return {
    fast: !!opts?.fast,
    ...(fastRegexDisabledLanguages.length > 0
      ? { fastRegexDisabledLanguages }
      : {}),
    resolveNodeModules: !!opts?.resolveNodeModules,
    dynamicImportHeuristics: !!opts?.dynamicImportHeuristics,
    ...(resolutionHints.length > 0 ? { resolutionHints } : {}),
  };
}

function edgeKey(edge: Edge): string {
  const toKey =
    edge.to.type === "file"
      ? `file:${edge.to.path}`
      : `external:${edge.to.name}`;
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${edge.from}|${toKey}|${edge.raw}|${typeOnly}`;
}

function compareEdges(left: Edge, right: Edge): number {
  const fromCompare = left.from.localeCompare(right.from);
  if (fromCompare !== 0) return fromCompare;
  if (left.to.type !== right.to.type) {
    return left.to.type === "file" ? -1 : 1;
  }
  const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
  const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
  const toCompare = leftTo.localeCompare(rightTo);
  if (toCompare !== 0) return toCompare;
  const rawCompare = left.raw.localeCompare(right.raw);
  if (rawCompare !== 0) return rawCompare;
  const leftTypeOnly = left.typeOnly ? 1 : 0;
  const rightTypeOnly = right.typeOnly ? 1 : 0;
  return leftTypeOnly - rightTypeOnly;
}

function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
  return {
    from: normalizePath(path.relative(projectRoot, edge.from)),
    to:
      edge.to.type === "file"
        ? {
            type: "file",
            path: normalizePath(path.relative(projectRoot, edge.to.path)),
          }
        : edge.to,
    raw: edge.raw,
    ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
  };
}

function parseObjectPatternBindings(
  patternText: string,
): Array<{ imported: string; local: string }> {
  const trimmed = patternText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const parts = body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out: Array<{ imported: string; local: string }> = [];
  for (const part of parts) {
    const withoutDefault = part.replace(/\s*=\s*.+$/, "").trim();
    const match = withoutDefault.match(
      /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/,
    );
    if (!match) continue;
    const imported = match[1]!;
    const local = match[2] ?? imported;
    out.push({ imported, local });
  }
  return out;
}

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang: Parser.Language,
  imports: ImportBinding[] = [],
  opts?: { tree?: Parser.Tree; nativeQueries?: NativeQueryResults | null },
): ModuleIndex {
  const normalizeDocstringLine = (line: string) =>
    line.replace(/^\s*(?:\/\/\/?\s?|#\s?)/, "").replace(/^\s*\*\s?/, "");

  const _sourceLines = source.split(/\r?\n/);

  const extractLeadingDocstring = (
    node: Parser.SyntaxNode | null,
  ): string | undefined => {
    if (!node) return undefined;
    // If we're looking at an identifier, look at its parent (the declaration)
    let target = node;
    if (
      target.type === "identifier" ||
      target.type === "type_identifier" ||
      target.type === "property_identifier"
    ) {
      if (target.parent) target = target.parent;
    }
    // Handle variable declarators - climb to declaration statement
    if (target.type === "variable_declarator" && target.parent) {
      target = target.parent;
    }
    // Handle export statements wrapping the declaration
    if (target.parent && target.parent.type === "export_statement") {
      target = target.parent;
    }

    const comments: string[] = [];
    let prev = target.previousNamedSibling;
    // Walk backwards through comments
    while (
      prev &&
      (prev.type === "comment" ||
        prev.type === "line_comment" ||
        prev.type === "block_comment")
    ) {
      const text = sliceText(prev, source);
      // Clean up comment syntax
      const clean = text
        .replace(/^\s*\/\*\*?/, "") // /** or /*
        .replace(/\*\/\s*$/, "") // */
        .replace(/^\s*\/\/\/?/, "") // // or ///
        .replace(/^\s*#/, "") // #
        .split("\n")
        .map((l) => normalizeDocstringLine(l))
        .join("\n");
      comments.unshift(clean.trim());
      prev = prev.previousNamedSibling;
    }
    return comments.length > 0 ? comments.join("\n").trim() : undefined;
  };

  const countMatches = (text: string, re: RegExp): number => {
    const matches = text.match(re);
    return matches ? matches.length : 0;
  };

  const estimateComplexity = (
    range: Range,
    languageId: string,
  ): number | undefined => {
    const startIdx = range.start.index;
    const endIdx = range.end.index;
    if (startIdx === undefined || endIdx === undefined || endIdx <= startIdx)
      return undefined;
    const snippet = source.slice(startIdx, endIdx);
    if (!snippet.trim()) return undefined;
    const keywordPatterns = [
      /\bif\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\belse\s+if\b/g,
    ];
    if (languageId === "python") {
      keywordPatterns.push(/\belif\b/g, /\bexcept\b/g);
    }
    const operatorPatterns = [/&&/g, /\|\|/g, /\?\s*[^:]/g];
    let count = 0;
    for (const re of keywordPatterns) count += countMatches(snippet, re);
    for (const re of operatorPatterns) count += countMatches(snippet, re);
    return 1 + count;
  };

  const buildSymbolDef = (
    localName: string,
    kind: SymbolKind,
    range: Range,
    node?: Parser.SyntaxNode,
  ): SymbolDef => {
    let lineSpan: number | undefined;
    if (
      typeof range.start.line === "number" &&
      typeof range.end.line === "number" &&
      range.end.line >= range.start.line
    ) {
      lineSpan = Math.max(1, range.end.line - range.start.line + 1);
    }
    let docstring: string | undefined;
    if (node) {
      docstring = extractLeadingDocstring(node);
    }
    const shouldEstimateComplexity =
      kind === SymbolKind.Function || kind === SymbolKind.Class;
    const complexity = shouldEstimateComplexity
      ? estimateComplexity(range, support.id)
      : undefined;
    const base: SymbolDef = {
      file,
      localName,
      kind,
      range,
    };
    if (docstring) base.docstring = docstring;
    if (lineSpan) base.lineSpan = lineSpan;
    if (typeof complexity === "number") base.complexity = complexity;
    return base;
  };

  const nativeQueries = opts?.nativeQueries ?? null;
  let tree: Parser.Tree | null = opts?.tree ?? null;
  if (!tree) {
    try {
      const key =
        support.id === "python" ? "py" : support.id === "js" ? "js" : "ts";
      const parser = acquireParser(lang, key);
      try {
        parser.setLanguage(lang);
        tree = parser.parse(source);
      } finally {
        releaseParser(parser, key);
      }
    } catch {
      /* parse fallback: ignore */
    }
  }

  const locals: SymbolDef[] = [];
  const seenLocals = new Set<string>();
  const toKind = (s: string): SymbolKind => {
    if (s === "function") return SymbolKind.Function;
    if (s === "class") return SymbolKind.Class;
    if (s === "interface") return SymbolKind.Interface;
    if (s === "type") return SymbolKind.TypeAlias;
    return SymbolKind.Variable;
  };

  const pushLocal = (
    localName: string,
    kind: SymbolKind,
    range: Range,
    node?: Parser.SyntaxNode,
  ) => {
    const key = `${localName}:${range.start.index ?? 0}:${range.end.index ?? 0}`;
    if (seenLocals.has(key)) return;
    seenLocals.add(key);
    locals.push(buildSymbolDef(localName, kind, range, node));
  };

  const classifyLocalCapture = (
    capture: NativeCapture | Parser.QueryCapture,
    range: Range,
    node?: Parser.SyntaxNode,
  ): SymbolKind => {
    if (node) return toKind(support.classifyDefinition(node));
    if ("name" in capture && capture.name === "tname") {
      return SymbolKind.TypeAlias;
    }
    return SymbolKind.Variable;
  };

  const extractLocalsFromNativeQueries = (): boolean => {
    if (!nativeQueries) return false;
    if (!QUERY_DRIVEN_LOCALS_LANGUAGES.has(support.id)) return false;
    try {
      for (const match of nativeQueries.locals) {
        for (const capture of match.captures) {
          if (capture.name !== "name" && capture.name !== "tname") continue;
          const nativeRange = rangeFromNativeCapture(capture);
          const node =
            tree?.rootNode.descendantForIndex(
              nativeRange.start.index ?? 0,
              nativeRange.end.index ?? 0,
            ) ?? undefined;
          pushLocal(
            capture.text,
            classifyLocalCapture(capture, nativeRange, node),
            nativeRange,
            node,
          );
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  const extractLocalsFromJsQueries = (): boolean => {
    if (!tree || !support.queries.locals.trim()) return false;
    if (!QUERY_DRIVEN_LOCALS_LANGUAGES.has(support.id)) return false;
    try {
      let q: Parser.Query;
      try {
        ({ locals: q } = getCompiledQueries(lang, support));
      } catch {
        q = new Parser.Query(lang, support.queries.locals);
      }
      for (const m of q.matches(tree.rootNode)) {
        for (const cap of m.captures) {
          if (cap.name !== "name" && cap.name !== "tname") continue;
          const range = toRange(cap.node);
          pushLocal(
            sliceText(cap.node, source),
            classifyLocalCapture(cap, range, cap.node),
            range,
            cap.node,
          );
        }
      }
      return true;
    } catch (error) {
      console.warn(`Warning: Query error in locals for ${support.id}:`, error);
      return false;
    }
  };

  const usedNativeLocals = extractLocalsFromNativeQueries();
  const usedQueryLocals = usedNativeLocals || extractLocalsFromJsQueries();
  if (tree && !usedQueryLocals) {
      const scopeIdx = buildScopeIndexFromSource(
        file,
        source,
        support,
        lang,
        imports,
        tree ? { tree } : undefined,
      );
      for (const b of scopeIdx.all) {
        if (!b.def) continue;
        let kind: SymbolKind = SymbolKind.Variable;
        if (b.kind === "function") kind = SymbolKind.Function;
        else if (b.kind === "class") kind = SymbolKind.Class;
        else if (b.kind === "type") kind = SymbolKind.TypeAlias;
        // Find the node in tree corresponding to b.def range if possible
        const startIndex = b.def.start.index ?? 0;
        const endIndex = b.def.end.index ?? 0;
        const node = tree.rootNode.descendantForIndex(startIndex, endIndex);
        pushLocal(b.name, kind, b.def, node);
      }
  }

  const mergeTypeScriptNamespaceDeclarations = (
    items: SymbolDef[],
  ): SymbolDef[] => {
    if (support.id !== "ts" && support.id !== "tsx") return items;
    const byName = new Map<string, SymbolDef[]>();
    for (const item of items) {
      const group = byName.get(item.localName);
      if (group) group.push(item);
      else byName.set(item.localName, [item]);
    }
    const out: SymbolDef[] = [];
    const rank = (k: SymbolKind): number => {
      if (k === SymbolKind.Class) return 5;
      if (k === SymbolKind.Interface) return 4;
      if (k === SymbolKind.TypeAlias) return 3;
      if (k === SymbolKind.Function) return 2;
      return 1;
    };
    for (const group of byName.values()) {
      if (group.length === 1) {
        out.push(group[0]!);
        continue;
      }
      const sorted = [...group].sort((a, b) => rank(b.kind) - rank(a.kind));
      out.push(sorted[0]!);
    }
    return out;
  };
  const mergedLocals = mergeTypeScriptNamespaceDeclarations(locals);

  const exports: ExportEntry[] = [];
  const pythonAllExports = new Set<string>();
  let hasPythonAll = false;

  let usedNativeExports = false;
  if (support.queries.exports.trim() && nativeQueries) {
    try {
      for (const match of nativeQueries.exports) {
        const map = capturesByName(match);
        const stmtText = map["stmt"]?.text ?? "";
        const isTypeOnly = support.isTypeOnly(stmtText);

        if (support.id === "python") {
          const leftText = map["left"]?.text ?? "";
          const methodText = map["method"]?.text ?? "";
          const isAllAssignment = leftText === "__all__";
          const isAllMethod =
            leftText === "__all__" &&
            (methodText === "extend" || methodText === "append");

          if (isAllAssignment || isAllMethod) {
            hasPythonAll = true;
            const items = capturesNamed(match, "all_item");
            for (const item of items) {
              const name = unquote(item.text);
              pythonAllExports.add(name);
              const local = mergedLocals.find((def) => def.localName === name);
              if (
                local &&
                !exports.some(
                  (entry) =>
                    entry.type !== "exportStar" &&
                    "exportedAs" in entry &&
                    entry.exportedAs === name,
                )
              ) {
                exports.push({
                  type: "local",
                  exportedAs: name,
                  target: local,
                });
              }
            }
            if (isAllAssignment && map["stmt"]) {
              const assignmentText = map["stmt"]!.text;
              const hasTuple = /=\s*\(/.test(assignmentText);
              if (items.length === 0 || hasTuple) {
                const strRe = /["']([^"']+)["']/g;
                for (let submatch; (submatch = strRe.exec(assignmentText)); ) {
                  const name = submatch[1]!;
                  pythonAllExports.add(name);
                  const local = mergedLocals.find((def) => def.localName === name);
                  if (
                    local &&
                    !exports.some(
                      (entry) =>
                        entry.type !== "exportStar" &&
                        "exportedAs" in entry &&
                        entry.exportedAs === name,
                    )
                  ) {
                    exports.push({
                      type: "local",
                      exportedAs: name,
                      target: local,
                    });
                  }
                }
              }
            }
            continue;
          }
          if (map["name"]) {
            const nameText = map["name"]!.text;
            const local = locals.find((def) => def.localName === nameText);
            if (local && !nameText.startsWith("_")) {
              exports.push({
                type: "local",
                exportedAs: nameText,
                target: local,
              });
            }
            continue;
          }
        }

        if (map["from"]) {
          const from = unquote(map["from"]!.text);
          if (map["src"]) {
            const srcName = map["src"]!.text;
            const alias = map["alias"]?.text ?? srcName;
            exports.push({
              type: "reexport",
              exportedAs: alias,
              fromModule: from,
              moduleSpecifier: from,
              sourceSpecifier: srcName,
              typeOnly: isTypeOnly,
            });
          } else if (/^\s*export\s*\*/.test(stmtText)) {
            exports.push({
              type: "exportStar",
              fromModule: from,
              moduleSpecifier: from,
              sourceSpecifier: from,
              typeOnly: isTypeOnly,
            });
          }
          continue;
        }
        if (map["cjs_shorthand"]) {
          const nameText = map["cjs_shorthand"]!.text;
          const local = locals.find((def) => def.localName === nameText);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          }
          continue;
        }
        if (map["cjs_export_name"] && map["cjs_local"]) {
          const exportedAs = map["cjs_export_name"]!.text;
          const localName = map["cjs_local"]!.text;
          const local = locals.find((def) => def.localName === localName);
          if (local) exports.push({ type: "local", exportedAs, target: local });
          continue;
        }
        if (map["cjs_export_name"] && map["cjs_fn"]) {
          const exportedAs = map["cjs_export_name"]!.text;
          const sym = buildSymbolDef(
            exportedAs,
            SymbolKind.Function,
            rangeFromNativeCapture(map["cjs_fn"]!),
          );
          locals.push(sym);
          exports.push({ type: "local", exportedAs, target: sym });
          continue;
        }
        if (map["default"]) {
          const nameText = map["default"]!.text;
          const local = locals.find((def) => def.localName === nameText);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
          continue;
        }
        if (map["anon_default"]) {
          const sym = buildSymbolDef(
            "__default_export__",
            SymbolKind.Default,
            rangeFromNativeCapture(map["anon_default"]!),
          );
          locals.push(sym);
          exports.push({ type: "local", exportedAs: "default", target: sym });
          continue;
        }
        const tsExportAssignMatch =
          support.id === "ts" || support.id === "tsx"
            ? stmtText.match(/^\s*export\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/)
            : null;
        if (tsExportAssignMatch) {
          const ident = tsExportAssignMatch[1]!;
          const local = locals.find((def) => def.localName === ident);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
          continue;
        }
        if (map["ts_export_assign"]) {
          const ident = map["ts_export_assign"]!.text;
          const local = locals.find((def) => def.localName === ident);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
          continue;
        }
        if (map["name"]) {
          const nameText = map["name"]!.text;
          const local = locals.find((def) => def.localName === nameText);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
            const exportText = stmtText;
            if (/^\s*export\s+default\b/.test(exportText)) {
              exports.push({
                type: "local",
                exportedAs: "default",
                target: { ...local, kind: SymbolKind.Default },
              });
            }
          }
          continue;
        }
        if (map["src"]) {
          const srcName = map["src"]!.text;
          const alias = map["alias"]?.text ?? srcName;
          const local = locals.find((def) => def.localName === srcName);
          if (local) {
            exports.push({ type: "local", exportedAs: alias, target: local });
          }
        }
      }
      if (
        !exports.some((entry) => entry.type === "local" && entry.exportedAs === "default")
      ) {
        const mDefFn = source.match(
          /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/,
        );
        const mDefCls = source.match(
          /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
        );
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((def) => def.localName === name);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          }
        }
      }
      usedNativeExports = true;
    } catch {
      usedNativeExports = false;
    }
  }
  if (support.queries.exports.trim() && tree && !usedNativeExports) {
    try {
      const { exports: q } = getCompiledQueries(lang, support);
      for (const m of q.matches(tree.rootNode)) {
        const map = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const),
        );
        const stmtText = map["stmt"] ? sliceText(map["stmt"].node, source) : "";
        const isTypeOnly = support.isTypeOnly(stmtText);

        if (support.id === "python") {
          // Check for __all__ patterns: assignment, augmented assignment, extend(), append()
          const leftText = map["left"]
            ? sliceText(map["left"].node, source)
            : "";
          const methodText = map["method"]
            ? sliceText(map["method"].node, source)
            : "";
          const isAllAssignment = leftText === "__all__";
          const isAllMethod =
            leftText === "__all__" &&
            (methodText === "extend" || methodText === "append");

          if (isAllAssignment || isAllMethod) {
            hasPythonAll = true;
            const items = m.captures.filter(
              (c: Parser.QueryCapture) => c.name === "all_item",
            );
            for (const it of items) {
              const name = unquote(sliceText(it.node, source));
              pythonAllExports.add(name);
              const local = mergedLocals.find((d) => d.localName === name);
              if (
                local &&
                !exports.some(
                  (e) =>
                    e.type !== "exportStar" &&
                    (e as { exportedAs: string }).exportedAs === name,
                )
              )
                exports.push({
                  type: "local",
                  exportedAs: name,
                  target: local,
                });
            }
            // Fallback for tuples/multiline patterns that tree-sitter may not fully capture.
            // Run if tree-sitter captured 0 items, OR if statement contains tuple (parentheses)
            // which tree-sitter queries may only partially capture.
            if (isAllAssignment && map["stmt"]) {
              const stmtNode = map["stmt"].node;
              const stmtText = source.slice(
                stmtNode.startIndex,
                stmtNode.endIndex,
              );
              // Check if this is a tuple assignment (contains parentheses after =)
              const hasTuple = /=\s*\(/.test(stmtText);
              // Only run fallback if no items captured OR it's a tuple pattern
              if (items.length === 0 || hasTuple) {
                const strRe = /["']([^"']+)["']/g;
                for (let sm; (sm = strRe.exec(stmtText)); ) {
                  const name = sm[1]!;
                  pythonAllExports.add(name);
                  const local = mergedLocals.find((d) => d.localName === name);
                  if (
                    local &&
                    !exports.some(
                      (e) =>
                        e.type !== "exportStar" &&
                        (e as { exportedAs: string }).exportedAs === name,
                    )
                  )
                    exports.push({
                      type: "local",
                      exportedAs: name,
                      target: local,
                    });
                }
              }
            }
            continue;
          }
          if (map["name"]) {
            const nameText = sliceText(map["name"].node, source);
            const local = locals.find((d) => d.localName === nameText);
            if (local) {
              if (!nameText.startsWith("_")) {
                exports.push({
                  type: "local",
                  exportedAs: nameText,
                  target: local,
                });
              }
            }
            continue;
          }
        }

        if (map["from"]) {
          const from = unquote(sliceText(map["from"].node, source));
          if (map["src"]) {
            const srcName = sliceText(map["src"].node, source);
            const alias = map["alias"]
              ? sliceText(map["alias"].node, source)
              : srcName;
            exports.push({
              type: "reexport",
              exportedAs: alias,
              fromModule: from,
              moduleSpecifier: from,
              sourceSpecifier: srcName,
              typeOnly: isTypeOnly,
            });
          } else if (/^\s*export\s*\*/.test(stmtText)) {
            exports.push({
              type: "exportStar",
              fromModule: from,
              moduleSpecifier: from,
              sourceSpecifier: from,
              typeOnly: isTypeOnly,
            });
          }
          continue;
        }
        if (map["cjs_shorthand"]) {
          const nameText = sliceText(map["cjs_shorthand"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local)
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          continue;
        }
        if (map["cjs_export_name"] && map["cjs_local"]) {
          const exportedAs = sliceText(map["cjs_export_name"].node, source);
          const localName = sliceText(map["cjs_local"].node, source);
          const local = locals.find((d) => d.localName === localName);
          if (local) exports.push({ type: "local", exportedAs, target: local });
          continue;
        }
        // CJS: direct function/arrow assignment to exports/module.exports
        if (map["cjs_export_name"] && map["cjs_fn"]) {
          const exportedAs = sliceText(map["cjs_export_name"].node, source);
          const defRange = toRange(map["cjs_fn"].node);
          const sym = buildSymbolDef(
            exportedAs,
            SymbolKind.Function,
            defRange,
            map["cjs_fn"].node,
          );
          locals.push(sym);
          exports.push({ type: "local", exportedAs, target: sym });
          continue;
        }
        if (map["default"]) {
          const nameText = sliceText(map["default"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          continue;
        }
        if (map["anon_default"]) {
          const sym = buildSymbolDef(
            "__default_export__",
            SymbolKind.Default,
            toRange(map["anon_default"].node),
            map["anon_default"].node,
          );
          locals.push(sym);
          exports.push({ type: "local", exportedAs: "default", target: sym });
          continue;
        }
        const tsExportAssignMatch =
          support.id === "ts" || support.id === "tsx"
            ? stmtText.match(/^\s*export\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/)
            : null;
        if (tsExportAssignMatch) {
          const ident = tsExportAssignMatch[1]!;
          const local = locals.find((d) => d.localName === ident);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          continue;
        }
        if (map["ts_export_assign"]) {
          const ident = sliceText(map["ts_export_assign"].node, source);
          const local = locals.find((d) => d.localName === ident);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          continue;
        }
        if (map["name"]) {
          const nameNode = map["name"].node;
          const nameText = sliceText(nameNode, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
            let cur: Parser.SyntaxNode | null = nameNode;
            let exportStmt: Parser.SyntaxNode | null = null;
            while (cur) {
              if (cur.type === "export_statement") {
                exportStmt = cur;
                break;
              }
              cur = cur.parent;
            }
            const exportText = exportStmt
              ? sliceText(exportStmt, source)
              : stmtText;
            if (/^\s*export\s+default\b/.test(exportText)) {
              exports.push({
                type: "local",
                exportedAs: "default",
                target: { ...local, kind: SymbolKind.Default },
              });
            }
          }
          continue;
        }
        if (map["src"]) {
          const srcName = sliceText(map["src"].node, source);
          const alias = map["alias"]
            ? sliceText(map["alias"].node, source)
            : srcName;
          const local = locals.find((d) => d.localName === srcName);
          if (local)
            exports.push({ type: "local", exportedAs: alias, target: local });
        }
      }
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === "default")
      ) {
        const mDefFn = source.match(
          /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/,
        );
        const mDefCls = source.match(
          /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
        );
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
        }
      }
    } catch {
      // fall through to regex fallback below
    }
  }

  // Regex fallback for JS/TS exports when queries miss some patterns (e.g., re-exports)
  if (support.id === "ts" || support.id === "tsx" || support.id === "js") {
    const reDecl =
      /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
    const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
    const reExportAssign = /\bexport\s*=\s*([A-Za-z_$][\w$]*)/g;
    const reReexport = /\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']+)\2/g;
    const reReexportNs =
      /\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*("|')([^"']+)\2/g;
    const reStar = /\bexport\s*\*\s*from\s*("|')([^"']+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = reDecl.exec(source))) {
      const name = m[1]!;
      if (!exports.some((e) => e.type === "local" && e.exportedAs === name)) {
        const local = locals.find((d) => d.localName === name);
        if (local)
          exports.push({ type: "local", exportedAs: name, target: local });
      }
    }
    while ((m = reDefault.exec(source))) {
      const name = m[1]!;
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === "default")
      ) {
        const local = locals.find((d) => d.localName === name);
        if (local)
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
      }
    }
    while ((m = reExportAssign.exec(source))) {
      const name = m[1]!;
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === "default")
      ) {
        const local = locals.find((d) => d.localName === name);
        if (local)
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
      }
    }
    while ((m = reReexport.exec(source))) {
      const list = m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const from = m[3]!;
      for (const spec of list) {
        const mm = spec.match(
          /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
        );
        if (!mm) continue;
        const srcName = mm[1]!;
        const alias = mm[2] ?? srcName;
        if (
          !exports.some(
            (e) =>
              e.type === "reexport" &&
              e.exportedAs === alias &&
              e.fromModule === from,
          )
        ) {
          exports.push({
            type: "reexport",
            exportedAs: alias,
            fromModule: from,
            sourceSpecifier: srcName,
          });
        }
      }
    }
    while ((m = reReexportNs.exec(source))) {
      const alias = m[1]!;
      const from = m[3]!;
      if (
        !exports.some(
          (e) =>
            (e.type === "reexport" || e.type === "namespaceReexport") &&
            e.exportedAs === alias &&
            e.fromModule === from,
        )
      ) {
        exports.push({
          type: "namespaceReexport",
          exportedAs: alias,
          fromModule: from,
        });
      }
    }
    while ((m = reStar.exec(source))) {
      const from = m[2]!;
      if (
        !exports.some((e) => e.type === "exportStar" && e.fromModule === from)
      ) {
        exports.push({
          type: "exportStar",
          fromModule: from,
          sourceSpecifier: from,
        });
      }
    }
    // CommonJS: exports.name = function/arrow, module.exports.name = function/arrow
    const reCjsFn =
      /(?:^|[;\n\r])\s*(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(function\b|\([^)]*\)\s*=>)/g;
    while ((m = reCjsFn.exec(source))) {
      const exportedAs = m[1]!;
      if (!locals.find((d) => d.localName === exportedAs)) {
        const idx = m.index + m[0].indexOf(exportedAs);
        const pos = { line: 1, column: 1, index: idx };
        const sym: SymbolDef = {
          file,
          localName: exportedAs,
          kind: SymbolKind.Function,
          range: { start: pos, end: pos },
        };
        locals.push(sym);
      }
      const local = locals.find((d) => d.localName === exportedAs)!;
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === exportedAs)
      ) {
        exports.push({ type: "local", exportedAs, target: local });
      }
    }
    // CommonJS: module.exports = { helper: function(){}, ... }
    const reCjsObjFn = /([A-Za-z_$][\w$]*)\s*:\s*(function\b|\([^)]*\)\s*=>)/g;
    const moduleExportsObjMatch = source.match(
      /module\.exports\s*=\s*\{([^}]*)\}/s,
    );
    if (moduleExportsObjMatch && moduleExportsObjMatch.index !== undefined) {
      const objContent = moduleExportsObjMatch[1]!;
      let mObj: RegExpExecArray | null;
      while ((mObj = reCjsObjFn.exec(objContent))) {
        const exportedAs = mObj[1]!;
        if (!locals.find((d) => d.localName === exportedAs)) {
          const idx =
            moduleExportsObjMatch.index +
            moduleExportsObjMatch[0].indexOf(exportedAs);
          const pos = { line: 1, column: 1, index: idx };
          const sym: SymbolDef = {
            file,
            localName: exportedAs,
            kind: SymbolKind.Function,
            range: { start: pos, end: pos },
          };
          locals.push(sym);
        }
        const local = locals.find((d) => d.localName === exportedAs)!;
        if (
          !exports.some(
            (e) => e.type === "local" && e.exportedAs === exportedAs,
          )
        ) {
          exports.push({ type: "local", exportedAs, target: local });
        }
      }
    }
  }

  if (support.id === "python" && hasPythonAll) {
    const seen = new Set<string>();
    const filtered = exports.filter((e) => {
      if (e.type === "local") {
        if (!pythonAllExports.has(e.exportedAs)) return false;
        if (seen.has(e.exportedAs)) return false;
        seen.add(e.exportedAs);
        return true;
      }
      if (e.type === "reexport") return pythonAllExports.has(e.exportedAs);
      return true;
    });
    exports.length = 0;
    exports.push(...filtered);
  }

  if (
    (support.id === "ts" || support.id === "js") &&
    !exports.some((e) => e.type === "local" && e.exportedAs === "default")
  ) {
    const defFn = source.match(
      /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/,
    );
    const defCls = source.match(
      /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
    );
    const defIdent = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/);
    const name = defFn?.[1] ?? defCls?.[1] ?? defIdent?.[1];
    if (name) {
      const local = locals.find((d) => d.localName === name);
      if (local)
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
    }
  }

  return { file, exports, imports: [], locals };
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    tree?: Parser.Tree;
    sup?: LanguageSupport;
    lang?: Parser.Language;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
  },
): Promise<ImportBinding[]> {
  let source = opts?.source;
  let sup = opts?.sup;
  let lang = opts?.lang;

  if (!source || !sup || !lang) {
    const prep = await prepareParserInput(
      file,
      source !== undefined ? { source } : undefined,
    );
    source = prep.source;
    sup = prep.sup;
    lang = prep.lang;
  }

  const resolvedSource = source;
  const resolvedSup = sup;
  const resolvedLang = lang;
  const resolvedNativeQueries = opts?.nativeQueries ?? null;

  const imports: ImportBinding[] = [];

  if (resolvedSup.id === "python") {
    const pySrc = stripPythonCommentsAndStrings(resolvedSource);
    const pushStar = async (moduleSpec: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod,
        relDots,
      );
      imports.push({
        kind: "star",
        from: moduleSpec,
        resolved,
        mechanism: "python",
      });
    };
    const pushNamed = async (
      moduleSpec: string,
      imported: string,
      local: string,
    ) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod,
        relDots,
      );
      let nsResolved: string | undefined;
      if (typeof resolved === "string") {
        let baseDir = resolved;
        try {
          const st = fs.statSync(baseDir);
          if (
            !st.isDirectory() &&
            baseDir.toLowerCase().endsWith("__init__.py")
          )
            baseDir = path.dirname(baseDir);
        } catch {
          /* stat failed */
        }
        const sub = [
          path.join(baseDir, `${imported}.py`),
          path.join(baseDir, imported, "__init__.py"),
          path.join(baseDir, imported),
        ];
        for (const c of sub) {
          try {
            if (fs.existsSync(c)) {
              nsResolved = fs.statSync(c).isDirectory() ? c : c;
              break;
            }
          } catch {
            /* existsSync/stat: ignore */
          }
        }
      }
      if (nsResolved) {
        imports.push({
          kind: "namespace",
          localNS: local,
          from: moduleSpec,
          resolved: nsResolved,
          mechanism: "python",
        });
      } else {
        imports.push({
          kind: "named",
          local,
          imported,
          from: moduleSpec,
          resolved,
          mechanism: "python",
        });
      }
    };
    const pushDefault = async (dotted: string, local: string) => {
      const resolved = await resolvePythonModule(projectRoot, file, dotted, 0);
      imports.push({
        kind: "namespace",
        localNS: local,
        from: dotted,
        resolved,
        mechanism: "python",
      });
    };

    const reFromLine = /^\s*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
    for (const m of pySrc.matchAll(reFromLine)) {
      const mod = m[1]!.trim();
      const items = m[2]!.split(",").map((s) => s.trim());
      for (const it of items) {
        if (it === "*") {
          await pushStar(mod);
          continue;
        }
        const am = it.match(
          /^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/,
        );
        if (am) {
          const imported = am[1]!;
          const local = am[2] ?? imported;
          await pushNamed(mod, imported, local);
        }
      }
    }
    const reImp =
      /^(?:\s*)import\s+([A-Za-z_][\w.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
    for (const m of pySrc.matchAll(reImp)) {
      const dotted = m[1]!;
      const local = (m[2] ?? dotted.split(".")[0]) as string;
      await pushDefault(dotted, local);
    }
    return imports;
  }

  const key =
    resolvedSup.id === "python" ? "py" : resolvedSup.id === "js" ? "js" : "ts";
  const tsCfg =
    resolvedSup.id === "ts" || resolvedSup.id === "tsx"
      ? await loadNearestTsconfigFor(file)
      : undefined;
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const resolveFrom = async (from: string) => {
    const resolutionHints = opts?.graphOptions?.resolutionHints;
    const resolved = await resolveImportSpecifier(
      projectRoot,
      file,
      from,
      resolvedSup.id,
      {
        ...(tsCfg?.matchPath ? { matchPath: tsCfg.matchPath } : {}),
        ...(workspaceConfig ? { workspaceConfig } : {}),
        resolveNodeModules: !!opts?.graphOptions?.resolveNodeModules,
        ...(resolutionHints ? { resolutionHints } : {}),
      },
    );
    return typeof resolved === "string"
      ? resolved.replace(/\\/g, "/")
      : resolved;
  };

    const runFallback = async () => {
      const src =
        resolvedSup.id === "ts" || resolvedSup.id === "js"
          ? stripJsLikeComments(resolvedSource)
          : resolvedSource;
      const typeOnlyImport = /\bimport\s+type\b/;
      const reFrom = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<m>[^"']+)\2/gm;
      for (const m of src.matchAll(reFrom)) {
        const clause = m[1]!.trim();
        const mod = m.groups?.m as string;
        const typeOnly = typeOnlyImport.test(m[0]);
        const resolved = await resolveFrom(mod);
        const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (ns) {
          imports.push({
            kind: "namespace",
            localNS: ns[1]!,
            from: mod,
            resolved,
            typeOnly,
          });
          continue;
        }
        const parts = clause.split(",");
        if (parts.length) {
          const first = parts[0]!.trim();
          if (first && !first.startsWith("{"))
            imports.push({
              kind: "default",
              local: first,
              from: mod,
              resolved,
              typeOnly,
            });
          const namedBlock =
            parts.slice(1).join(",").trim() ||
            (first.startsWith("{") ? first : "");
          const names = namedBlock
            .replace(/[{}]/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          for (const spec of names) {
            const nm = spec.match(
              /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
            );
            if (!nm) continue;
            const imported = nm[1]!;
            const local = nm[2] ?? imported;
            imports.push({
              kind: "named",
              local,
              imported,
              from: mod,
              resolved,
              typeOnly,
            });
          }
        }
      }
      const reReqDefault =
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
      for (const m of src.matchAll(reReqDefault)) {
        const local = m[1]!;
        const mod = m.groups?.m as string;
        const resolved = await resolveFrom(mod);
        imports.push({
          kind: "default",
          local,
          from: mod,
          resolved,
          mechanism: "cjs",
        });
      }
      const reReqNamed =
        /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
      for (const m of src.matchAll(reReqNamed)) {
        const specs = m[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const mod = m.groups?.m as string;
        const resolved = await resolveFrom(mod);
        for (const spec of specs) {
          const nm = spec.match(
            /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/,
          );
          if (!nm) continue;
          const imported = nm[1]!;
          const local = nm[2] ?? imported;
          imports.push({
            kind: "named",
            local,
            imported,
            from: mod,
            resolved,
            mechanism: "cjs",
          });
        }
      }
    };

  if (resolvedNativeQueries) {
    try {
      for (const match of resolvedNativeQueries.importBindings) {
          const caps = capturesByName(match);
          const stmtText = caps["stmt"]?.text ?? "";
          const typeOnly = resolvedSup.isTypeOnly(stmtText);
          const from = caps["from"] ? unquote(caps["from"]!.text) : undefined;
          const patterns = capturesNamed(match, "pattern");

          for (const pattern of patterns) {
            if (pattern.nodeType !== "object_pattern" || !from) continue;
            const resolved = await resolveFrom(from);
            for (const binding of parseObjectPatternBindings(pattern.text)) {
              imports.push({
                kind: "named",
                local: binding.local,
                imported: binding.imported,
                from,
                resolved,
                typeOnly,
              });
            }
          }

          if (!from) continue;
          const resolved = await resolveFrom(from);
          if (caps["def"]) {
            imports.push({
              kind: "default",
              local: caps["def"]!.text,
              from,
              resolved,
              typeOnly,
            });
          }
          if (caps["ns"]) {
            imports.push({
              kind: "namespace",
              localNS: caps["ns"]!.text,
              from,
              resolved,
              typeOnly,
            });
          }

          const inames = capturesNamed(match, "iname");
          const aliases = capturesNamed(match, "alias");
          for (let i = 0; i < inames.length; i++) {
            const imported = inames[i]!.text;
            const alias = aliases[i]?.text ?? imported;
            imports.push({
              kind: "named",
              local: alias,
              imported,
              from,
              resolved,
              typeOnly,
            });
          }

          if (
            !caps["def"] &&
            !caps["ns"] &&
            inames.length === 0 &&
            patterns.length === 0
          ) {
            if (resolvedSup.id === "java") {
              const parts = from.split(".");
              const last = parts[parts.length - 1];
              if (last && /^[A-Z]/.test(last)) {
                imports.push({
                  kind: "named",
                  local: last,
                  imported: last,
                  from,
                  resolved,
                  typeOnly,
                });
              }
            } else if (resolvedSup.id === "csharp") {
              if (caps["alias"]) {
                const alias = caps["alias"]!.text;
                const fromParts = from.split(".");
                const imported = fromParts[fromParts.length - 1] ?? alias;
                imports.push({
                  kind: "named",
                  local: alias,
                  imported,
                  from,
                  resolved,
                  typeOnly,
                });
              } else {
                imports.push({ kind: "star", from, resolved, typeOnly });
              }
            } else if (resolvedSup.id === "ruby") {
              imports.push({ kind: "star", from, resolved });
            } else if (resolvedSup.id === "go") {
              if (caps["alias"]) {
                imports.push({
                  kind: "namespace",
                  localNS: caps["alias"]!.text,
                  from,
                  resolved,
                });
              } else {
                const parts = from.replace(/"/g, "").split("/");
                const last = parts[parts.length - 1];
                if (last) {
                  imports.push({
                    kind: "namespace",
                    localNS: last,
                    from,
                    resolved,
                  });
                }
              }
            } else if (resolvedSup.id === "rust") {
              if (stmtText.startsWith("mod ")) {
                imports.push({
                  kind: "namespace",
                  localNS: from,
                  from,
                  resolved,
                });
              } else {
                const parts = from.split("::");
                const last = parts[parts.length - 1];
                if (!last) continue;
                if (last === "*") {
                  imports.push({ kind: "star", from, resolved });
                } else {
                  imports.push({
                    kind: "named",
                    local: last,
                    imported: last,
                    from,
                    resolved,
                  });
                }
              }
            } else if (resolvedSup.id === "kotlin") {
              const wildcard = !!caps["wild"] || from.endsWith(".*");
              if (wildcard) {
                imports.push({ kind: "star", from, resolved, typeOnly });
              } else {
                const parts = from.split(".");
                const imported = parts[parts.length - 1];
                if (!imported) continue;
                imports.push({
                  kind: "named",
                  local: caps["alias"]?.text ?? imported,
                  imported,
                  from,
                  resolved,
                  typeOnly,
                });
              }
            } else if (resolvedSup.id === "swift") {
              const parts = from.split(".");
              const last = parts[parts.length - 1];
              if (!last) continue;
              if (parts.length === 1) {
                imports.push({
                  kind: "namespace",
                  localNS: last,
                  from,
                  resolved,
                  typeOnly,
                });
                imports.push({ kind: "star", from, resolved, typeOnly });
              } else {
                imports.push({
                  kind: "named",
                  local: last,
                  imported: last,
                  from,
                  resolved,
                  typeOnly,
                });
              }
            } else if (resolvedSup.id === "c" || resolvedSup.id === "cpp") {
              imports.push({ kind: "star", from, resolved, typeOnly });
            }
          }
      }
      if (imports.length > 0) return imports;
    } catch {
      imports.length = 0;
    }
  }

  let parser: Parser | undefined;
  try {
    const tree =
      opts?.tree ??
      (() => {
        parser = acquireParser(resolvedLang, key);
        parser.setLanguage(resolvedLang);
        return parser.parse(resolvedSource);
      })();
    let ranFallback = false;
    try {
      let q: Parser.Query;
      try {
        ({ importBindings: q } = getCompiledQueries(resolvedLang, resolvedSup));
      } catch {
        // getCompiledQueries may fail if other queries in the language
        // definition are incompatible with the current tree-sitter version.
        // Fall back to compiling only the import bindings query.
        try {
          q = new Parser.Query(
            resolvedLang,
            resolvedSup.queries.importBindings,
          );
        } catch {
          await runFallback();
          ranFallback = true;
          return imports;
        }
      }
      for (const m of q.matches(tree.rootNode)) {
        const caps = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const),
        );
        const stmtText = caps["stmt"]
          ? sliceText(caps["stmt"].node, source)
          : "";
        const typeOnly = resolvedSup.isTypeOnly(stmtText);
        const from: string | undefined = caps["from"]
          ? unquote(sliceText(caps["from"].node, source))
          : undefined;

        const patterns = m.captures.filter(
          (c: Parser.QueryCapture) => c.name === "pattern",
        );
        for (const pattern of patterns) {
          const patternNode = pattern.node;
          if (patternNode.type === "object_pattern" && from) {
            for (const child of patternNode.namedChildren) {
              if (
                child.type === "shorthand_property_identifier" ||
                child.type === "shorthand_property_identifier_pattern"
              ) {
                const name = sliceText(child, source);
                const resolved = await resolveFrom(from);
                imports.push({
                  kind: "named",
                  local: name,
                  imported: name,
                  from,
                  resolved,
                  typeOnly,
                });
              } else if (child.type === "pair_pattern") {
                const key = child.childForFieldName("key");
                const value = child.childForFieldName("value");
                if (
                  key &&
                  value &&
                  key.type === "property_identifier" &&
                  value.type === "identifier"
                ) {
                  const imported = sliceText(key, source);
                  const local = sliceText(value, source);
                  const resolved = await resolveFrom(from);
                  imports.push({
                    kind: "named",
                    local,
                    imported,
                    from,
                    resolved,
                    typeOnly,
                  });
                }
              }
            }
          }
        }

        if (!from) continue;
        const fromValue = from;
        const resolved = await resolveFrom(fromValue);
        if (caps["def"]) {
          imports.push({
            kind: "default",
            local: sliceText(caps["def"].node, source),
            from: fromValue,
            resolved,
            typeOnly,
          });
        }
        if (caps["ns"]) {
          const nsName = sliceText(caps["ns"].node, source);
          imports.push({
            kind: "namespace",
            localNS: nsName,
            from: fromValue,
            resolved,
            typeOnly,
          });
        }
        const inames = m.captures.filter(
          (c: Parser.QueryCapture) => c.name === "iname",
        );
        const aliases = m.captures.filter(
          (c: Parser.QueryCapture) => c.name === "alias",
        );
        for (let i = 0; i < inames.length; i++) {
          const imported = sliceText(inames[i]!.node, source);
          const alias = aliases[i]
            ? sliceText(aliases[i]!.node, source)
            : imported;
          imports.push({
            kind: "named",
            local: alias,
            imported,
            from: fromValue,
            resolved,
            typeOnly,
          });
        }

        // Heuristics for languages where we captured @from but no explicit bindings
        if (
          fromValue &&
          !caps["def"] &&
          !caps["ns"] &&
          inames.length === 0 &&
          patterns.length === 0
        ) {
          if (resolvedSup.id === "java") {
            // import java.util.List; -> local "List"
            const parts = fromValue.split(".");
            const last = parts[parts.length - 1];
            if (last && /^[A-Z]/.test(last)) {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "csharp") {
            const aliasNode = caps["alias"];
            if (aliasNode) {
              const alias = sliceText(aliasNode.node, source);
              // For "using Alias = Type.Path;", try to grab the last part as the imported name
              let imported = alias;
              const fromParts = fromValue.split(".");
              if (fromParts.length > 0) {
                const candidate = fromParts[fromParts.length - 1];
                if (candidate) imported = candidate;
              }

              imports.push({
                kind: "named",
                local: alias,
                imported,
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              // implicit namespace import - treated as star to bring members into scope
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "ruby") {
            // require 'foo' -> star import to bring constants into scope
            imports.push({ kind: "star", from: fromValue, resolved });
          } else if (resolvedSup.id === "go") {
            // import "fmt" -> local "fmt"
            // import "github.com/pkg/foo" -> local "foo"
            const aliasNode = caps["alias"];
            if (aliasNode) {
              const alias = sliceText(aliasNode.node, source);
              imports.push({
                kind: "namespace",
                localNS: alias,
                from: fromValue,
                resolved,
              });
            } else {
              const parts = fromValue.replace(/"/g, "").split("/");
              const last = parts[parts.length - 1];
              if (!last) continue;
              imports.push({
                kind: "namespace",
                localNS: last,
                from: fromValue,
                resolved,
              });
            }
          } else if (resolvedSup.id === "rust") {
            // mod utils; -> namespace (from="utils")
            // use foo::bar; -> named (from="foo::bar")
            if (stmtText.startsWith("mod ")) {
              // treat 'mod name;' as namespace import pointing to name.rs / name/mod.rs
              imports.push({
                kind: "namespace",
                localNS: fromValue,
                from: fromValue,
                resolved,
              });
            } else {
              const parts = fromValue.split("::");
              const last = parts[parts.length - 1];
              if (!last) continue;
              if (last === "*") {
                imports.push({ kind: "star", from: fromValue, resolved });
              } else {
                imports.push({
                  kind: "named",
                  local: last,
                  imported: last,
                  from: fromValue,
                  resolved,
                });
              }
            }
          } else if (resolvedSup.id === "kotlin") {
            const aliasNode = caps["alias"];
            const wildcard = !!caps["wild"] || fromValue.endsWith(".*");
            if (wildcard) {
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              const parts = fromValue.split(".");
              const imported = parts[parts.length - 1];
              if (!imported) continue;
              const local = aliasNode
                ? sliceText(aliasNode.node, source)
                : imported;
              imports.push({
                kind: "named",
                local,
                imported,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "swift") {
            const parts = fromValue.split(".");
            const last = parts[parts.length - 1];
            if (!last) continue;
            if (parts.length === 1) {
              imports.push({
                kind: "namespace",
                localNS: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "c" || resolvedSup.id === "cpp") {
            imports.push({
              kind: "star",
              from: fromValue,
              resolved,
              typeOnly,
            });
          }
        }
      }
    } catch {
      await runFallback();
      ranFallback = true;
    }
    // Only run fallback when query path produced no results
    if (!ranFallback && imports.length === 0) {
      await runFallback();
    }
    return imports;
  } finally {
    if (parser) releaseParser(parser, key);
  }
}

export async function parseFile(file: string): Promise<ParsedFileContext> {
  return parsePreparedFileContext(await prepareFileForIndexing(file));
}

async function prepareFileForIndexing(file: string): Promise<PreparedFileContext> {
  const prep = await prepareParserInput(file);
  const nativeExecution = getNativeQueryExecution(prep.source, prep.sup);

  return {
    source: prep.source,
    sup: prep.sup,
    lang: prep.lang,
    nativeQueries: nativeExecution.results,
    ...(nativeExecution.fallbackReason
      ? { nativeFallbackReason: nativeExecution.fallbackReason }
      : {}),
    ...(nativeExecution.error ? { nativeError: nativeExecution.error } : {}),
  };
}

export async function ensureParsedContext(
  file: string,
  parsedEntry?: {
    source: string;
    tree: Parser.Tree;
    sup: LanguageSupport | undefined;
    lang: Parser.Language;
    nativeQueries?: NativeQueryResults | null;
  },
): Promise<ParsedFileContext> {
  if (parsedEntry?.sup) {
    return {
      source: parsedEntry.source,
      tree: parsedEntry.tree,
      sup: parsedEntry.sup,
      lang: parsedEntry.lang,
      nativeQueries: parsedEntry.nativeQueries ?? null,
    };
  }
  return parsePreparedFileContext(await prepareFileForIndexing(file));
}

type ManifestMode = "off" | "read-only" | "read-write";

type BuildIndexHelperOptions = {
  manifestMode?: ManifestMode;
  warnNoFilesMessage?: string;
};

async function buildIndexFromFileListShared(
  projectRoot: string,
  rawFiles: string[],
  opts?: BuildOptions,
  helperOpts?: BuildIndexHelperOptions,
): Promise<ProjectIndex> {
  const report = opts?.report;
  const timings = report?.timings;
  const totalStart = performance.now();
  const manifestMode: ManifestMode = helperOpts?.manifestMode ?? "off";
  const useManifest = manifestMode !== "off";
  const shouldWriteManifest = manifestMode === "read-write";
  const cacheMode = opts?.cache ?? "off";
  const cacheEnabled = cacheMode !== "off";
  const graphOptions = normalizeGraphOptions(opts?.graph);
  initManifestReport(report, useManifest, false);
  initNativeBackendReport(report);
  const normalizedFiles = Array.from(
    new Set(
      (rawFiles ?? [])
        .filter(Boolean)
        .map((file) => path.resolve(file))
        .map((resolved) => resolved.replace(/\\/g, "/")),
    ),
  );
  if (normalizedFiles.length === 0 && helperOpts?.warnNoFilesMessage) {
    console.warn(helperOpts.warnNoFilesMessage);
  }
  const fileReport = initFileReport(report);
  const onFallbackImportExtraction = createFallbackImportExtractionHandler(
    report,
    opts,
  );
  if (fileReport) {
    fileReport.total = normalizedFiles.length;
  }
  const manifestStart = performance.now();
  const manifest = useManifest ? await loadManifest(projectRoot, opts) : null;
  if (timings && useManifest) {
    timings.manifestMs = Math.round(performance.now() - manifestStart);
  }
  const cachedGraphEntries =
    manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)
      ? new Map<string, ManifestFileEntry>(Object.entries(manifest.files ?? {}))
      : undefined;
  if (report?.manifest) {
    report.manifest.reused = !!cachedGraphEntries;
  }
  const manifestEntries = shouldWriteManifest
    ? new Map<string, ManifestFileEntry>()
    : undefined;
  const modules = new Map<FileId, ModuleIndex>();
  const fileSignatures = new Map<string, FileSignature>();
  const gitAvailable = await isGitRepo(projectRoot);
  const useGitSignatures =
    gitAvailable && (cacheMode !== "off" || opts?.cacheStrict);
  const gitSigMap = useGitSignatures
    ? await getGitBlobHashes(projectRoot, normalizedFiles, {
        gitAvailable,
      })
    : new Map<string, string>();
  const jsonDependencies = new Set<string>();
  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));
  const useBloomFilters = opts?.useBloomFilters ?? true; // Default to true for performance
  const bloomFilterCache = useBloomFilters
    ? new (await import("./util/bloomFilter.js")).BloomFilterCache()
    : undefined;
    const parsedMap = new Map<string, ParsedFileContext>();
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const parseStart = performance.now();
  const graph: Graph = { nodes: new Set(normalizedFiles), edges: [] };
  const onFileEdges = manifestEntries
    ? (file: string, entry: GraphCacheEntry) => {
        if (!entry?.sig) return;
        manifestEntries.set(file, {
          sig: entry.sig,
          ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
          edges: entry.edges,
        });
      }
    : undefined;
  let processedFiles = 0;
  const totalFiles = normalizedFiles.length;
  const fileResults = await mapLimit(normalizedFiles, conc, async (f) => {
    try {
      const sigInfo = await fileSignature(
        f,
        opts?.cacheStrict,
        gitSigMap.get(f),
        { forceContentHash: cacheEnabled },
      );
      fileSignatures.set(f, sigInfo);

      const cacheSig = cacheEnabled
        ? await cacheSignatureForFile(f, sigInfo)
        : sigInfo.cacheSig;
      let mod: ModuleIndex | null = cacheEnabled
        ? tryLoadFromCache(projectRoot, f, cacheSig, opts, report)
        : null;
      if (mod && fileReport) {
        fileReport.cached = (fileReport.cached ?? 0) + 1;
      }

      // Check if edges are cached (via collectEdgesForFile logic essentially)
      // We manually check here to decide if we need to parse
      const cachedEdgesEntry = cachedGraphEntries?.get(f);
      const edgesCached =
        !!cachedEdgesEntry &&
        ((cachedEdgesEntry.gitSig &&
          cachedEdgesEntry.gitSig === sigInfo.gitSig) ||
          cachedEdgesEntry.sig === sigInfo.sig);

      let edges: import("./types.js").Edge[] = [];

      if (mod && edgesCached) {
        // Both cached, no need to parse
        edges = await collectEdgesForFile(f, projectRoot, workspaceConfig, {
          fast: !!graphOptions.fast,
          ...(graphOptions.fastRegexDisabledLanguages
            ? {
                fastRegexDisabledLanguages:
                  graphOptions.fastRegexDisabledLanguages,
              }
            : {}),
          resolveNodeModules: !!graphOptions.resolveNodeModules,
          dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
          ...(graphOptions.resolutionHints
            ? { resolutionHints: graphOptions.resolutionHints }
            : {}),
          fileSignature: sigInfo,
          ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
          ...(onFileEdges ? { onFileEdges } : {}),
          ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
        });
        if (bloomFilterCache) {
          const filter = await buildBloomFilterForFile(f);
          if (filter) bloomFilterCache.set(f, filter);
        }
        return [f, mod, edges] as const;
      }

      if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;

      // FIX: Check support before parsing to avoid throwing errors for non-code files
      const supCheck = supportForFile(f);
      if (!supCheck) {
        const mod: ModuleIndex = {
          file: f,
          exports: [],
          imports: [],
          locals: [],
        };
        return [f, mod, []] as const;
      }

      const prepared = await prepareFileForIndexing(f);
      recordNativeBackendOutcome(report, {
        usedNative: !!prepared.nativeQueries,
        support: prepared.sup,
        file: f,
        languageId: prepared.sup.id,
        ...(prepared.nativeFallbackReason
          ? { fallbackReason: prepared.nativeFallbackReason }
          : {}),
        ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
      });
      const { source: src, sup, lang, nativeQueries } = prepared;
      let tree: Parser.Tree | undefined;

      if (!nativeQueries) {
        const parsed = parsePreparedFileContext(prepared);
        tree = parsed.tree;
        setParsedCacheEntry(
          parsedMap,
          f,
          {
            source: parsed.source,
            tree: parsed.tree,
            sup: parsed.sup,
            lang: parsed.lang,
            nativeQueries: parsed.nativeQueries ?? null,
          },
          Math.max(1, opts?.parsedCacheMaxEntries ?? 1024),
        );
      }

      if (bloomFilterCache) {
        const filter = buildBloomFilterFromSource(src, sup.id);
        bloomFilterCache.set(f, filter);
      }

      // 1. Recompute ModuleIndex if needed
      if (!mod) {
        const imports = await collectImportsForFile(f, projectRoot, {
          source: src,
          ...(tree ? { tree } : {}),
          sup,
          lang,
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
          graphOptions,
        });
        collectJsonDependencies(imports, jsonDependencies);
        mod = collectLocalsAndExportsFromSource(f, src, sup, lang, imports, {
          ...(tree ? { tree } : {}),
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
        });
        mod.imports = imports;

        if (sup.supportsCrossModuleSymbols) {
          if (sup.id === "ts" || sup.id === "js") {
            const { matchPath } = await loadNearestTsconfigFor(f);
            for (const e of mod.exports)
              if (
                e.type === "reexport" ||
                e.type === "exportStar" ||
                e.type === "namespaceReexport"
              ) {
                if (e.fromModule.startsWith(".")) {
                  const resolved = await resolveSpecifier(
                    f,
                    e.fromModule,
                    projectRoot,
                    matchPath,
                    workspaceConfig,
                    {
                      resolveNodeModules: !!graphOptions.resolveNodeModules,
                      ...(graphOptions.resolutionHints
                        ? { resolutionHints: graphOptions.resolutionHints }
                        : {}),
                    },
                  );
                  if (typeof resolved === "string") e.fromModule = resolved;
                } else {
                  const pkgResolved = await resolveWorkspacePackage(
                    e.fromModule,
                    workspaceConfig,
                  );
                  if (pkgResolved) e.fromModule = pkgResolved;
                }
              }
          }
        }
        writeToCache(projectRoot, f, cacheSig, mod, opts);
      } else {
        // If mod was cached but edges weren't, we still need to collect json deps from mod
        collectJsonDependencies(mod.imports, jsonDependencies);
      }

      // 2. Recompute Edges (using the parsed tree)
      edges = await collectEdgesForFile(f, projectRoot, workspaceConfig, {
        parsed: {
          source: src,
          ...(tree ? { tree } : {}),
          sup,
          lang,
          ...(nativeQueries !== undefined ? { nativeQueries } : {}),
        },
        fast: !!graphOptions.fast,
        ...(graphOptions.fastRegexDisabledLanguages
          ? {
              fastRegexDisabledLanguages:
                graphOptions.fastRegexDisabledLanguages,
            }
          : {}),
        resolveNodeModules: !!graphOptions.resolveNodeModules,
        dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
        ...(graphOptions.resolutionHints
          ? { resolutionHints: graphOptions.resolutionHints }
          : {}),
        fileSignature: sigInfo,
        ...(cachedEdgesEntry ? { cachedFileEdges: cachedEdgesEntry } : {}),
        ...(onFileEdges ? { onFileEdges } : {}),
        ...(onFallbackImportExtraction ? { onFallbackImportExtraction } : {}),
      });

      if (!mod) {
        mod = {
          file: f,
          exports: [],
          imports: [],
          locals: [],
        };
      }

      return [f, mod, edges] as const;
    } catch (error) {
      if (isUnsupportedParserInputError(error)) {
        const modUnsupported: ModuleIndex = {
          file: f,
          exports: [],
          imports: [],
          locals: [],
        };
        return [f, modUnsupported, []] as const;
      }
      console.warn(`Warning: Failed to process file ${f}:`, error);
      const modError: ModuleIndex = {
        file: f,
        exports: [],
        imports: [],
        locals: [],
      };
      return [f, modError, []] as const;
    } finally {
      if (opts?.onProgress) {
        opts.onProgress({
          type: "progress",
          message: `Indexed ${f}`,
          current: ++processedFiles,
          total: totalFiles,
        });
      }
    }
  });
  if (timings) timings.parseMs = Math.round(performance.now() - parseStart);

  const graphStart = performance.now();
  const appendUniqueGraphEdges = (edges: Edge[]) => {
    if (edges.length === 0) return;
    const seen = new Set(
      graph.edges.map(
        (edge) =>
          `${edge.from}::${edge.to.type === "file" ? edge.to.path : edge.to.name}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`,
      ),
    );
    for (const edge of edges) {
      const key = `${edge.from}::${edge.to.type === "file" ? edge.to.path : edge.to.name}::${edge.raw ?? ""}::${edge.typeOnly ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      graph.edges.push(edge);
      if (edge.to.type === "file") graph.nodes.add(edge.to.path);
    }
  };

  for (const [file, mod, edges] of fileResults) {
    modules.set(file, mod);
    for (const e of edges) {
      graph.edges.push(e);
      if (e.to.type === "file") graph.nodes.add(e.to.path);
    }
  }

  appendUniqueGraphEdges(
    await collectWorkspaceManifestDependencyEdges(projectRoot),
  );
  if (timings) timings.graphMs = Math.round(performance.now() - graphStart);

  for (const jsonPath of jsonDependencies) {
    ensureJsonModule(modules, jsonPath);
  }

  for (const [_file, mod] of modules) {
    for (const imp of [...mod.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (!target) continue;
        const targetSup =
          typeof imp.resolved === "string"
            ? supportForFile(imp.resolved)
            : null;
        const exported =
          target.exports.filter((e) => e.type === "local").length > 0
            ? target.exports
                .filter(
                  (e): e is Extract<ExportEntry, { type: "local" }> =>
                    e.type === "local",
                )
                .map((e) => e.target)
            : target.locals.filter((l) => !l.localName.startsWith("_"));
        const seen = new Set<string>();
        for (const sym of exported) {
          if (!sym.localName || seen.has(sym.localName)) continue;
          seen.add(sym.localName);
          const treatAsNamespace =
            targetSup?.id === "ruby" && sym.kind === SymbolKind.Class;
          if (treatAsNamespace) {
            mod.imports.push({
              kind: "namespace",
              localNS: sym.localName,
              from: imp.from,
              resolved: imp.resolved,
            });
          } else {
            mod.imports.push({
              kind: "named",
              local: sym.localName,
              imported: sym.localName,
              from: imp.from,
              resolved: imp.resolved,
            });
          }
        }
      }
    }
  }

  if (manifestEntries && manifestEntries.size > 0) {
    const writeManifestStart = performance.now();
    const lastCommit = await getGitHead(projectRoot);
    const configHash = await computeConfigHash(projectRoot);
    const manifestData: IndexManifest = {
      version: MANIFEST_VERSION,
      projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
      updatedAt: Date.now(),
      ...(lastCommit ? { lastCommit } : {}),
      ...(configHash ? { configHash } : {}),
      graphOptions,
      buildOptions: summarizeBuildOptions(opts),
      files: Object.fromEntries(manifestEntries),
    };
    await writeManifest(projectRoot, opts, manifestData);
    if (timings)
      timings.writeManifestMs = Math.round(
        performance.now() - writeManifestStart,
      );
  }

  if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
  const projectFiles = await discoverProjectFiles(projectRoot);

  const keepParsed = opts?.keepParsed ?? false;
  const maxParsedEntries = Math.max(1, opts?.parsedCacheMaxEntries ?? 1024);
  if (!keepParsed) {
    parsedMap.clear();
  } else {
    while (parsedMap.size > maxParsedEntries) {
      const oldest = parsedMap.keys().next().value;
      if (!oldest) break;
      parsedMap.delete(oldest);
    }
  }

  return {
    graph,
    modules,
    byFile: modules,
    exportCache: new Map(),
    scopeCache: new Map(),
    parsed: keepParsed ? parsedMap : undefined,
    ...(bloomFilterCache ? { bloomFilters: bloomFilterCache } : {}),
    projectFiles,
  };
}

export async function buildProjectIndex(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    const files = await listProjectFiles(projectRoot);
    return buildIndexFromFileListShared(projectRoot, files, opts, {
      manifestMode: "read-write",
      warnNoFilesMessage: `Warning: No files found in project root: ${projectRoot}`,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk")
      closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildProjectIndexFromFiles(
  projectRoot: string,
  inputFiles: string[],
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  try {
    return buildIndexFromFileListShared(projectRoot, inputFiles, opts, {
      manifestMode: "read-only",
      warnNoFilesMessage: `Warning: No files provided for indexing in ${projectRoot}`,
    });
  } finally {
    if ((opts?.cache ?? "off") === "disk")
      closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildProjectIndexIncremental(
  projectRoot: string,
  opts?: IncrementalBuildOptions,
): Promise<ProjectIndex> {
  const report = opts?.report;
  initNativeBackendReport(report);
  const timings = report?.timings;
  const totalStart = performance.now();
  const cacheMode = opts?.cache ?? "off";
  const cacheEnabled = cacheMode !== "off";
  try {
    const onFallbackImportExtraction = createFallbackImportExtractionHandler(
      report,
      opts,
    );
    const manifestStart = performance.now();
    const manifest = await loadManifest(projectRoot, opts);
    if (timings)
      timings.manifestMs = Math.round(performance.now() - manifestStart);
    const graphOptions = normalizeGraphOptions(opts?.graph);
    const strictIncremental = opts?.incrementalStrict ?? false;
    if (strictIncremental && graphOptions.fast) {
      graphOptions.fast = false;
    }
    const manifestUsed = !!manifest;
    const manifestReport = initManifestReport(report, manifestUsed, false);
    if (manifestReport && !manifestUsed) {
      manifestReport.reason = "missing";
    }
    const optionDiffs = diffBuildOptions(manifest?.buildOptions, opts);
    if (optionDiffs.length > 0) {
      console.warn(
        `Warning: Manifest options differ from current build options: ${optionDiffs.join(
          ", ",
        )}`,
      );
      if (manifestReport) manifestReport.optionsMismatch = optionDiffs;
    }

    // Check config hash
    const currentConfigHash = await computeConfigHash(projectRoot);
    const configChanged =
      !!currentConfigHash &&
      (!manifest?.configHash || currentConfigHash !== manifest.configHash);

    if (
      !manifest ||
      !graphOptionsEqual(manifest.graphOptions, graphOptions) ||
      configChanged
    ) {
      if (configChanged) {
        console.warn("Configuration changed, rebuilding index...");
      }
      if (manifestReport && manifest) {
        manifestReport.reason = "graphOptionsMismatch";
      }
      return await buildProjectIndexFromExport(projectRoot, opts);
    }

    const gitAvailable = await isGitRepo(projectRoot);
    const currentHead = gitAvailable ? await getGitHead(projectRoot) : null;
    const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
    const manifestCommitMismatch =
      !hasExplicitGitRange &&
      !!manifest.lastCommit &&
      !!currentHead &&
      manifest.lastCommit !== currentHead;
    const manifestDiffFiles = manifestCommitMismatch
      ? await listChangedFiles(projectRoot, {
          base: manifest.lastCommit,
          head: currentHead,
        })
      : [];
    if (manifestReport) manifestReport.reused = true;
    if (opts?.cacheVerify) {
      const { mismatches, missing } = await verifyManifestEntries(
        projectRoot,
        manifest,
        opts,
        gitAvailable,
      );
      if (manifestReport) {
        manifestReport.mismatches = mismatches;
        manifestReport.missing = missing;
      }
      if (mismatches > 0 || missing > 0) {
        console.warn(
          `Warning: Manifest verification failed (mismatches: ${mismatches}, missing: ${missing}). Rebuilding full index.`,
        );
        return await buildProjectIndexFromExport(projectRoot, opts);
      }
    }

    const normalizeFilePath = (file: string): string =>
      (path.isAbsolute(file) ? file : path.resolve(projectRoot, file)).replace(
        /\\/g,
        "/",
      );

    const trackedEntries = manifest.files ?? {};
    const trackedFiles = new Set(
      Object.keys(trackedEntries).filter((file) => fs.existsSync(file)),
    );
    const fileReport = initFileReport(report);
    if (fileReport) {
      fileReport.total = trackedFiles.size;
    }

    const explicitFiles = (opts?.files ?? []).map(normalizeFilePath);
    const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
    const gitOpts: { base?: string; head?: string; changedSince?: string } = {};
    if (opts?.gitBase) gitOpts.base = opts.gitBase;
    if (opts?.gitHead) gitOpts.head = opts.gitHead;
    if (!opts?.gitBase && opts?.changedSince)
      gitOpts.changedSince = opts.changedSince;

    const gitFiles = needsGitScan
      ? await listChangedFiles(projectRoot, gitOpts)
      : [];

    const allFiles = new Set<string>([
      ...trackedFiles,
      ...explicitFiles.filter((f) => fs.existsSync(f)),
      ...manifestDiffFiles.filter((f) => fs.existsSync(f)),
      ...gitFiles.filter((f) => fs.existsSync(f)),
    ]);
    if (fileReport) {
      fileReport.total = allFiles.size;
    }

    if (allFiles.size === 0) {
      return {
        graph: { nodes: new Set(), edges: [] },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
        parsed: new Map(),
      };
    }

    const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));
    const workspaceConfig = await loadWorkspaceConfig(projectRoot);
    const fileSignatures = new Map<string, FileSignature>();
    const useGitSignatures = gitAvailable;
    const gitSigMap = useGitSignatures
      ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
          gitAvailable,
        })
      : new Map<string, string>();
    const changedFiles = new Set<string>();
    const modules = new Map<FileId, ModuleIndex>();
    const parsedMap = new Map<string, ParsedFileContext>();
    const jsonDependencies = new Set<string>();
    const useBloomFilters = opts?.useBloomFilters ?? true; // Default to true for performance
    const bloomFilterCache = useBloomFilters
      ? new (await import("./util/bloomFilter.js")).BloomFilterCache()
      : undefined;

    const markAsChanged = (file: string) => {
      if (fs.existsSync(file)) changedFiles.add(file);
    };
    explicitFiles.forEach(markAsChanged);
    manifestDiffFiles.forEach(markAsChanged);
    gitFiles.forEach(markAsChanged);
    if (fileReport) {
      fileReport.changed = changedFiles.size;
    }

    for (const file of allFiles) {
      const sigInfo = await fileSignature(
        file,
        opts?.cacheStrict,
        gitSigMap.get(file),
        { forceContentHash: cacheEnabled },
      );
      fileSignatures.set(file, sigInfo);
      const entry = trackedEntries[file];
      const hasMatchingGitSig =
        !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
      const hasMatchingSig = entry?.sig === sigInfo.sig;
      if (!entry || !(hasMatchingGitSig || hasMatchingSig)) {
        changedFiles.add(file);
      }
    }

    for (const file of allFiles) {
      if (changedFiles.has(file)) continue;
      const sigInfo = fileSignatures.get(file)!;
      const cacheSig = cacheEnabled
        ? await cacheSignatureForFile(file, sigInfo)
        : sigInfo.cacheSig;
      const cached = cacheEnabled
        ? tryLoadFromCache(projectRoot, file, cacheSig, opts, report)
        : null;
      if (cached) {
        if (fileReport) fileReport.cached = (fileReport.cached ?? 0) + 1;
        modules.set(file, cached);
        collectJsonDependencies(cached.imports, jsonDependencies);
        if (bloomFilterCache) {
          const filter = await buildBloomFilterForFile(file);
          if (filter) bloomFilterCache.set(file, filter);
        }
      } else {
        changedFiles.add(file);
      }
    }

    const changedList = Array.from(changedFiles);
    if (fileReport) {
      fileReport.changed = changedList.length;
    }
    if (changedList.length > 0) {
      const parseStart = performance.now();
      let processedFiles = 0;
      const totalFiles = changedList.length;
      const fileResults = await mapLimit(changedList, conc, async (f) => {
        try {
          if (fileReport) fileReport.parsed = (fileReport.parsed ?? 0) + 1;

          // FIX: Check support before parsing to avoid throwing errors for non-code files
          const supCheck = supportForFile(f);
          if (!supCheck) {
            const mod: ModuleIndex = {
              file: f,
              exports: [],
              imports: [],
              locals: [],
            };
            return [f, mod] as const;
          }

          const prepared = await prepareFileForIndexing(f);
          recordNativeBackendOutcome(report, {
            usedNative: !!prepared.nativeQueries,
            support: prepared.sup,
            file: f,
            languageId: prepared.sup.id,
            ...(prepared.nativeFallbackReason
              ? { fallbackReason: prepared.nativeFallbackReason }
              : {}),
            ...(prepared.nativeError ? { error: prepared.nativeError } : {}),
          });
          const { source: src, sup, lang, nativeQueries } = prepared;
          let tree: Parser.Tree | undefined;

          if (!nativeQueries) {
            const parsed = parsePreparedFileContext(prepared);
            tree = parsed.tree;
            setParsedCacheEntry(
              parsedMap,
              f,
              parsed,
              Math.max(1, opts?.parsedCacheMaxEntries ?? 1024),
            );
          }

          // Build bloom filter for this file if enabled
          if (bloomFilterCache) {
            const { buildBloomFilterFromSource } =
              await import("./util/bloomFilter.js");
            const filter = buildBloomFilterFromSource(src, sup.id);
            bloomFilterCache.set(f, filter);
          }

          const imports = await collectImportsForFile(f, projectRoot, {
            source: src,
            ...(tree ? { tree } : {}),
            sup,
            lang,
            ...(nativeQueries !== undefined ? { nativeQueries } : {}),
            graphOptions,
          });
          collectJsonDependencies(imports, jsonDependencies);
          const mod = collectLocalsAndExportsFromSource(
            f,
            src,
            sup,
            lang,
            imports,
            {
              ...(tree ? { tree } : {}),
              ...(nativeQueries !== undefined ? { nativeQueries } : {}),
            },
          );
          mod.imports = imports;

          if (sup.supportsCrossModuleSymbols) {
            if (sup.id === "ts" || sup.id === "js") {
              const { matchPath } = await loadNearestTsconfigFor(f);
              for (const e of mod.exports)
                if (
                  e.type === "reexport" ||
                  e.type === "exportStar" ||
                  e.type === "namespaceReexport"
                ) {
                  if (e.fromModule.startsWith(".")) {
                    const resolved = await resolveSpecifier(
                      f,
                      e.fromModule,
                      projectRoot,
                      matchPath,
                      workspaceConfig,
                      {
                        resolveNodeModules: !!graphOptions.resolveNodeModules,
                        ...(graphOptions.resolutionHints
                          ? { resolutionHints: graphOptions.resolutionHints }
                          : {}),
                      },
                    );
                    if (typeof resolved === "string") e.fromModule = resolved;
                  } else {
                    const pkgResolved = await resolveWorkspacePackage(
                      e.fromModule,
                      workspaceConfig,
                    );
                    if (pkgResolved) e.fromModule = pkgResolved;
                  }
                }
            }
          }
          const sigInfo = fileSignatures.get(f)!;
          const cacheSig = cacheEnabled
            ? await cacheSignatureForFile(f, sigInfo)
            : sigInfo.cacheSig;
          writeToCache(projectRoot, f, cacheSig, mod, opts);
          return [f, mod] as const;
        } catch (error) {
          if (isUnsupportedParserInputError(error)) {
            const modUnsupported: ModuleIndex = {
              file: f,
              exports: [],
              imports: [],
              locals: [],
            };
            return [f, modUnsupported] as const;
          }
          console.warn(`Warning: Failed to process file ${f}:`, error);
          const modError: ModuleIndex = {
            file: f,
            exports: [],
            imports: [],
            locals: [],
          };
          return [f, modError] as const;
        } finally {
          if (opts?.onProgress) {
            opts.onProgress({
              type: "progress",
              message: `Indexed ${f}`,
              current: ++processedFiles,
              total: totalFiles,
            });
          }
        }
      });
      for (const [f, mod] of fileResults) {
        modules.set(f.replace(/\\/g, "/"), mod);
      }
      if (timings) timings.parseMs = Math.round(performance.now() - parseStart);
    }

    for (const jsonPath of jsonDependencies) {
      ensureJsonModule(modules, jsonPath);
    }

    for (const [_file, m] of modules) {
      for (const imp of [...m.imports]) {
        if (imp.kind === "star" && typeof imp.resolved === "string") {
          const target = modules.get(imp.resolved);
          if (target) {
            let exported: string[] = [];
            const viaAll = target.exports.filter((e) => e.type === "local");
            if (viaAll.length) exported = viaAll.map((e) => e.exportedAs);
            else
              exported = target.locals
                .map((l) => l.localName)
                .filter((n) => !n.startsWith("_"));
            for (const name of exported)
              m.imports.push({
                kind: "named",
                local: name,
                imported: name,
                from: imp.from,
                resolved: imp.resolved,
              });
          }
        }
      }
    }

    const cachedGraphEntries = new Map<string, ManifestFileEntry>(
      Object.entries(manifest.files ?? {}).filter(([file]) =>
        fs.existsSync(file),
      ),
    );
    const manifestEntries = new Map<string, ManifestFileEntry>(
      cachedGraphEntries,
    );

    const baseGraph: Graph | undefined =
      cachedGraphEntries.size > 0
        ? {
            nodes: new Set<string>(),
            edges: [],
          }
        : undefined;

    if (baseGraph) {
      for (const [file, entry] of cachedGraphEntries) {
        baseGraph.nodes.add(file);
        for (const edge of entry.edges) {
          baseGraph.edges.push(edge);
          if (edge.to.type === "file") baseGraph.nodes.add(edge.to.path);
        }
      }
    }

    const filesList = Array.from(changedFiles);
    const graphStart = performance.now();
    const graph =
      filesList.length === 0 && baseGraph
        ? { nodes: new Set(baseGraph.nodes), edges: [...baseGraph.edges] }
        : await collectGraph(projectRoot, filesList, {
            parsed: parsedMap,
            fast: !!graphOptions.fast,
            ...(graphOptions.fastRegexDisabledLanguages
              ? {
                  fastRegexDisabledLanguages:
                    graphOptions.fastRegexDisabledLanguages,
                }
              : {}),
            resolveNodeModules: !!graphOptions.resolveNodeModules,
            dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
            ...(graphOptions.resolutionHints
              ? { resolutionHints: graphOptions.resolutionHints }
              : {}),
            fileSignatures,
            cachedFileEdges: cachedGraphEntries,
            ...(onFallbackImportExtraction
              ? { onFallbackImportExtraction }
              : {}),
            ...(baseGraph ? { baseGraph } : {}),
            replaceFiles: new Set<string>(changedFiles),
            onFileEdges: (file, entry) => {
              if (!entry?.sig) return;
              manifestEntries.set(file, {
                sig: entry.sig,
                ...(entry.gitSig ? { gitSig: entry.gitSig } : {}),
                edges: entry.edges,
              });
            },
          });
    if (timings) timings.graphMs = Math.round(performance.now() - graphStart);

    if (manifestEntries.size > 0) {
      const writeManifestStart = performance.now();
      const lastCommit = await getGitHead(projectRoot);
      const configHash = await computeConfigHash(projectRoot);
      const manifestData: IndexManifest = {
        version: MANIFEST_VERSION,
        projectRoot: path.resolve(projectRoot).replace(/\\/g, "/"),
        updatedAt: Date.now(),
        ...(lastCommit ? { lastCommit } : {}),
        ...(configHash ? { configHash } : {}),
        graphOptions,
        buildOptions: summarizeBuildOptions(opts),
        files: Object.fromEntries(manifestEntries),
      };
      await writeManifest(projectRoot, opts, manifestData);
      if (timings)
        timings.writeManifestMs = Math.round(
          performance.now() - writeManifestStart,
        );
    }

    if (timings) timings.totalMs = Math.round(performance.now() - totalStart);
    const projectFiles = await discoverProjectFiles(projectRoot);

    const keepParsed = opts?.keepParsed ?? false;
    const maxParsedEntries = Math.max(1, opts?.parsedCacheMaxEntries ?? 1024);
    if (!keepParsed) {
      parsedMap.clear();
    } else {
      while (parsedMap.size > maxParsedEntries) {
        const oldest = parsedMap.keys().next().value;
        if (!oldest) break;
        parsedMap.delete(oldest);
      }
    }

    return {
      graph,
      modules,
      byFile: modules,
      exportCache: new Map(),
      scopeCache: new Map(),
      parsed: keepParsed ? parsedMap : undefined,
      ...(bloomFilterCache ? { bloomFilters: bloomFilterCache } : {}),
      projectFiles,
    };
  } finally {
    if (cacheMode === "disk") closeDiskCacheDatabase(projectRoot, opts);
  }
}

export async function buildGraphDelta(
  projectRoot: string,
  opts?: IncrementalBuildOptions,
): Promise<GraphDeltaReport> {
  const normalizeFilePath = (file: string): string =>
    normalizePath(
      path.isAbsolute(file) ? file : path.resolve(projectRoot, file),
    );
  const manifest = await loadManifest(projectRoot, opts);
  const graphOptions = normalizeGraphOptions(opts?.graph);
  const strictIncremental = opts?.incrementalStrict ?? false;
  if (strictIncremental && graphOptions.fast) {
    graphOptions.fast = false;
  }

  const explicitFiles = (opts?.files ?? [])
    .map(normalizeFilePath)
    .filter((file) => fs.existsSync(file));
  const needsGitScan = !!opts?.gitBase || !!opts?.changedSince;
  const gitOpts: { base?: string; head?: string; changedSince?: string } = {};
  if (opts?.gitBase) gitOpts.base = opts.gitBase;
  if (opts?.gitHead) gitOpts.head = opts.gitHead;
  if (!opts?.gitBase && opts?.changedSince)
    gitOpts.changedSince = opts.changedSince;
  const gitFiles = needsGitScan
    ? await listChangedFiles(projectRoot, gitOpts)
    : [];

  const trackedEntries = manifest?.files ?? {};
  const trackedFiles = new Set(
    Object.keys(trackedEntries).filter((file) => fs.existsSync(file)),
  );

  const gitAvailable = await isGitRepo(projectRoot);
  const currentHead = gitAvailable ? await getGitHead(projectRoot) : null;
  const hasExplicitGitRange = !!opts?.gitBase || !!opts?.gitHead;
  const manifestCommitMismatch =
    !hasExplicitGitRange &&
    !!manifest?.lastCommit &&
    !!currentHead &&
    manifest.lastCommit !== currentHead;
  const manifestDiffFiles = manifestCommitMismatch
    ? await listChangedFiles(projectRoot, {
        base: manifest?.lastCommit,
        head: currentHead,
      })
    : [];

  const allFiles = new Set<string>([
    ...trackedFiles,
    ...explicitFiles,
    ...manifestDiffFiles.filter((file) => fs.existsSync(file)),
    ...gitFiles.filter((file) => fs.existsSync(file)),
  ]);

  if (allFiles.size === 0) {
    return { changedFiles: [], added: [], removed: [] };
  }

  const changedFiles = new Set<string>();
  explicitFiles.forEach((file) => changedFiles.add(file));
  manifestDiffFiles.forEach((file) => changedFiles.add(file));
  gitFiles.forEach((file) => changedFiles.add(file));

  if (manifest && graphOptionsEqual(manifest.graphOptions, graphOptions)) {
    const gitSigMap = gitAvailable
      ? await getGitBlobHashes(projectRoot, Array.from(allFiles), {
          gitAvailable,
        })
      : new Map<string, string>();
    for (const file of allFiles) {
      const sigInfo = await fileSignature(
        file,
        opts?.cacheStrict,
        gitSigMap.get(file),
      );
      const entry = trackedEntries[file];
      const hasMatchingGitSig =
        !!entry?.gitSig && !!sigInfo.gitSig && entry.gitSig === sigInfo.gitSig;
      const hasMatchingSig = entry?.sig === sigInfo.sig;
      if (!entry || !(hasMatchingGitSig || hasMatchingSig)) {
        changedFiles.add(file);
      }
    }
  }

  const changedList = Array.from(changedFiles);
  const beforeEdges = new Map<string, Edge>();
  if (manifest) {
    for (const file of changedList) {
      const entry = trackedEntries[file];
      if (!entry?.edges) continue;
      for (const edge of entry.edges) {
        beforeEdges.set(edgeKey(edge), edge);
      }
    }
  }

  const index = await buildProjectIndexIncremental(projectRoot, opts);
  const afterEdges = new Map<string, Edge>();
  for (const edge of index.graph.edges) {
    if (changedFiles.has(edge.from)) {
      afterEdges.set(edgeKey(edge), edge);
    }
  }

  const added: Edge[] = [];
  const removed: Edge[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) added.push(edge);
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) removed.push(edge);
  }

  const changedFilesRelative = changedList.map((file) =>
    normalizePath(path.relative(projectRoot, file)),
  );
  const addedRelative = added.map((edge) => toRelativeEdge(projectRoot, edge));
  const removedRelative = removed.map((edge) =>
    toRelativeEdge(projectRoot, edge),
  );

  return {
    changedFiles: changedFilesRelative.sort(),
    added: addedRelative.sort(compareEdges),
    removed: removedRelative.sort(compareEdges),
  };
}

function cacheKey(file: FileId, name: string) {
  return `${file}::${name}`;
}

function setParsedCacheEntry(
  parsedMap: Map<string, ParsedFileContext>,
  file: string,
  entry: ParsedFileContext,
  maxEntries: number,
): void {
  if (parsedMap.has(file)) parsedMap.delete(file);
  parsedMap.set(file, entry);
  while (parsedMap.size > maxEntries) {
    const oldest = parsedMap.keys().next().value;
    if (!oldest) break;
    parsedMap.delete(oldest);
  }
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
): ResolvedExport | null {
  const visited = new Set<string>();
  function _resolve(fileInner: FileId, name: string): ResolvedExport | null {
    const normalizedFile = fileInner.replace(/\\/g, "/");
    const mod = index.byFile.get(normalizedFile);
    if (!mod) return null;
    const key = cacheKey(normalizedFile, name);
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    // Detect and break cycles
    const cycleKey = `${normalizedFile}::${name}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const goPackageExport = resolveGoPackageExport(index, normalizedFile, name);
    if (goPackageExport) {
      const res: ResolvedExport = { kind: "resolved", def: goPackageExport };
      index.exportCache.set(key, res);
      return res;
    }

    for (const e of mod.exports)
      if (e.type === "local" && e.exportedAs === name) {
        const res: ResolvedExport = { kind: "resolved", def: e.target };
        index.exportCache.set(key, res);
        return res;
      }
    for (const e of mod.exports)
      if (e.type === "namespaceReexport" && e.exportedAs === name) {
        const res: ResolvedExport = { kind: "namespace", file: e.fromModule };
        index.exportCache.set(key, res);
        return res;
      }
    for (const e of mod.exports)
      if (
        e.type === "reexport" &&
        e.exportedAs === name &&
        typeof e.fromModule === "string"
      ) {
        const down =
          _resolve(e.fromModule, e.sourceSpecifier || name) ||
          _resolve(e.fromModule, name);
        if (down) {
          index.exportCache.set(key, down);
          return down;
        }
      }
    for (const e of mod.exports)
      if (e.type === "exportStar" && typeof e.fromModule === "string") {
        const down = _resolve(e.fromModule, name);
        if (down) {
          index.exportCache.set(key, down);
          return down;
        }
      }

    // Fallback: treat local with same name as exported (Python/Ruby or missing export metadata)
    const local = mod.locals.find((l) => l.localName === name);
    if (local) {
      const res: ResolvedExport = { kind: "resolved", def: local };
      index.exportCache.set(key, res);
      return res;
    }

    index.exportCache.set(key, null);
    return null;
  }
  return _resolve(file, exportedName);
}

const goPackageNameCache = new Map<FileId, string | null>();

function readGoPackageName(filePath: string): string | null {
  const cached = goPackageNameCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const match = src.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
    const pkg = match?.[1] ?? null;
    goPackageNameCache.set(filePath, pkg);
    return pkg;
  } catch {
    goPackageNameCache.set(filePath, null);
    return null;
  }
}

function resolveGoPackageExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
): SymbolDef | null {
  try {
    const sup = supportForFile(file);
    if (!sup || sup.id !== "go") return null;
    const baseDir = path.dirname(file);
    const sourcePackage = readGoPackageName(file);
    for (const [filePath, mod] of index.byFile) {
      if (path.dirname(filePath) !== baseDir) continue;
      if (sourcePackage && readGoPackageName(filePath) !== sourcePackage)
        continue;
      for (const e of mod.exports) {
        if (e.type === "local" && e.exportedAs === exportedName) {
          return e.target;
        }
      }
    }
  } catch {
    // supportForFile throws on unsupported files (e.g. .json)
  }
  return null;
}

export type GoToRequest = { file: FileId; line: number; column: number };
export type GoToResult =
  | {
      status: "ok";
      definition: SymbolDef;
      via?: {
        importedFrom?: string | undefined;
        exportedName?: string | undefined;
      };
    }
  | { status: "not_found"; reason: string };

export async function goToDefinition(
  index: ProjectIndex,
  req: GoToRequest,
): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(file);
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const parsedEntry = index.parsed?.get(file);
  const context = await ensureParsedContext(file, parsedEntry);
  const sup = context.sup;
  const lang = context.lang;
  const source = context.source;
  const tree = context.tree;

  const pos = {
    row: Math.max(0, line - 1),
    column: Math.max(0, column - 1),
  };
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(
    pos,
    pos,
  );

  if (node && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && value.type === "call_expression") {
      let callee = value.childForFieldName("function");
      if (!callee) callee = value.childForFieldName("callee");
      if (!callee) callee = value.child(0);
      if (callee && sup.nodeTypes.identifier.includes(callee.type)) {
        node = callee;
      }
    }
  }

  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  const isId = sup.nodeTypes.identifier.includes(node.type);
  let name: string | null = isId ? sliceText(node, source) : null;

  if (!name) {
    const findDeclNameNode = (
      n: Parser.SyntaxNode | null,
    ): Parser.SyntaxNode | null => {
      let cur: Parser.SyntaxNode | null = n;
      while (cur) {
        if (
          cur.type === "function_declaration" ||
          cur.type === "class_declaration" ||
          cur.type === "variable_declarator" ||
          cur.type === "interface_declaration" ||
          cur.type === "type_alias_declaration" ||
          cur.type === "function_definition" ||
          cur.type === "class_definition" ||
          cur.type === "assignment"
        ) {
          let named = cur.childForFieldName("name");
          if (!named && cur.type === "assignment") {
            const left = cur.child(0);
            if (left && sup.nodeTypes.identifier.includes(left.type))
              named = left;
          }
          if (named && sup.nodeTypes.identifier.includes(named.type))
            return named;
        }
        cur = cur.parent;
      }
      return null;
    };
    const declNameNode = findDeclNameNode(node);
    if (declNameNode) name = sliceText(declNameNode, source);
  }

  // Check if node is part of a member access chain (property, method call, scope resolution)
  const isMemberAccess =
    node.parent &&
    (node.parent.type ===
      (sup.nodeTypes.memberExpression ?? "member_expression") ||
      node.parent.type === "member_access_expression" || // C#
      node.parent.type === "qualified_name" || // C#
      node.parent.type === "field_access" || // Java
      node.parent.type === "method_invocation" || // Java
      node.parent.type === "scoped_identifier" || // Java/Rust
      node.parent.type === "scoped_type_identifier" || // Java
      node.parent.type === "call" || // Ruby
      node.parent.type === "scope_resolution" || // Ruby
      node.parent.type === "field_expression" || // Rust
      node.parent.type === "attribute"); // Python

  if (sup.supportsCrossModuleSymbols && isMemberAccess) {
    const memberNode = node.parent!;
    let obj: Parser.SyntaxNode | null = null;
    let prop: Parser.SyntaxNode | null = null;

    if (sup.id === "python") {
      obj = memberNode.childForFieldName("object") ?? memberNode.child(0);
      prop = memberNode.childForFieldName("attribute") ?? memberNode.child(2);
    } else if (sup.id === "csharp") {
      if (memberNode.type === "qualified_name") {
        obj = memberNode.child(0);
        prop = memberNode.child(2);
      } else {
        obj = memberNode.child(0);
        prop = memberNode.child(2);
      }
      // Unwrap nested structure if needed (A.B.C)
      let current = obj;
      while (
        current &&
        (current.type === "qualified_name" ||
          current.type === "member_access_expression")
      ) {
        current = current.child(0);
      }
    } else if (sup.id === "java") {
      if (memberNode.type === "method_invocation") {
        obj = memberNode.childForFieldName("object") ?? memberNode.child(0);
        prop = memberNode.childForFieldName("name") ?? memberNode.child(2);
        // method_invocation: object . name (args)
        // tree-sitter-java: method_invocation (object)? . (type_arguments)? name (arguments)
      } else if (
        memberNode.type === "scoped_identifier" ||
        memberNode.type === "scoped_type_identifier"
      ) {
        obj = memberNode.childForFieldName("scope") ?? memberNode.child(0);
        prop = memberNode.childForFieldName("name") ?? memberNode.child(2);
      } else {
        obj = memberNode.child(0);
        prop = memberNode.child(2);
      }
    } else if (sup.id === "ruby") {
      if (memberNode.type === "scope_resolution") {
        obj = memberNode.childForFieldName("scope") ?? memberNode.child(0);
        prop = memberNode.childForFieldName("name") ?? memberNode.child(2);
      } else {
        // call: receiver . method
        obj = memberNode.childForFieldName("receiver") ?? memberNode.child(0);
        prop = memberNode.childForFieldName("method") ?? memberNode.child(2);
      }
    } else if (sup.id === "rust") {
      if (memberNode.type === "scoped_identifier") {
        obj = memberNode.childForFieldName("path") ?? memberNode.child(0);
        prop = memberNode.childForFieldName("name") ?? memberNode.child(2);
      } else {
        obj = memberNode.child(0);
        prop = memberNode.child(2);
      }
    } else if (sup.id === "kotlin" || sup.id === "swift") {
      if (memberNode.type === "navigation_expression") {
        obj = memberNode.namedChildren[0] ?? memberNode.child(0);
        const suffix =
          memberNode.namedChildren.find(
            (c) => c.type === "navigation_suffix",
          ) ?? memberNode.child(1);
        if (suffix) {
          prop =
            suffix.childForFieldName("suffix") ??
            suffix.childForFieldName("name") ??
            suffix.namedChildren[0] ??
            suffix.child(0);
        }
      } else {
        obj = memberNode.child(0);
        prop = memberNode.child(2);
      }
    } else {
      // Default (JS/TS)
      obj = memberNode.child(0);
      prop = memberNode.child(2);
    }

    const memberExpressionType =
      sup.nodeTypes.memberExpression ?? "member_expression";
    const _propertyIdentifierTypes: string[] = sup.nodeTypes
      .propertyIdentifier ?? ["property_identifier"];
    const optionalMemberTypes = new Set<string>([
      memberExpressionType,
      "optional_member_expression",
      "subscript_expression",
      "optional_chain",
      sup.id === "python" ? "attribute" : "",
    ]);

    const resolveExpression = async (
      expr: Parser.SyntaxNode,
    ): Promise<ResolvedExport | null> => {
      const exprName = sliceText(expr, source);
      const exprIsId = sup.nodeTypes.identifier.includes(expr.type);
      if (
        exprIsId ||
        expr.type === "identifier" ||
        expr.type === "type_identifier" ||
        expr.type === "constant"
      ) {
        // Check imports
        const imp = mod.imports.find(
          (i) =>
            (i.kind === "named" && i.local === exprName) ||
            (i.kind === "default" && i.local === exprName) ||
            (i.kind === "namespace" && i.localNS === exprName),
        );
        if (imp) {
          if (imp.kind === "namespace") {
            return {
              kind: "namespace",
              file:
                typeof imp.resolved === "string"
                  ? imp.resolved.replace(/\\/g, "/")
                  : imp.resolved?.external || "",
            };
          }
          const res = resolveImported(
            index,
            imp,
            imp.kind === "named" ? imp.imported : "default",
          );
          if (res) {
            if ("namespace" in res)
              return { kind: "namespace", file: res.namespace };
            return { kind: "resolved", def: res };
          }
        }
        // Check locals
        const local = mod.locals.find((l) => l.localName === exprName);
        if (local) return { kind: "resolved", def: local };

        // Check star imports
        for (const starImp of mod.imports.filter((i) => i.kind === "star")) {
          const res = resolveImported(index, starImp, exprName);
          if (res) {
            if ("namespace" in res)
              return { kind: "namespace", file: res.namespace };
            return { kind: "resolved", def: res };
          }
        }
        return null;
      }

      if (optionalMemberTypes.has(expr.type)) {
        const subObj = expr.child(0);
        let subProp =
          expr.childForFieldName?.("property") ??
          expr.child(2) ??
          expr.childForFieldName?.("attribute");
        if (!subProp && expr.type === "navigation_expression") {
          const suffix =
            expr.namedChildren.find((c) => c.type === "navigation_suffix") ??
            expr.child(1);
          if (suffix) {
            subProp =
              suffix.childForFieldName?.("suffix") ??
              suffix.childForFieldName?.("name") ??
              suffix.namedChildren[0] ??
              suffix.child(0);
          }
        }
        if (subObj && subProp) {
          const base = await resolveExpression(subObj);
          if (base?.kind === "namespace") {
            const memberName = sliceText(subProp, source);
            const hit = resolveExport(index, base.file, memberName);
            return hit;
          } else if (base?.kind === "resolved") {
            // Handled by the language-specific member logic below for classes/structs
            return null;
          }
        }
      }
      return null;
    };

    const chain = await resolveExpression(memberNode);
    if (chain && prop && node.id === prop.id) {
      if (chain.kind === "resolved") {
        return {
          status: "ok",
          definition: chain.def,
          via: { exportedName: sliceText(prop, source) },
        };
      } else if (chain.kind === "namespace") {
        // Fallback to first export or just return it as a variable if we can't find a member
        const targetMod = index.byFile.get(chain.file);
        const first = targetMod?.exports.find((e) => e.type === "local");
        if (first) {
          return {
            status: "ok",
            definition: first.target,
            via: { exportedName: first.exportedAs },
          };
        }
      }
    }

    // Special logic for class members in some languages (Java, C#, Ruby, Rust)
    if (
      obj &&
      prop &&
      node.id === prop.id &&
      (sup.id === "csharp" ||
        sup.id === "java" ||
        sup.id === "ruby" ||
        sup.id === "rust")
    ) {
      const _nsName = sliceText(obj, source);
      const member = sliceText(prop, source);
      let objDef: SymbolDef | null = null;
      const res = await resolveExpression(obj);
      if (res?.kind === "resolved") objDef = res.def;

      if (objDef) {
        const tCtx = await ensureParsedContext(objDef.file);
        if (tCtx) {
          const { tree: tTree } = tCtx;
          const start = objDef.range.start;
          const p = { row: start.line - 1, column: start.column - 1 };
          const nameNode = tTree.rootNode.descendantForPosition(p, p);
          const container = nameNode.parent;

          if (container) {
            const tMod = index.byFile.get(objDef.file);
            if (tMod) {
              const cStart = container.startIndex;
              const cEnd = container.endIndex;

              const memberDef = tMod.locals.find((l) => {
                const startIndex = l.range.start.index;
                const endIndex = l.range.end.index;
                return (
                  l.localName === member &&
                  startIndex !== undefined &&
                  endIndex !== undefined &&
                  startIndex >= cStart &&
                  endIndex <= cEnd
                );
              });

              if (memberDef) {
                return {
                  status: "ok",
                  definition: memberDef,
                  via: { exportedName: member },
                };
              }
            }
          }
        }
      }
    }
  }

  if (name) {
    let scopeIndex = index.scopeCache.get(file);
    if (!scopeIndex) {
      scopeIndex = buildScopeIndexFromSource(
        file,
        source,
        sup,
        lang,
        mod.imports,
        { tree },
      );
      index.scopeCache.set(file, scopeIndex);
    }

    const findClosestBinding = (
      name: string,
      node: Parser.SyntaxNode,
    ): SymbolDef | null => {
      // Find the scope that contains this node
      let currentScope = scopeIndex.allScopes.find((s) => {
        const start = s.node.startIndex;
        const end = s.node.endIndex;
        return node.startIndex >= start && node.endIndex <= end;
      });

      // Find the most specific scope
      if (currentScope) {
        let best = currentScope;
        for (const s of scopeIndex.allScopes) {
          if (
            node.startIndex >= s.node.startIndex &&
            node.endIndex <= s.node.endIndex &&
            s.node.startIndex >= best.node.startIndex &&
            s.node.endIndex <= best.node.endIndex
          ) {
            best = s;
          }
        }
        currentScope = best;
      }

      while (currentScope) {
        const b = currentScope.map.get(name);
        if (b && b.def) {
          return {
            file,
            localName: b.name,
            kind:
              b.kind === "function"
                ? SymbolKind.Function
                : b.kind === "class"
                  ? SymbolKind.Class
                  : b.kind === "type"
                    ? SymbolKind.TypeAlias
                    : SymbolKind.Variable,
            range: b.def,
          };
        }
        currentScope = currentScope.parent;
      }
      return null;
    };

    const local = findClosestBinding(name, node);
    if (local) {
      return { status: "ok", definition: local };
    }
    if (sup.supportsCrossModuleSymbols) {
      const hit = resolveExport(index, file, name);
      if (hit?.kind === "resolved") {
        return {
          status: "ok",
          definition: hit.def,
          via: { exportedName: name },
        };
      } else if (hit?.kind === "namespace") {
        const targetFile = hit.file;
        const targetMod = index.byFile.get(targetFile);
        if (targetMod) {
          const firstExport = targetMod.exports.find((e) => e.type === "local");
          if (firstExport) {
            return {
              status: "ok",
              definition: firstExport.target,
              via: { exportedName: name },
            };
          }
        }
      }

      for (const imp of mod.imports) {
        if (imp.kind === "default" && imp.local === name) {
          const res = resolveImported(index, imp, "default");
          if (res) {
            const target = "namespace" in res ? null : res;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved)
                    ? { importedFrom: toModuleRef(imp.resolved) }
                    : {}),
                  exportedName: "default",
                },
              };
            }
          }
        } else if (imp.kind === "named" && imp.local === name) {
          const res = resolveImported(index, imp, imp.imported);
          if (res) {
            const target = "namespace" in res ? null : res;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved)
                    ? { importedFrom: toModuleRef(imp.resolved) }
                    : {}),
                  exportedName: imp.imported,
                },
              };
            }
          }
        } else if (imp.kind === "star") {
          // If name is exported from the star-imported module
          const res = resolveImported(index, imp, name);
          if (res) {
            const target = "namespace" in res ? null : res;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved)
                    ? { importedFrom: toModuleRef(imp.resolved) }
                    : {}),
                  exportedName: name,
                },
              };
            }
          }
        } else if (imp.kind === "namespace" && imp.localNS === name) {
          const targetFile =
            typeof imp.resolved === "string"
              ? imp.resolved.replace(/\\/g, "/")
              : undefined;
          if (targetFile) {
            const targetMod = index.byFile.get(targetFile);
            if (targetMod) {
              const firstExport = targetMod.exports.find(
                (e) => e.type === "local",
              );
              if (firstExport) {
                return {
                  status: "ok",
                  definition: firstExport.target,
                  via: {
                    ...(toModuleRef(imp.resolved)
                      ? { importedFrom: toModuleRef(imp.resolved) }
                      : {}),
                    exportedName: firstExport.exportedAs,
                  },
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function toModuleRef(resolved?: FileId | { external: string }) {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}
export function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string,
): SymbolDef | { namespace: FileId } | null {
  const targetFile =
    typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return null;
  const hit = resolveExport(index, targetFile, exportedName);
  if (hit?.kind === "resolved") return hit.def;
  if (hit?.kind === "namespace") return { namespace: hit.file };
  try {
    const sup = supportForFile(targetFile);
    if (sup?.id === "python") {
      const base =
        fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()
          ? targetFile
          : path.dirname(targetFile);
      const subCandidates = [
        path.join(base, `${exportedName}.py`),
        path.join(base, exportedName, "__init__.py"),
        path.join(base, exportedName),
      ];
      for (const c of subCandidates) {
        try {
          if (fs.existsSync(c)) {
            const isDir = fs.statSync(c).isDirectory();
            const filePath = isDir ? c : c;
            return {
              file: filePath.replace(/\\/g, "/"),
              localName: exportedName,
              kind: SymbolKind.Variable,
              range: {
                start: { line: 1, column: 1, index: 0 },
                end: { line: 1, column: 1, index: 0 },
              },
            };
          }
        } catch {
          /* resolve fallback */
        }
      }
      return {
        file: targetFile.replace(/\\/g, "/"),
        localName: exportedName,
        kind: SymbolKind.Variable,
        range: {
          start: { line: 1, column: 1, index: 0 },
          end: { line: 1, column: 1, index: 0 },
        },
      };
    }
  } catch {
    // Unsupported file extension - cannot resolve detailed import.
  }
  return null;
}

export type BindingKind =
  | "local"
  | "param"
  | "function"
  | "class"
  | "type"
  | "importDefault"
  | "importNamed"
  | "namespace";
export type Binding = {
  name: string;
  kind: BindingKind;
  def?: Range;
  occurrences: Range[];
  import?: ImportBinding;
};

export type Scope = {
  kind: "module" | "function" | "block";
  map: Map<string, Binding>;
  node: Parser.SyntaxNode;
  parent: Scope | undefined;
};

export type ScopeIndex = {
  bindings: Map<string, Binding[]>;
  all: Binding[];
  allScopes: Scope[];
};

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang: Parser.Language,
  imports: ImportBinding[] = [],
  opts?: { tree?: Parser.Tree },
): ScopeIndex {
  const key2 =
    support.nodeTypes && support.id === "python"
      ? "py"
      : support.id === "js"
        ? "js"
        : "ts";
  let parser2: Parser | undefined;
  const tree =
    opts?.tree ??
    (() => {
      parser2 = acquireParser(lang, key2);
      parser2.setLanguage(lang);
      return parser2.parse(source);
    })();

  const rootScope: Scope = {
    kind: "module",
    map: new Map(),
    node: tree.rootNode,
    parent: undefined,
  };
  const stack: Scope[] = [rootScope];
  const allScopes: Scope[] = [rootScope];

  for (const imp of imports) {
    if (imp.kind === "default")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importDefault",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "named")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importNamed",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "namespace")
      rootScope.map.set(imp.localNS, {
        name: imp.localNS,
        kind: "namespace",
        occurrences: [],
        import: imp,
      });
  }

  const idSet = new Set([
    ...support.nodeTypes.identifier,
    ...(support.nodeTypes.shorthandPropertyIdentifier ?? []),
  ]);
  const customDeclLanguages = new Set(["c", "cpp", "kotlin", "swift"]);
  const paramParentTypes = new Set([
    "parameter_declaration",
    "parameter",
    "class_parameter",
    "lambda_parameters",
  ]);

  const toBindingKind = (kind: string): BindingKind => {
    if (kind === "function") return "function";
    if (kind === "class" || kind === "interface") return "class";
    if (kind === "type") return "type";
    return "local";
  };

  const isParamNode = (node: Parser.SyntaxNode): boolean => {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
      if (paramParentTypes.has(current.type)) return true;
      current = current.parent;
    }
    return false;
  };

  const addDecl = (nameNode: Parser.SyntaxNode, kind: BindingKind) => {
    const name = sliceText(nameNode, source);
    const target = stack[stack.length - 1];
    const b: Binding = {
      name,
      kind,
      def: toRange(nameNode),
      occurrences: [],
    };
    target?.map.set(name, b);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i]!.map.get(name);
      if (hit) return hit;
    }
    return rootScope.map.get(name);
  };

  const walk = (node: Parser.SyntaxNode) => {
    // 1. Add declarations to the CURRENT scope (before pushing a new one)
    if (
      node.type === "function_declaration" ||
      node.type === "function_definition" ||
      node.type === "method_declaration" ||
      node.type === "method" ||
      node.type === "singleton_method" ||
      node.type === "function_item" ||
      node.type === "func_literal"
    ) {
      const name = node.childForFieldName("name");
      if (name) {
        addDecl(name, "function");
      }
    }
    if (
      node.type === "class_declaration" ||
      node.type === "class_definition" ||
      node.type === "class" ||
      node.type === "module" ||
      node.type === "struct_item" ||
      node.type === "mod_item"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "class");
    }
    if (
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration" ||
      node.type === "type_spec" ||
      node.type === "trait_item"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }

    // 2. Handle scope creation
    let pushed = false;
    if (support.createsFunctionScope(node)) {
      const s: Scope = {
        kind: "function",
        map: new Map(),
        node,
        parent: stack[stack.length - 1],
      };
      stack.push(s);
      allScopes.push(s);
      pushed = true;

      // Parameters belong to the NEW scope
      if (
        node.type === "function_declaration" ||
        node.type === "function_definition" ||
        node.type === "method_declaration" ||
        node.type === "method" ||
        node.type === "singleton_method" ||
        node.type === "function_item" ||
        node.type === "func_literal"
      ) {
        const params = node.childForFieldName("parameters");
        if (params) {
          const q: Parser.SyntaxNode[] = [params];
          while (q.length) {
            const n = q.pop()!;
            if (n.type === "identifier") addDecl(n, "param");
            for (const ch of n.namedChildren) q.push(ch);
          }
        }
      }
    } else if (support.createsBlockScope(node)) {
      if (node.type !== "program" && node.type !== "module") {
        const s: Scope = {
          kind: "block",
          map: new Map(),
          node,
          parent: stack[stack.length - 1],
        };
        stack.push(s);
        allScopes.push(s);
        pushed = true;
      }
    }

    // 3. Handle variable declarations (these are always in current scope)
    if (
      node.type === "variable_declaration" ||
      node.type === "lexical_declaration" ||
      node.type === "assignment" ||
      node.type === "field_declaration" ||
      node.type === "local_variable_declaration" || // C#
      node.type === "var_declaration" || // Go
      node.type === "const_declaration" || // Go
      node.type === "short_var_declaration" || // Go
      node.type === "let_declaration" || // Rust
      node.type === "const_item" || // Rust
      node.type === "static_item" // Rust
    ) {
      for (const ch of node.namedChildren) {
        if (
          ch.type === "variable_declarator" ||
          ch.type === "var_spec" ||
          ch.type === "const_spec"
        ) {
          const nm = ch.childForFieldName("name");
          if (nm) addDecl(nm, "local");
        } else if (
          (ch.type === "identifier" || ch.type === "field_identifier") &&
          (node.type === "assignment" || node.type === "short_var_declaration")
        ) {
          addDecl(ch, "local");
        } else if (
          node.type === "let_declaration" ||
          node.type === "const_item" ||
          node.type === "static_item"
        ) {
          // Rust: let pattern = value;
          const pat =
            node.childForFieldName("pattern") || node.childForFieldName("name");
          if (pat && pat.type === "identifier") addDecl(pat, "local");
        }
      }
    }

    if (
      customDeclLanguages.has(support.id) &&
      idSet.has(node.type) &&
      support.isDeclarationName(node)
    ) {
      const kind = isParamNode(node)
        ? "param"
        : toBindingKind(support.classifyDefinition(node));
      addDecl(node, kind);
    }

    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const name = sliceText(node, source);
      const b = lookup(name);
      if (b) {
        b.occurrences.push(toRange(node));
      }
    }

    // 4. Recurse, but skip nodes we already handled manually to control scope
    for (const ch of node.namedChildren) {
      if (pushed) {
        const type = node.type;
        if (
          (type === "function_declaration" ||
            type === "function_definition" ||
            type === "method_declaration" ||
            type === "method" ||
            type === "singleton_method" ||
            type === "function_item" ||
            type === "func_literal" ||
            type === "class_declaration" ||
            type === "class_definition" ||
            type === "class" ||
            type === "module" ||
            type === "struct_item" ||
            type === "mod_item") &&
          (ch.type === "identifier" ||
            ch.type === "type_identifier" ||
            ch.type === "parameters")
        ) {
          continue;
        }
      }
      walk(ch);
    }

    if (pushed) stack.pop();
  };

  walk(tree.rootNode);
  if (parser2) releaseParser(parser2, key2);

  const bindings = new Map<string, Binding[]>();
  const all: Binding[] = [];
  const flush = (scope: Scope) => {
    for (const b of scope.map.values()) {
      if (!bindings.has(b.name)) bindings.set(b.name, []);
      bindings.get(b.name)!.push(b);
      all.push(b);
    }
  };
  for (const s of allScopes) flush(s);
  return { bindings, all, allScopes };
}

export type Reference = {
  file: FileId;
  range: Range;
  context?: string;
  via?: { import?: ImportBinding; namespaceMember?: string };
};

function sameDef(a: SymbolDef, b: SymbolDef) {
  const aIndex = a.range.start.index ?? 0;
  const bIndex = b.range.start.index ?? 0;
  return a.file === b.file && a.localName === b.localName && aIndex === bIndex;
}

function _rangeContains(
  range: Range,
  pos: { row: number; column: number },
): boolean {
  if (pos.row < range.start.line || pos.row > range.end.line) return false;
  if (pos.row === range.start.line && pos.column < range.start.column)
    return false;
  if (pos.row === range.end.line && pos.column > range.end.column) return false;
  return true;
}

function extractLineContext(
  source: string,
  line: number,
  lines: number,
): string {
  const allLines = source.split(/\r?\n/);
  const startLine = Math.max(0, line - 1 - lines); // 1-based to 0-based, then subtract context
  const endLine = Math.min(allLines.length, line - 1 + lines + 1); // +1 to include the line itself
  return allLines.slice(startLine, endLine).join("\n");
}

function extractEnclosingBlock(
  source: string,
  tree: Parser.Tree,
  range: Range,
  maxLines: number,
  sup: LanguageSupport,
): string {
  // Find the node at the reference position
  const node = tree.rootNode.descendantForIndex(
    range.start.index ?? 0,
    range.end.index ?? range.start.index ?? 0,
  );
  if (!node)
    return extractLineContext(
      source,
      range.start.line,
      DEFAULT_REF_CONTEXT_LINES,
    ); // fallback to line context

  // Climb to find an enclosing block (function, class, etc.)
  let current = node;
  const isBlockType = (type: string) => {
    // TypeScript/JavaScript block types
    if (sup.id === "ts" || sup.id === "js") {
      return [
        "function_declaration",
        "method_definition",
        "class_declaration",
        "arrow_function",
        "function_expression",
        "statement_block",
        "class_body",
      ].includes(type);
    }
    // Python block types
    if (sup.id === "python") {
      return ["function_definition", "class_definition", "suite"].includes(
        type,
      );
    }
    return false;
  };

  while (current && !isBlockType(current.type)) {
    const parent = current.parent;
    if (!parent) break;
    current = parent;
  }

  if (!current)
    return extractLineContext(
      source,
      range.start.line,
      DEFAULT_REF_CONTEXT_LINES,
    ); // fallback to line context

  const blockText = sliceText(current, source);
  const blockLines = blockText.split(/\r?\n/);

  // If block is too long, truncate it
  if (blockLines.length > maxLines) {
    return blockLines.slice(0, maxLines).join("\n") + "\n...";
  }

  return blockText;
}

export async function findReferences(
  index: ProjectIndex,
  req: { file: FileId; line: number; column: number } | { def: SymbolDef },
  opts?: { context?: "line" | "block"; lines?: number; blockMaxLines?: number },
): Promise<
  | { status: "ok"; definition: SymbolDef; references: Reference[] }
  | { status: "not_found"; reason: string }
> {
  let def: SymbolDef | null = null;
  if ("def" in req) def = req.def;
  else {
    const got = await goToDefinition(index, req);
    if (got.status === "ok") def = got.definition;
  }
  if (!def)
    return { status: "not_found", reason: "Could not resolve definition" };

  const definitionFile = def.file;
  const parsedDef = index.parsed?.get(definitionFile);
  const parsedContext = await ensureParsedContext(definitionFile, parsedDef);
  const _sup = parsedContext.sup;
  const _lang = parsedContext.lang;
  const _src = parsedContext.source;
  const getCachedScope = (
    fileId: string,
    moduleIndex: ModuleIndex,
    parsedCtx: {
      source: string;
      sup: LanguageSupport;
      lang: Parser.Language;
      tree: Parser.Tree;
    },
  ) => {
    if (index.scopeCache.has(fileId)) return index.scopeCache.get(fileId)!;
    const s = buildScopeIndexFromSource(
      fileId,
      parsedCtx.source,
      parsedCtx.sup,
      parsedCtx.lang,
      moduleIndex.imports,
      { tree: parsedCtx.tree },
    );
    index.scopeCache.set(fileId, s);
    return s;
  };

  const mod = index.byFile.get(definitionFile);
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const scope = getCachedScope(definitionFile, mod, parsedContext);

  const refs: Reference[] = [];

  const localBindings = scope.bindings.get(def.localName) ?? [];
  const localBinding = localBindings.find(
    (b) => b.def && b.def.start.index === def.range.start.index,
  );
  if (localBinding)
    for (const occ of localBinding.occurrences)
      refs.push({ file: definitionFile, range: occ });
  refs.push({ file: definitionFile, range: def.range });

  const exportedNames: string[] = [];

  for (const e of mod.exports)
    if (e.type === "local" && sameDef(e.target, def))
      exportedNames.push(e.exportedAs);
  if (!exportedNames.length) exportedNames.push(def.localName);

  const exportedNameSet = new Set(exportedNames);
  const getCandidateReferenceNames = (module: ModuleIndex): string[] => {
    const names = new Set<string>();
    let hasDirectImport = false;

    for (const imp of module.imports) {
      const resolved =
        typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!resolved || resolved !== definitionFile) continue;
      hasDirectImport = true;

      if (imp.kind === "named") {
        if (exportedNameSet.has(imp.imported)) {
          names.add(imp.local);
        }
      } else if (imp.kind === "default") {
        if (exportedNameSet.has("default")) {
          names.add(imp.local);
        }
      } else if (imp.kind === "namespace") {
        for (const name of exportedNameSet) {
          names.add(name);
        }
      } else if (imp.kind === "star") {
        for (const name of exportedNameSet) {
          names.add(name);
        }
      }
    }

    if (!hasDirectImport) return [];
    return Array.from(names);
  };

  // Use bloom filters to pre-filter files that might contain references
  let candidateFiles = Array.from(index.byFile.keys()).filter(
    (f) => f !== definitionFile,
  );
  if (index.bloomFilters && exportedNames.length > 0) {
    candidateFiles = candidateFiles.filter((file) => {
      const mod = index.byFile.get(file);
      if (!mod) return true;
      const filter = index.bloomFilters?.get(file);
      if (!filter) return true;

      const aliases = getCandidateReferenceNames(mod);
      if (aliases.length === 0) {
        // Fallback: if no direct imports found, it might still contain a reference
        // via re-exports, globals, or same-package usage. Check the original names.
        return exportedNames.some((name) => filter.mightContain(name));
      }
      return aliases.some((name) => filter.mightContain(name));
    });
  }

  for (const f of candidateFiles) {
    const m = index.byFile.get(f);
    if (!m) continue;

    let sc: ScopeIndex | null = null;
    const ensure = async () => {
      if (!sc) {
        const parsedF = index.parsed?.get(f);
        const parsed = await ensureParsedContext(f, parsedF);
        sc = getCachedScope(f, m, parsed);
      }
      return sc;
    };

    for (const imp of m.imports) {
      const targetFile =
        typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!targetFile) continue;
      for (const name of exportedNames) {
        if (imp.kind === "namespace") {
          const hit = resolveExport(index, targetFile, name);
          const matchesDef =
            hit?.kind === "resolved"
              ? sameDef(hit.def, def)
              : targetFile === definitionFile;
          if (!matchesDef) continue;
          const _scopeIdx = await ensure();
          const nsName = imp.localNS;
          const member = name;
          const ranges = await collectNamespaceMemberRefs(f, nsName, member);
          for (const r of ranges)
            refs.push({
              file: f,
              range: r,
              via: { import: imp, namespaceMember: member },
            });
        } else {
          if (imp.kind === "star") continue;
          const exported =
            imp.kind === "named"
              ? imp.imported
              : imp.kind === "default"
                ? "default"
                : name;
          const hit = resolveExport(index, targetFile, exported);
          const matchesDef =
            hit?.kind === "resolved"
              ? sameDef(hit.def, def)
              : targetFile === definitionFile;
          if (!matchesDef) continue;
          const scopeIdx = await ensure();
          const localName = imp.local;
          const binds = scopeIdx.bindings.get(localName) ?? [];
          for (const b of binds) {
            // Only include occurrences if this binding is actually the one from this import.
            // A binding from an import will have b.import set.
            if (b.import === imp) {
              for (const occ of b.occurrences)
                refs.push({ file: f, range: occ, via: { import: imp } });
            }
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqueRefs: typeof refs = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRefs.push(ref);
    }
  }

  uniqueRefs.sort((a, b) => {
    if (a.file === b.file) {
      const aIndex = a.range.start.index ?? 0;
      const bIndex = b.range.start.index ?? 0;
      return aIndex - bIndex;
    }
    return a.file.localeCompare(b.file);
  });

  // Populate context snippets if requested
  if (opts?.context) {
    const perFileCache = new Map<
      string,
      { source: string; tree: Parser.Tree; sup: LanguageSupport }
    >();

    for (const ref of uniqueRefs) {
      let cached = perFileCache.get(ref.file);
      if (!cached) {
        const parsedEntry = index.parsed?.get(ref.file);
        const parsed = await ensureParsedContext(ref.file, parsedEntry);
        cached = { source: parsed.source, tree: parsed.tree, sup: parsed.sup };
        perFileCache.set(ref.file, cached);
      }

      if (opts.context === "line") {
        const lines = opts.lines ?? DEFAULT_REF_CONTEXT_LINES;
        ref.context = extractLineContext(
          cached.source,
          ref.range.start.line,
          lines,
        );
      } else if (opts.context === "block") {
        const maxLines = opts.blockMaxLines ?? 60;
        ref.context = extractEnclosingBlock(
          cached.source,
          cached.tree,
          ref.range,
          maxLines,
          cached.sup,
        );
      }
    }
  }

  return { status: "ok", definition: def, references: uniqueRefs };
}

// Detailed symbol graph re-export compatibility
export async function __buildSymbolGraphDetailedCompat(
  index: ProjectIndex,
): Promise<SymbolGraph> {
  // Defer to original algorithm via barrel import after refactor; this placeholder will be overridden.
  const { buildSymbolGraphDetailed } = await import("./index.js");
  return await buildSymbolGraphDetailed(index);
}

export async function collectNamespaceMemberRefs(
  file: string,
  ns: string,
  member: string,
): Promise<Range[]> {
  const parsed = await ensureParsedContext(file, undefined);
  const sup = parsed.sup;
  const src = parsed.source;
  const tree = parsed.tree;
  const ranges: Range[] = [];
  const isRuby = sup.id === "ruby";
  const isMember =
    sup.nodeTypes.memberExpression ??
    (sup.id === "python"
      ? "attribute"
      : sup.id === "ruby"
        ? "call"
        : "member_expression");
  const isPropId = (t: string) =>
    (sup.nodeTypes.propertyIdentifier || ["property_identifier"]).includes(t) ||
    t === "identifier" ||
    t === "constant";
  const isObjId = (t: string) =>
    t === "identifier" ||
    t === "type_identifier" ||
    t === "constant" ||
    t === "namespace_identifier";
  const walk = (node: Parser.SyntaxNode) => {
    if (
      node.type === isMember ||
      (isRuby && (node.type === "call" || node.type === "scope_resolution"))
    ) {
      let obj: Parser.SyntaxNode | null = null;
      let prop: Parser.SyntaxNode | null = null;
      if (isRuby) {
        if (node.type === "scope_resolution") {
          obj = node.childForFieldName("scope") ?? node.child(0);
          prop = node.childForFieldName("name") ?? node.child(2);
        } else {
          obj = node.childForFieldName("receiver") ?? node.child(0);
          prop = node.childForFieldName("method") ?? node.child(2);
        }
      } else {
        obj = node.childForFieldName("object") ?? node.child(0);
        prop =
          node.childForFieldName("property") ??
          node.childForFieldName("attribute") ??
          node.child(2);
      }
      if (obj && prop && isObjId(obj.type) && isPropId(prop.type)) {
        const oname = sliceText(obj, src);
        const pname = sliceText(prop, src);
        if (oname === ns && pname === member) {
          ranges.push(toRange(node));
        }
      }
    }
    for (const ch of node.namedChildren) walk(ch);
  };
  walk(tree.rootNode);
  return ranges;
}
