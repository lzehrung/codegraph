import fs, { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { currentProbeCache, probeKind, type FsProbeCache } from "../fs-probe-cache.js";
import { confineResolvedPath, isFilePathWithinRoot, normalizePath } from "../paths.js";
import { fileExists } from "../workspace.js";
import { PYTHON_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";

type FileId = string;

const resolvePythonModuleCache = new Map<string, FileId | { external: string }>();

const LISTED_FILE = 1;
const LISTED_DIRECTORY = 2;

/**
 * What one index build reads while it resolves Python imports, kept as long as the build's probe cache snapshot (a
 * reset drops it, and the next build reads its own). Each answer is what the replaced `statSync`, `readdirSync`, or
 * computation gives for the same inputs and spelling; outside a build every call reads the file system.
 */
type PythonBuildProbes = {
  readonly id: number;
  /** `statSync(path).isDirectory()`, or `null` where `statSync` throws. */
  readonly directories: Map<string, boolean | null>;
  /** The `LISTED_*` kinds `readdirSync` reports under each entry name, or `null` where the listing throws. */
  readonly listings: Map<string, ReadonlyMap<string, number> | null>;
  /** The module path a candidate names (a file or a namespace package directory), by root and candidate. */
  readonly candidates: Map<string, Promise<string | null>>;
  /** The nearest manifest root, by root and importer directory. */
  readonly packageRoots: Map<string, Promise<string>>;
  /** The topmost directory with `__init__.py` up to the manifest root, by importer directory and manifest root. */
  readonly anchors: Map<string, Promise<string>>;
  /** Module resolutions, by root, importer directory, and specifier. */
  readonly modules: Map<string, Promise<FileId | { external: string }>>;
};

const pythonBuildProbes = new WeakMap<FsProbeCache, PythonBuildProbes>();

function currentPythonBuildProbes(): PythonBuildProbes | undefined {
  const probes = currentProbeCache();
  if (!probes) return undefined;
  let state = pythonBuildProbes.get(probes);
  if (state?.id !== probes.id) {
    state = {
      id: probes.id,
      directories: new Map(),
      listings: new Map(),
      candidates: new Map(),
      packageRoots: new Map(),
      anchors: new Map(),
      modules: new Map(),
    };
    pythonBuildProbes.set(probes, state);
  }
  return state;
}

/** What `compute` gives for `key`, computed once per build; outside a build (no `memo`) every call computes. */
function rememberInBuild<T>(
  memo: Map<string, Promise<T>> | undefined,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  if (!memo) return compute();
  let result = memo.get(key);
  if (!result) {
    result = compute();
    memo.set(key, result);
  }
  return result;
}

/** `statSync(target).isDirectory()`, or `null` where `statSync` throws. */
function statIsDirectory(target: string, probes: PythonBuildProbes | undefined): boolean | null {
  const remembered = probes?.directories.get(target);
  if (remembered !== undefined) return remembered;
  let isDirectory: boolean | null;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    isDirectory = null;
  }
  probes?.directories.set(target, isDirectory);
  return isDirectory;
}

/** What `readdirSync` reports under each entry name, without following links, or `null` where it throws. */
function listedKinds(directory: string, probes: PythonBuildProbes | undefined): ReadonlyMap<string, number> | null {
  const remembered = probes?.listings.get(directory);
  if (remembered !== undefined) return remembered;
  let kinds: Map<string, number> | null = new Map();
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const kind = (entry.isFile() ? LISTED_FILE : 0) | (entry.isDirectory() ? LISTED_DIRECTORY : 0);
      if (kind) kinds.set(entry.name, (kinds.get(entry.name) ?? 0) | kind);
    }
  } catch {
    kinds = null;
  }
  probes?.listings.set(directory, kinds);
  return kinds;
}

function isListedAs(kinds: ReadonlyMap<string, number>, name: string, kind: number): boolean {
  return !!((kinds.get(name) ?? 0) & kind);
}

function pythonResolutionCacheKey(
  projectRoot: string,
  fromFile: string,
  moduleName: string | null,
  importDotCount: number,
): string {
  const normalizedRoot = normalizePath(path.resolve(projectRoot));
  const normalizedFromFile = normalizePath(path.resolve(fromFile));
  return `${normalizedRoot}::${normalizedFromFile}::${".".repeat(importDotCount)}${moduleName ?? ""}`;
}

async function findPythonPackageAnchor(startDir: string, stopDir: string): Promise<string> {
  let dir = startDir;
  let topWithInit = startDir;
  const stop = path.resolve(stopDir);
  while (true) {
    if (await fileExists(path.join(dir, "__init__.py"))) {
      topWithInit = dir;
    }
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topWithInit;
}

function isPythonSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".py") || lower.endsWith(".pyi");
}

async function directoryContainsImportablePython(dirPath: string, seen: Set<string>): Promise<boolean> {
  const key = path.resolve(dirPath);
  if (seen.has(key)) return false;
  seen.add(key);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      if (isPythonSourceFileName(entry.name)) return true;
      continue;
    }
    if (entry.isDirectory()) {
      subdirs.push(full);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        if (isPythonSourceFileName(entry.name)) return true;
      } else if (st.isDirectory()) {
        subdirs.push(full);
      }
    } catch {
      // Dangling symlink: not an importable member.
    }
  }
  for (const sub of subdirs) {
    if (await directoryContainsImportablePython(sub, seen)) return true;
  }
  return false;
}

async function isPythonDirectoryModule(dirPath: string): Promise<boolean> {
  return directoryContainsImportablePython(dirPath, new Set());
}

/**
 * A candidate outside the root fails without a probe, as in `confineResolvedPath`. A missing one fails on its kind,
 * before the physical confinement check reads real paths.
 */
async function acceptPythonModule(projectRoot: string, candidate: string): Promise<string | null> {
  if (!isFilePathWithinRoot(projectRoot, path.resolve(candidate))) return null;
  const kind = await probeKind(candidate);
  if (kind !== "file" && kind !== "directory") return null;
  const confined = await confineResolvedPath(projectRoot, candidate);
  if (!confined) return null;
  if (kind === "file") return normalizePath(confined);
  return (await isPythonDirectoryModule(confined)) ? normalizePath(confined) : null;
}

/** The first candidate that names a module, each checked once per build. */
async function firstPythonModule(
  projectRoot: string,
  candidates: readonly string[],
  probes: PythonBuildProbes | undefined,
): Promise<string | null> {
  for (const candidate of candidates) {
    const accepted = await rememberInBuild(probes?.candidates, `${projectRoot}\0${candidate}`, () =>
      acceptPythonModule(projectRoot, candidate),
    );
    if (accepted) return accepted;
  }
  return null;
}

function pythonFileCandidates(basePath: string): string[] {
  return [
    basePath + ".py",
    basePath + ".pyi",
    path.join(basePath, "__init__.py"),
    path.join(basePath, "__init__.pyi"),
    basePath,
  ];
}

export async function resolvePythonModule(
  projectRoot: string,
  fromFile: string,
  moduleName: string | null,
  importDotCount: number,
): Promise<FileId | { external: string }> {
  const cacheKey = pythonResolutionCacheKey(projectRoot, fromFile, moduleName, importDotCount);
  const cached = resolvePythonModuleCache.get(cacheKey);
  if (cached) return cached;
  const probes = currentPythonBuildProbes();
  // The importer reaches a resolution only through these two spellings of its directory, so a build shares each one
  // between the files of a directory.
  const resolvedDirectory = fromFile ? path.dirname(path.resolve(fromFile)) : "";
  const resolved = await rememberInBuild(
    probes?.modules,
    `${projectRoot}\0${path.dirname(fromFile)}\0${resolvedDirectory}\0${importDotCount}\0${moduleName ?? ""}`,
    () =>
      resolvePythonModuleFromDirectory(projectRoot, fromFile, resolvedDirectory, moduleName, importDotCount, probes),
  );
  resolvePythonModuleCache.set(cacheKey, resolved);
  return resolved;
}

async function resolvePythonModuleFromDirectory(
  projectRoot: string,
  fromFile: string,
  resolvedDirectory: string,
  moduleName: string | null,
  importDotCount: number,
  probes: PythonBuildProbes | undefined,
): Promise<FileId | { external: string }> {
  const fromDir = path.dirname(fromFile);
  const packageRoot = await rememberInBuild(probes?.packageRoots, `${projectRoot}\0${resolvedDirectory}`, () =>
    resolveNearestManifestRoot(projectRoot, fromFile, PYTHON_PACKAGE_MANIFEST_NAMES),
  );

  let startDir = fromDir;
  if (importDotCount > 0) {
    const stepsUp = Math.max(0, importDotCount - 1);
    for (let i = 0; i < stepsUp; i++) {
      startDir = path.dirname(startDir);
    }
  } else {
    startDir = packageRoot;
  }

  const parts = (moduleName ? moduleName.split(".") : []).filter(Boolean);
  const relPath = parts.length ? path.join(...parts) : "";

  const candidates: string[] = [];
  if (relPath) {
    candidates.push(...pythonFileCandidates(path.join(startDir, relPath)));
  } else if (importDotCount > 0) {
    candidates.push(path.join(startDir, "__init__.py"));
    candidates.push(path.join(startDir, "__init__.pyi"));
    candidates.push(startDir);
  }

  const accepted = await firstPythonModule(projectRoot, candidates, probes);
  if (accepted) return accepted;

  if (importDotCount === 0 && moduleName) {
    let anchor: string;
    try {
      anchor = await rememberInBuild(probes?.anchors, `${fromDir}\0${packageRoot}`, () =>
        findPythonPackageAnchor(fromDir, packageRoot),
      );
    } catch {
      anchor = packageRoot;
    }

    const moduleParts = moduleName.split(".");
    const parentPath = path.join(path.dirname(anchor), ...moduleParts);
    const anchorPath = path.join(anchor, ...moduleParts);
    const anchorCandidates = [...pythonFileCandidates(parentPath), ...pythonFileCandidates(anchorPath)];
    const anchored = await firstPythonModule(projectRoot, anchorCandidates, probes);
    if (anchored) return anchored;
  }

  return {
    external: ".".repeat(importDotCount) + (moduleName ?? ""),
  } as const;
}

export function clearPythonResolutionCache(): void {
  resolvePythonModuleCache.clear();
}

/**
 * The submodule `from pkg import name` binds when `pkg` has no attribute `name`: `name.py`,
 * `name.pyi`, `name/__init__.py`, `name/__init__.pyi`, then a PEP 420 directory `name/`.
 * Python compares entries case-sensitively even on case-insensitive filesystems, so `Widget`
 * never names `widget.py`; the import stays a named binding of the package attribute.
 */
export function resolvePythonSubmoduleExact(
  resolved: string | { external: string },
  imported: string,
): string | undefined {
  if (typeof resolved !== "string") return undefined;
  const probes = currentPythonBuildProbes();
  const isDirectory = statIsDirectory(resolved, probes);
  if (isDirectory === null) return undefined;
  let baseDir = resolved;
  if (!isDirectory) {
    const base = path.basename(resolved);
    if (base !== "__init__.py" && base !== "__init__.pyi") return undefined;
    baseDir = path.dirname(resolved);
  }
  const entries = listedKinds(baseDir, probes);
  if (!entries) return undefined;
  for (const fileName of [`${imported}.py`, `${imported}.pyi`]) {
    if (isListedAs(entries, fileName, LISTED_FILE)) return path.join(baseDir, fileName).replace(/\\/g, "/");
  }
  if (!isListedAs(entries, imported, LISTED_DIRECTORY)) return undefined;
  const packageDir = path.join(baseDir, imported);
  const packageEntries = listedKinds(packageDir, probes);
  if (!packageEntries) return undefined;
  for (const initializer of ["__init__.py", "__init__.pyi"]) {
    if (isListedAs(packageEntries, initializer, LISTED_FILE)) {
      return path.join(packageDir, initializer).replace(/\\/g, "/");
    }
  }
  return packageDir.replace(/\\/g, "/");
}
