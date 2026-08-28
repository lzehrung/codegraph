import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BuildOptions } from "../types.js";
import { fileIdentityKey } from "../../util/paths.js";

export const PROJECT_CACHE_DIRECTORY = ".codegraph";
export const PROJECT_CACHE_RELATIVE_PATH = path.join(PROJECT_CACHE_DIRECTORY, "cache", "index-v1");
const LEGACY_PROJECT_CACHE_RELATIVE_PATH = path.join(".codegraph-cache", "index-v1");

export type CacheAnchorResolution = {
  anchor: string;
  layer: "explicit" | "environment" | "manifest" | "git" | "project" | "user";
};

function isWritableDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory() && fs.accessSync(candidate, fs.constants.W_OK) === undefined;
  } catch {
    return false;
  }
}

function isForbiddenAnchor(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const home = path.resolve(os.homedir());
  const parsed = path.parse(resolved);
  return (
    fileIdentityKey(resolved) === fileIdentityKey(home) || fileIdentityKey(resolved) === fileIdentityKey(parsed.root)
  );
}

function findRepositoryAnchor(projectRoot: string): CacheAnchorResolution {
  const start = path.resolve(projectRoot);
  let current = start;
  while (true) {
    const manifest = path.join(current, ".codegraph", "manifest.json");
    if (fs.existsSync(manifest) && isWritableDirectory(current) && !isForbiddenAnchor(current)) {
      return { anchor: current, layer: "manifest" };
    }
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && isWritableDirectory(current) && !isForbiddenAnchor(current)) {
      return { anchor: current, layer: "git" };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { anchor: start, layer: "project" };
}

function resolveCodegraphUserCacheRoot(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(base, "codegraph");
}

export function projectCacheNamespace(projectRoot: string, anchor?: string): string {
  const root = path.resolve(projectRoot);
  const identity = anchor ? fileIdentityKey(path.relative(path.resolve(anchor), root)) || "." : fileIdentityKey(root);
  const hash = crypto.createHash("sha256").update(identity).digest("hex");
  return `project-${hash}`;
}

export function resolveCacheAnchor(projectRoot: string, opts?: BuildOptions): CacheAnchorResolution {
  const explicit = opts?.cacheDir?.trim();
  if (explicit) return { anchor: path.resolve(explicit), layer: "explicit" };
  const environment = process.env.CODEGRAPH_CACHE_DIR?.trim();
  if (environment) return { anchor: path.resolve(environment), layer: "environment" };
  const location = opts?.cacheLocation;
  if (location === "project") return { anchor: path.resolve(projectRoot), layer: "project" };
  if (location === "user") return { anchor: resolveCodegraphUserCacheRoot(), layer: "user" };
  if (location && location !== "repo") {
    if (!path.isAbsolute(location)) {
      throw new Error(`Cache location must be "project", "repo", "user", or an absolute path. Received: "${location}"`);
    }
    return { anchor: path.resolve(location), layer: "explicit" };
  }
  return findRepositoryAnchor(projectRoot);
}

export type CacheLocationResolution = CacheAnchorResolution & { path: string };

const CONFIGURED_ANCHOR_LAYER_LABELS: Record<"explicit" | "environment" | "user", string> = {
  explicit: "--cache-dir (or an absolute cache.location)",
  environment: "CODEGRAPH_CACHE_DIR",
  user: 'cache.location "user"',
};

/**
 * Explicitly configured anchors (`--cache-dir`, `CODEGRAPH_CACHE_DIR`, an absolute
 * `cache.location`, or `cache.location: "user"`) must never resolve to the user's home
 * directory or a filesystem root: writing a full cache tree there is destructive and,
 * unlike auto-detected anchors, there is no safe fallback to silently relocate to.
 */
function assertAnchorNotForbidden(resolution: CacheAnchorResolution): void {
  if (resolution.layer !== "explicit" && resolution.layer !== "environment" && resolution.layer !== "user") return;
  if (!isForbiddenAnchor(resolution.anchor)) return;
  throw new Error(
    `Cache anchor "${resolution.anchor}" (from ${CONFIGURED_ANCHOR_LAYER_LABELS[resolution.layer]}) is the ` +
      `home directory or a filesystem root. codegraph refuses to use it as a cache root. Use a subdirectory ` +
      `instead, e.g. "${path.join(resolution.anchor, PROJECT_CACHE_DIRECTORY)}".`,
  );
}

type LegacyProjectCache = { path: string; cleanupBoundary: string };

function migrateLegacyProjectCache(
  candidate: string,
  legacyCandidates: readonly LegacyProjectCache[],
  logLevel: BuildOptions["logLevel"],
): void {
  if (fs.existsSync(candidate)) return;
  const legacy = legacyCandidates.find(({ path: legacyPath }) => fs.existsSync(legacyPath));
  if (!legacy) return;

  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.renameSync(legacy.path, candidate);
  } catch (error) {
    if (logLevel === "debug") console.debug(`Unable to migrate legacy cache from ${legacy.path}:`, error);
    return;
  }

  let current = path.dirname(legacy.path);
  for (;;) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    if (fileIdentityKey(current) === fileIdentityKey(legacy.cleanupBoundary)) break;
    current = path.dirname(current);
  }
}

/**
 * Resolves the effective on-disk cache path along with the anchor/layer that actually
 * produced it. This can differ from `resolveCacheAnchor`'s intended anchor when that
 * anchor is not writable (falls back to the project root). Project-local legacy caches
 * are migrated to the consolidated cache directory when possible.
 */
export function resolveCacheLocation(projectRoot: string, opts?: BuildOptions): CacheLocationResolution {
  const root = path.resolve(projectRoot);
  const resolution = resolveCacheAnchor(root, opts);
  assertAnchorNotForbidden(resolution);
  const anchorCreatable =
    resolution.layer === "explicit" || resolution.layer === "environment" || resolution.layer === "user";
  const anchorWritable = anchorCreatable || isWritableDirectory(resolution.anchor);
  const anchor = anchorWritable ? resolution.anchor : root;
  const effectiveLayer = anchorWritable ? resolution.layer : "project";
  const sameRoot = fileIdentityKey(anchor) === fileIdentityKey(root);
  const explicitBase = opts?.cacheDir?.trim() || process.env.CODEGRAPH_CACHE_DIR?.trim();
  if (sameRoot && !explicitBase && (!opts?.cacheLocation || opts.cacheLocation === "project")) {
    const candidate = path.join(root, PROJECT_CACHE_RELATIVE_PATH);
    migrateLegacyProjectCache(
      candidate,
      [
        {
          path: path.join(root, LEGACY_PROJECT_CACHE_RELATIVE_PATH),
          cleanupBoundary: path.join(root, ".codegraph-cache"),
        },
      ],
      opts?.logLevel,
    );
    return { path: candidate, anchor, layer: effectiveLayer };
  }
  const namespace = projectCacheNamespace(
    root,
    effectiveLayer === "git" || effectiveLayer === "manifest" ? anchor : undefined,
  );
  if (explicitBase) {
    const configured = path.resolve(explicitBase);
    const configuredPath = path.basename(configured) === namespace ? configured : path.join(configured, namespace);
    return { path: configuredPath, anchor, layer: effectiveLayer };
  }
  if (opts?.cacheLocation === "user") {
    return {
      path: path.join(resolveCodegraphUserCacheRoot(), "index-v1", namespace),
      anchor,
      layer: effectiveLayer,
    };
  }
  const candidate = path.join(anchor, PROJECT_CACHE_RELATIVE_PATH, namespace);
  const legacyCandidates: LegacyProjectCache[] = [
    {
      path: path.join(anchor, LEGACY_PROJECT_CACHE_RELATIVE_PATH, namespace),
      cleanupBoundary: path.join(anchor, ".codegraph-cache"),
    },
  ];
  if (!sameRoot && !opts?.cacheLocation) {
    legacyCandidates.push({
      path: path.join(root, LEGACY_PROJECT_CACHE_RELATIVE_PATH),
      cleanupBoundary: path.join(root, ".codegraph-cache"),
    });
  }
  migrateLegacyProjectCache(candidate, legacyCandidates, opts?.logLevel);
  return { path: candidate, anchor, layer: effectiveLayer };
}
export function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  return resolveCacheLocation(projectRoot, opts).path;
}
