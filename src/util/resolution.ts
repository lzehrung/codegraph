import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { clearJvmResolutionCaches, resolveJavaImportPath, resolveKotlinImportPath } from "./resolution/jvm.js";
import { clearCsharpResolutionCaches } from "./resolution/csharp.js";
import { clearCppResolutionCaches, isCppNamedModuleSpecifier, resolveCppImportPath } from "./resolution/cpp.js";
import { findFirstExistingResolutionCandidate } from "./resolution/find-first-existing.js";
import { isDirectory } from "./resolution/files.js";
import { findGoPackageEntry, resolveGoImportPath } from "./resolution/go.js";
import { resolveFromNodeModules } from "./resolution/node.js";
import { clearPhpResolutionCaches, resolvePhpImportPath } from "./resolution/php.js";
import { clearPythonResolutionCache } from "./resolution/python.js";
import { resolveRustImportPath } from "./resolution/rust.js";
import { clearTsconfigCache, type MatchPathFn } from "./resolution/tsconfig.js";
import type { ModuleSpecifierExportCondition, ModuleSpecifierResolutionKind } from "./specifiers.js";
import type { PackageExportConditionMode } from "./package-exports.js";
import { lruMapGet, lruMapSet } from "./lru-map.js";
export { resolveGoImportPath } from "./resolution/go.js";
export { resolveJvmPackageImportPaths } from "./resolution/jvm.js";
export { getPhpComposerImplicitFiles } from "./resolution/php.js";
export { resolvePythonModule } from "./resolution/python.js";
export { resolveRustImportPath } from "./resolution/rust.js";
export { loadNearestTsconfigFor, type MatchPathFn } from "./resolution/tsconfig.js";
export { mapLimit } from "./concurrency.js";
export { listResolutionCandidates } from "./resolution-candidates.js";

const MAX_RESOLVE_SPECIFIER_CACHE_ENTRIES = 10_000;
const resolveSpecifierCache = new Map<string, FileId | { external: string }>();

function getResolveSpecifierCacheEntry(key: string): FileId | { external: string } | undefined {
  return lruMapGet(resolveSpecifierCache, key);
}

function setResolveSpecifierCacheEntry(key: string, value: FileId | { external: string }): void {
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

function fileExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function acceptFirstPartyFile(projectRoot: string, filePath: string | null | undefined): Promise<string | null> {
  const confined = await confineResolvedPath(projectRoot, filePath);
  if (!confined) return null;
  try {
    const st = await fsp.stat(confined);
    if (st.isDirectory()) return null;
  } catch {
    return null;
  }
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
  if (!basename || basename.startsWith("_")) return null;
  const originalExt = path.extname(base);
  const baseExt = originalExt.toLowerCase();
  if (baseExt && baseExt !== ".scss") return null;
  const partialStem = baseExt ? path.basename(base, originalExt) : basename;
  const partialBasename = `_${partialStem}.scss`;
  const partialPath = path.join(path.dirname(base), partialBasename);
  return (await fileExists(partialPath)) ? path.resolve(partialPath) : null;
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

export async function resolveImportSpecifier(
  projectRoot: string,
  fromFile: string,
  spec: string,
  languageId: string,
  opts?: {
    matchPath?: MatchPathFn;
    workspaceConfig?: WorkspaceConfig;
    resolveNodeModules?: boolean;
    resolutionHints?: string[];
    phpImportType?: "class" | "function" | "const";
    resolutionKind?: ModuleSpecifierResolutionKind;
    allowScssPartialResolution?: boolean;
    exportCondition?: ModuleSpecifierExportCondition;
    pathAttribute?: string;
    statementStartIndex?: number;
  },
): Promise<FileId | { external: string }> {
  if (languageId === "go") {
    const goHit = await confineLanguageHit(projectRoot, await resolveGoImportPath(projectRoot, fromFile, spec), spec);
    if (goHit) return goHit;
  }
  if (languageId === "kotlin") {
    const kotlinHit = await confineLanguageHit(
      projectRoot,
      await resolveKotlinImportPath(projectRoot, spec, fromFile),
      spec,
    );
    if (kotlinHit) return kotlinHit;
  }
  if (languageId === "java") {
    const javaHit = await confineLanguageHit(
      projectRoot,
      await resolveJavaImportPath(projectRoot, spec, fromFile),
      spec,
    );
    if (javaHit) return javaHit;
  }
  if (languageId === "php") {
    const phpHit = await confineLanguageHit(
      projectRoot,
      await resolvePhpImportPath(projectRoot, fromFile, spec, opts?.phpImportType),
      spec,
    );
    if (phpHit) return phpHit;
  }
  if (languageId === "cpp") {
    const cppHit = await confineLanguageHit(projectRoot, await resolveCppImportPath(projectRoot, spec), spec);
    if (cppHit) return cppHit;
    if (isCppNamedModuleSpecifier(spec)) return { external: spec };
  }
  if (
    (languageId === "c" || languageId === "cpp") &&
    !(spec.startsWith("<") && spec.endsWith(">")) &&
    !spec.startsWith(".") &&
    !spec.startsWith("/")
  ) {
    const quotedIncludeHit = await resolveSpecifier(
      fromFile,
      `./${spec}`,
      projectRoot,
      opts?.matchPath,
      opts?.workspaceConfig,
      {
        resolveNodeModules: !!opts?.resolveNodeModules,
        ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
        ...(opts?.resolutionKind ? { resolutionKind: opts.resolutionKind } : {}),
        ...(opts?.resolutionKind === "stylesheet" ? { resolutionExtensions: STYLESHEET_RESOLUTION_EXTENSIONS } : {}),
        ...(opts?.allowScssPartialResolution ? { allowScssPartialResolution: true } : {}),
        ...(opts?.exportCondition ? { exportCondition: opts.exportCondition } : {}),
      },
    );
    if (typeof quotedIncludeHit === "string") return quotedIncludeHit;
  }
  if (languageId === "rust") {
    const statementStartIndex = opts?.statementStartIndex;
    const pathAttribute = statementStartIndex !== undefined ? opts?.pathAttribute : undefined;
    const rustResolved = await resolveRustImportPath(projectRoot, fromFile, spec, pathAttribute, statementStartIndex);
    const rustHit = await confineLanguageHit(projectRoot, rustResolved, spec);
    if (rustHit) return rustHit;
    return { external: spec };
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
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const hintKey = resolutionHints.join("|");
  const resolutionExtensions = getResolutionExtensions(opts?.resolutionExtensions);
  const extensionKey = resolutionExtensions.join("|");
  const workspaceKey = workspaceConfig ? fileIdentityKey(path.resolve(workspaceConfig.rootDir)) : "";
  const exportCondition: PackageExportConditionMode = opts?.exportCondition === "require" ? "require" : "import";
  const cacheKey = [
    fileIdentityKey(path.resolve(projectRoot)),
    fileIdentityKey(path.resolve(fromFile)),
    spec,
    `workspace=${workspaceKey}`,
    `nm=${opts?.resolveNodeModules ? 1 : 0}`,
    `kind=${opts?.resolutionKind ?? ""}`,
    `scssPartial=${opts?.allowScssPartialResolution ? 1 : 0}`,
    `hints=${hintKey}`,
    `exts=${extensionKey}`,
    `exportCondition=${exportCondition}`,
  ].join("::");
  const cached = getResolveSpecifierCacheEntry(cacheKey);
  if (cached) {
    if (typeof cached !== "string") return cached;
    const confinedCached = await acceptFirstPartyFile(projectRoot, cached);
    if (confinedCached) return confinedCached;
    resolveSpecifierCache.delete(cacheKey);
  }
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(spec);
  if (!isWindowsAbsolutePath && (hasSchemePrefix || spec.startsWith("//"))) {
    const ext = { external: spec } as const;
    setResolveSpecifierCacheEntry(cacheKey, ext);
    return ext;
  }

  const isRelativeOrAbsolute = spec.startsWith(".") || spec.startsWith("/") || isWindowsAbsolutePath;
  const stylesheetBareSpecifier = opts?.resolutionKind === "stylesheet" && !isRelativeOrAbsolute;
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
    if (hit) {
      setResolveSpecifierCacheEntry(cacheKey, hit);
      return hit;
    }
    if (opts?.allowScssPartialResolution && path.extname(fromFile).toLowerCase() === ".scss") {
      const partialHit = await acceptFirstPartyFile(projectRoot, await findFirstExistingScssPartialCandidate(base));
      if (partialHit) {
        setResolveSpecifierCacheEntry(cacheKey, partialHit);
        return partialHit;
      }
    }
    if (isRelativeOrAbsolute) {
      const ext = { external: spec } as const;
      setResolveSpecifierCacheEntry(cacheKey, ext);
      return ext;
    }
  }
  // Bare specifier: prefer TS path mappings (tsconfig `paths`) before workspace/node_modules.
  if (matchPath) {
    const m = matchPath(
      spec,
      undefined,
      (candidate: string) => {
        return isFilePathWithinRoot(projectRoot, candidate) && fileExistsSync(candidate);
      },
      resolutionExtensions,
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, cand);
        if (mappedFile) {
          setResolveSpecifierCacheEntry(cacheKey, mappedFile);
          return mappedFile;
        }
      }
      for (const e of resolutionExtensions) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, cand + e);
        if (mappedFile) {
          setResolveSpecifierCacheEntry(cacheKey, mappedFile);
          return mappedFile;
        }
      }
      for (const e of resolutionExtensions) {
        const mappedFile = await acceptFirstPartyFile(projectRoot, path.join(cand, "index" + e));
        if (mappedFile) {
          setResolveSpecifierCacheEntry(cacheKey, mappedFile);
          return mappedFile;
        }
      }
    }
  }

  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await acceptFirstPartyFile(
      projectRoot,
      await resolveWorkspacePackage(spec, workspaceConfig, opts?.resolutionExtensions, exportCondition),
    );
    if (resolvedWs) {
      setResolveSpecifierCacheEntry(cacheKey, resolvedWs);
      return resolvedWs;
    }
    const fromExt = path.extname(fromFile).toLowerCase();
    const prefersPathLikeFallback = [".go", ".java", ".cs", ".rb", ".rs", ".swift"].includes(fromExt);
    if (prefersPathLikeFallback) {
      // These languages use package-like specifiers for first-party source paths.
      const pathLike = await resolvePathLikeModule(projectRoot, spec, opts?.resolutionExtensions);
      if (pathLike) {
        setResolveSpecifierCacheEntry(cacheKey, pathLike);
        return pathLike;
      }
    }
    if (opts?.resolveNodeModules) {
      const nm = await acceptFirstPartyFile(
        projectRoot,
        await resolveFromNodeModules(spec, fromFile, projectRoot, opts?.resolutionExtensions, exportCondition),
      );
      if (nm) {
        setResolveSpecifierCacheEntry(cacheKey, nm);
        return nm;
      }
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
      if (hit) {
        setResolveSpecifierCacheEntry(cacheKey, hit);
        return hit;
      }
    }
  }
  const ext = { external: spec } as const;
  setResolveSpecifierCacheEntry(cacheKey, ext);
  return ext;
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
