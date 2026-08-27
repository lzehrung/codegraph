import { findLocalSymbolDefinitions, getApiSurface, parseQualifiedSymbolPath } from "../indexer/symbols.js";
import { parseAgentSymbolHandle } from "../agent/handles.js";
import type { CurrentProjectIndexLoader } from "../indexer/load-current-index.js";
import type { GraphAdjacencyIndex } from "../graphs/adjacency.js";
import {
  findDetailedCycles,
  getDependencies,
  getReverseDependencies,
  getShortestPath,
  getUnresolvedImports,
  sortDetailedCycles,
} from "../graphs/queries.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import type { Graph } from "../types.js";
import { fileIdentityKey, toProjectDisplayPath } from "../util/paths.js";
import { parseOptionalNonNegativeIntegerOption } from "./options.js";
import { resolveCliProjectFile, writeCliProjectFileError } from "./projectFile.js";

export type GraphQueryCommand = "deps" | "rdeps" | "path" | "cycles" | "unresolved" | "apisurface";

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
  /** Loads the index for current repository state; query handlers never select a builder. */
  loadCurrentIndex: CurrentProjectIndexLoader;
  collectGraph?: (projectRoot: string, files: string[], options?: GraphBuildOptions) => Promise<Graph>;
};

type LoadedGraph = {
  graph: Graph;
  adjacency?: GraphAdjacencyIndex;
};

function findGraphNodeByIdentity(nodes: ReadonlySet<string>, file: string): string | undefined {
  const identity = fileIdentityKey(file);
  return [...nodes].find((node) => fileIdentityKey(node) === identity);
}

async function loadGraph(context: GraphQueryCommandContext): Promise<LoadedGraph> {
  if (context.collectGraph) {
    const graph = await context.collectGraph(
      context.projectRootFs,
      await context.listProjectFilesForScan(),
      context.graphOptions,
    );
    return { graph };
  }
  const index = await context.loadCurrentIndex();
  return {
    graph: index.graph,
    ...(index.graphAdjacency ? { adjacency: index.graphAdjacency } : {}),
  };
}

async function handleDepsCommand(context: GraphQueryCommandContext): Promise<void> {
  const [fileArg] = context.positionals;
  if (!fileArg) {
    context.writeStderrLine(`Usage: ${context.command} <file|file::symbol|symbol:...> [--depth N | --all] [--json]`);
    context.exit(2);
  }
  const depthRaw = context.getOpt("--depth");
  const all = context.hasFlag("--all");
  if (all && depthRaw !== undefined) {
    context.writeStderrLine("--all cannot be combined with --depth.");
    context.exit(2);
  }
  let depth: number | undefined;
  try {
    depth = parseOptionalNonNegativeIntegerOption(depthRaw, "--depth");
  } catch {
    context.writeStderrLine(`Invalid --depth value "${depthRaw}". Expected a non-negative integer.`);
    context.exit(2);
  }
  const json = context.hasFlag("--json");
  const symbolPath = parseQualifiedSymbolPath(fileArg);
  const symbolHandle = parseAgentSymbolHandle(fileArg);
  const targetInput = symbolPath?.file ?? symbolHandle?.file ?? fileArg;
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, targetInput, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, json ? "json" : "text");
  }

  const loaded = await loadGraph(context);
  let targetFile = resolvedFile.file;
  if (symbolPath || symbolHandle) {
    const index = await context.loadCurrentIndex();
    if (symbolPath) {
      const definitions = findLocalSymbolDefinitions(index, resolvedFile.file, symbolPath.name);
      if (definitions.length === 1) {
        const definition = definitions[0];
        if (!definition) throw new Error("Expected one symbol-path definition.");
        targetFile = definition.file;
      } else {
        const status = definitions.length ? "ambiguous" : "not_found";
        const detail = definitions.length
          ? `Multiple symbols named ${symbolPath.name} are defined in ${symbolPath.file}.`
          : `No indexed symbol ${symbolPath.name} is defined in ${symbolPath.file}.`;
        const reason = definitions.length
          ? `${detail} Run codegraph symbols "${symbolPath.file}::${symbolPath.name}" to obtain a portable handle.`
          : detail;
        const output = {
          status,
          reason,
          ...(definitions.length
            ? {
                candidates: definitions.map((definition) => ({
                  name: definition.localName,
                  kind: definition.kind,
                  range: definition.range,
                })),
              }
            : {}),
        };
        if (json) context.writeJSONLine(output);
        else context.writeStdoutLine(`${status}: ${reason}`);
        context.exit(1);
      }
    } else if (symbolHandle) {
      const definition = findLocalSymbolDefinitions(index, resolvedFile.file, symbolHandle.name).find(
        (candidate) =>
          candidate.range.start.line === symbolHandle.line && candidate.range.start.column === symbolHandle.column,
      );
      if (!definition) {
        const reason = `Symbol handle is stale or missing. Run codegraph symbols "${symbolHandle.file}::${symbolHandle.name}" to resolve it again.`;
        const output = { status: "not_found", reason };
        if (json) context.writeJSONLine(output);
        else context.writeStdoutLine(`not_found: ${reason}`);
        context.exit(1);
      }
      targetFile = definition.file;
    }
  }
  const matchedGraphNode = findGraphNodeByIdentity(loaded.graph.nodes, targetFile);
  if (!matchedGraphNode) {
    const missing = {
      status: "not_found" as const,
      reason: "file_not_indexed",
      file: targetFile,
      error: `File is not in the project graph: ${targetFile}`,
    };
    if (json) context.writeJSONLine(missing);
    else context.writeStdoutLine(`not_found: ${missing.error}`);
    context.exit(1);
  }
  targetFile = matchedGraphNode;
  const effectiveDepth = depth ?? 1;
  const traversalOptions = {
    ...(loaded.adjacency ? { adjacency: loaded.adjacency } : {}),
    ...(json && !all ? { depth: effectiveDepth + 1 } : {}),
  };
  const allResults =
    context.command === "deps"
      ? getDependencies(loaded.graph, targetFile, traversalOptions)
      : getReverseDependencies(loaded.graph, targetFile, traversalOptions);
  const results = all ? allResults : allResults.filter((result) => result.depth <= effectiveDepth);
  const truncated = results.length !== allResults.length;
  const omittedCount = allResults.length - results.length;

  if (json) {
    context.writeJSONLine({ items: results, truncated });
    return;
  }

  const depthDescription = all ? "all depths" : `depth ${effectiveDepth}`;
  context.writeStdoutLine(
    `${context.command === "deps" ? "Dependencies" : "Reverse dependencies"} for ${fileArg} (${depthDescription}; ${omittedCount} omitted):`,
  );
  for (const result of results) {
    const rel = toProjectDisplayPath(context.projectRootFs, result.file);
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
  }
  const resolvedTo = resolveCliProjectFile(context.projectRootFs, toArg, "To file");
  if (resolvedTo.status === "error") {
    writeCliProjectFileError(context, resolvedTo, json ? "json" : "text");
  }

  const loaded = await loadGraph(context);
  const pathResult = getShortestPath(
    loaded.graph,
    findGraphNodeByIdentity(loaded.graph.nodes, resolvedFrom.file) ?? resolvedFrom.file,
    findGraphNodeByIdentity(loaded.graph.nodes, resolvedTo.file) ?? resolvedTo.file,
    { ...(loaded.adjacency ? { adjacency: loaded.adjacency } : {}) },
  );

  if (json) {
    context.writeJSONLine(pathResult);
  } else if (pathResult) {
    context.writeStdoutLine(`Path from ${fromArg} to ${toArg}:`);
    context.writeStdoutLine(pathResult.map((entry) => toProjectDisplayPath(context.projectRootFs, entry)).join(" -> "));
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

  const { graph } = await loadGraph(context);
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
    context.writeStdoutLine(
      `  ${cycle.files.map((entry) => toProjectDisplayPath(context.projectRootFs, entry)).join(" -> ")} -> ...`,
    );
    if (cycle.entryEdges.length) {
      context.writeStdoutLine("  Incoming edges:");
      for (const edge of cycle.entryEdges) {
        context.writeStdoutLine(
          `    ${toProjectDisplayPath(context.projectRootFs, edge.from)} -> ${toProjectDisplayPath(context.projectRootFs, edge.to)} (import ${edge.raw})`,
        );
      }
    }
    if (cycle.internalEdges.length) {
      context.writeStdoutLine("  Internal cycle edges:");
      for (const edge of cycle.internalEdges) {
        context.writeStdoutLine(
          `    ${toProjectDisplayPath(context.projectRootFs, edge.from)} -> ${toProjectDisplayPath(context.projectRootFs, edge.to)} (import ${edge.raw})`,
        );
      }
    }
    context.writeStdoutLine(`  Hint: ${cycle.remediationHint}`);
  }
}

async function handleUnresolvedCommand(context: GraphQueryCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const { graph } = await loadGraph(context);
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
        context.writeStdoutLine(`    ${toProjectDisplayPath(context.projectRootFs, imp.file)} (as "${imp.raw}")`);
      }
    }
  }
}

async function handleApiSurfaceCommand(context: GraphQueryCommandContext): Promise<void> {
  const json = context.hasFlag("--json");
  const index = await context.loadCurrentIndex();
  const apiSurface = getApiSurface(index);

  if (json) {
    context.writeJSONLine(apiSurface);
    return;
  }

  context.writeStdoutLine(`API Surface for ${context.projectRootAbs}:`);
  for (const item of apiSurface) {
    context.writeStdoutLine(`  ${toProjectDisplayPath(context.projectRootFs, item.file)}:`);
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
