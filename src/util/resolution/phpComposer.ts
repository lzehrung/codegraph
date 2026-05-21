import fsp from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { listProjectFiles } from "../projectFiles.js";
import { listResolutionCandidates } from "../resolutionCandidates.js";
import { fileExists } from "../workspace.js";
import { findNearestFile } from "./files.js";

export type PhpComposerConfig = {
  psr4: Map<string, string[]>;
  psr0: Map<string, string[]>;
  classmap: string[];
  excludeFromClassmap: string[];
  files: string[];
};

const phpComposerConfigCache = new Map<string, Promise<PhpComposerConfig | null>>();
const phpComposerAutoloadFileCache = new Map<string, Promise<Set<string>>>();

type PhpComposerAutoloadRoot = {
  path: string;
  applyClassmapExcludes: boolean;
};

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

function readComposerNamespaceDirs(value: unknown, composerDir: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!value || typeof value !== "object") {
    return result;
  }
  for (const [prefix, rawTarget] of Object.entries(value as Record<string, unknown>)) {
    const targets = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
    const dirs = targets
      .filter((target): target is string => typeof target === "string")
      .map((target) => resolveComposerPath(target, composerDir));
    if (dirs.length) {
      result.set(prefix, dirs);
    }
  }
  return result;
}

function mergeComposerNamespaceDirMaps(...maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [prefix, dirs] of map) {
      const currentDirs = merged.get(prefix) ?? [];
      const dedupedDirs = Array.from(new Set([...currentDirs, ...dirs]));
      merged.set(prefix, dedupedDirs);
    }
  }
  return merged;
}

function resolveComposerPath(entry: string, composerDir: string): string {
  if (entry.startsWith("/") || entry.startsWith("\\")) {
    return path.resolve(composerDir, `.${entry}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(entry) || path.isAbsolute(entry)) {
    return path.resolve(entry);
  }
  return path.resolve(composerDir, entry);
}

function readComposerStringList(value: unknown, composerDir: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolveComposerPath(entry, composerDir));
}

export async function loadPhpComposerConfig(composerPath: string): Promise<PhpComposerConfig | null> {
  const cached = phpComposerConfigCache.get(composerPath);
  if (cached) return await cached;

  const pending = (async () => {
    try {
      const raw = await fsp.readFile(composerPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const composerDir = path.dirname(composerPath);
      const autoload =
        parsed.autoload && typeof parsed.autoload === "object" ? (parsed.autoload as Record<string, unknown>) : {};
      const autoloadDev =
        parsed["autoload-dev"] && typeof parsed["autoload-dev"] === "object"
          ? (parsed["autoload-dev"] as Record<string, unknown>)
          : {};

      const psr4 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-4"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-4"], composerDir),
      );
      const psr0 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-0"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-0"], composerDir),
      );
      const classmap = [
        ...readComposerStringList(autoload["classmap"], composerDir),
        ...readComposerStringList(autoloadDev["classmap"], composerDir),
      ];
      const excludeFromClassmap = [
        ...readComposerStringList(autoload["exclude-from-classmap"], composerDir),
        ...readComposerStringList(autoloadDev["exclude-from-classmap"], composerDir),
      ];
      const files = [
        ...readComposerStringList(autoload["files"], composerDir),
        ...readComposerStringList(autoloadDev["files"], composerDir),
      ];

      return { psr4, psr0, classmap, excludeFromClassmap, files };
    } catch {
      return null;
    }
  })();

  phpComposerConfigCache.set(composerPath, pending);
  return await pending;
}

function sortPhpComposerMappings(mappings: Map<string, string[]>): Array<[string, string[]]> {
  return Array.from(mappings.entries()).sort((left, right) => right[0].length - left[0].length);
}

export async function resolvePhpPsr4MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    if (!normalizedSpec.startsWith(prefix)) continue;
    const suffix = normalizedSpec.slice(prefix.length).replace(/\\/g, "/");
    for (const dir of dirs) {
      const basePath = suffix ? path.join(dir, suffix) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

function buildPhpPsr0RelativePath(spec: string, prefix: string): string | null {
  if (!spec.startsWith(prefix)) return null;
  const suffix = spec.slice(prefix.length);
  const namespaceParts = suffix.split("\\");
  const classPart = namespaceParts.pop() ?? "";
  const namespacePath = namespaceParts.filter(Boolean).join("/");
  const classPath = classPart.replace(/_/g, "/");
  return [namespacePath, classPath].filter(Boolean).join("/");
}

export async function resolvePhpPsr0MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    const relativePath = buildPhpPsr0RelativePath(normalizedSpec, prefix);
    if (relativePath === null) continue;
    for (const dir of dirs) {
      const basePath = relativePath ? path.join(dir, relativePath) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

export async function findPhpComposerPath(projectRoot: string, fromFile: string): Promise<string | null> {
  return (
    (await findNearestFile(path.dirname(fromFile), projectRoot, "composer.json")) ??
    ((await fileExists(path.join(projectRoot, "composer.json"))) ? path.join(projectRoot, "composer.json") : null)
  );
}

export async function getPhpComposerImplicitFiles(projectRoot: string, fromFile: string): Promise<string[]> {
  const composerPath = await findPhpComposerPath(projectRoot, fromFile);
  if (!composerPath) {
    return [];
  }

  const composerConfig = await loadPhpComposerConfig(composerPath);
  if (!composerConfig) {
    return [];
  }

  const deduped = new Set<string>();
  for (const filePath of composerConfig.files) {
    if (!(await fileExists(filePath))) continue;
    deduped.add(path.resolve(filePath));
  }
  return Array.from(deduped);
}

export async function getPhpComposerAutoloadFiles(
  composerPath: string,
  composerConfig: PhpComposerConfig,
): Promise<Set<string>> {
  const cached = phpComposerAutoloadFileCache.get(composerPath);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    const candidates = new Set<string>();
    const roots: PhpComposerAutoloadRoot[] = [];
    const seenRoots = new Set<string>();
    const addRoot = (rootPath: string, applyClassmapExcludes: boolean): void => {
      const resolvedRoot = path.resolve(rootPath);
      const cacheKey = `${resolvedRoot}\0${applyClassmapExcludes ? "classmap" : "autoload"}`;
      if (seenRoots.has(cacheKey)) return;
      seenRoots.add(cacheKey);
      roots.push({ path: resolvedRoot, applyClassmapExcludes });
    };

    for (const root of composerConfig.classmap) {
      addRoot(root, true);
    }
    for (const root of composerConfig.files) {
      addRoot(root, false);
    }
    for (const root of Array.from(composerConfig.psr4.values()).flat()) {
      addRoot(root, true);
    }
    for (const root of Array.from(composerConfig.psr0.values()).flat()) {
      addRoot(root, true);
    }

    for (const root of roots) {
      try {
        const stat = await fsp.stat(root.path);
        if (stat.isDirectory()) {
          const files = await listProjectFiles(root.path, ["**/*.php"]);
          for (const filePath of files) {
            if (root.applyClassmapExcludes && isPhpComposerClassmapExcluded(filePath, composerConfig)) {
              continue;
            }
            candidates.add(path.resolve(filePath));
          }
          continue;
        }
        if (stat.isFile() && root.path.toLowerCase().endsWith(".php")) {
          if (root.applyClassmapExcludes && isPhpComposerClassmapExcluded(root.path, composerConfig)) continue;
          candidates.add(path.resolve(root.path));
        }
      } catch {
        // Ignore missing Composer autoload roots.
      }
    }

    return candidates;
  })();

  phpComposerAutoloadFileCache.set(composerPath, pending);
  return await pending;
}

export function isPhpComposerClassmapExcluded(filePath: string, composerConfig: PhpComposerConfig): boolean {
  const normalizedFile = normalizePath(path.resolve(filePath));
  return composerConfig.excludeFromClassmap.some((entry) => {
    const normalizedEntry = normalizePath(path.resolve(entry)).replace(/\/+$/, "");
    return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
  });
}

export function clearPhpComposerResolutionCaches(): void {
  phpComposerConfigCache.clear();
  phpComposerAutoloadFileCache.clear();
}
