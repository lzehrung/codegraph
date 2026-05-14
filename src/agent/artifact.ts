import fs from "node:fs/promises";
import path from "node:path";
import { getHotspots, type SymbolNode } from "../graphs.js";
import { writeGraphSqlite } from "../sqlite.js";
import { normalizePath, toProjectRelativePath } from "../util.js";
import { createAgentSession } from "./session.js";
import type { AgentProjectSnapshot, AgentSession } from "./session.js";

export type CodegraphArtifactBuildRequest = {
  root: string;
  outDir?: string;
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
  artifacts: Record<string, string>;
};

type ArtifactManifest = CodegraphArtifactBuildResult & {
  sql: {
    supported: boolean;
    limitation: string;
  };
  graphJsonSchema: string;
};

type ArtifactQuestion = {
  id: string;
  question: string;
  command: string;
};

const DEFAULT_OUT_DIR = "codegraph-out";
const SQLITE_FILE = "codegraph.sqlite";
const GRAPH_JSON_FILE = "graph.json";
const REPORT_FILE = "CODEGRAPH_REPORT.md";
const QUESTIONS_FILE = "questions.json";
const MANIFEST_FILE = "manifest.json";

export async function buildCodegraphArtifact(
  request: CodegraphArtifactBuildRequest,
): Promise<CodegraphArtifactBuildResult> {
  const root = path.resolve(request.root);
  const outDir = path.resolve(root, request.outDir ?? DEFAULT_OUT_DIR);
  const session = createAgentSession({
    root,
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
  const snapshot = filterSnapshotForOutputDirectory(await session.loadProject(), filterOutDir);
  await fs.mkdir(outDir, { recursive: true });
  const artifacts: Record<string, string> = {};

  if (selected.sqlite) {
    const outputPath = path.join(outDir, SQLITE_FILE);
    await writeGraphSqlite({
      fileGraph: snapshot.fileGraph,
      symbolGraph: snapshot.symbolGraph,
      outputPath,
    });
    artifacts.sqlite = SQLITE_FILE;
  }

  if (selected.graphJson) {
    await writeJson(path.join(outDir, GRAPH_JSON_FILE), buildGraphJson(snapshot));
    artifacts.graphJson = GRAPH_JSON_FILE;
  }

  if (selected.report) {
    await fs.writeFile(path.join(outDir, REPORT_FILE), buildReport(snapshot), "utf8");
    artifacts.report = REPORT_FILE;
  }

  if (selected.questions) {
    await writeJson(path.join(outDir, QUESTIONS_FILE), {
      schemaVersion: 1,
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
    },
    graphJsonSchema: "codegraph graph --json --symbols-detailed full",
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
  if (entries.length > 0 && !force) {
    throw new Error(`Refusing to write into non-empty output directory: ${outDir}. Pass --force to overwrite artifacts.`);
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

function buildGraphJson(snapshot: AgentProjectSnapshot): {
  files: string[];
  fileEdges: AgentProjectSnapshot["fileGraph"]["edges"];
  symbols: SymbolNode[];
  symbolEdges: AgentProjectSnapshot["symbolGraph"]["edges"];
} {
  return {
    files: [...snapshot.fileGraph.nodes].sort(),
    fileEdges: [...snapshot.fileGraph.edges].sort((left, right) => {
      const fromDelta = left.from.localeCompare(right.from);
      if (fromDelta !== 0) return fromDelta;
      const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
      const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
      return leftTo.localeCompare(rightTo);
    }),
    symbols: [...snapshot.symbolGraph.nodes.values()].sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.name.localeCompare(right.name);
    }),
    symbolEdges: [...snapshot.symbolGraph.edges].sort((left, right) => {
      const fromDelta = left.from.localeCompare(right.from);
      if (fromDelta !== 0) return fromDelta;
      const toDelta = left.to.localeCompare(right.to);
      if (toDelta !== 0) return toDelta;
      return (left.label ?? "").localeCompare(right.label ?? "");
    }),
  };
}

function filterSnapshotForOutputDirectory(snapshot: AgentProjectSnapshot, outDir: string): AgentProjectSnapshot {
  const relativeOutDir = toProjectRelativePath(snapshot.root, outDir);
  if (!relativeOutDir) return snapshot;
  const outputPrefix = `${relativeOutDir.replace(/\/+$/, "")}/`;
  const isOutputFile = (file: string): boolean => {
    const relative = toProjectRelativePath(snapshot.root, file);
    return relative === relativeOutDir || (relative?.startsWith(outputPrefix) ?? false);
  };

  const files = snapshot.files.filter((file) => !isOutputFile(file));
  const fileGraph = {
    nodes: new Set([...snapshot.fileGraph.nodes].filter((file) => !isOutputFile(file))),
    edges: snapshot.fileGraph.edges.filter((edge) => {
      if (isOutputFile(edge.from)) return false;
      return edge.to.type !== "file" || !isOutputFile(edge.to.path);
    }),
  };
  const symbols = new Map(
    [...snapshot.symbolGraph.nodes.entries()].filter(([, node]) => !isOutputFile(node.file)),
  );
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
    index,
    fileGraph,
    symbolGraph,
  };
}

function buildReport(snapshot: AgentProjectSnapshot): string {
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
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function formatHotspots(
  snapshot: AgentProjectSnapshot,
  hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>,
): string[] {
  if (hotspots.length === 0) return ["- None"];
  return hotspots.map(
    (hotspot) =>
      `- ${relativeFile(snapshot.root, hotspot.file)} (fan-in ${hotspot.fanIn}, fan-out ${hotspot.fanOut}, score ${hotspot.score})`,
  );
}

function buildQuestions(snapshot: AgentProjectSnapshot): ArtifactQuestion[] {
  const questions: ArtifactQuestion[] = [];
  const hotspots = getHotspots(snapshot.fileGraph, { limit: 3 });
  for (const hotspot of hotspots) {
    const file = relativeFile(snapshot.root, hotspot.file);
    questions.push({
      id: `rdeps:${file}`,
      question: `Which files depend on ${file}?`,
      command: `codegraph rdeps ${quoteArg(file)} --json`,
    });
  }

  const exportedSymbols = collectExportedSymbols(snapshot).slice(0, 3);
  for (const symbol of exportedSymbols) {
    questions.push({
      id: `refs:${symbol.file}:${symbol.name}`,
      question: `Where is ${symbol.name} referenced?`,
      command: `codegraph explain ${quoteArg(symbol.name)} --json`,
    });
  }

  const sqlObjects = collectSqlObjects(snapshot).slice(0, 3);
  for (const object of sqlObjects) {
    questions.push({
      id: `sql:${object.name}`,
      question: `What SQL objects are related to ${object.name}?`,
      command: `codegraph explain ${quoteArg(object.name)} --json`,
    });
  }

  return questions.sort((left, right) => left.id.localeCompare(right.id));
}

function collectExportedSymbols(snapshot: AgentProjectSnapshot): Array<{ name: string; file: string }> {
  const exported: Array<{ name: string; file: string }> = [];
  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const exportEntry of moduleIndex.exports) {
      if (exportEntry.type !== "local") continue;
      exported.push({
        name: exportEntry.exportedAs,
        file: relativeFile(snapshot.root, exportEntry.target.file),
      });
    }
  }
  return exported.sort((left, right) => {
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) return fileDelta;
    return left.name.localeCompare(right.name);
  });
}

function collectSqlObjects(snapshot: AgentProjectSnapshot): Array<{ name: string; kind: string; file: string }> {
  return [...snapshot.symbolGraph.nodes.values()]
    .filter((node) => node.kind === "table" || node.kind === "view" || node.kind === "index" || node.kind === "routine")
    .map((node) => ({
      name: node.name,
      kind: node.kind,
      file: relativeFile(snapshot.root, node.file),
    }))
    .sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.name.localeCompare(right.name);
    });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function relativeFile(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}
