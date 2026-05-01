import {
  buildProjectIndex,
  analyzeImpactFromDiff,
  listSymbols,
  listProjectFiles,
  collectGraph,
  goToDefinition,
  findReferences,
  symbolId,
  type ImpactOptions,
  type ImpactReport,
  type CompactImpactReport,
  type Edge,
  type ImportBinding,
  type ProjectIndex,
  type Reference,
  type NativeRuntimeMode,
  type SymbolDef,
} from "./index.js";
import {
  fileExists,
  isFilePathWithinRoot,
  normalizePath,
  resolveFilePathFromRoot,
  toProjectRelativePath,
} from "./util.js";

type ToolRuntimeOptions = {
  native?: NativeRuntimeMode;
};

export type ToolFileOverviewImport = {
  name: string;
  kind: ImportBinding["kind"];
  from: string;
  resolved?: string;
};

export type ToolFileOverviewDefinition = {
  id: string;
  name: string;
  kind: string;
  line?: number;
  exported: boolean;
  docstring?: string;
};

export type ToolFileOverview = {
  imports: ToolFileOverviewImport[];
  definitions: ToolFileOverviewDefinition[];
  summary?: string;
};

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

/**
 * Agent-friendly tool wrapper for PR impact analysis.
 * Returns JSON-serializable impact report for LLM consumption.
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
    // Build the project index if not already available
    // In a real agent scenario, you might want to cache this
    const index = await buildProjectIndex(root, {
      logLevel: "error",
      ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
    });

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
 * The rendered markdown summary is kept only as a convenience field.
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

    const index = await buildProjectIndex(root, {
      logLevel: "error",
      ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
    });
    const { absPath, relativeFile } = resolvedFile;
    const mod = index.byFile.get(absPath);
    if (!mod) {
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

    const symbols = listSymbolsForOverview(index, absPath);
    const overview = buildToolFileOverview(symbols);
    const renderedOverview = renderToolFileOverview(relativeFile, overview);

    const hasSymbols = overview.imports.length > 0 || overview.definitions.length > 0;

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

/**
 * Searches for symbols by name across the project.
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
  matches?: Array<{ name: string; kind: string; file: string; line: number }>;
  error?: string;
}> {
  try {
    const index =
      options.index ??
      (await buildProjectIndex(root, {
        logLevel: "error",
        ...(options.native ? { native: options.native } : {}),
      }));
    const allSymbols = listSymbols(index, { includeImports: false });
    const q = query.toLowerCase();

    const matches = allSymbols
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        file: toProjectRelativePath(root, s.file) ?? normalizePath(s.file),
        line: s.range?.start.line ?? 0,
      }));

    // Sort by exact match then name
    matches.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q;
      const bExact = b.name.toLowerCase() === q;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      status: "ok",
      matches: matches.slice(0, options.maxResults ?? 20),
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
    const files = await listProjectFiles(root);
    const g = await collectGraph(root, files, {
      ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
    });
    return {
      status: "ok",
      graph: normalizeToolGraph(root, {
        nodes: [...g.nodes],
        edges: g.edges,
      }),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

function normalizePathArg(root: string, file: string): string {
  return normalizePath(resolveFilePathFromRoot(root, file));
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
    relativeFile: toProjectRelativePath(root, absPath) ?? normalizePath(filePath),
  };
}

function listSymbolsForOverview(
  index: ProjectIndex,
  file: string,
): {
  imports: ImportBinding[];
  definitions: ReturnType<typeof listSymbols>;
  exportedNames: Set<string>;
} {
  const symbols = listSymbols(index, { file, includeImports: false });
  const mod = index.byFile.get(file);
  const exportedNames = new Set(
    mod?.exports
      .filter((entry) => entry.type === "local")
      .map((entry) => entry.target.localName) ?? [],
  );
  return {
    imports: mod?.imports ?? [],
    definitions: symbols,
    exportedNames,
  };
}

function buildToolFileOverview(symbols: {
  imports: ImportBinding[];
  definitions: ReturnType<typeof listSymbols>;
  exportedNames: Set<string>;
}): ToolFileOverview {
  const imports = symbols.imports.map((entry) => ({
    name: getToolImportDisplayName(entry),
    kind: entry.kind,
    from: entry.from,
    ...(typeof entry.resolved === "string" ? { resolved: entry.resolved } : {}),
  }));

  const definitions = [...symbols.definitions]
    .sort((left, right) => (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0))
    .map((def) => ({
      id: def.id,
      name: def.name,
      kind: String(def.kind),
      ...(def.range ? { line: def.range.start.line } : {}),
      exported: symbols.exportedNames.has(def.name),
      ...(def.docstring ? { docstring: def.docstring } : {}),
    }));

  let summary: string | undefined;
  if (imports.length > 0 || definitions.length > 0) {
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
  if (overview.imports.length === 0) {
    lines.push("No imports found.");
  } else {
    const uniqueImports = Array.from(new Set(overview.imports.map((entry) => entry.name)));
    lines.push(`Imported symbols: ${uniqueImports.sort().join(", ")}`);
  }

  lines.push("", "## Definitions");
  if (overview.definitions.length === 0) {
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

  if (overview.imports.length === 0 && overview.definitions.length === 0) {
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
  return toProjectRelativePath(root, filePath) ?? normalizePath(filePath);
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
  error?: string;
  reason?: string;
}> {
  try {
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const idx =
      index ??
      (await buildProjectIndex(root, {
        logLevel: "error",
        ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
      }));

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
  error?: string;
  reason?: string;
}> {
  try {
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

    const idx =
      index ??
      (await buildProjectIndex(root, {
        logLevel: "error",
        ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
      }));

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
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}
