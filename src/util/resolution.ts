import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizePath, normalizeResolutionHints } from "./paths.js";
import { DEFAULT_RESOLUTION_EXTENSIONS, listResolutionCandidates } from "./resolutionCandidates.js";
import {
  clearWorkspaceCaches,
  clearFileExistsCache,
  fileExists,
  loadWorkspaceConfig,
  resolveWorkspacePackage,
  type WorkspaceConfig,
} from "./workspace.js";
import { clearJvmResolutionCaches, resolveJavaImportPath, resolveKotlinImportPath } from "./resolution/jvm.js";
import { resolveGoImportPath } from "./resolution/go.js";
import { resolveFromNodeModules } from "./resolution/node.js";
import { clearPhpResolutionCaches, getPhpComposerImplicitFiles, resolvePhpImportPath } from "./resolution/php.js";
import { clearPythonResolutionCache, resolvePythonModule } from "./resolution/python.js";
import { clearTsconfigCache, loadNearestTsconfigFor, type MatchPathFn } from "./resolution/tsconfig.js";
export { resolveGoImportPath } from "./resolution/go.js";
export { resolveJvmPackageImportPaths } from "./resolution/jvm.js";
export { getPhpComposerImplicitFiles } from "./resolution/php.js";
export { resolvePythonModule } from "./resolution/python.js";
export { loadNearestTsconfigFor, type MatchPathFn } from "./resolution/tsconfig.js";
export { listResolutionCandidates } from "./resolutionCandidates.js";

const resolveSpecifierCache = new Map<string, FileId | { external: string }>();
export type FileId = string;

export const GRAPH_ONLY_RESOLUTION_EXTENSIONS = [
  ".md",
  ".mdx",
  ".astro",
  ".hbs",
  ".handlebars",
  ".rst",
  ".adoc",
  ".asciidoc",
] as const;

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
  astro: [".astro", ...DEFAULT_RESOLUTION_EXTENSIONS],
};

function getResolutionExtensions(resolutionExtensions?: readonly string[]): string[] {
  const extensions = resolutionExtensions === undefined ? DEFAULT_RESOLUTION_EXTENSIONS : resolutionExtensions;
  return Array.from(new Set(extensions));
}

function fileExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function getGraphOnlyResolutionExtensions(
  languageId: string,
  resolutionKind: "document" | "source" = "document",
): string[] {
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

async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of listResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
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
      if (await fileExists(p + e)) return path.resolve(p + e);
    }
    for (const e of exts) {
      if (await fileExists(path.join(p, "index" + e))) return path.resolve(path.join(p, "index" + e));
    }
    if (await fileExists(p)) {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) return path.resolve(p);
    }
  }
  return null;
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
  },
): Promise<FileId | { external: string }> {
  if (languageId === "go") {
    const goResolved = await resolveGoImportPath(projectRoot, fromFile, spec);
    if (goResolved) return goResolved;
  }
  if (languageId === "kotlin") {
    const kotlinResolved = await resolveKotlinImportPath(projectRoot, spec);
    if (kotlinResolved) return kotlinResolved;
  }
  if (languageId === "java") {
    const javaResolved = await resolveJavaImportPath(projectRoot, spec);
    if (javaResolved) return javaResolved;
  }
  if (languageId === "php") {
    const phpResolved = await resolvePhpImportPath(projectRoot, fromFile, spec, opts?.phpImportType);
    if (phpResolved) return phpResolved;
  }

  return resolveSpecifier(fromFile, spec, projectRoot, opts?.matchPath, opts?.workspaceConfig, {
    resolveNodeModules: !!opts?.resolveNodeModules,
    ...(opts?.resolutionHints ? { resolutionHints: opts.resolutionHints } : {}),
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
    allowScssPartialResolution?: boolean;
  },
): Promise<FileId | { external: string }> {
  const resolutionHints = normalizeResolutionHints(opts?.resolutionHints);
  const hintKey = resolutionHints.join("|");
  const resolutionExtensions = getResolutionExtensions(opts?.resolutionExtensions);
  const extensionKey = resolutionExtensions.join("|");
  const workspaceKey = workspaceConfig ? normalizePath(workspaceConfig.rootDir) : "";
  const cacheKey = [
    normalizePath(projectRoot),
    fromFile,
    spec,
    `workspace=${workspaceKey}`,
    `nm=${opts?.resolveNodeModules ? 1 : 0}`,
    `scssPartial=${opts?.allowScssPartialResolution ? 1 : 0}`,
    `hints=${hintKey}`,
    `exts=${extensionKey}`,
  ].join("::");
  const cached = resolveSpecifierCache.get(cacheKey);
  if (cached) return cached;
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(spec);
  if (!isWindowsAbsolutePath && (hasSchemePrefix || spec.startsWith("//"))) {
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext);
    return ext;
  }

  const isRelativeOrAbsolute = spec.startsWith(".") || spec.startsWith("/") || isWindowsAbsolutePath;
  if (isRelativeOrAbsolute) {
    let base = path.resolve(path.dirname(fromFile), spec);
    if (isWindowsAbsolutePath) {
      base = spec;
    } else if (spec.startsWith("/")) {
      base = path.join(projectRoot, spec);
    }
    const hit = await findFirstExistingResolutionCandidate(base, resolutionExtensions);
    if (hit) {
      resolveSpecifierCache.set(cacheKey, hit);
      return hit;
    }
    if (opts?.allowScssPartialResolution && path.extname(fromFile).toLowerCase() === ".scss") {
      const partialHit = await findFirstExistingScssPartialCandidate(base);
      if (partialHit) {
        resolveSpecifierCache.set(cacheKey, partialHit);
        return partialHit;
      }
    }
    const ext = { external: spec } as const;
    resolveSpecifierCache.set(cacheKey, ext);
    return ext;
  }
  // Bare specifier: prefer TS path mappings (tsconfig `paths`) before workspace/node_modules.
  if (matchPath) {
    const m = matchPath(
      spec,
      undefined,
      (candidate: string) => {
        return fileExistsSync(candidate);
      },
      resolutionExtensions,
    );
    if (m) {
      const cand = path.resolve(m);
      const hasExt = !!path.extname(cand);
      if (hasExt && fileExistsSync(cand)) {
        resolveSpecifierCache.set(cacheKey, cand);
        return cand;
      }
      for (const e of resolutionExtensions) {
        const pth = cand + e;
        if (fileExistsSync(pth)) {
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        }
      }
      for (const e of resolutionExtensions) {
        const pth = path.join(cand, "index" + e);
        if (fileExistsSync(pth)) {
          resolveSpecifierCache.set(cacheKey, pth);
          return pth;
        }
      }
    }
  }

  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const resolvedWs = await resolveWorkspacePackage(spec, workspaceConfig, opts?.resolutionExtensions);
    if (resolvedWs) {
      resolveSpecifierCache.set(cacheKey, resolvedWs);
      return resolvedWs;
    }
    const fromExt = path.extname(fromFile).toLowerCase();
    const prefersPathLikeFallback = [".go", ".java", ".cs", ".rb", ".rs", ".swift"].includes(fromExt);
    const shouldTryPathLikeFallback = prefersPathLikeFallback || spec.includes("/") || spec.includes(".");
    if (shouldTryPathLikeFallback) {
      // Try path-like fallback for languages that often map package-like names to source paths.
      const pathLike = await resolvePathLikeModule(projectRoot, spec, opts?.resolutionExtensions);
      if (pathLike) {
        resolveSpecifierCache.set(cacheKey, pathLike);
        return pathLike;
      }
    }
    if (opts?.resolveNodeModules) {
      const nm = await resolveFromNodeModules(spec, fromFile, projectRoot, opts?.resolutionExtensions);
      if (nm) {
        resolveSpecifierCache.set(cacheKey, nm);
        return nm;
      }
    }
  }
  if (resolutionHints.length) {
    for (const hint of resolutionHints) {
      const baseDir = path.isAbsolute(hint) ? hint : path.resolve(projectRoot, hint);
      const base = path.resolve(baseDir, spec);
      const hit = await findFirstExistingResolutionCandidate(base, resolutionExtensions);
      if (hit) {
        resolveSpecifierCache.set(cacheKey, hit);
        return hit;
      }
    }
  }
  const ext = { external: spec } as const;
  resolveSpecifierCache.set(cacheKey, ext);
  return ext;
}

export function clearImportResolutionCaches(): void {
  resolveSpecifierCache.clear();
  clearPythonResolutionCache();
  clearFileExistsCache();
  clearJvmResolutionCaches();
  clearPhpResolutionCaches();
}

export function clearResolutionCaches(): void {
  clearImportResolutionCaches();
  clearTsconfigCache();
  clearWorkspaceCaches();
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let activeCount = 0;
  let resolveAll: (() => void) | null = null;
  let rejectAll: ((err: unknown) => void) | null = null;
  let aborted = false;

  const startNext = (): void => {
    if (aborted) return;
    while (activeCount < safeLimit && nextIndex < items.length) {
      if (aborted) return;
      const index = nextIndex++;
      const item = items[index]!;
      activeCount++;

      fn(item)
        .then((result) => {
          if (aborted) return;
          results[index] = result;
          activeCount--;
          if (nextIndex < items.length) {
            startNext();
          } else if (activeCount === 0 && resolveAll) {
            resolveAll();
          }
        })
        .catch((err) => {
          if (aborted) return;
          aborted = true;
          activeCount--;
          if (rejectAll) rejectAll(err);
        });
    }
  };

  return new Promise<R[]>((resolve, reject) => {
    resolveAll = () => resolve(results);
    rejectAll = reject;
    startNext();
    if (!aborted && nextIndex >= items.length && activeCount === 0) {
      resolve(results);
    }
  });
}
