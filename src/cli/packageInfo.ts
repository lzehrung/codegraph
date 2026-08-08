import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath } from "../util/paths.js";

export function normalizePathForDisplay(filePath: string): string {
  return normalizePath(filePath);
}

export function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function findPackageRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (pathExists(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate package root from current CLI path.");
    }
    current = parent;
  }
}

export type CodegraphPackageIdentity = {
  name: string;
  version: string;
  packageRoot: string;
};

export function getCodegraphPackageRoot(): string {
  return findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
}

export function getCodegraphVersion(): string {
  const packageRoot = getCodegraphPackageRoot();
  const packageJsonPath = path.join(packageRoot, "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  if (!parsed.version) {
    throw new Error("Unable to determine codegraph package version.");
  }
  return parsed.version;
}

export function getCodegraphPackageIdentity(): CodegraphPackageIdentity {
  const packageRoot = getCodegraphPackageRoot();
  const packageJsonPath = path.join(packageRoot, "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { name?: string; version?: string };
  if (!parsed.name || !parsed.version) {
    throw new Error("Unable to determine codegraph package identity.");
  }
  return {
    name: parsed.name,
    version: parsed.version,
    packageRoot: normalizePathForDisplay(packageRoot),
  };
}
