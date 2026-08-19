import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { mapLimit } from "../../util/concurrency.js";
import { isFilePathWithinRoot } from "../../util/paths.js";

const PROJECT_RESOLUTION_INPUTS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
] as const;
const NODE_MODULES_STATE_INPUTS = [".package-lock.json", ".yarn-state.yml", ".modules.yaml"] as const;
const MAX_NODE_MODULE_ROOTS = 4_096;
const MAX_PACKAGE_MANIFESTS = 10_000;

const RESOLUTION_INPUT_SAMPLE_BYTES = 4 * 1024;
const RESOLUTION_INPUT_CONCURRENCY = 16;

type ResolutionInput = {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
};

function normalizedRelativePath(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/");
}

async function statInput(projectRoot: string, target: string): Promise<ResolutionInput | null> {
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return null;
    const sampleBytes = Math.min(stat.size, RESOLUTION_INPUT_SAMPLE_BYTES);
    const hash = crypto.createHash("sha256");
    if (sampleBytes) {
      const first = Buffer.allocUnsafe(sampleBytes);
      const handle = await fsp.open(target, "r");
      try {
        const firstRead = await handle.read(first, 0, sampleBytes, 0);
        hash.update(first.subarray(0, firstRead.bytesRead));
        if (stat.size > sampleBytes) {
          const last = Buffer.allocUnsafe(sampleBytes);
          const lastRead = await handle.read(last, 0, sampleBytes, stat.size - sampleBytes);
          hash.update(last.subarray(0, lastRead.bytesRead));
        }
      } finally {
        await handle.close();
      }
    }
    return {
      path: normalizedRelativePath(projectRoot, target),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      contentHash: hash.digest("hex"),
    };
  } catch {
    return null;
  }
}

function nodeModulesRootCandidates(projectRoot: string, files: readonly string[]): string[] | null {
  const candidates = new Set<string>();
  candidates.add(path.join(projectRoot, "node_modules"));
  for (const file of files) {
    let directory = path.dirname(file);
    while (isFilePathWithinRoot(projectRoot, directory)) {
      candidates.add(path.join(directory, "node_modules"));
      if (path.resolve(directory) === path.resolve(projectRoot)) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (candidates.size > MAX_NODE_MODULE_ROOTS) return null;
  }
  return [...candidates].sort((left, right) => left.localeCompare(right));
}

async function activeNodeModulesRoots(projectRoot: string, files: readonly string[]): Promise<string[] | null> {
  const candidates = nodeModulesRootCandidates(projectRoot, files);
  if (!candidates) return null;
  const roots = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await fsp.stat(candidate)).isDirectory() ? candidate : null;
      } catch {
        return null;
      }
    }),
  );
  return roots.filter((root): root is string => root !== null);
}

async function installedPackageManifests(projectRoot: string, root: string): Promise<ResolutionInput[] | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const packageDirectories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.name.startsWith("@")) {
      try {
        const scopedEntries = await fsp.readdir(entryPath, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory()) packageDirectories.push(path.join(entryPath, scopedEntry.name));
        }
      } catch {
        continue;
      }
    } else {
      packageDirectories.push(entryPath);
    }
    if (packageDirectories.length > MAX_PACKAGE_MANIFESTS) return null;
  }
  const manifests = await mapLimit(
    packageDirectories,
    RESOLUTION_INPUT_CONCURRENCY,
    async (directory) => await statInput(projectRoot, path.join(directory, "package.json")),
  );
  const inputs = manifests.filter((input): input is ResolutionInput => input !== null);
  return inputs.length > MAX_PACKAGE_MANIFESTS ? null : inputs;
}

/**
 * Fingerprints resolver inputs once per build. A package tree beyond either bound returns null,
 * making callers re-resolve rather than spending unbounded time scanning installations.
 *
 * Fixed leading and trailing samples detect common in-place edits without retaining whole files;
 * a same-metadata edit outside both samples can still remain stale.
 */
export async function computeResolverEnvironmentFingerprint(
  projectRoot: string,
  files: readonly string[],
): Promise<string | null> {
  const nodeModulesRoots = await activeNodeModulesRoots(projectRoot, files);
  if (!nodeModulesRoots) return null;
  const inputs: ResolutionInput[] = [];
  for (const name of PROJECT_RESOLUTION_INPUTS) {
    const input = await statInput(projectRoot, path.join(projectRoot, name));
    if (input) inputs.push(input);
  }
  for (const root of nodeModulesRoots) {
    for (const name of NODE_MODULES_STATE_INPUTS) {
      const input = await statInput(projectRoot, path.join(root, name));
      if (input) inputs.push(input);
    }
    const manifests = await installedPackageManifests(projectRoot, root);
    if (!manifests || inputs.length + manifests.length > MAX_PACKAGE_MANIFESTS) return null;
    inputs.push(...manifests);
  }
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const hash = crypto.createHash("sha256");
  for (const input of inputs) {
    hash.update(`${input.path}\0${input.mtimeMs}\0${input.size}\0${input.contentHash}\n`);
  }
  return hash.digest("hex");
}
