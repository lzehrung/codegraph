import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Edge, EdgeTo, Graph } from "../../types.js";
import { buildGraphAdjacency } from "../../graphs/adjacency.js";
import type { ProjectFileInfo } from "../../util/projectFiles.js";
import type { BuildOptions, ModuleIndex, ProjectIndex } from "../types.js";
import { cacheRoot } from "./module-cache.js";
import type { ManifestFileEntry } from "./manifest.js";

const PROJECT_SNAPSHOT_VERSION = 1;

type ProjectIndexSnapshotPayload = {
  version: number;
  filesSignature: string;
  graph: {
    nodes: string[];
    edges: Graph["edges"];
  };
  modules: ModuleIndex[];
  projectRoot?: string;
  nativeMode?: ProjectIndex["nativeMode"];
  projectFiles?: ProjectFileInfo[];
};

export function projectSnapshotFilesSignature(entries: ReadonlyMap<string, ManifestFileEntry>): string {
  const hash = createHash("sha256");
  for (const [file, entry] of [...entries.entries()].sort(([left], [right]) => compareSnapshotPath(left, right))) {
    hash.update(file);
    hash.update("\0");
    hash.update(entry.sig);
    hash.update("\0");
    hash.update(entry.gitSig ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compareSnapshotPath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function tryLoadProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  filesSignature: string,
): Promise<ProjectIndex | null> {
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const payload = JSON.parse(await fsp.readFile(projectSnapshotPath(projectRoot, opts), "utf8")) as unknown;
    if (
      !isProjectIndexSnapshotPayload(payload) ||
      payload.filesSignature !== filesSignature ||
      payload.nativeMode !== normalizedSnapshotNativeMode(opts?.native)
    ) {
      return null;
    }
    const graph: Graph = {
      nodes: new Set(payload.graph.nodes),
      edges: payload.graph.edges,
    };
    const modules = new Map(payload.modules.map((moduleIndex) => [moduleIndex.file, moduleIndex]));
    return {
      graph,
      graphAdjacency: buildGraphAdjacency(graph),
      modules,
      byFile: modules,
      ...(payload.projectRoot ? { projectRoot: payload.projectRoot } : {}),
      ...(payload.nativeMode ? { nativeMode: payload.nativeMode } : {}),
      exportCache: new Map(),
      scopeCache: new Map(),
      ...(payload.projectFiles ? { projectFiles: payload.projectFiles } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  filesSignature: string,
): Promise<void> {
  if ((opts?.cache ?? "off") !== "disk") return;
  const payload: ProjectIndexSnapshotPayload = {
    version: PROJECT_SNAPSHOT_VERSION,
    filesSignature,
    graph: {
      nodes: [...index.graph.nodes],
      edges: index.graph.edges,
    },
    modules: [...index.byFile.values()],
    ...(index.projectRoot ? { projectRoot: index.projectRoot } : {}),
    ...(normalizedSnapshotNativeMode(index.nativeMode) ? { nativeMode: normalizedSnapshotNativeMode(index.nativeMode) } : {}),
    ...(index.projectFiles ? { projectFiles: index.projectFiles } : {}),
  };
  try {
    const snapshotPath = projectSnapshotPath(projectRoot, opts);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, JSON.stringify(payload), "utf8");
  } catch {
    // Snapshot writes are an optimization; cache write failures must not fail indexing.
  }
}

function projectSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  return path.join(cacheRoot(projectRoot, opts), "project-index-snapshot.json");
}

function normalizedSnapshotNativeMode(nativeMode: ProjectIndex["nativeMode"] | undefined): ProjectIndex["nativeMode"] | undefined {
  if (nativeMode === undefined || nativeMode === "auto") return undefined;
  return nativeMode;
}

function isProjectIndexSnapshotPayload(value: unknown): value is ProjectIndexSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  return (
    payload.version === PROJECT_SNAPSHOT_VERSION &&
    typeof payload.filesSignature === "string" &&
    !!payload.graph &&
    Array.isArray(payload.graph.nodes) &&
    payload.graph.nodes.every((node) => typeof node === "string") &&
    Array.isArray(payload.graph.edges) &&
    payload.graph.edges.every(isGraphEdge) &&
    Array.isArray(payload.modules) &&
    payload.modules.every(isModuleIndex)
  );
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const moduleIndex = value as Partial<ModuleIndex>;
  return (
    typeof moduleIndex.file === "string" &&
    Array.isArray(moduleIndex.locals) &&
    Array.isArray(moduleIndex.imports) &&
    Array.isArray(moduleIndex.exports)
  );
}

function isGraphEdge(value: unknown): value is Edge {
  if (!value || typeof value !== "object") return false;
  const edge = value as Partial<Edge>;
  const resolved = edge.resolved;
  return (
    typeof edge.from === "string" &&
    isEdgeTo(edge.to) &&
    typeof edge.raw === "string" &&
    (edge.typeOnly === undefined || typeof edge.typeOnly === "boolean") &&
    (resolved === undefined || resolved === "heuristic" || resolved === "precise") &&
    (edge.confidence === undefined || typeof edge.confidence === "number")
  );
}

function isEdgeTo(value: unknown): value is EdgeTo {
  if (!value || typeof value !== "object") return false;
  const edgeTo = value as Partial<EdgeTo>;
  if (edgeTo.type === "file") return typeof edgeTo.path === "string";
  if (edgeTo.type === "external") return typeof edgeTo.name === "string";
  return false;
}
