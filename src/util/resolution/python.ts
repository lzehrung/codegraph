import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../paths.js";
import { isDirectory } from "./files.js";

type FileId = string;

const resolvePythonModuleCache = new Map<string, FileId | { external: string }>();

function pythonResolutionCacheKey(projectRoot: string, fromFile: string, moduleName: string | null, importDotCount: number): string {
  const normalizedRoot = normalizePath(path.resolve(projectRoot));
  const normalizedFromFile = normalizePath(path.resolve(fromFile));
  return `${normalizedRoot}::${normalizedFromFile}::${".".repeat(importDotCount)}${moduleName ?? ""}`;
}

async function findPythonPackageAnchor(startDir: string): Promise<string> {
  let dir = startDir;
  let topWithInit = startDir;
  while (true) {
    try {
      await fsp.access(path.join(dir, "__init__.py"), fs.constants.R_OK);
      topWithInit = dir;
    } catch {
      /* no __init__.py: continue */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topWithInit;
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

  let startDir = fromDir;
  if (importDotCount > 0) {
    const stepsUp = Math.max(0, importDotCount - 1);
    for (let i = 0; i < stepsUp; i++) {
      startDir = path.dirname(startDir);
    }
  } else {
    startDir = projectRoot;
  }

  const parts = (moduleName ? moduleName.split(".") : []).filter(Boolean);
  const relPath = parts.length ? path.join(...parts) : "";

  const candidates: string[] = [];
  if (relPath) {
    candidates.push(path.join(startDir, relPath + ".py"));
    candidates.push(path.join(startDir, relPath, "__init__.py"));
    candidates.push(path.join(startDir, relPath));
  } else if (importDotCount > 0) {
    candidates.push(path.join(startDir, "__init__.py"));
  }

  for (const c of candidates) {
    try {
      if (await isDirectory(c)) {
        const res = normalizePath(path.resolve(c));
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
      await fsp.access(c, fs.constants.R_OK);
      {
        const res = normalizePath(path.resolve(c));
        resolvePythonModuleCache.set(cacheKey, res);
        return res;
      }
    } catch {
      /* access failed: try next */
    }
  }

  if (importDotCount === 0 && moduleName) {
    let anchor: string;
    try {
      anchor = await findPythonPackageAnchor(fromDir);
    } catch {
      anchor = projectRoot;
    }

    const parts = moduleName.split(".");
    const parentPath = path.join(path.dirname(anchor), ...parts);
    const anchorPath = path.join(anchor, ...parts);

    const anchorCandidates = [
      parentPath + ".py",
      path.join(parentPath, "__init__.py"),
      parentPath,
      anchorPath + ".py",
      path.join(anchorPath, "__init__.py"),
      anchorPath,
    ];
    for (const c of anchorCandidates) {
      try {
        if (await isDirectory(c)) {
          const res = normalizePath(path.resolve(c));
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
        await fsp.access(c, fs.constants.R_OK);
        {
          const res = normalizePath(path.resolve(c));
          resolvePythonModuleCache.set(cacheKey, res);
          return res;
        }
      } catch {
        /* access failed: try next */
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
