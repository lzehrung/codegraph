import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { confineResolvedPath, normalizePath } from "../paths.js";
import { PYTHON_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";

type FileId = string;

const resolvePythonModuleCache = new Map<string, FileId | { external: string }>();

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
    try {
      await fsp.access(path.join(dir, "__init__.py"), fs.constants.R_OK);
      topWithInit = dir;
    } catch {
      /* no __init__.py: continue */
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
  let entries: fs.Dirent[];
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

async function acceptPythonModule(projectRoot: string, candidate: string): Promise<string | null> {
  const confined = await confineResolvedPath(projectRoot, candidate);
  if (!confined) return null;
  try {
    const st = await fsp.stat(confined);
    if (st.isFile()) return normalizePath(confined);
    if (st.isDirectory() && (await isPythonDirectoryModule(confined))) {
      return normalizePath(confined);
    }
  } catch {
    return null;
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
  const fromDir = path.dirname(fromFile);
  const packageRoot = await resolveNearestManifestRoot(projectRoot, fromFile, PYTHON_PACKAGE_MANIFEST_NAMES);

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

  for (const c of candidates) {
    const accepted = await acceptPythonModule(projectRoot, c);
    if (accepted) {
      resolvePythonModuleCache.set(cacheKey, accepted);
      return accepted;
    }
  }

  if (importDotCount === 0 && moduleName) {
    let anchor: string;
    try {
      anchor = await findPythonPackageAnchor(fromDir, packageRoot);
    } catch {
      anchor = packageRoot;
    }

    const moduleParts = moduleName.split(".");
    const parentPath = path.join(path.dirname(anchor), ...moduleParts);
    const anchorPath = path.join(anchor, ...moduleParts);
    const anchorCandidates = [...pythonFileCandidates(parentPath), ...pythonFileCandidates(anchorPath)];
    for (const c of anchorCandidates) {
      const accepted = await acceptPythonModule(projectRoot, c);
      if (accepted) {
        resolvePythonModuleCache.set(cacheKey, accepted);
        return accepted;
      }
    }
  }

  const ext = {
    external: ".".repeat(importDotCount) + (moduleName ?? ""),
  } as const;
  resolvePythonModuleCache.set(cacheKey, ext);
  return ext;
}

export function clearPythonResolutionCache(): void {
  resolvePythonModuleCache.clear();
}
