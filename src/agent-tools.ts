import {
  buildProjectIndex,
  analyzeImpactFromDiff,
  listSymbols,
  listProjectFiles,
  collectGraph,
  goToDefinition,
  findReferences,
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

type ToolFileOverviewResult =
  | {
      status: "ok";
      file: string;
      overview: string;
      hasSymbols: boolean;
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
 * Generates a high-level markdown overview of a file's structure.
 * Useful for agents to quickly understand a file without reading the raw code.
 */
export async function tool_getFileOverview(
  root: string,
  filePath: string,
  runtimeOptions: ToolRuntimeOptions = {},
): Promise<ToolFileOverviewResult> {
  try {
    const index = await buildProjectIndex(root, {
      logLevel: "error",
      ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
    });

    const resolvedFile = resolveToolFileInput(root, filePath);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }
    const { absPath, relativeFile } = resolvedFile;
    const mod = index.byFile.get(absPath);
    if (!mod) {
      const reason = (await fileExists(absPath))
        ? "file_not_indexed"
        : "file_not_found";
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

    const lines: string[] = [`# Overview of ${relativeFile}`];
    const hasSymbols =
      symbols.imports.length > 0 || symbols.definitions.length > 0;

    if (symbols.imports.length > 0) {
      lines.push("\n## Imports");
      const uniqueImports = Array.from(new Set(symbols.imports.map((i) => i.name)));
      lines.push(`Imported symbols: ${uniqueImports.sort().join(", ")}`);
    }

    if (symbols.definitions.length > 0) {
      lines.push("\n## Definitions");
      symbols.definitions.sort(
        (a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0),
      );

      for (const def of symbols.definitions) {
        const lineInfo = def.range ? `(line ${def.range.start.line})` : "";
        lines.push(`### ${def.kind} \`${def.name}\` ${lineInfo}`);
        if (def.docstring) {
          lines.push(`> ${def.docstring.split("\n")[0]}...`);
        }
      }
    } else {
      lines.push("\n## Definitions");
      lines.push("No definitions found.");
    }

    if (!hasSymbols) {
      lines.push("\nNo symbols found.");
    }

    return {
      status: "ok",
      file: relativeFile,
      overview: lines.join("\n"),
      hasSymbols,
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
    return { status: "ok", files };
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
    return { status: "ok", graph: { nodes: [...g.nodes], edges: g.edges } };
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

function listSymbolsForOverview(index: ProjectIndex, file: string): {
  imports: Array<{ name: string }>;
  definitions: ReturnType<typeof listSymbols>;
} {
  const symbols = listSymbols(index, { file, includeImports: false });
  const mod = index.byFile.get(file);
  const imports =
    mod?.imports.map((entry) => ({
      name:
        entry.kind === "namespace"
          ? entry.localNS
          : entry.kind === "star"
            ? entry.from
            : entry.local,
    })) ?? [];
  return {
    imports,
    definitions: symbols,
  };
}

function normalizeToolFileOutput(root: string, filePath: string): string {
  return toProjectRelativePath(root, filePath) ?? normalizePath(filePath);
}

function normalizeToolModuleRef(root: string, filePath: string): string {
  return normalizeToolFileOutput(root, filePath);
}

function normalizeToolImportBinding(
  root: string,
  binding: ImportBinding,
): ImportBinding {
  const resolved =
    typeof binding.resolved === "string"
      ? normalizeToolFileOutput(root, binding.resolved)
      : binding.resolved;
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
    const idx =
      index ??
      (await buildProjectIndex(root, {
        logLevel: "error",
        ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
      }));
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

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
    const idx =
      index ??
      (await buildProjectIndex(root, {
        logLevel: "error",
        ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
      }));
    const resolvedFile = resolveToolFileInput(root, file);
    if (resolvedFile.status === "error") {
      return resolvedFile;
    }

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
      references: result.references.map((reference) =>
        normalizeToolReference(root, reference),
      ),
    };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}
