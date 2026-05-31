import path from "node:path";
import { findDuplicates } from "../duplicates.js";
import { getHotspots } from "../graphs/hotspots.js";
import { findDetailedCycles, getUnresolvedImports, sortDetailedCycles } from "../graphs/queries.js";
import { buildProjectIndex, buildProjectIndexFromFiles } from "../indexer/build-index.js";
import { getApiSurface } from "../indexer/symbols.js";
import { supportForFile } from "../languages.js";
import type { Edge } from "../types.js";
import { DEFAULT_PROJECT_PATTERNS, listProjectFiles } from "../util/projectFiles.js";
import { normalizePath, resolveFilePathFromRoot, toProjectDisplayPath } from "../util/paths.js";
import type {
  ArchitectureCycle,
  ArchitectureDuplicateSummary,
  ArchitectureGraphEdge,
  ArchitectureHotspot,
  ArchitecturePublicApiSymbol,
  ArchitectureSnapshot,
  ArchitectureSnapshotOptions,
  ArchitectureUnresolvedImport,
} from "./types.js";

const DUPLICATE_PROJECT_PATTERNS = [...DEFAULT_PROJECT_PATTERNS, "**/*.{json,jsonc,toml,txt,yaml,yml}"];
const DEFAULT_DUPLICATE_LIMIT = 50;

function normalizeRoot(root: string): string {
  return normalizePath(path.resolve(root));
}

function normalizeIncludeRoot(root: string, includeRoot: string): string {
  return normalizePath(resolveFilePathFromRoot(root, includeRoot));
}

function isUnderIncludeRoots(filePath: string, roots: readonly string[]): boolean {
  if (!roots.length) return true;
  const normalizedFile = normalizePath(filePath);
  return roots.some((root) => normalizedFile === root || normalizedFile.startsWith(`${root}/`));
}

async function listFilesForSnapshot(root: string, options: ArchitectureSnapshotOptions): Promise<string[] | undefined> {
  if (!options.includeRoots?.length) return undefined;
  const roots = options.includeRoots.map((entry) => normalizeIncludeRoot(root, entry));
  const files = await listProjectFiles(root, DUPLICATE_PROJECT_PATTERNS, options.discovery);
  return files.filter((file) => isUnderIncludeRoots(file, roots)).sort();
}

function snapshotLanguageId(id: string): string {
  if (id === "ts") return "typescript";
  return id;
}

function languageCounts(files: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const support = supportForFile(file);
    if (!support) continue;
    const languageId = snapshotLanguageId(support.id);
    counts[languageId] = (counts[languageId] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function cycleKey(files: readonly string[]): string {
  return [...files].sort().join("->");
}

function toSnapshotCycles(root: string, cycles: ReturnType<typeof findDetailedCycles>): ArchitectureCycle[] {
  return sortDetailedCycles(cycles, "priority")
    .map((cycle) => {
      const files = cycle.files.map((file) => toProjectDisplayPath(root, file)).sort();
      return {
        key: cycleKey(files),
        files,
        priorityScore: cycle.priorityScore,
        size: cycle.fileCount,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function toSnapshotHotspots(root: string, hotspots: ReturnType<typeof getHotspots>): ArchitectureHotspot[] {
  return hotspots
    .map((entry) => ({
      file: toProjectDisplayPath(root, entry.file),
      fanIn: entry.fanIn,
      fanOut: entry.fanOut,
      score: entry.score,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function toSnapshotUnresolved(
  root: string,
  graph: Parameters<typeof getUnresolvedImports>[0],
): { total: number; imports: ArchitectureUnresolvedImport[] } {
  const unresolved: ArchitectureUnresolvedImport[] = [];
  for (const item of getUnresolvedImports(graph, { projectRoot: root })) {
    for (const importer of item.importers) {
      const file = toProjectDisplayPath(root, importer.file);
      unresolved.push({
        key: `${file}\0${importer.raw}`,
        file,
        specifier: importer.raw,
      });
    }
  }
  return {
    total: unresolved.length,
    imports: unresolved.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function toSnapshotPublicApi(root: string, index: Parameters<typeof getApiSurface>[0]): ArchitecturePublicApiSymbol[] {
  const symbols: ArchitecturePublicApiSymbol[] = [];
  for (const item of getApiSurface(index)) {
    const file = toProjectDisplayPath(root, item.file);
    for (const exp of item.exports) {
      symbols.push({
        id: `${file}#${exp.exportedAs}:${exp.kind}`,
        file,
        name: exp.exportedAs,
        kind: exp.kind,
      });
    }
  }
  return symbols.sort((left, right) => left.id.localeCompare(right.id));
}

function duplicateGroupKey(group: { primaryLeft: { file: string; startLine: number }; primaryRight: { file: string; startLine: number } }): string {
  const left = `${group.primaryLeft.file}:${group.primaryLeft.startLine}`;
  const right = `${group.primaryRight.file}:${group.primaryRight.startLine}`;
  return left < right ? `${left}<->${right}` : `${right}<->${left}`;
}

async function duplicateSummary(index: Parameters<typeof findDuplicates>[0], limit: number): Promise<ArchitectureDuplicateSummary> {
  const duplicateOptions = {
    limit,
    minConfidence: "medium" as const,
    ...(index.projectRoot ? { projectRoot: index.projectRoot } : {}),
  };
  const result = await findDuplicates(index, duplicateOptions);
  const topGroupKeys = result.groups.map(duplicateGroupKey).sort();
  return {
    groups: { total: result.groups.length + result.omittedCounts.groups },
    topGroupKeys,
  };
}

function edgeTarget(edge: Edge, root: string): string {
  if (edge.to.type === "file") return toProjectDisplayPath(root, edge.to.path);
  return `external:${edge.to.name}`;
}

function edgeKey(edge: Edge, root: string): string {
  return `${toProjectDisplayPath(root, edge.from)}\0${edge.raw}\0${edgeTarget(edge, root)}`;
}

function toSnapshotEdges(root: string, edges: readonly Edge[]): ArchitectureGraphEdge[] {
  return edges
    .map((edge) => ({
      key: edgeKey(edge, root),
      from: toProjectDisplayPath(root, edge.from),
      to: edgeTarget(edge, root),
      raw: edge.raw,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function buildArchitectureSnapshot(
  rootInput: string,
  options: ArchitectureSnapshotOptions = {},
): Promise<ArchitectureSnapshot> {
  const root = normalizeRoot(rootInput);
  const files = await listFilesForSnapshot(root, options);
  const indexOptions = {
    ...options.index,
    ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
    ...(options.graph !== undefined ? { graph: options.graph } : {}),
    ...(options.native !== undefined ? { native: options.native } : {}),
  };
  const index = files
    ? await buildProjectIndexFromFiles(root, files, indexOptions)
    : await buildProjectIndex(root, indexOptions);
  const includeRoots = options.includeRoots?.map((entry) => normalizeIncludeRoot(root, entry)) ?? [];
  const indexedFiles = [...index.byFile.keys()].sort();

  return {
    schemaVersion: 1,
    root,
    files: {
      total: indexedFiles.length,
      byLanguage: languageCounts(indexedFiles),
    },
    hotspots: toSnapshotHotspots(root, getHotspots(index.graph, { includeRoots })),
    cycles: toSnapshotCycles(root, findDetailedCycles(index.graph)),
    unresolved: toSnapshotUnresolved(root, index.graph),
    publicApi: toSnapshotPublicApi(root, index),
    duplicates: await duplicateSummary(index, options.duplicateLimit ?? DEFAULT_DUPLICATE_LIMIT),
    graphEdges: toSnapshotEdges(root, index.graph.edges),
  };
}
