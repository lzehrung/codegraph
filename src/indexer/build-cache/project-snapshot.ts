import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Edge, EdgeTo, Graph, Pos, Range } from "../../types.js";
import { buildGraphAdjacency } from "../../graphs/adjacency.js";
import type { ProjectFileInfo } from "../../util/projectFiles.js";
import {
  SymbolKind,
  type BuildOptions,
  type ExportEntry,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
} from "../types.js";
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

function isSnapshotNativeMode(value: unknown): value is ProjectIndex["nativeMode"] {
  return value === "auto" || value === "on" || value === "off";
}

function isProjectFileInfo(value: unknown): value is ProjectFileInfo {
  if (!value || typeof value !== "object") return false;
  const projectFile = value as Partial<ProjectFileInfo>;
  return (
    typeof projectFile.path === "string" &&
    (projectFile.kind === "file" || projectFile.kind === "dir") &&
    isProjectFileType(projectFile.type) &&
    isProjectFileRole(projectFile.role) &&
    typeof projectFile.projectRoot === "string" &&
    (projectFile.name === undefined || typeof projectFile.name === "string")
  );
}

function isProjectFileType(value: unknown): boolean {
  return (
    value === "node" ||
    value === "typescript" ||
    value === "python" ||
    value === "rust" ||
    value === "go" ||
    value === "maven" ||
    value === "gradle" ||
    value === "dotnet" ||
    value === "ruby" ||
    value === "php" ||
    value === "swift" ||
    value === "native" ||
    value === "ide"
  );
}

function isProjectFileRole(value: unknown): boolean {
  return value === "manifest" || value === "lockfile" || value === "config" || value === "solution" || value === "ide";
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
    payload.modules.every(isModuleIndex) &&
    (payload.projectRoot === undefined || typeof payload.projectRoot === "string") &&
    (payload.nativeMode === undefined || isSnapshotNativeMode(payload.nativeMode)) &&
    (payload.projectFiles === undefined ||
      (Array.isArray(payload.projectFiles) && payload.projectFiles.every(isProjectFileInfo)))
  );
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const moduleIndex = value as Partial<ModuleIndex>;
  return (
    typeof moduleIndex.file === "string" &&
    Array.isArray(moduleIndex.locals) &&
    moduleIndex.locals.every(isSymbolDef) &&
    Array.isArray(moduleIndex.imports) &&
    moduleIndex.imports.every(isImportBinding) &&
    Array.isArray(moduleIndex.exports) &&
    moduleIndex.exports.every(isExportEntry)
  );
}

function isSymbolDef(value: unknown): value is SymbolDef {
  if (!value || typeof value !== "object") return false;
  const symbol = value as Partial<SymbolDef>;
  return (
    typeof symbol.file === "string" &&
    typeof symbol.localName === "string" &&
    isSymbolKind(symbol.kind) &&
    isRange(symbol.range) &&
    (symbol.docstring === undefined || typeof symbol.docstring === "string") &&
    (symbol.lineSpan === undefined || typeof symbol.lineSpan === "number") &&
    (symbol.complexity === undefined || typeof symbol.complexity === "number")
  );
}

function isImportBinding(value: unknown): value is ImportBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ImportBinding>;
  if (
    typeof binding.from !== "string" ||
    !isResolvedImportTarget(binding.resolved) ||
    !isOptionalBoolean(binding.typeOnly) ||
    !isImportMechanism(binding.mechanism) ||
    !isResolvedType(binding.resolvedType) ||
    !isOptionalNumber(binding.confidence)
  ) {
    return false;
  }
  if (binding.kind === "default") return typeof binding.local === "string";
  if (binding.kind === "named") {
    return (
      typeof binding.local === "string" &&
      typeof binding.imported === "string" &&
      (binding.phpImportType === undefined ||
        binding.phpImportType === "class" ||
        binding.phpImportType === "function" ||
        binding.phpImportType === "const")
    );
  }
  if (binding.kind === "namespace") return typeof binding.localNS === "string";
  return binding.kind === "star";
}

function isExportEntry(value: unknown): value is ExportEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ExportEntry>;
  if (entry.type === "local") return typeof entry.exportedAs === "string" && isSymbolDef(entry.target);
  if (entry.type === "reexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "namespaceReexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "exportStar") {
    return (
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  return false;
}

function isResolvedImportTarget(value: ImportBinding["resolved"] | undefined): boolean {
  if (value === undefined || typeof value === "string") return true;
  return Boolean(value && typeof value === "object" && typeof value.external === "string");
}

function isImportMechanism(value: unknown): boolean {
  return value === undefined || value === "es" || value === "cjs" || value === "python" || value === "php";
}

function isResolvedType(value: unknown): boolean {
  return value === undefined || value === "heuristic" || value === "precise";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isSymbolKind(value: unknown): value is SymbolKind {
  return Object.values(SymbolKind).includes(value as SymbolKind);
}

function isRange(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<Range>;
  return isPos(range.start) && isPos(range.end);
}

function isPos(value: unknown): value is Pos {
  if (!value || typeof value !== "object") return false;
  const pos = value as Partial<Pos>;
  return (
    typeof pos.line === "number" &&
    typeof pos.column === "number" &&
    (pos.index === undefined || typeof pos.index === "number")
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
