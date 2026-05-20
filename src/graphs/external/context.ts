import path from "node:path";
import { BoundedCacheMap } from "./cache.js";
import {
  createDependencyManifestForDirectory,
  directoryExists,
  pathExists,
  type DependencyManifest,
} from "./manifests.js";

type ExternalClassifierCacheStats = {
  dependencyManifests: number;
  declaredPackageContexts: number;
};

const MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES = 512;
const MAX_MANIFEST_ANCESTOR_SEARCH_DEPTH = 64;

const dependencyManifestCache = new BoundedCacheMap<string, DependencyManifest>(MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES);
const declaredPackagesByContextCache = new BoundedCacheMap<string, Set<string>>(MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES);

export function resetExternalClassifierCaches(): void {
  dependencyManifestCache.clear();
  declaredPackagesByContextCache.clear();
}

export function getExternalClassifierCacheStats(): ExternalClassifierCacheStats {
  return {
    dependencyManifests: dependencyManifestCache.size,
    declaredPackageContexts: declaredPackagesByContextCache.size,
  };
}

function dependencyManifestForDirectory(directory: string): DependencyManifest {
  const resolvedRoot = path.resolve(directory);
  const cached = dependencyManifestCache.get(resolvedRoot);
  if (cached) return cached;
  const manifest = createDependencyManifestForDirectory(resolvedRoot);
  dependencyManifestCache.set(resolvedRoot, manifest);
  return manifest;
}

function parentDirectory(directory: string): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : parent;
}

function nearestVcsAncestor(startDirectory: string): string | null {
  let current: string | null = path.resolve(startDirectory);
  while (current) {
    if (pathExists(path.join(current, ".git"))) return current;
    current = parentDirectory(current);
  }
  return null;
}

function nearestManifestAncestor(startDirectory: string, stopDirectory: string | null): string | null {
  let depth = 0;
  let current: string | null = path.resolve(startDirectory);
  const resolvedStop = stopDirectory ? path.resolve(stopDirectory) : null;
  while (current && depth <= MAX_MANIFEST_ANCESTOR_SEARCH_DEPTH) {
    if (dependencyManifestForDirectory(current).hasManifest) return current;
    if (resolvedStop && current === resolvedStop) break;
    current = parentDirectory(current);
    depth += 1;
  }
  return null;
}

function isSameOrInside(directory: string, possibleAncestor: string): boolean {
  const relative = path.relative(possibleAncestor, directory);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function declaredPackagesFromAncestors(startDirectory: string, stopDirectory: string): Set<string> {
  const resolvedStart = path.resolve(startDirectory);
  const resolvedStop = path.resolve(stopDirectory);
  const cacheKey = `${resolvedStart}\0${resolvedStop}`;
  const cached = declaredPackagesByContextCache.get(cacheKey);
  if (cached) return cached;

  const declaredPackages = new Set<string>();
  let current: string | null = resolvedStart;
  while (current && isSameOrInside(current, resolvedStop)) {
    for (const packageName of dependencyManifestForDirectory(current).declaredPackages) {
      declaredPackages.add(packageName);
    }
    if (current === resolvedStop) break;
    current = parentDirectory(current);
  }

  declaredPackagesByContextCache.set(cacheKey, declaredPackages);
  return declaredPackages;
}

function importerDirectoryForFile(importerFile: string): string {
  if (directoryExists(importerFile)) return importerFile;
  return path.dirname(importerFile);
}

export function declaredPackagesForContext(importerFile: string, projectRoot: string | undefined): Set<string> {
  const importerDirectory = path.resolve(importerDirectoryForFile(importerFile));
  const ancestorSearchStart = path.resolve(projectRoot ?? importerDirectory);
  const vcsBoundary = nearestVcsAncestor(ancestorSearchStart);
  const boundary =
    nearestManifestAncestor(ancestorSearchStart, vcsBoundary) ?? path.resolve(projectRoot ?? importerDirectory);
  if (!isSameOrInside(importerDirectory, boundary)) {
    return dependencyManifestForDirectory(boundary).declaredPackages;
  }
  return declaredPackagesFromAncestors(importerDirectory, boundary);
}
