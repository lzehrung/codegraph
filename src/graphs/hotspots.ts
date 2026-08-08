import type { FileId, Graph } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { getFiniteNonNegativeLimit } from "./limits.js";

export type HotspotEntry = {
  file: FileId;
  fanIn: number;
  fanOut: number;
  score: number;
};

export type HotspotOptions = {
  limit?: number;
  includeRoots?: string[];
};

function normalizeHotspotRoots(includeRoots: string[]): string[] {
  return includeRoots.map(normalizePath);
}

function compareHotspotEntries(a: HotspotEntry, b: HotspotEntry): number {
  const byScore = b.score - a.score;
  if (byScore) return byScore;
  const byFanIn = b.fanIn - a.fanIn;
  if (byFanIn) return byFanIn;
  const byFanOut = b.fanOut - a.fanOut;
  if (byFanOut) return byFanOut;
  if (a.file < b.file) return -1;
  if (a.file > b.file) return 1;
  return 0;
}

function isHotspotUnderRoots(filePath: string, normalizedRoots: string[]): boolean {
  if (!normalizedRoots.length) {
    return true;
  }
  const normalizedFile = normalizePath(filePath);
  return normalizedRoots.some((root) => normalizedFile === root || normalizedFile.startsWith(`${root}/`));
}

function insertLimitedHotspot(topHotspots: HotspotEntry[], entry: HotspotEntry, limit: number): void {
  const insertIndex = topHotspots.findIndex((existing) => compareHotspotEntries(entry, existing) < 0);
  if (insertIndex === -1) {
    topHotspots.push(entry);
  } else {
    topHotspots.splice(insertIndex, 0, entry);
  }
  if (topHotspots.length > limit) {
    topHotspots.length = limit;
  }
}

export function getHotspots(graph: Graph, options?: HotspotOptions): HotspotEntry[] {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const normalizedRoots = normalizeHotspotRoots(options?.includeRoots ?? []);
  const limit = getFiniteNonNegativeLimit(options?.limit);
  const scopedNodes = new Set<string>();

  for (const node of graph.nodes) {
    if (!isHotspotUnderRoots(node, normalizedRoots)) {
      continue;
    }
    scopedNodes.add(node);
    fanIn.set(node, 0);
    fanOut.set(node, 0);
  }

  for (const edge of graph.edges) {
    if (!scopedNodes.has(edge.from)) {
      continue;
    }
    fanOut.set(edge.from, (fanOut.get(edge.from) || 0) + 1);
    if (edge.to.type === "file" && scopedNodes.has(edge.to.path)) {
      fanIn.set(edge.to.path, (fanIn.get(edge.to.path) || 0) + 1);
    }
  }

  if (limit === 0) {
    return [];
  }

  const hotspots: HotspotEntry[] = [];
  for (const file of scopedNodes) {
    const fi = fanIn.get(file) || 0;
    const fo = fanOut.get(file) || 0;
    const entry = {
      file,
      fanIn: fi,
      fanOut: fo,
      score: fi * 2 + fo,
    };
    if (limit === undefined) {
      hotspots.push(entry);
      continue;
    }
    insertLimitedHotspot(hotspots, entry, limit);
  }

  if (limit === undefined) {
    hotspots.sort(compareHotspotEntries);
  }
  return hotspots;
}
