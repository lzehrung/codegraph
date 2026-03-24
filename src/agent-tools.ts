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
  type ProjectIndex,
  type NativeRuntimeMode,
} from "./index.js";
import path from "path";

type ToolRuntimeOptions = {
  native?: NativeRuntimeMode;
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
): Promise<string> {
  try {
    const index = await buildProjectIndex(root, {
      logLevel: "error",
      ...(runtimeOptions.native ? { native: runtimeOptions.native } : {}),
    });
    const absPath = path.resolve(root, filePath).replace(/\\/g, "/");
    const symbols = listSymbols(index, {
      file: absPath,
      includeImports: true,
    });

    if (symbols.length === 0) {
      return `No symbols found in ${filePath}. The file might be empty, ignored, or failed to parse.`;
    }

    const imports = symbols.filter(
      (s) => s.kind === "import" || s.kind === "namespaceImport",
    );
    const defs = symbols.filter(
      (s) => s.kind !== "import" && s.kind !== "namespaceImport",
    );

    const lines: string[] = [`# Overview of ${filePath}`];

    if (imports.length > 0) {
      lines.push("\n## Imports");
      // Group by file (from ID: file::local::import) is hard because ID format for imports is specific
      // We'll just list them simply for now
      const uniqueImports = Array.from(new Set(imports.map((i) => i.name)));
      lines.push(`Imported symbols: ${uniqueImports.sort().join(", ")}`);
    }

    if (defs.length > 0) {
      lines.push("\n## Definitions");
      // Sort by line number
      defs.sort(
        (a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0),
      );

      for (const def of defs) {
        const lineInfo = def.range ? `(line ${def.range.start.line})` : "";
        lines.push(`### ${def.kind} \`${def.name}\` ${lineInfo}`);
        if (def.docstring) {
          lines.push(`> ${def.docstring.split("\n")[0]}...`); // First line of docstring
        }
      }
    }

    return lines.join("\n");
  } catch (error) {
    return `Error generating overview: ${error instanceof Error ? error.message : String(error)}`;
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
): Promise<Array<{ name: string; kind: string; file: string; line: number }>> {
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
        file: path.relative(root, s.file),
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

    return matches.slice(0, options.maxResults ?? 20);
  } catch (error) {
    console.error(error);
    return [];
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
  const absPath = path.isAbsolute(file) ? file : path.resolve(root, file);
  return absPath.replace(/\\/g, "/");
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
  definition?: {
    file: string;
    range: {
      start: {
        line: number;
        column: number;
      };
    };
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
    const normalizedPath = normalizePathArg(root, file);

    const result = await goToDefinition(idx, {
      file: normalizedPath,
      line,
      column,
    });
    return result;
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
  references?: Array<{
    file: string;
    range: { start: { line: number; column: number } };
  }>;
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
    const normalizedPath = normalizePathArg(root, file);

    const result = await findReferences(idx, {
      file: normalizedPath,
      line,
      column,
    });
    return result;
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}
