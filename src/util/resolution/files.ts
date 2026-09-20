import fsp from "node:fs/promises";
import path from "node:path";
import { fileIdentityKey, isFilePathWithinRoot } from "../paths.js";
import { fileExists } from "../workspace.js";

export const JVM_PACKAGE_MANIFEST_NAMES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
] as const;

export const CSHARP_PACKAGE_MANIFEST_NAMES = ["*.csproj"] as const;

export const PHP_PACKAGE_MANIFEST_NAMES = ["composer.json"] as const;

export const PYTHON_PACKAGE_MANIFEST_NAMES = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"] as const;

function isExtensionManifestPattern(name: string): boolean {
  return name.startsWith("*.") && !name.includes("/") && !name.includes("\\");
}

export async function findNearestFile(startDir: string, stopDir: string, fileName: string): Promise<string | null> {
  return await findNearestManifest(startDir, stopDir, [fileName]);
}

export async function findNearestManifest(
  startDir: string,
  stopDir: string,
  names: readonly string[],
): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  const stopKey = fileIdentityKey(stop);
  while (true) {
    for (const name of names) {
      if (isExtensionManifestPattern(name)) {
        const suffix = name.slice(1).toLowerCase();
        try {
          const entries = await fsp.readdir(dir);
          const hit = entries.find((entry) => entry.toLowerCase().endsWith(suffix));
          if (hit) return path.join(dir, hit);
        } catch {
          // Unreadable directory: try the next name, then climb.
        }
        continue;
      }
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
    if (dir === stop || fileIdentityKey(dir) === stopKey) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isFilePathWithinRoot(stop, parent) && fileIdentityKey(parent) !== stopKey) break;
    dir = parent;
  }
  return null;
}

export async function resolveNearestManifestRoot(
  projectRoot: string,
  fromFile: string,
  names: readonly string[],
): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  // Empty or out-of-root importers fall back here, not by omitting `fromFile` at call sites.
  if (!fromFile) return resolvedRoot;
  const startDir = path.dirname(path.resolve(fromFile));
  const startKey = fileIdentityKey(startDir);
  const rootKey = fileIdentityKey(resolvedRoot);
  if (startKey !== rootKey && !isFilePathWithinRoot(resolvedRoot, startDir)) {
    return resolvedRoot;
  }
  const manifest = await findNearestManifest(startDir, resolvedRoot, names);
  if (!manifest) return resolvedRoot;
  return path.dirname(path.resolve(manifest));
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
