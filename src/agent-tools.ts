import { buildProjectIndexIncremental } from "./indexer/build-index.js";
import { listSymbols, symbolId } from "./indexer/symbols.js";
import { goToDefinition, findReferences } from "./indexer/navigation.js";
import type {
  BuildOptions,
  ImportBinding,
  ProjectIndex,
  Reference,
  ResolutionProvenance,
  SymbolDef,
  SymbolListItem,
} from "./indexer/types.js";
import { analyzeImpactFromDiff } from "./impact/index.js";
import type { CompactImpactReport, ImpactOptions, ImpactReport } from "./impact/types.js";
import type { Edge, Range } from "./types.js";
import { collectGraph } from "./graph-builder.js";
import { getDependencies, getReverseDependencies, type DependencyNode } from "./graphs/queries.js";
import { getHotspots } from "./graphs/hotspots.js";
import type { NativeRuntimeMode } from "./native/treeSitterNative.js";
import { fileExists } from "./util/workspace.js";
import { isFilePathWithinRoot, normalizePath, resolveFilePathFromRoot } from "./util/paths.js";
import { listProjectFiles } from "./util/projectFiles.js";
import { boundAgentList, defaultAgentLimit, normalizeAgentLimit } from "./agent/bounds.js";
import { normalizeAgentOutputPath } from "./agent/normalize.js";
import type { AgentSession } from "./agent/session.js";
import {
  workspaceSymbols,
  workspaceSymbolsWithSession,
  type WorkspaceSymbolsResponse,
} from "./agent/workspaceSymbols.js";
import type { WorkspaceSymbolsRequest } from "./indexer/workspace-symbols.js";
import {
  findImplementations as findAgentImplementations,
  findImplementationsWithSession,
  findSubtypes,
  findSubtypesWithSession,
  findSupertypes,
  findSupertypesWithSession,
  type ImplementationsResponse,
  type TypeHierarchyRequest,
  type TypeHierarchyResponse,
} from "./agent/typeHierarchy.js";

type ToolRuntimeOptions = {
  index?: ProjectIndex;
  native?: NativeRuntimeMode;
};

/** Import entry rendered for agent tool responses. */
export type ToolFileOverviewImport = {
  name: string;
  kind: ImportBinding["kind"];
  from: string;
  resolved?: string;
};

/** Definition entry rendered for agent tool file overviews. */
export type ToolFileOverviewDefinition = {
  id: string;
  name: string;
  kind: string;
  line?: number;
  exported: boolean;
  docstring?: string;
};

/** Structured imports and definitions for one indexed source file. */
export type ToolFileOverview = {
  imports: ToolFileOverviewImport[];
  definitions: ToolFileOverviewDefinition[];
  summary?: string;
};

/** Result envelope returned by `tool_getFileOverview`. */
export type ToolFileOverviewResult =
  | {
      status: "ok";
      file: string;
      overview: ToolFileOverview;
      hasSymbols: boolean;
      renderedOverview?: string;
    }
  | {
      status: "not_found";
      file: string;
      reason: "file_not_found" | "file_not_indexed";
      error: string;
    }
  | {
      status: "error";
      error: string;
      reason?: "outside_project_root";
    };

/** Symbol search match with project-relative file output. */
export type ToolSymbolMatch = {
  id: string;
  name: string;
  kind: string;
  file: string;
  range?: Range;
  line: number;
  exported: boolean;
  exactMatch: boolean;
  matchKind: "exact" | "substring";
};

/** Dependency or dependent file entry returned by graph traversal tools. */
export type ToolDependencyEntry = {
  file: string;
  depth: number;
};

type ToolDependencyOptions = ToolRuntimeOptions & {
  depth?: number;
  limit?: number;
};

type ToolDependencyListResult =
  | {
      status: "ok";
      file: string;
      entries: ToolDependencyEntry[];
      truncated: boolean;
    }
  | {
      status: "not_found";
      file: string;
      reason: "file_not_found" | "file_not_indexed";
      error: string;
    }
  | {
      status: "error";
      error: string;
      reason?: "outside_project_root";
    };
type ToolDependencyOkResult = Extract<ToolDependencyListResult, { status: "ok" }>;
type ToolDependencyFailureResult = Exclude<ToolDependencyListResult, ToolDependencyOkResult>;
type ToolDependenciesResponse =
  | {
      status: "ok";
      file: string;
      dependencies: ToolDependencyEntry[];
      truncated: boolean;
    }
  | ToolDependencyFailureResult;
type ToolReverseDependenciesResponse =
  | {
      status: "ok";
      file: string;
      dependents: ToolDependencyEntry[];
      truncated: boolean;
    }
  | ToolDependencyFailureResult;

/** File-level hotspot metrics returned by `tool_getHotspots`. */
export type ToolHotspotEntry = {
  file: string;
  fanIn: number;
  fanOut: number;
  score: number;
};

/**
 * Agent-friendly tool wrapper for PR impact analysis.
 *
 * Returns a JSON-serializable impact report envelope with an explicit `status`.
 * Pass a shared `index` through `runtimeOptions` when a review agent is making
 * several calls over the same repo snapshot.
 */
export async function tool_impactJSON(
  root: string,
  options: ImpactOptions,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  try {
    const index = await getToolIndex(root, runtimeOptions);

    // Analyze the impact
    const report = await analyzeImpactFromDiff(root, index, options);

    return {
      status: "ok",
      report,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Simplified wrapper for raw diff text analysis.
 * Useful for testing or when you already have diff content.
 */
export async function tool_impactFromDiffText(
  root: string,
  diffText: string,
  options: Omit<ImpactOptions, "provider" | "diffText"> = {},
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  return tool_impactJSON(
    root,
    {
      provider: "raw",
      diffText,
      ...options,
    },
    runtimeOptions,
  );
}

/**
 * Generates a structured overview of a file's imports and definitions.
 *
 * Prefer `overview.imports` and `overview.definitions` for deterministic agent
 * packets. `renderedOverview` is a convenience string for logs or debugging, not
 * the stable integration contract.
 */
export async function tool_getFileOverview(
  root: string,
  filePath: string,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<ToolFileOverviewResult> {
  try {
    const resolvedFile = resolveToolFileInput(root, filePath);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const index = await getToolIndex(root, runtimeOptions);
    const { absPath, relativeFile } = resolvedFile;
    const missing = await getToolMissingFileResult(index, absPath, relativeFile);
    if (missing) {
      return missing;
    }

    const symbols = listSymbolsForOverview(index, absPath);
    const overview = buildToolFileOverview(root, symbols);
    const renderedOverview = renderToolFileOverview(relativeFile, overview);

    const hasSymbols = !!(overview.imports.length || overview.definitions.length);

    return {
      status: "ok",
      file: relativeFile,
      overview,
      hasSymbols,
      renderedOverview,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Optional warm-session or build configuration for `tool_workspaceSymbols`. */
export type ToolWorkspaceSymbolsRuntimeOptions = {
  session?: AgentSession;
  buildOptions?: BuildOptions;
};

/**
 * Looks up workspace symbols with deterministic ranking and portable output.
 *
 * Pass a shared `session` for repeated calls over the same project snapshot.
 */
export async function tool_workspaceSymbols(
  root: string,
  request: WorkspaceSymbolsRequest,
  runtimeOptions: ToolWorkspaceSymbolsRuntimeOptions = {},
): Promise<WorkspaceSymbolsResponse> {
  if (runtimeOptions.session && runtimeOptions.buildOptions) {
    throw new Error("Workspace symbol tool options cannot combine a prebuilt session with buildOptions.");
  }
  const agentRequest = {
    root,
    ...request,
    ...(runtimeOptions.buildOptions ? { buildOptions: runtimeOptions.buildOptions } : {}),
  };
  if (runtimeOptions.session) {
    return await workspaceSymbolsWithSession(runtimeOptions.session, agentRequest);
  }
  return await workspaceSymbols(agentRequest);
}

/** Optional warm-session or build configuration for type hierarchy tools. */
export type ToolTypeHierarchyRuntimeOptions = {
  session?: AgentSession;
  buildOptions?: BuildOptions;
};

/** Finds proven supertypes for a portable symbol handle. */
export async function tool_findSupertypes(
  root: string,
  request: Omit<TypeHierarchyRequest, "root" | "buildOptions">,
  runtimeOptions: ToolTypeHierarchyRuntimeOptions = {},
): Promise<TypeHierarchyResponse> {
  assertTypeHierarchyToolOptions(runtimeOptions);
  const agentRequest = typeHierarchyAgentRequest(root, request, runtimeOptions);
  if (runtimeOptions.session) return await findSupertypesWithSession(runtimeOptions.session, agentRequest);
  return await findSupertypes(agentRequest);
}

/** Finds proven subtypes for a portable symbol handle. */
export async function tool_findSubtypes(
  root: string,
  request: Omit<TypeHierarchyRequest, "root" | "buildOptions">,
  runtimeOptions: ToolTypeHierarchyRuntimeOptions = {},
): Promise<TypeHierarchyResponse> {
  assertTypeHierarchyToolOptions(runtimeOptions);
  const agentRequest = typeHierarchyAgentRequest(root, request, runtimeOptions);
  if (runtimeOptions.session) return await findSubtypesWithSession(runtimeOptions.session, agentRequest);
  return await findSubtypes(agentRequest);
}

/** Finds proven type or interface-member implementations for a portable symbol handle. */
export async function tool_findImplementations(
  root: string,
  request: Omit<TypeHierarchyRequest, "root" | "buildOptions" | "depth">,
  runtimeOptions: ToolTypeHierarchyRuntimeOptions = {},
): Promise<ImplementationsResponse> {
  assertTypeHierarchyToolOptions(runtimeOptions);
  const agentRequest = typeHierarchyAgentRequest(root, request, runtimeOptions);
  if (runtimeOptions.session) return await findImplementationsWithSession(runtimeOptions.session, agentRequest);
  return await findAgentImplementations(agentRequest);
}

function assertTypeHierarchyToolOptions(runtimeOptions: ToolTypeHierarchyRuntimeOptions): void {
  if (runtimeOptions.session && runtimeOptions.buildOptions) {
    throw new Error("Type hierarchy tool options cannot combine a prebuilt session with buildOptions.");
  }
}

function typeHierarchyAgentRequest(
  root: string,
  request: Omit<TypeHierarchyRequest, "root" | "buildOptions">,
  runtimeOptions: ToolTypeHierarchyRuntimeOptions,
): TypeHierarchyRequest {
  return {
    root,
    ...request,
    ...(runtimeOptions.buildOptions ? { buildOptions: runtimeOptions.buildOptions } : {}),
  };
}

/**
 * Searches indexed definitions by case-insensitive substring.
 *
 * Pass a cached `index` when making several calls against the same snapshot.
 */
export async function tool_findSymbol(
  root: string,
  query: string,
  options: {
    maxResults?: number;
    index?: ProjectIndex;
    native?: NativeRuntimeMode;
  } = {},
): Promise<{
  status: "ok" | "error";
  matches?: ToolSymbolMatch[];
  error?: string;
}> {
  try {
    const index = options.index ?? (await getToolIndex(root, options));
    const allSymbols = listSymbols(index, { includeImports: false });
    const q = query.toLowerCase();

    const matches = allSymbols
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((symbol) => {
        const exactMatch = symbol.name.toLowerCase() === q;
        const matchKind: ToolSymbolMatch["matchKind"] = exactMatch ? "exact" : "substring";
        return {
          id: symbol.id,
          name: symbol.name,
          kind: String(symbol.kind),
          file: normalizeToolFileOutput(root, symbol.file),
          ...(symbol.range ? { range: symbol.range } : {}),
          line: symbol.range?.start.line ?? 0,
          exactMatch,
          matchKind,
          symbol,
        };
      });

    matches.sort((a, b) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      const byFile = a.file.localeCompare(b.file);
      if (byFile !== 0) return byFile;
      return a.line - b.line;
    });

    const exportedDefinitionsByFile = new Map<string, Set<string>>();
    const limitedMatches = boundAgentList(matches, getToolDefaultedLimit(options.maxResults, 20)).items.map((match) => {
      const exportedDefinitions =
        exportedDefinitionsByFile.get(match.symbol.file) ?? getExportedSymbolIdsForFile(index, match.symbol.file);
      exportedDefinitionsByFile.set(match.symbol.file, exportedDefinitions);
      return {
        id: match.id,
        name: match.name,
        kind: match.kind,
        file: match.file,
        ...(match.range ? { range: match.range } : {}),
        line: match.line,
        exported: isExportedSymbolDefinition(exportedDefinitions, match.symbol),
        exactMatch: match.exactMatch,
        matchKind: match.matchKind,
      };
    });

    return {
      status: "ok",
      matches: limitedMatches,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Lists all files in the project that codegraph can analyze.
 *
 * Results are project-relative when the file is under `root`.
 */
export async function tool_listProjectFiles(
  root: string,
): Promise<{ status: "ok" | "error"; files?: string[]; error?: string }> {
  try {
    const files = await listProjectFiles(root);
    return {
      status: "ok",
      files: files.map((file) => normalizeToolFileOutput(root, file)),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

/**
 * Gets the dependency graph for the project.
 *
 * Returns project-relative node and edge paths for agent-safe display.
 */
export async function tool_getGraph(
  root: string,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<{
  status: "ok" | "error";
  graph?: { nodes: string[]; edges: Edge[] };
  error?: string;
}> {
  try {
    const graph = runtimeOptions.index?.graph ?? (await collectToolGraph(root, runtimeOptions));
    return {
      status: "ok",
      graph: normalizeToolGraph(root, {
        nodes: [...graph.nodes],
        edges: graph.edges,
      }),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

/**
 * Lists files imported by, required by, or otherwise depended on by a file.
 */
export async function tool_getDependencies(
  root: string,
  filePath: string,
  options: ToolDependencyOptions = {},
): Promise<ToolDependenciesResponse> {
  const result = await collectToolDependencyEntries(root, filePath, options, (index, file, traversalOptions) =>
    getDependencies(index.graph, file, traversalOptions),
  );
  return mapToolDependencyResult(result, (ok) => ({
    status: "ok",
    file: ok.file,
    dependencies: ok.entries,
    truncated: ok.truncated,
  }));
}

/**
 * Lists files that depend on the requested file.
 */
export async function tool_getReverseDependencies(
  root: string,
  filePath: string,
  options: ToolDependencyOptions = {},
): Promise<ToolReverseDependenciesResponse> {
  const result = await collectToolDependencyEntries(root, filePath, options, (index, file, traversalOptions) =>
    getReverseDependencies(index.graph, file, traversalOptions),
  );
  return mapToolDependencyResult(result, (ok) => ({
    status: "ok",
    file: ok.file,
    dependents: ok.entries,
    truncated: ok.truncated,
  }));
}

function mapToolDependencyResult<T>(
  result: ToolDependencyListResult,
  buildOkResult: (result: ToolDependencyOkResult) => T,
): T | ToolDependencyFailureResult {
  if (result.status !== "ok") return result;
  return buildOkResult(result);
}

async function collectToolDependencyEntries(
  root: string,
  filePath: string,
  options: ToolDependencyOptions,
  collectEntries: (
    index: ProjectIndex,
    file: string,
    traversalOptions: { depth?: number; limit: number },
  ) => DependencyNode[],
): Promise<ToolDependencyListResult> {
  try {
    const resolvedFile = resolveToolFileInput(root, filePath);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const index = await getToolIndex(root, options);
    const missing = await getToolMissingFileResult(index, resolvedFile.absPath, resolvedFile.relativeFile);
    if (missing) {
      return missing;
    }

    const limit = getToolLimit(options.limit) ?? 20;
    const entries = collectEntries(index, resolvedFile.absPath, {
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      limit: limit + 1,
    });
    const sortedEntries = [...entries].sort((left, right) => {
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return left.depth - right.depth;
    });
    const limited = boundAgentList(sortedEntries, limit).items.map((entry) => ({
      file: normalizeToolFileOutput(root, entry.file),
      depth: entry.depth,
    }));

    return {
      status: "ok",
      file: resolvedFile.relativeFile,
      entries: limited,
      truncated: entries.length !== limited.length,
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

/**
 * Lists high fan-in/fan-out files, optionally scoped to include roots.
 */
export async function tool_getHotspots(
  root: string,
  options: {
    limit?: number;
    includeRoots?: string[];
    index?: ProjectIndex;
    native?: NativeRuntimeMode;
  } = {},
): Promise<{ status: "ok" | "error"; hotspots?: ToolHotspotEntry[]; error?: string }> {
  try {
    const index = await getToolIndex(root, options);

    const includeRoots = (options.includeRoots ?? []).map((entry) => normalizePathArg(root, entry));
    const limit = getToolLimit(options.limit);
    const hotspots = getHotspots(index.graph, {
      ...(limit !== undefined ? { limit } : {}),
      ...(includeRoots.length ? { includeRoots } : {}),
    }).map((entry) => ({
      file: normalizeToolFileOutput(root, entry.file),
      fanIn: entry.fanIn,
      fanOut: entry.fanOut,
      score: entry.score,
    }));

    return {
      status: "ok",
      hotspots,
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

function normalizePathArg(root: string, file: string): string {
  return normalizePath(resolveFilePathFromRoot(root, file));
}

async function getToolIndex(root: string, options: ToolRuntimeOptions): Promise<ProjectIndex> {
  return (
    options.index ??
    (await buildProjectIndexIncremental(root, {
      cache: "disk",
      keepParsed: true,
      useBloomFilters: true,
      logLevel: "error",
      ...(options.native ? { native: options.native } : {}),
    }))
  );
}

async function collectToolGraph(
  root: string,
  options: ToolRuntimeOptions,
): Promise<Awaited<ReturnType<typeof collectGraph>>> {
  const files = await listProjectFiles(root);
  return await collectGraph(root, files, {
    ...(options.native ? { native: options.native } : {}),
  });
}

function getToolLimit(limit: number | undefined): number | undefined {
  return normalizeAgentLimit(limit);
}

function getToolDefaultedLimit(limit: number | undefined, fallback: number): number {
  return defaultAgentLimit(limit, fallback);
}

function resolveToolFileInput(
  root: string,
  filePath: string,
):
  | {
      status: "ok";
      absPath: string;
      relativeFile: string;
    }
  | {
      status: "error";
      error: string;
      reason: "outside_project_root";
    } {
  const absPath = normalizePathArg(root, filePath);
  if (!isFilePathWithinRoot(root, absPath)) {
    return {
      status: "error",
      reason: "outside_project_root",
      error: `File is outside project root: ${normalizePath(filePath)}`,
    };
  }
  return {
    status: "ok",
    absPath,
    relativeFile: normalizeToolFileOutput(root, absPath),
  };
}

function listSymbolsForOverview(
  index: ProjectIndex,
  file: string,
): {
  imports: ImportBinding[];
  definitions: ReturnType<typeof listSymbols>;
  exportedDefinitions: Set<string>;
} {
  const symbols = listSymbols(index, { file, includeImports: false });
  const mod = index.byFile.get(file);
  return {
    imports: mod?.imports ?? [],
    definitions: symbols,
    exportedDefinitions: getExportedSymbolIdsForFile(index, file),
  };
}

function buildToolFileOverview(
  root: string,
  symbols: {
    imports: ImportBinding[];
    definitions: ReturnType<typeof listSymbols>;
    exportedDefinitions: Set<string>;
  },
): ToolFileOverview {
  const imports = symbols.imports.map((entry) => ({
    name: getToolImportDisplayName(entry),
    kind: entry.kind,
    from: entry.from,
    ...(typeof entry.resolved === "string" ? { resolved: normalizeToolFileOutput(root, entry.resolved) } : {}),
  }));

  const definitions = [...symbols.definitions]
    .sort((left, right) => (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0))
    .map((def) => ({
      id: def.id,
      name: def.name,
      kind: String(def.kind),
      ...(def.range ? { line: def.range.start.line } : {}),
      exported: isExportedSymbolDefinition(symbols.exportedDefinitions, def),
      ...(def.docstring ? { docstring: def.docstring } : {}),
    }));

  let summary: string | undefined;
  if (imports.length || definitions.length) {
    summary = `${imports.length} imports, ${definitions.length} definitions`;
  }

  return {
    imports,
    definitions,
    ...(summary ? { summary } : {}),
  };
}

function renderToolFileOverview(file: string, overview: ToolFileOverview): string {
  const lines: string[] = [`# Overview of ${file}`];

  if (overview.summary) {
    lines.push("", overview.summary);
  }

  lines.push("", "## Imports");
  if (!overview.imports.length) {
    lines.push("No imports found.");
  } else {
    const uniqueImports = Array.from(new Set(overview.imports.map((entry) => entry.name)));
    lines.push(`Imported symbols: ${uniqueImports.sort().join(", ")}`);
  }

  lines.push("", "## Definitions");
  if (!overview.definitions.length) {
    lines.push("No definitions found.");
  } else {
    for (const def of overview.definitions) {
      const lineInfo = def.line !== undefined ? `(line ${def.line})` : "";
      lines.push(`### ${def.kind} \`${def.name}\` ${lineInfo}`.trim());
      if (def.docstring) {
        lines.push(`> ${def.docstring.split("\n")[0]}...`);
      }
    }
  }

  if (!overview.imports.length && !overview.definitions.length) {
    lines.push("", "No symbols found.");
  }

  return lines.join("\n");
}

function getToolImportDisplayName(entry: ImportBinding): string {
  if (entry.kind === "namespace") return entry.localNS;
  if (entry.kind === "star") return entry.from;
  return entry.local;
}

function normalizeToolFileOutput(root: string, filePath: string): string {
  return normalizeAgentOutputPath(root, filePath);
}

async function getToolMissingFileResult(
  index: ProjectIndex,
  absPath: string,
  relativeFile: string,
): Promise<
  | {
      status: "not_found";
      file: string;
      reason: "file_not_found" | "file_not_indexed";
      error: string;
    }
  | undefined
> {
  if (index.byFile.has(absPath)) {
    return undefined;
  }
  const reason = (await fileExists(absPath)) ? "file_not_indexed" : "file_not_found";
  return {
    status: "not_found",
    file: relativeFile,
    reason,
    error:
      reason === "file_not_found"
        ? `File was not found under the project root: ${relativeFile}`
        : `File is not indexed: ${relativeFile}`,
  };
}

function normalizeToolModuleRef(root: string, filePath: string): string {
  return normalizeToolFileOutput(root, filePath);
}

function normalizeToolImportBinding(root: string, binding: ImportBinding): ImportBinding {
  const resolved =
    typeof binding.resolved === "string" ? normalizeToolFileOutput(root, binding.resolved) : binding.resolved;
  if (resolved === binding.resolved || resolved === undefined) {
    return binding;
  }
  return { ...binding, resolved };
}

function normalizeToolDefinition(root: string, definition: SymbolDef): SymbolDef {
  return {
    ...definition,
    file: normalizeToolFileOutput(root, definition.file),
  };
}

function normalizeToolGoToVia(
  root: string,
  via: { importedFrom?: string | undefined; exportedName?: string | undefined },
): { importedFrom?: string; exportedName?: string } {
  const normalizedVia: { importedFrom?: string; exportedName?: string } = {};
  if (via.importedFrom) {
    normalizedVia.importedFrom = normalizeToolModuleRef(root, via.importedFrom);
  }
  if (via.exportedName) {
    normalizedVia.exportedName = via.exportedName;
  }
  return normalizedVia;
}

function normalizeToolReference(root: string, reference: Reference): Reference {
  return {
    ...reference,
    file: normalizeToolFileOutput(root, reference.file),
    ...(reference.via
      ? {
          via: {
            ...reference.via,
            ...(reference.via.import
              ? {
                  import: normalizeToolImportBinding(root, reference.via.import),
                }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeToolEdge(root: string, edge: Edge): Edge {
  return {
    ...edge,
    from: normalizeToolFileOutput(root, edge.from),
    to:
      edge.to.type === "file"
        ? {
            type: "file",
            path: normalizeToolFileOutput(root, edge.to.path),
          }
        : edge.to,
  };
}

function normalizeToolGraph(
  root: string,
  graph: { nodes: string[]; edges: Edge[] },
): { nodes: string[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node) => normalizeToolFileOutput(root, node)),
    edges: graph.edges.map((edge) => normalizeToolEdge(root, edge)),
  };
}

/**
 * Go to definition for a symbol at a specific location.
 */
export async function tool_goToDefinition(
  root: string,
  file: string,
  line: number,
  column: number,
  index?: ProjectIndex,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<{
  status: "ok" | "error" | "not_found";
  definition?: SymbolDef;
  via?: {
    importedFrom?: string;
    exportedName?: string;
  };
  provenance?: ResolutionProvenance;
  error?: string;
  reason?: string;
}> {
  try {
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const idx = index ?? (await getToolIndex(root, runtimeOptions));

    const result = await goToDefinition(idx, {
      file: resolvedFile.absPath,
      line,
      column,
    });
    if (result.status !== "ok") {
      return result;
    }
    const { definition, via, ...rest } = result;
    return {
      ...rest,
      definition: normalizeToolDefinition(root, definition),
      ...(via ? { via: normalizeToolGoToVia(root, via) } : {}),
      ...(result.provenance ? { provenance: result.provenance } : {}),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

/**
 * Find references for a symbol at a specific location.
 */
export async function tool_findReferences(
  root: string,
  file: string,
  line: number,
  column: number,
  index?: ProjectIndex,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<{
  status: "ok" | "error" | "not_found";
  definition?: SymbolDef;
  references?: Reference[];
  provenance?: ResolutionProvenance;
  error?: string;
  reason?: string;
}> {
  try {
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const idx = index ?? (await getToolIndex(root, runtimeOptions));

    const result = await findReferences(idx, {
      file: resolvedFile.absPath,
      line,
      column,
    });
    if (result.status !== "ok") {
      return result;
    }
    return {
      ...result,
      definition: normalizeToolDefinition(root, result.definition),
      references: result.references.map((reference) => normalizeToolReference(root, reference)),
      ...(result.provenance ? { provenance: result.provenance } : {}),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

function isExportedSymbolDefinition(exportedDefinitions: Set<string>, symbol: SymbolListItem): boolean {
  return exportedDefinitions.has(symbol.id);
}

function getExportedSymbolIdsForFile(index: ProjectIndex, file: string): Set<string> {
  const mod = index.byFile.get(file);
  return new Set(mod?.exports.filter((entry) => entry.type === "local").map((entry) => symbolId(entry.target)) ?? []);
}
