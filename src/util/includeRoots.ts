import path from "node:path";
import type { Graph } from "../types.js";
import { normalizePath, resolveFilePathFromRoot } from "./paths.js";

export function isPathUnderIncludeRoots(normalizedPath: string, normalizedRoots: readonly string[]): boolean {
  if (!normalizedRoots.length) return true;
  const file = normalizedPath.replace(/\\/g, "/");
  return normalizedRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

export function normalizeIncludeRootsRelative(projectRoot: string, includeRoots: readonly string[]): string[] {
  return includeRoots
    .map((includeRoot) => {
      const relativeRoot = path.isAbsolute(includeRoot) ? path.relative(projectRoot, includeRoot) : includeRoot;
      return normalizePath(relativeRoot)
        .replace(/^\.?\//, "")
        .replace(/\/$/, "");
    })
    .filter((includeRoot) => includeRoot && includeRoot !== ".");
}

export function normalizeIncludeRootsAbsolute(projectRoot: string, includeRoots: readonly string[]): string[] {
  return includeRoots.map((entry) => normalizePath(resolveFilePathFromRoot(projectRoot, entry)));
}

export function restrictGraphToIncludeRoots(
  graph: Graph,
  includeRoots: readonly string[],
  normalizeFile: (file: string) => string = normalizePath,
): Graph {
  if (!includeRoots.length) {
    return graph;
  }
  const normalizedRoots = includeRoots.map(normalizeFile);
  const nodes = new Set<string>();
  for (const file of graph.nodes) {
    const normalizedFile = normalizeFile(file);
    if (isPathUnderIncludeRoots(normalizedFile, normalizedRoots)) {
      nodes.add(normalizedFile);
    }
  }
  const edges = graph.edges.filter((edge) => {
    if (!nodes.has(normalizeFile(edge.from))) {
      return false;
    }
    return edge.to.type === "external" || nodes.has(normalizeFile(edge.to.path));
  });
  return {
    nodes,
    edges,
  };
}
