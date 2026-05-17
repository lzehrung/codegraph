import path from "node:path";

import {
  buildProjectIndex as defaultBuildProjectIndex,
  getApiSurface,
  type BuildOptions,
  type ProjectIndex,
} from "../indexer.js";
import {
  collectGraph as defaultCollectGraph,
  findDetailedCycles,
  getDependencies,
  getReverseDependencies,
  getShortestPath,
  getUnresolvedImports,
  sortDetailedCycles,
  type GraphBuildOptions,
} from "../graphs.js";
import type { Graph } from "../types.js";
import { assertFilePathWithinRoot } from "../util.js";

export type GraphQueryCommand = "deps" | "rdeps" | "path" | "cycles" | "unresolved" | "apisurface";

type CliProjectFileInput =
  | { status: "ok"; file: string }
  | { status: "error"; reason: "outside_project_root"; error: string };

export type GraphQueryCommandContext = {
  command: GraphQueryCommand;
  positionals: string[];
  projectRootFs: string;
  projectRootAbs: string;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
  listProjectFilesForScan: () => Promise<string[]>;
  graphOptions?: GraphBuildOptions;
  indexOptions?: BuildOptions;
  collectGraph?: (projectRoot: string, files: string[], options?: GraphBuildOptions) => Promise<Graph>;
  buildProjectIndex?: (root: string, options?: BuildOptions) => Promise<ProjectIndex>;
};

function resolveCliProjectFile(projectRoot: string, fileArg: string, label: string): CliProjectFileInput {
  try {
    return {
      status: "ok",
      file: assertFilePathWithinRoot(projectRoot, fileArg, label),
    };
  } catch (error) {
    return {
      status: "error",
      reason: "outside_project_root",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeCliProjectFileError(
  context: Pick<GraphQueryCommandContext, "writeJSONLine" | "writeStdoutLine">,
  result: Extract<CliProjectFileInput, { status: "error" }>,
  output: "json" | "text" = "json",
): void {
  if (output === "json") {
    context.writeJSONLine(result);
    return;
  }
  context.writeStdoutLine(`error: ${result.reason}: ${result.error}`);
}

async function loadGraph(context: GraphQueryCommandContext): Promise<Graph> {
  const collectGraph = context.collectGraph ?? defaultCollectGraph;
  return collectGraph(context.projectRootFs, await context.listProjectFilesForScan(), context.graphOptions);
}

async function handleDepsCommand(context: GraphQueryCommandContext): Promise<void> {
  const [fileArg] = context.positionals;
  if (!fileArg) {
    context.writeStderrLine(`Usage: ${context.command} <file> [--depth N] [--json]`);
    context.exit(2);
  }
  const depthRaw = context.getOpt("--depth");
  const depth = depthRaw !== undefined ? Number(depthRaw) : undefined;
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
    context.writeStderrLine(`Invalid --depth value "${depthRaw}". Expected a non-negative integer.`);
    context.exit(2);
  }
  const json = context.hasFlag("--json");
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, fileArg, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, json ? "json" : "text");
    return;
  }

  const graph = await loadGraph(context);
  const results =
    context.command === "deps"
      ? getDependencies(graph, resolvedFile.file, depth !== undefined ? { depth } : {})
      : getReverseDependencies(graph, resolvedFile.file, depth !== undefined ? { depth } : {});

  if (json) {
    context.writeJSONLine(results);
    return;
  }

  context.writeStdoutLine(`${context.command === "deps" ? "Dependencies" : "Reverse dependencies"} for ${fileArg}:`);
  for (const result of results) {
    const rel = path.relative(context.projectRootFs, result.file);
    context.writeStdoutLine(`${"  ".repeat(result.depth)} ${rel} (depth ${result.depth})`);
  }
}

async function handlePathCommand(context: GraphQueryCommandContext): Promise<void> {
  const [fromArg, toArg] = context.positionals;
  if (!fromArg || !toArg) {
    context.writeStderrLine("Usage: path <from-file> <to-file> [--json]");
    context.exit(2);
  }
  const json = context.hasFlag("--json");
  const resolvedFrom = resolveCliProjectFile(context.projectRootFs, fromArg, "From file");
  if (resolvedFrom.status === "error") {
    writeCliProjectFileError(context, resolvedFrom, json ? "json" : "text");
    return;
  }
  const resolvedTo = resolveCliProjectFile(context.projectRootFs, toArg, "To file");
  if (resolvedTo.status === "error") {
    writeCliProjectFileError(context, resolvedTo, json ? "json" : "text");
    return;
  }

  const graph = await loadGraph(context);
  const pathResult = getShortestPath(graph, resolvedFrom.file, resolvedTo.file);

  if (json) {
    context.writeJSONLine(pathResult);
  } else if (pathResult) {
    context.writeStdoutLine(`Path from ${fromArg} to ${toArg}:`);
    context.writeStdoutLine(pathResult.map((entry) => path.relative(context.projectRootFs, entry)).join(" -> "));
  } else {
    context.writeStdoutLine(`No path found from ${fromArg} to ${toArg}`);
  }
}

async function handleCyclesCommand(context: GraphQueryCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const sortModeRaw = context.getOpt("--sort") ?? "priority";
  const sortMode = sortModeRaw === "priority" || sortModeRaw === "size" || sortModeRaw === "fanin" ? sortModeRaw : null;
  if (!sortMode) {
    context.writeStderrLine("Invalid --sort value. Use one of: priority, size, fanin.");
    context.exit(2);
  }

  const graph = await loadGraph(context);
  const cycleDetails = sortDetailedCycles(findDetailedCycles(graph), sortMode);

  if (json) {
    context.writeJSONLine(cycleDetails);
    return;
  }

  if (!cycleDetails.length) {
    context.writeStdoutLine("No dependency cycles found.");
    return;
  }

  context.writeStdoutLine(`Found ${cycleDetails.length} dependency cycles (sorted by ${sortMode}):`);
  for (let i = 0; i < cycleDetails.length; i++) {
    const cycle = cycleDetails[i]!;
    context.writeStdoutLine(`Cycle ${i + 1} (priority=${cycle.priorityScore}):`);
    context.writeStdoutLine(`  ${cycle.files.map((entry) => path.relative(context.projectRootFs, entry)).join(" -> ")} -> ...`);
    if (cycle.entryEdges.length) {
      context.writeStdoutLine("  Incoming edges:");
      for (const edge of cycle.entryEdges) {
        context.writeStdoutLine(
          `    ${path.relative(context.projectRootFs, edge.from)} -> ${path.relative(context.projectRootFs, edge.to)} (import ${edge.raw})`,
        );
      }
    }
    if (cycle.internalEdges.length) {
      context.writeStdoutLine("  Internal cycle edges:");
      for (const edge of cycle.internalEdges) {
        context.writeStdoutLine(
          `    ${path.relative(context.projectRootFs, edge.from)} -> ${path.relative(context.projectRootFs, edge.to)} (import ${edge.raw})`,
        );
      }
    }
    context.writeStdoutLine(`  Hint: ${cycle.remediationHint}`);
  }
}

async function handleUnresolvedCommand(context: GraphQueryCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const graph = await loadGraph(context);
  const unresolved = getUnresolvedImports(graph, { projectRoot: context.projectRootFs });

  if (json) {
    context.writeJSONLine(unresolved);
    return;
  }

  if (!unresolved.length) {
    context.writeStdoutLine("No unresolved external imports found.");
    return;
  }

  context.writeStdoutLine(`Found ${unresolved.length} unresolved external imports:`);
  for (const item of unresolved) {
    context.writeStdoutLine(`- ${item.name} (imported by ${item.importers.length} files)`);
    if (context.hasFlag("--verbose")) {
      for (const imp of item.importers) {
        context.writeStdoutLine(`    ${path.relative(context.projectRootFs, imp.file)} (as "${imp.raw}")`);
      }
    }
  }
}

async function handleApiSurfaceCommand(context: GraphQueryCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const buildProjectIndex = context.buildProjectIndex ?? defaultBuildProjectIndex;
  const index = await buildProjectIndex(context.projectRootFs, context.indexOptions);
  const apiSurface = getApiSurface(index);

  if (json) {
    context.writeJSONLine(apiSurface);
    return;
  }

  context.writeStdoutLine(`API Surface for ${context.projectRootAbs}:`);
  for (const item of apiSurface) {
    context.writeStdoutLine(`  ${path.relative(context.projectRootFs, item.file)}:`);
    for (const exp of item.exports) {
      context.writeStdoutLine(`    - ${exp.exportedAs} (${exp.kind})`);
    }
  }
}

export async function handleGraphQueryCommand(context: GraphQueryCommandContext): Promise<void> {
  if (context.command === "deps" || context.command === "rdeps") {
    await handleDepsCommand(context);
    return;
  }
  if (context.command === "path") {
    await handlePathCommand(context);
    return;
  }
  if (context.command === "cycles") {
    await handleCyclesCommand(context);
    return;
  }
  if (context.command === "unresolved") {
    await handleUnresolvedCommand(context);
    return;
  }
  await handleApiSurfaceCommand(context);
}
