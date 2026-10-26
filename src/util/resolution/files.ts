import fs, { type Dirent } from "node:fs";
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

/**
 * A symlink counts as a manifest when `stat` follows it to a regular file.
 * Directories, directory links, and dangling links are not manifests.
 */
async function direntIsManifestFile(entry: Dirent, fullPath: string): Promise<boolean> {
  if (entry.isFile()) return true;
  if (entry.isDirectory()) return false;
  try {
    const st = await fsp.stat(fullPath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function findExtensionManifestInDir(dir: string, suffix: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(suffix)) continue;
    const fullPath = path.join(dir, entry.name);
    if (await direntIsManifestFile(entry, fullPath)) matches.push(entry.name);
  }
  const first = sortManifestMatches(dir, suffix, matches)[0];
  if (!first) return null;
  return path.join(dir, first);
}

/**
 * Deterministic tie-break for a directory holding several extension-manifest matches.
 * `readdir` order is filesystem- and locale-dependent (`*.csproj` can match both `App.csproj`
 * and `App.Core.csproj`), so the winner must not depend on it. Prefer the manifest whose stem
 * equals the directory name, because the primary project file is conventionally named after its
 * directory; then fall back to code-unit name order, which is identical on every platform.
 */
function sortManifestMatches(dir: string, suffix: string, names: string[]): string[] {
  const dirName = path.basename(dir).toLowerCase();
  return names.sort((a, b) => {
    const aPreferred = a.slice(0, a.length - suffix.length).toLowerCase() === dirName;
    const bPreferred = b.slice(0, b.length - suffix.length).toLowerCase() === dirName;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export async function findNearestFile(startDir: string, stopDir: string, fileName: string): Promise<string | null> {
  return await findNearestManifest(startDir, stopDir, [fileName]);
}

/**
 * The directories from `startDir` up to `stopDir`, nearest first. The walk ends at `stopDir`, at the file
 * system root, or where the next parent would leave `stopDir`. The async and sync manifest lookups share it.
 */
function* ancestorDirectories(startDir: string, stopDir: string): Generator<string> {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  const stopKey = fileIdentityKey(stop);
  while (true) {
    yield dir;
    if (dir === stop || fileIdentityKey(dir) === stopKey) return;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    if (!isFilePathWithinRoot(stop, parent) && fileIdentityKey(parent) !== stopKey) return;
    dir = parent;
  }
}

export async function findNearestManifest(
  startDir: string,
  stopDir: string,
  names: readonly string[],
): Promise<string | null> {
  for (const dir of ancestorDirectories(startDir, stopDir)) {
    for (const name of names) {
      if (isExtensionManifestPattern(name)) {
        const suffix = name.slice(1).toLowerCase();
        const hit = await findExtensionManifestInDir(dir, suffix);
        if (hit) return hit;
        continue;
      }
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The resolved root and the directory a manifest search starts in, which is `null` for an empty or out-of-root
 * importer. Those fall back to the root here, not by omitting `fromFile` at call sites.
 */
function manifestSearchStart(projectRoot: string, fromFile: string): { root: string; startDir: string | null } {
  const root = path.resolve(projectRoot);
  if (!fromFile) return { root, startDir: null };
  const startDir = path.dirname(path.resolve(fromFile));
  const withinRoot = fileIdentityKey(startDir) === fileIdentityKey(root) || isFilePathWithinRoot(root, startDir);
  return { root, startDir: withinRoot ? startDir : null };
}

export async function resolveNearestManifestRoot(
  projectRoot: string,
  fromFile: string,
  names: readonly string[],
): Promise<string> {
  const { root, startDir } = manifestSearchStart(projectRoot, fromFile);
  if (!startDir) return root;
  const manifest = await findNearestManifest(startDir, root, names);
  return manifest ? path.dirname(path.resolve(manifest)) : root;
}

function statIsFileSync(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function directoryHasManifestSync(dir: string, name: string): boolean {
  if (!isExtensionManifestPattern(name)) return statIsFileSync(path.join(dir, name));
  const suffix = name.slice(1).toLowerCase();
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.name.toLowerCase().endsWith(suffix) || entry.isDirectory()) return false;
    return entry.isFile() || statIsFileSync(path.join(dir, entry.name));
  });
}

/**
 * {@link resolveNearestManifestRoot} for the one lookup that cannot await: C# alias shadowing runs inside
 * synchronous name resolution. It walks the same directories under the same nearest-manifest rule, so both name
 * the same project root. It reads the live file system, as the build does when it resolves a using directive.
 */
export function resolveNearestManifestRootSync(
  projectRoot: string,
  fromFile: string,
  names: readonly string[],
): string {
  const { root, startDir } = manifestSearchStart(projectRoot, fromFile);
  if (!startDir) return root;
  for (const dir of ancestorDirectories(startDir, root)) {
    if (names.some((name) => directoryHasManifestSync(dir, name))) return dir;
  }
  return root;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
