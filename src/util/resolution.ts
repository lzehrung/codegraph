import path from "node:path";
import { GRAPH_ONLY_RESOLUTION_EXTENSIONS } from "./graph-only-extensions.js";
import { confineResolvedPath, fileIdentityKey, isFilePathWithinRoot, normalizeResolutionHints } from "./paths.js";
import {
  DEFAULT_RESOLUTION_EXTENSIONS,
  STYLESHEET_RESOLUTION_EXTENSIONS,
  getResolutionExtensions,
} from "./resolution-candidates.js";
import {
  clearWorkspaceCaches,
  clearFileExistsCache,
  fileExists,
  resolveWorkspacePackage,
  type WorkspaceConfig,
} from "./workspace.js";
import { clearJvmResolutionCaches } from "./resolution/jvm.js";
import { clearCsharpResolutionCaches } from "./resolution/csharp.js";
import { clearCppResolutionCaches } from "./resolution/cpp.js";
import { findFirstExistingResolutionCandidate } from "./resolution/find-first-existing.js";
import { isDirectory } from "./resolution/files.js";
import { findGoPackageEntry } from "./resolution/go.js";
import { resolveFromNodeModules } from "./resolution/node.js";
import { clearPhpResolutionCaches } from "./resolution/php.js";
import { clearPythonResolutionCache } from "./resolution/python.js";
import {
  clearTsconfigCache,
  matchMappedSpecifier,
  matchPathScopeKey,
  type MatchPathFn,
} from "./resolution/tsconfig.js";
import type { ModuleSpecifierExportCondition, ModuleSpecifierResolutionKind } from "./specifiers.js";
import type { PackageExportConditionMode } from "./package-exports.js";
import { lruMapGet, lruMapSet } from "./lru-map.js";
import { currentProbeCache, probeKind } from "./fs-probe-cache.js";
import { specifierTargetPolicyFor } from "./resolution/language-specifiers.js";
import type {
  ImportSpecifierDeps,
  ImportSpecifierOptions,
  SpecifierTargetPolicy,
} from "./resolution/language-policy-types.js";
export { resolveGoImportPath } from "./resolution/go.js";
export { resolveJvmPackageImportPaths } from "./resolution/jvm.js";
export { getPhpComposerImplicitFiles } from "./resolution/php.js";
export { resolvePythonModule } from "./resolution/python.js";
export { resolveRustImportPath } from "./resolution/rust.js";
export { loadNearestTsconfigFor, type MatchPathFn } from "./resolution/tsconfig.js";
export { mapLimit } from "./concurrency.js";
export { listResolutionCandidates } from "./resolution-candidates.js";

const MAX_RESOLVE_SPECIFIER_CACHE_ENTRIES = 10_000;

/**
 * `probeCacheId` names the build probe cache that proved a file result, so a hit inside the same build needs
 * no second check. Any other hit (another build, or a call outside a build) is checked against the file system.
 */
type ResolveSpecifierCacheEntry = {
  result: FileId | { external: string };
  probeCacheId: number | undefined;
};
const resolveSpecifierCache = new Map<string, ResolveSpecifierCacheEntry>();

function getResolveSpecifierCacheEntry(key: string): ResolveSpecifierCacheEntry | undefined {
  return lruMapGet(resolveSpecifierCache, key);
}

function setResolveSpecifierCacheEntry(key: string, value: ResolveSpecifierCacheEntry): void {
  lruMapSet(resolveSpecifierCache, key, value, MAX_RESOLVE_SPECIFIER_CACHE_ENTRIES);
}

export type FileId = string;

export {
  GRAPH_ONLY_DOCUMENT_EXTENSIONS,
  GRAPH_ONLY_RESOLUTION_EXTENSIONS,
  type GraphOnlyDocumentExtension,
  type GraphOnlyResolutionExtension,
} from "./graph-only-extensions.js";

const GRAPH_ONLY_LANGUAGE_DOCUMENT_RESOLUTION_EXTENSIONS: Record<string, readonly string[]> = {
  markdown: [".md", ".mdx"],
  mdx: [".mdx", ".md"],
  astro: [".astro"],
  hbs: [".hbs", ".handlebars"],
  rst: [".rst"],
  adoc: [".adoc", ".asciidoc"],
};

const GRAPH_ONLY_LANGUAGE_SOURCE_RESOLUTION_EXTENSIONS: Record<string, readonly string[]> = {
  mdx: DEFAULT_RESOLUTION_EXTENSIONS,
  astro: [...DEFAULT_RESOLUTION_EXTENSIONS, ".astro"],
};

async function acceptFirstPartyFile(projectRoot: string, filePath: string | null | undefined): Promise<string | null> {
  const confined = await confineResolvedPath(projectRoot, filePath);
  if (!confined) return null;
  const kind = await probeKind(confined);
  if (kind === null || kind === "directory") return null;
  return confined;
}

export function getGraphOnlyResolutionExtensions(
  languageId: string,
  resolutionKind: ModuleSpecifierResolutionKind = "document",
): string[] {
  if (resolutionKind === "stylesheet") {
    return Array.from(STYLESHEET_RESOLUTION_EXTENSIONS);
  }
  const normalizedLanguageId = languageId.toLowerCase();
  const preferredExtensions =
    resolutionKind === "source"
      ? (GRAPH_ONLY_LANGUAGE_SOURCE_RESOLUTION_EXTENSIONS[normalizedLanguageId] ?? DEFAULT_RESOLUTION_EXTENSIONS)
      : (GRAPH_ONLY_LANGUAGE_DOCUMENT_RESOLUTION_EXTENSIONS[normalizedLanguageId] ?? GRAPH_ONLY_RESOLUTION_EXTENSIONS);
  const includeGraphOnlyFallbacks = resolutionKind === "document";
  return Array.from(
    new Set([
      ...preferredExtensions,
      ...(includeGraphOnlyFallbacks ? GRAPH_ONLY_RESOLUTION_EXTENSIONS : []),
      ...DEFAULT_RESOLUTION_EXTENSIONS,
    ]),
  );
}

async function findFirstExistingScssPartialCandidate(base: string): Promise<string | null> {
  const basename = path.basename(base);
  if (!basename) return null;
  const originalExt = path.extname(base);
  const baseExt = originalExt.toLowerCase();
  if (baseExt && baseExt !== ".scss") return null;
  if (!basename.startsWith("_")) {
    const partialStem = baseExt ? path.basename(base, originalExt) : basename;
    const partialBasename = "_" + partialStem + ".scss";
    const partialPath = path.join(path.dirname(base), partialBasename);
    if (await fileExists(partialPath)) return path.resolve(partialPath);
  }
  if (baseExt) return null;
  // `index.scss` is already an ordinary directory index candidate. This partial is the Sass
  // `_index.scss` form. Incremental rebuilds treat both as the directory's entry file.
  const indexPartial = path.join(base, "_index.scss");
  return (await fileExists(indexPartial)) ? path.resolve(indexPartial) : null;
}

export async function resolvePathLikeModule(
  projectRoot: string,
  spec: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  const parts = spec.split(/[/.:]+/).filter(Boolean);
  const exts = getResolutionExtensions(resolutionExtensions);

  // Try matching progressively shorter prefixes (e.g. a.b.c -> a/b/c, a/b, a)
  for (let i = parts.length; i > 0; i--) {
    const sub = parts.slice(0, i);
    const p = path.join(projectRoot, ...sub);

    for (const e of exts) {
      const hit = await acceptFirstPartyFile(projectRoot, p + e);
      if (hit) return hit;
    }
    for (const e of exts) {
      const hit = await acceptFirstPartyFile(projectRoot, path.join(p, "index" + e));
      if (hit) return hit;
    }
    if (await isDirectory(p)) {
      const goHit = await acceptFirstPartyFile(projectRoot, await findGoPackageEntry(p));
      if (goHit) return goHit;
      continue;
    }
    const extensionless = await acceptFirstPartyFile(projectRoot, p);
    if (extensionless) return extensionless;
  }
  return null;
}

async function confineLanguageHit(
  projectRoot: string,
  resolved: string | null,
  spec: string,
): Promise<FileId | { external: string } | null> {
  if (!resolved) return null;
  const confined = await acceptFirstPartyFile(projectRoot, resolved);
  return confined ?? { external: spec };
}
const IMPORT_SPECIFIER_DEPS: ImportSpecifierDeps = { confineLanguageHit, acceptFirstPartyFile, resolveSpecifier };
const EMPTY_IMPORT_SPECIFIER_OPTIONS: ImportSpecifierOptions = {};

export async function resolveImportSpecifier(
  projectRoot: string,
  fromFile: string,
  spec: string,
  languageId: string,
  opts?: ImportSpecifierOptions,
  policy: SpecifierTargetPolicy = specifierTargetPolicyFor(languageId),
): Promise<FileId | { external: string }> {
  const declarationImport = policy.declarationImport;
  if (declarationImport) {
    const lookup = await declarationImport.lookup(projectRoot, spec, {
      languageId: declarationImport.languageId,
      fromFile,
    });
    const hit = await confineLanguageHit(projectRoot, lookup.file, spec);
    if (hit) return hit;
    // Known packages and unread declarations never permit a filename guess.
    if (lookup.incomplete || lookup.packageKnown) return { external: spec };
  }
  const resolveLanguageImport = policy.resolveImport;
  if (resolveLanguageImport) {
    const resolved = await resolveLanguageImport(
      projectRoot,
      fromFile,
      spec,
      opts ?? EMPTY_IMPORT_SPECIFIER_OPTIONS,
      IMPORT_SPECIFIER_DEPS,
    );
    if (resolved !== undefined) return resolved;
  }

  const resolutionKind = opts?.resolutionKind;
  return resolveSpecifier(fromFile, spec, projectRoot, opts?.matchPath, opts?.workspaceConfig, {
    resolveNodeModules: !!opts?.resolveNodeModules,
    ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
    ...(resolutionKind ? { resolutionKind } : {}),
    ...(resolutionKind === "stylesheet" ? { resolutionExtensions: STYLESHEET_RESOLUTION_EXTENSIONS } : {}),
    ...(opts?.allowScssPartialResolution ? { allowScssPartialResolution: true } : {}),
    ...(opts?.exportCondition ? { exportCondition: opts.exportCondition } : {}),
  });
}

/** Importer extensions whose bare specifiers may also name a first-party source path. */
const PATH_LIKE_FALLBACK_EXTENSIONS: readonly string[] = [".go", ".java", ".cs", ".rb", ".rs", ".swift"];

/**
 * Resolves a specifier written in `fromFile` to the first-party file it names, or to its external name.
 *
 * The cache key holds what decides the result, by branch:
 * - A specifier that starts with `.` resolves from the importer's directory, not its name, so the files of one
 *   directory share an entry.
 * - A `/`-rooted or Windows-absolute specifier depends on the project root alone.
 * - A bare specifier depends on the tsconfig mappings of the importer (the `baseUrl` and `paths` of its nearest
 *   config, so packages that extend one base config share an entry), the workspace, the hints, and whether the
 *   importer's language falls back to a path-like lookup. It also depends on the importer's directory where a
 *   `node_modules` walk starts there (`resolveNodeModules`) or a stylesheet tries it as a relative path first.
 * - An SCSS partial depends on whether the importer is a `.scss` file.
 * The options of the call (extensions, kind, hints, export condition, `node_modules` lookup) are in every key.
 */
export async function resolveSpecifier(
  fromFile: string,
  spec: string,
  projectRoot: string,
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig,
  opts?: {
    resolveNodeModules?: boolean;
    resolutionHints?: string[];
    resolutionExtensions?: readonly string[];
    resolutionKind?: ModuleSpecifierResolutionKind;
    allowScssPartialResolution?: boolean;
    exportCondition?: ModuleSpecifierExportCondition;
  },
): Promise<FileId | { external: string }> {
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(spec);
  if (!isWindowsAbsolutePath && (hasSchemePrefix || spec.startsWith("//"))) {
    return { external: spec };
  }

  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const hintKey = resolutionHints.join("|");
  const resolutionExtensions = getResolutionExtensions(opts?.resolutionExtensions);
  const extensionKey = opts?.resolutionExtensions === undefined ? "default" : resolutionExtensions.join("|");
  const workspaceKey = workspaceConfig ? fileIdentityKey(path.resolve(workspaceConfig.rootDir)) : "";
  const exportCondition: PackageExportConditionMode = opts?.exportCondition === "require" ? "require" : "import";
  const isRelativeOrAbsolute = spec.startsWith(".") || spec.startsWith("/") || isWindowsAbsolutePath;
  const stylesheetBareSpecifier = opts?.resolutionKind === "stylesheet" && !isRelativeOrAbsolute;
  const importerExtension = path.extname(fromFile).toLowerCase();
  const prefersPathLikeFallback = PATH_LIKE_FALLBACK_EXTENSIONS.includes(importerExtension);
  const scssPartialImporter = !!opts?.allowScssPartialResolution && importerExtension === ".scss";
  let importerScope: string;
  if (spec.startsWith(".")) {
    importerScope = `dir=${fileIdentityKey(path.dirname(path.resolve(fromFile)))}`;
  } else if (isRelativeOrAbsolute) {
    importerScope = "root";
  } else {
    importerScope = `mappings=${matchPathScopeKey(matchPath)}:pathLike=${prefersPathLikeFallback ? 1 : 0}`;
    if (opts?.resolveNodeModules || stylesheetBareSpecifier) {
      importerScope += `:dir=${fileIdentityKey(path.dirname(path.resolve(fromFile)))}`;
    }
  }
  if (scssPartialImporter && (isRelativeOrAbsolute || stylesheetBareSpecifier)) importerScope += ":scss";
  const cacheKey = [
    fileIdentityKey(path.resolve(projectRoot)),
    importerScope,
    spec,
    `workspace=${workspaceKey}`,
    `nm=${opts?.resolveNodeModules ? 1 : 0}`,
    `kind=${opts?.resolutionKind ?? ""}`,
    `scssPartial=${opts?.allowScssPartialResolution ? 1 : 0}`,
    `hints=${hintKey}`,
    `exts=${extensionKey}`,
    `exportCondition=${exportCondition}`,
  ].join("::");
  const probeCacheId = currentProbeCache()?.id;
  const cached = getResolveSpecifierCacheEntry(cacheKey);
  if (cached) {
    if (typeof cached.result !== "string") return cached.result;
    if (probeCacheId !== undefined && cached.probeCacheId === probeCacheId) return cached.result;
    const confinedCached = await acceptFirstPartyFile(projectRoot, cached.result);
    if (confinedCached) return confinedCached;
    resolveSpecifierCache.delete(cacheKey);
  }
  const remember = <T extends FileId | { external: string }>(result: T): T => {
    setResolveSpecifierCacheEntry(cacheKey, { result, probeCacheId });
    return result;
  };

  if (isRelativeOrAbsolute || stylesheetBareSpecifier) {
    let base = path.resolve(path.dirname(fromFile), spec);
    if (isWindowsAbsolutePath) {
      base = spec;
    } else if (spec.startsWith("/")) {
      base = path.join(projectRoot, spec);
    }
    const hit = await acceptFirstPartyFile(
      projectRoot,
      await findFirstExistingResolutionCandidate(base, resolutionExtensions),
    );
    if (hit) return remember(hit);
    if (scssPartialImporter) {
      const partialHit = await acceptFirstPartyFile(projectRoot, await findFirstExistingScssPartialCandidate(base));
      if (partialHit) return remember(partialHit);
    }
    if (isRelativeOrAbsolute) return remember({ external: spec });
  }
  // Bare specifier: prefer TS path mappings (tsconfig `paths`) before workspace/node_modules.
  if (matchPath) {
    const m = await matchMappedSpecifier(matchPath, spec, projectRoot, resolutionExtensions);
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, cand);
        if (mappedFile) return remember(mappedFile);
      }
      for (const e of resolutionExtensions) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, cand + e);
        if (mappedFile) return remember(mappedFile);
      }
      for (const e of resolutionExtensions) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, path.join(cand, "index" + e));
        if (mappedFile) return remember(mappedFile);
      }
    }
  }

  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await acceptFirstPartyFile(
      projectRoot,
      await resolveWorkspacePackage(spec, workspaceConfig, opts?.resolutionExtensions, exportCondition),
    );
    if (resolvedWs) return remember(resolvedWs);
    if (prefersPathLikeFallback) {
      // These languages use package-like specifiers for first-party source paths.
      const pathLike = await resolvePathLikeModule(projectRoot, spec, opts?.resolutionExtensions);
      if (pathLike) return remember(pathLike);
    }
    if (opts?.resolveNodeModules) {
      const nm = await acceptFirstPartyFile(
        projectRoot,
        await resolveFromNodeModules(spec, fromFile, projectRoot, opts?.resolutionExtensions, exportCondition),
      );
      if (nm) return remember(nm);
    }
  }
  if (resolutionHints.length) {
    for (const hint of resolutionHints) {
      const baseDir = path.isAbsolute(hint) ? hint : path.resolve(projectRoot, hint);
      if (!isFilePathWithinRoot(projectRoot, baseDir)) continue;
      const base = path.resolve(baseDir, spec);
      if (!isFilePathWithinRoot(projectRoot, base)) continue;
      const hit = await acceptFirstPartyFile(
        projectRoot,
        await findFirstExistingResolutionCandidate(base, resolutionExtensions),
      );
      if (hit) return remember(hit);
    }
  }
  return remember({ external: spec });
}

export function clearImportResolutionCaches(): void {
  resolveSpecifierCache.clear();
  clearPythonResolutionCache();
  clearFileExistsCache();
  clearJvmResolutionCaches();
  clearCsharpResolutionCaches();
  clearPhpResolutionCaches();
  clearCppResolutionCaches();
}

export function clearResolutionCaches(): void {
  clearImportResolutionCaches();
  clearTsconfigCache();
  clearWorkspaceCaches();
}
