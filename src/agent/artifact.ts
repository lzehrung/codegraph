import fs from "node:fs/promises";
import path from "node:path";
import { getHotspots } from "../graphs/hotspots.js";
import { type SymbolNode, type SymbolEdge } from "../graphs/symbol-graph.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import type { BuildOptions } from "../indexer/types.js";
import { queryGraphSqliteRaw, writeGraphSqlite } from "../sqlite.js";
import { isPlainRecord } from "../util/guards.js";
import { fileIdentityKey, isFilePathWithinRoot, normalizePath, toProjectRelativePath } from "../util/paths.js";
import { formatAgentSqlHandle, formatAgentSymbolHandle } from "./handles.js";
import { createAgentFileLookup, normalizeAgentFilePath } from "./normalize.js";
import { createAgentSession } from "./session.js";
import type { AgentProjectSnapshot, AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type CodegraphArtifactBuildRequest = {
  root: string;
  outDir?: string;
  buildOptions?: BuildOptions;
  filterOutDir?: string;
  sqlite?: boolean;
  graphJson?: boolean;
  report?: boolean;
  questions?: boolean;
  force?: boolean;
};

export type CodegraphArtifactBuildResult = {
  schemaVersion: 1;
  root: string;
  outDir: string;
  manifestPath: string;
  artifacts: {
    sqlite?: string;
    graphJson?: string;
    report?: string;
    questions?: string;
  };
};

type ArtifactManifest = CodegraphArtifactBuildResult & {
  sql: {
    supported: boolean;
    limitation: string;
    fileSignatures: {
      signed: number;
      skipped: number;
    };
  };
  graphJsonSchema: string;
};

type ArtifactQuestion = {
  id: string;
  question: string;
  command: string;
  handle?: string;
};

type PortableGraphBody = {
  files: string[];
  fileEdges: Array<{
    from: string;
    to: { type: "file"; path: string } | { type: "external"; name: string };
    raw: string;
    typeOnly?: boolean;
    resolved?: "heuristic" | "precise";
    confidence?: number;
  }>;
  symbols: Array<SymbolNode & { file: string }>;
  symbolEdges: AgentProjectSnapshot["symbolGraph"]["edges"];
};

type PortableGraphJson = PortableGraphBody & {
  schemaVersion: 2;
  format: "codegraph.graph-json";
  graph: PortableGraphBody;
};

const DEFAULT_OUT_DIR = "codegraph-out";
const SQLITE_FILE = "codegraph.sqlite";
const GRAPH_JSON_FILE = "graph.json";
const REPORT_FILE = "CODEGRAPH_REPORT.md";
const QUESTIONS_FILE = "questions.json";
const MANIFEST_FILE = "manifest.json";
const RESERVED_ARTIFACT_FILES = new Set([SQLITE_FILE, GRAPH_JSON_FILE, REPORT_FILE, QUESTIONS_FILE, MANIFEST_FILE]);

export async function buildCodegraphArtifact(
  request: CodegraphArtifactBuildRequest,
): Promise<CodegraphArtifactBuildResult> {
  const root = path.resolve(request.root);
  const outDir = path.resolve(root, request.outDir ?? DEFAULT_OUT_DIR);
  const session = createAgentSession({
    root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
    discovery: {
      ignoreGlobs: outputIgnoreGlobs(root, outDir),
    },
  });
  return await buildCodegraphArtifactWithSession(session, request);
}

export async function buildCodegraphArtifactWithSession(
  session: AgentSession,
  request: CodegraphArtifactBuildRequest,
): Promise<CodegraphArtifactBuildResult> {
  const root = path.resolve(request.root);
  const outDir = path.resolve(root, request.outDir ?? DEFAULT_OUT_DIR);
  await validateOutputDirectory(outDir, request.force ?? false);

  const selected = normalizeArtifactSelection(request);
  const filterOutDir = path.resolve(root, request.filterOutDir ?? request.outDir ?? DEFAULT_OUT_DIR);
  const snapshot = await filterSnapshotForOutputDirectory(await session.loadProject(), filterOutDir);
  await fs.mkdir(outDir, { recursive: true });
  if (request.force) {
    await prepareForcedOutputDirectory(outDir, selected);
  }
  const artifacts: CodegraphArtifactBuildResult["artifacts"] = {};
  let sqliteFileSignatures = { signed: 0, skipped: 0 };

  if (selected.sqlite) {
    const fileSignatures: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const file of snapshot.fileGraph.nodes) {
      const signature = snapshot.fileSignatures?.get(file);
      if (!signature) {
        sqliteFileSignatures = { ...sqliteFileSignatures, skipped: sqliteFileSignatures.skipped + 1 };
        continue;
      }
      fileSignatures.push({ path: signature.file, size: signature.size, mtimeMs: signature.mtimeMs });
    }
    sqliteFileSignatures = { signed: fileSignatures.length, skipped: sqliteFileSignatures.skipped };
    const outputPath = path.join(outDir, SQLITE_FILE);
    await writeGraphSqlite({
      fileGraph: snapshot.fileGraph,
      symbolGraph: snapshot.symbolGraph,
      outputPath,
      fileSignatures,
    });
    artifacts.sqlite = SQLITE_FILE;
  }

  if (selected.graphJson) {
    await writeJson(path.join(outDir, GRAPH_JSON_FILE), buildCodegraphGraphJson(snapshot));
    artifacts.graphJson = GRAPH_JSON_FILE;
  }

  if (selected.report) {
    await fs.writeFile(
      path.join(outDir, REPORT_FILE),
      buildReport(snapshot, selected.graphJson ? path.join(outDir, GRAPH_JSON_FILE) : undefined),
      "utf8",
    );
    artifacts.report = REPORT_FILE;
  }

  if (selected.questions) {
    await writeJson(path.join(outDir, QUESTIONS_FILE), {
      schemaVersion: 1,
      format: "codegraph.questions",
      questions: buildQuestions(snapshot),
    });
    artifacts.questions = QUESTIONS_FILE;
  }

  const manifestPath = path.join(outDir, MANIFEST_FILE);
  const result: CodegraphArtifactBuildResult = {
    schemaVersion: 1,
    root,
    outDir,
    manifestPath,
    artifacts,
  };
  const manifest: ArtifactManifest = {
    ...result,
    sql: {
      supported: true,
      limitation: "SQL support does not perform current-schema reconstruction.",
      fileSignatures: sqliteFileSignatures,
    },
    graphJsonSchema: "codegraph.graph-json",
  };
  await writeJson(manifestPath, manifest);

  return result;
}

function normalizeArtifactSelection(request: CodegraphArtifactBuildRequest): {
  sqlite: boolean;
  graphJson: boolean;
  report: boolean;
  questions: boolean;
} {
  const hasExplicitSelection =
    request.sqlite !== undefined ||
    request.graphJson !== undefined ||
    request.report !== undefined ||
    request.questions !== undefined;
  if (!hasExplicitSelection) {
    return {
      sqlite: true,
      graphJson: true,
      report: true,
      questions: true,
    };
  }
  return {
    sqlite: request.sqlite ?? false,
    graphJson: request.graphJson ?? false,
    report: request.report ?? false,
    questions: request.questions ?? false,
  };
}

async function validateOutputDirectory(outDir: string, force: boolean): Promise<void> {
  const entries = await readDirectoryIfPresent(outDir);
  if (entries.length && !force) {
    throw new Error(
      `Refusing to write into non-empty output directory: ${outDir}. Pass --force to overwrite artifacts.`,
    );
  }
}

async function prepareForcedOutputDirectory(
  outDir: string,
  selected: { sqlite: boolean; graphJson: boolean; report: boolean; questions: boolean },
): Promise<void> {
  const cleanup = new Set<string>();
  const manifest = await readCodegraphManifest(outDir);
  if (manifest) {
    cleanup.add(MANIFEST_FILE);
    for (const artifactFile of Object.values(manifest.artifacts)) {
      if (RESERVED_ARTIFACT_FILES.has(artifactFile)) {
        cleanup.add(artifactFile);
      }
    }
  }

  for (const fileName of RESERVED_ARTIFACT_FILES) {
    if (cleanup.has(fileName)) continue;
    const filePath = path.join(outDir, fileName);
    if ((await fileExists(filePath)) && (await isRecognizedCodegraphArtifact(filePath, fileName))) {
      cleanup.add(fileName);
    }
  }

  for (const fileName of selectedArtifactFileNames(selected)) {
    if (cleanup.has(fileName)) continue;
    const filePath = path.join(outDir, fileName);
    if (!(await fileExists(filePath))) continue;
    if (!(await isRecognizedCodegraphArtifact(filePath, fileName))) {
      throw new Error(`Refusing to overwrite unrecognized file in artifact output directory: ${filePath}`);
    }
    cleanup.add(fileName);
  }

  await Promise.all([...cleanup].map(async (fileName) => await removeFileIfPresent(path.join(outDir, fileName))));
}

function selectedArtifactFileNames(selected: {
  sqlite: boolean;
  graphJson: boolean;
  report: boolean;
  questions: boolean;
}): string[] {
  const fileNames = [MANIFEST_FILE];
  if (selected.sqlite) fileNames.push(SQLITE_FILE);
  if (selected.graphJson) fileNames.push(GRAPH_JSON_FILE);
  if (selected.report) fileNames.push(REPORT_FILE);
  if (selected.questions) fileNames.push(QUESTIONS_FILE);
  return fileNames;
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
async function readCodegraphManifest(outDir: string): Promise<ArtifactManifest | undefined> {
  const value = await readJsonIfPresent(path.join(outDir, MANIFEST_FILE));
  if (!isPlainRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.graphJsonSchema !== "codegraph.graph-json") return undefined;
  if (!isPlainRecord(value.artifacts)) return undefined;
  const artifacts: CodegraphArtifactBuildResult["artifacts"] = {};
  for (const [key, artifactFile] of Object.entries(value.artifacts)) {
    if (typeof artifactFile !== "string") continue;
    if (key === "sqlite") artifacts.sqlite = artifactFile;
    if (key === "graphJson") artifacts.graphJson = artifactFile;
    if (key === "report") artifacts.report = artifactFile;
    if (key === "questions") artifacts.questions = artifactFile;
  }
  const sql = isPlainRecord(value.sql) ? value.sql : undefined;
  const fileSignatures = sql && isPlainRecord(sql.fileSignatures) ? sql.fileSignatures : undefined;
  return {
    schemaVersion: 1,
    root: typeof value.root === "string" ? value.root : "",
    outDir: typeof value.outDir === "string" ? value.outDir : outDir,
    manifestPath: typeof value.manifestPath === "string" ? value.manifestPath : path.join(outDir, MANIFEST_FILE),
    artifacts,
    sql: {
      supported: true,
      limitation: "",
      fileSignatures: {
        signed: typeof fileSignatures?.signed === "number" ? fileSignatures.signed : 0,
        skipped: typeof fileSignatures?.skipped === "number" ? fileSignatures.skipped : 0,
      },
    },
    graphJsonSchema: "codegraph.graph-json",
  };
}

async function isRecognizedCodegraphArtifact(filePath: string, fileName: string): Promise<boolean> {
  if (fileName === MANIFEST_FILE) {
    return (await readCodegraphManifest(path.dirname(filePath))) !== undefined;
  }
  if (fileName === GRAPH_JSON_FILE) {
    const value = await readJsonIfPresent(filePath);
    return isPlainRecord(value) && value.format === "codegraph.graph-json";
  }
  if (fileName === QUESTIONS_FILE) {
    const value = await readJsonIfPresent(filePath);
    return isPlainRecord(value) && value.format === "codegraph.questions";
  }
  if (fileName === REPORT_FILE) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      return text.startsWith("# Codegraph Report\n");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }
  if (fileName === SQLITE_FILE) {
    return await isRecognizedCodegraphSqlite(filePath);
  }
  return false;
}

async function isRecognizedCodegraphSqlite(filePath: string): Promise<boolean> {
  try {
    const header = await readSqliteHeader(filePath);
    if (!header.equals(Buffer.from("SQLite format 3\0", "ascii"))) return false;
    const metadata = await queryGraphSqliteRaw(
      filePath,
      "SELECT value FROM graph_metadata WHERE key = 'schema_version' LIMIT 1;",
    );
    const schemaVersion = metadata.rows[0]?.[0];
    if (typeof schemaVersion !== "string" || !/^\d+$/.test(schemaVersion)) return false;

    const tables = await queryGraphSqliteRaw(
      filePath,
      [
        "SELECT name FROM sqlite_master",
        "WHERE type = 'table'",
        "AND name IN ('files', 'file_edges', 'symbols', 'symbol_edges', 'graph_metadata')",
        "ORDER BY name;",
      ].join(" "),
    );
    const tableNames = new Set(
      tables.rows.map((row) => row[0]).filter((value): value is string => typeof value === "string"),
    );
    return ["files", "file_edges", "graph_metadata", "symbol_edges", "symbols"].every((tableName) =>
      tableNames.has(tableName),
    );
  } catch {
    return false;
  }
}

async function readSqliteHeader(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readDirectoryIfPresent(outDir: string): Promise<string[]> {
  try {
    return await fs.readdir(outDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function outputIgnoreGlobs(root: string, outDir: string): string[] {
  const relative = toProjectRelativePath(root, outDir);
  if (!relative) return [];
  return [`${relative}/**`];
}

export function buildCodegraphGraphJson(snapshot: AgentProjectSnapshot): {
  schemaVersion: 2;
  format: "codegraph.graph-json";
  files: PortableGraphJson["files"];
  fileEdges: PortableGraphJson["fileEdges"];
  symbols: PortableGraphJson["symbols"];
  symbolEdges: PortableGraphJson["symbolEdges"];
  graph: PortableGraphJson["graph"];
} {
  const symbolIds = buildPortableSymbolIdMap(snapshot);
  const symbolPositions = buildPortableSymbolPositions(snapshot, symbolIds);
  const portableSymbolId = (id: string): string => symbolIds.get(id) ?? id;
  const graph: PortableGraphBody = {
    files: [...snapshot.fileGraph.nodes].map((file) => normalizeAgentFilePath(snapshot.root, file)).sort(),
    fileEdges: [...snapshot.fileGraph.edges]
      .map((edge) => ({
        ...edge,
        from: normalizeAgentFilePath(snapshot.root, edge.from),
        to:
          edge.to.type === "file"
            ? { type: "file" as const, path: normalizeAgentFilePath(snapshot.root, edge.to.path) }
            : { type: "external" as const, name: edge.to.name },
      }))
      .sort((left, right) => {
        const fromDelta = left.from.localeCompare(right.from);
        if (fromDelta !== 0) return fromDelta;
        const leftToType = left.to.type;
        const rightToType = right.to.type;
        const toTypeDelta = leftToType.localeCompare(rightToType);
        if (toTypeDelta !== 0) return toTypeDelta;
        const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
        const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
        const toDelta = leftTo.localeCompare(rightTo);
        if (toDelta !== 0) return toDelta;
        const rawDelta = left.raw.localeCompare(right.raw);
        if (rawDelta !== 0) return rawDelta;
        const typeOnlyDelta = Number(left.typeOnly ?? false) - Number(right.typeOnly ?? false);
        if (typeOnlyDelta !== 0) return typeOnlyDelta;
        const resolvedDelta = (left.resolved ?? "").localeCompare(right.resolved ?? "");
        if (resolvedDelta !== 0) return resolvedDelta;
        return (left.confidence ?? -1) - (right.confidence ?? -1);
      }),
    symbols: [...snapshot.symbolGraph.nodes.values()]
      .map((node) => ({
        ...node,
        id: portableSymbolId(node.id),
        file: normalizeAgentFilePath(snapshot.root, node.file),
      }))
      .sort((left, right) => {
        const fileDelta = left.file.localeCompare(right.file);
        if (fileDelta !== 0) return fileDelta;
        const nameDelta = left.name.localeCompare(right.name);
        if (nameDelta !== 0) return nameDelta;
        const kindDelta = left.kind.localeCompare(right.kind);
        if (kindDelta !== 0) return kindDelta;
        const leftPosition = symbolPositions.get(left.id) ?? ZERO_SYMBOL_POSITION;
        const rightPosition = symbolPositions.get(right.id) ?? ZERO_SYMBOL_POSITION;
        const lineDelta = leftPosition.line - rightPosition.line;
        if (lineDelta !== 0) return lineDelta;
        const columnDelta = leftPosition.column - rightPosition.column;
        if (columnDelta !== 0) return columnDelta;
        return left.id.localeCompare(right.id);
      }),
    symbolEdges: [...snapshot.symbolGraph.edges]
      .map((edge) => ({
        ...edge,
        from: portableSymbolId(edge.from),
        to: portableSymbolId(edge.to),
      }))
      .sort((left, right) => {
        const fromDelta = left.from.localeCompare(right.from);
        if (fromDelta !== 0) return fromDelta;
        const toDelta = left.to.localeCompare(right.to);
        if (toDelta !== 0) return toDelta;
        const labelDelta = (left.label ?? "").localeCompare(right.label ?? "");
        if (labelDelta !== 0) return labelDelta;
        return compareSymbolEdgeSites(snapshot.root, left.site, right.site);
      }),
  };
  return {
    schemaVersion: 2,
    format: "codegraph.graph-json",
    files: graph.files,
    fileEdges: graph.fileEdges,
    symbols: graph.symbols,
    symbolEdges: graph.symbolEdges,
    graph,
  };
}

type SymbolPosition = { line: number; column: number };
const ZERO_SYMBOL_POSITION: SymbolPosition = { line: 0, column: 0 };

function buildPortableSymbolPositions(
  snapshot: AgentProjectSnapshot,
  symbolIds: ReadonlyMap<string, string>,
): Map<string, SymbolPosition> {
  const positions = new Map<string, SymbolPosition>();
  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      const portableId = symbolIds.get(defNodeId(local));
      if (!portableId) continue;
      positions.set(portableId, {
        line: local.range.start.line,
        column: local.range.start.column,
      });
    }
  }
  return positions;
}

function compareSymbolEdgeSites(root: string, left: SymbolEdge["site"], right: SymbolEdge["site"]): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const fileDelta = normalizeAgentFilePath(root, left.file).localeCompare(normalizeAgentFilePath(root, right.file));
  if (fileDelta !== 0) return fileDelta;
  const startLineDelta = left.range.start.line - right.range.start.line;
  if (startLineDelta !== 0) return startLineDelta;
  const startColumnDelta = left.range.start.column - right.range.start.column;
  if (startColumnDelta !== 0) return startColumnDelta;
  const startIndexDelta = (left.range.start.index ?? -1) - (right.range.start.index ?? -1);
  if (startIndexDelta !== 0) return startIndexDelta;
  const endLineDelta = left.range.end.line - right.range.end.line;
  if (endLineDelta !== 0) return endLineDelta;
  const endColumnDelta = left.range.end.column - right.range.end.column;
  if (endColumnDelta !== 0) return endColumnDelta;
  return (left.range.end.index ?? -1) - (right.range.end.index ?? -1);
}

function buildPortableSymbolIdMap(snapshot: AgentProjectSnapshot): Map<string, string> {
  const byId = new Map<string, string>();
  const graphNodeIds = new Set<string>();
  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      const relFile = normalizeAgentFilePath(snapshot.root, local.file);
      const id = defNodeId(local);
      const isSqlObject = local.file.toLowerCase().endsWith(".sql");
      byId.set(
        id,
        isSqlObject
          ? formatAgentSqlHandle({ name: local.localName, file: relFile, line: local.range.start.line })
          : formatAgentSymbolHandle({
              file: relFile,
              name: local.localName,
              line: local.range.start.line,
              column: local.range.start.column,
            }),
      );
    }
  }

  for (const node of snapshot.symbolGraph.nodes.values()) {
    if (byId.has(node.id)) continue;
    const relFile = normalizeAgentFilePath(snapshot.root, node.file);
    byId.set(node.id, uniqueGraphSymbolId(graphNodeIds, relFile, node));
  }
  return byId;
}

function uniqueGraphSymbolId(seen: Set<string>, relFile: string, node: SymbolNode): string {
  const base = [
    "graph-symbol",
    encodeURIComponent(relFile),
    encodeURIComponent(node.kind),
    encodeURIComponent(node.name),
  ].join(":");
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}:${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

async function filterSnapshotForOutputDirectory(
  snapshot: AgentProjectSnapshot,
  outDir: string,
): Promise<AgentProjectSnapshot> {
  const outputDirs = await collectRelativeOutputDirectories(snapshot.root, outDir);
  if (!outputDirs.length) return snapshot;
  const isOutputFile = (file: string): boolean => {
    const relative = toProjectRelativePath(snapshot.root, file);
    if (!relative) return false;
    return outputDirs.some((outputDir) => relative === outputDir.relative || relative.startsWith(outputDir.prefix));
  };

  const files = snapshot.files.filter((file) => !isOutputFile(file));
  const fileGraph = {
    nodes: new Set([...snapshot.fileGraph.nodes].filter((file) => !isOutputFile(file))),
    edges: snapshot.fileGraph.edges.filter((edge) => {
      if (isOutputFile(edge.from)) return false;
      return edge.to.type !== "file" || !isOutputFile(edge.to.path);
    }),
  };
  const symbols = new Map([...snapshot.symbolGraph.nodes.entries()].filter(([, node]) => !isOutputFile(node.file)));
  const symbolGraph = {
    nodes: symbols,
    edges: snapshot.symbolGraph.edges.filter((edge) => symbols.has(edge.from) && symbols.has(edge.to)),
  };
  const byFile = new Map([...snapshot.index.byFile.entries()].filter(([file]) => !isOutputFile(file)));
  const modules = new Map([...snapshot.index.modules.entries()].filter(([file]) => !isOutputFile(file)));
  const index = {
    ...snapshot.index,
    graph: fileGraph,
    byFile,
    modules,
  };

  return {
    ...snapshot,
    files,
    fileLookup: createAgentFileLookup(files),
    index,
    fileGraph,
    symbolGraph,
  };
}

async function collectRelativeOutputDirectories(
  root: string,
  outDir: string,
): Promise<Array<{ relative: string; prefix: string }>> {
  const filters: Array<{ relative: string; prefix: string }> = [];
  const seen = new Set<string>();
  const addRelative = (relative: string | null): void => {
    if (!relative) return;
    const normalized = relative.replace(/\/+$/, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    filters.push({ relative: normalized, prefix: `${normalized}/` });
  };

  addRelative(toProjectRelativePath(root, outDir));

  try {
    const [realRoot, realOutDir] = await Promise.all([fs.realpath(root), fs.realpath(outDir)]);
    if (isFilePathWithinRoot(realRoot, realOutDir)) {
      addRelative(normalizePath(path.relative(realRoot, realOutDir)));
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  return filters;
}

function buildReport(snapshot: AgentProjectSnapshot, graphPath?: string): string {
  const hotspots = getHotspots(snapshot.fileGraph, { limit: 5 });
  const sqlObjects = collectSqlObjects(snapshot).slice(0, 10);
  const questions = buildQuestions(snapshot).slice(0, 5);
  const lines = [
    "# Codegraph Report",
    "",
    `Root: ${normalizePath(snapshot.root)}`,
    `Files: ${snapshot.files.length}`,
    `File edges: ${snapshot.fileGraph.edges.length}`,
    `Symbols: ${snapshot.symbolGraph.nodes.size}`,
    `Symbol edges: ${snapshot.symbolGraph.edges.length}`,
    "",
    "## Hotspots",
    ...formatHotspots(snapshot, hotspots),
    "",
    "## SQL",
    "SQL files are indexed for objects, statement chunks, SQL-to-SQL graph edges, navigation, and review context.",
    "Limitation: no current-schema reconstruction.",
    ...sqlObjects.map((object) => `- ${object.name} (${object.kind}) in ${object.file}`),
    "",
    "## Suggested Questions",
    ...questions.map((entry) => `- ${entry.question}`),
    ...(graphPath
      ? [
          "",
          "## Graph Viewer",
          `Open this artifact graph in the packaged human viewer:`,
          `codegraph viewer --root ${quoteShellArg(path.dirname(graphPath))} --graph ${quoteShellArg(path.basename(graphPath))} --open`,
        ]
      : []),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function formatHotspots(
  snapshot: AgentProjectSnapshot,
  hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>,
): string[] {
  if (!hotspots.length) return ["- None"];
  return hotspots.map(
    (hotspot) =>
      `- ${normalizeAgentFilePath(snapshot.root, hotspot.file)} (fan-in ${hotspot.fanIn}, fan-out ${hotspot.fanOut}, score ${hotspot.score})`,
  );
}

function buildQuestions(snapshot: AgentProjectSnapshot): ArtifactQuestion[] {
  const questions: ArtifactQuestion[] = [];
  const hotspots = getHotspots(snapshot.fileGraph, { limit: 3 });
  for (const hotspot of hotspots) {
    const file = normalizeAgentFilePath(snapshot.root, hotspot.file);
    questions.push({
      id: `rdeps:${file}`,
      question: `Which files depend on ${file}?`,
      command: `codegraph rdeps ${quoteShellArg(file)} --json`,
    });
  }

  const seenSymbolHandles = new Set<string>();
  for (const symbol of collectExportedSymbols(snapshot)) {
    if (seenSymbolHandles.has(symbol.handle)) continue;
    if (seenSymbolHandles.size >= 3) break;
    seenSymbolHandles.add(symbol.handle);
    const symbolLabel = symbol.localName === symbol.name ? symbol.name : `${symbol.name} (${symbol.localName})`;
    questions.push({
      id: `refs:${symbol.handle}`,
      question: `Where is ${symbolLabel} referenced?`,
      command: `codegraph explain ${quoteShellArg(symbol.handle)} --json`,
      handle: symbol.handle,
    });
  }

  const sqlObjects = collectSqlObjects(snapshot).slice(0, 3);
  for (const object of sqlObjects) {
    questions.push({
      id: `sql:${object.handle}`,
      question: `What SQL objects are related to ${object.name}?`,
      command: `codegraph explain ${quoteShellArg(object.handle)} --json`,
      handle: object.handle,
    });
  }

  return questions.sort((left, right) => left.id.localeCompare(right.id));
}

function collectExportedSymbols(
  snapshot: AgentProjectSnapshot,
): Array<{ name: string; localName: string; file: string; handle: string }> {
  const exported: Array<{ name: string; localName: string; file: string; handle: string }> = [];
  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const exportEntry of moduleIndex.exports) {
      if (exportEntry.type !== "local") continue;
      const file = normalizeAgentFilePath(snapshot.root, exportEntry.target.file);
      exported.push({
        name: exportEntry.exportedAs,
        localName: exportEntry.target.localName,
        file,
        handle: formatAgentSymbolHandle({
          file,
          name: exportEntry.target.localName,
          line: exportEntry.target.range.start.line,
          column: exportEntry.target.range.start.column,
        }),
      });
    }
  }
  return exported.sort((left, right) => {
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) return fileDelta;
    const nameDelta = left.name.localeCompare(right.name);
    if (nameDelta !== 0) return nameDelta;
    return left.localName.localeCompare(right.localName);
  });
}

function collectSqlObjects(
  snapshot: AgentProjectSnapshot,
): Array<{ name: string; kind: string; file: string; handle: string }> {
  return [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => node.kind === "table" || node.kind === "view" || node.kind === "index" || node.kind === "routine")
    .map((node) => {
      const file = normalizeAgentFilePath(snapshot.root, node.file);
      const def = snapshot.index.byFile
        .get(fileIdentityKey(node.file))
        ?.locals.find((local) => defNodeId(local) === node.id);
      return {
        name: node.name,
        kind: node.kind,
        file,
        handle: formatAgentSqlHandle({ name: node.name, file, line: def?.range.start.line ?? 0 }),
      };
    })
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.name.localeCompare(right.name);
    });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
