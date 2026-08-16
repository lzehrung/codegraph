import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BuildOptions } from "../types.js";
import { fileIdentityKey } from "../../util/paths.js";

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

export function projectCacheNamespace(projectRoot: string): string {
  const rootIdentity = fileIdentityKey(path.resolve(projectRoot));
  const hash = crypto.createHash("sha256").update(rootIdentity).digest("hex");
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
  if (location && location !== "repo") return { anchor: path.resolve(location), layer: "explicit" };
  return findRepositoryAnchor(projectRoot);
}

export function cacheRoot(projectRoot: string, opts?: BuildOptions): string {
  const root = path.resolve(projectRoot);
  const resolution = resolveCacheAnchor(root, opts);
  const anchor = resolution.layer === "explicit" || isWritableDirectory(resolution.anchor) ? resolution.anchor : root;
  const sameRoot = fileIdentityKey(anchor) === fileIdentityKey(root);
  if (
    sameRoot &&
    !opts?.cacheDir &&
    !process.env.CODEGRAPH_CACHE_DIR?.trim() &&
    (!opts?.cacheLocation || opts.cacheLocation === "project")
  ) {
    return path.join(root, ".codegraph-cache", "index-v1");
  }
  const namespace = projectCacheNamespace(root);
  const explicitBase = opts?.cacheDir?.trim() || process.env.CODEGRAPH_CACHE_DIR?.trim();
  if (explicitBase) {
    const configured = path.resolve(explicitBase);
    if (path.basename(configured) === namespace) return configured;
    return path.join(configured, namespace);
  }
  const base = opts?.cacheLocation === "user" ? resolveCodegraphUserCacheRoot() : path.join(anchor, ".codegraph-cache");
  const candidate = path.join(path.resolve(base), "index-v1", namespace);
  if (!sameRoot && !opts?.cacheLocation) {
    const legacy = path.join(root, ".codegraph-cache", "index-v1");
    if (!fs.existsSync(candidate) && fs.existsSync(legacy)) return legacy;
  }
  return candidate;
}
