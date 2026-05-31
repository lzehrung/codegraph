import fsp from "node:fs/promises";
import path from "node:path";
import { getHotspots } from "../graphs/hotspots.js";
import { findDetailedCycles, getUnresolvedImports, sortDetailedCycles } from "../graphs/queries.js";
import { supportForFile } from "../languages.js";
import type { Edge, Graph } from "../types.js";
import { isPlainRecord } from "../util/guards.js";
import { normalizePath } from "../util/paths.js";
import type { ArchitectureGraphEdge, ArchitectureSnapshot, ArchitectureUnresolvedImport } from "./types.js";

interface ArtifactManifest {
  artifacts: { graphJson: string };
}

interface PortableGraphJson {
  schemaVersion: 1;
  format: "codegraph.graph-json";
  graph: {
    files: string[];
    fileEdges: Edge[];
    symbols?: Array<{ file: string; name: string; kind: string }>;
  };
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function parseManifest(value: unknown): ArtifactManifest | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion !== 1 || value.graphJsonSchema !== "codegraph.graph-json") return null;
  const artifacts = readStringRecord(value.artifacts);
  if (!artifacts.graphJson) return null;
  return { artifacts: { graphJson: artifacts.graphJson } };
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Codegraph artifact ${label} is missing.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Codegraph artifact ${label} is invalid JSON.`);
    }
    throw error;
  }
}

function assertArtifactChild(outDir: string, artifactPath: string): string {
  const resolved = path.resolve(outDir, artifactPath);
  const normalizedRoot = normalizePath(path.resolve(outDir));
  const normalizedFile = normalizePath(resolved);
  if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Codegraph artifact file is outside artifact directory: ${artifactPath}`);
  }
  return resolved;
}

function parseGraphJson(value: unknown): PortableGraphJson {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || value.format !== "codegraph.graph-json") {
    throw new Error("Codegraph artifact graph.json is missing or invalid.");
  }
  if (!isPlainRecord(value.graph) || !Array.isArray(value.graph.files) || !Array.isArray(value.graph.fileEdges)) {
    throw new Error("Codegraph artifact graph.json does not contain a portable graph.");
  }
  const files = value.graph.files.filter((entry): entry is string => typeof entry === "string").map(normalizePath).sort();
  const fileEdges: Edge[] = [];
  for (const edge of value.graph.fileEdges) {
    if (!isPlainRecord(edge) || typeof edge.from !== "string" || typeof edge.raw !== "string" || !isPlainRecord(edge.to)) {
      continue;
    }
    if (edge.to.type === "file" && typeof edge.to.path === "string") {
      fileEdges.push({ from: normalizePath(edge.from), raw: edge.raw, to: { type: "file", path: normalizePath(edge.to.path) } });
    } else if (edge.to.type === "external" && typeof edge.to.name === "string") {
      fileEdges.push({ from: normalizePath(edge.from), raw: edge.raw, to: { type: "external", name: edge.to.name } });
    }
  }
  const symbols = Array.isArray(value.graph.symbols)
    ? value.graph.symbols.filter((entry): entry is { file: string; name: string; kind: string } => {
        return isPlainRecord(entry) && typeof entry.file === "string" && typeof entry.name === "string" && typeof entry.kind === "string";
      })
    : [];
  return {
    schemaVersion: 1,
    format: "codegraph.graph-json",
    graph: { files, fileEdges, symbols },
  };
}

function languageId(id: string): string {
  if (id === "ts") return "typescript";
  return id;
}

function languageCounts(files: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const support = supportForFile(file);
    if (!support) continue;
    const id = languageId(support.id);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function edgeTarget(edge: Edge): string {
  if (edge.to.type === "file") return edge.to.path;
  return `external:${edge.to.name}`;
}

function edgeKey(edge: Edge): string {
  return `${edge.from}\0${edge.raw}\0${edgeTarget(edge)}`;
}

function graphEdges(edges: readonly Edge[]): ArchitectureGraphEdge[] {
  return edges
    .map((edge) => ({ key: edgeKey(edge), from: edge.from, to: edgeTarget(edge), raw: edge.raw }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function unresolvedImports(graph: Graph): { total: number; imports: ArchitectureUnresolvedImport[] } {
  const imports: ArchitectureUnresolvedImport[] = [];
  for (const item of getUnresolvedImports(graph)) {
    for (const importer of item.importers) {
      imports.push({ key: `${importer.file}\0${importer.raw}`, file: importer.file, specifier: importer.raw });
    }
  }
  imports.sort((left, right) => left.key.localeCompare(right.key));
  return { total: imports.length, imports };
}

export async function loadArchitectureSnapshotFromArtifact(outDirInput: string): Promise<ArchitectureSnapshot> {
  const outDir = path.resolve(outDirInput);
  const manifest = parseManifest(await readJson(path.join(outDir, "manifest.json"), "manifest"));
  if (!manifest) {
    throw new Error("Codegraph artifact manifest is missing graph.json metadata.");
  }
  const graphPath = assertArtifactChild(outDir, manifest.artifacts.graphJson);
  const graphJson = parseGraphJson(await readJson(graphPath, "graph.json"));
  const graph: Graph = { nodes: new Set(graphJson.graph.files), edges: graphJson.graph.fileEdges };
  return {
    schemaVersion: 1,
    root: outDir,
    files: { total: graphJson.graph.files.length, byLanguage: languageCounts(graphJson.graph.files) },
    hotspots: getHotspots(graph).map((entry) => ({ file: entry.file, fanIn: entry.fanIn, fanOut: entry.fanOut, score: entry.score })),
    cycles: sortDetailedCycles(findDetailedCycles(graph), "priority")
      .map((cycle) => {
        const files = cycle.files.map(normalizePath).sort();
        return { key: files.join("->"), files, priorityScore: cycle.priorityScore, size: cycle.fileCount };
      })
      .sort((left, right) => left.key.localeCompare(right.key)),
    unresolved: unresolvedImports(graph),
    publicApi: [],
    duplicates: { groups: { total: 0 }, topGroupKeys: [] },
    graphEdges: graphEdges(graph.edges),
    signalAvailability: {
      unresolved: false,
      publicApi: false,
      duplicates: false,
    },
  };
}
