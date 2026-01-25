import {
  buildProjectIndex,
  analyzeImpactFromDiff,
  listSymbols,
  type ImpactOptions,
  type ImpactReport,
  type CompactImpactReport,
  type SymbolListItem,
} from "./index.js";
import path from "path";

/**
 * Agent-friendly tool wrapper for PR impact analysis.
 * Returns JSON-serializable impact report for LLM consumption.
 */
export async function tool_impactJSON(
  root: string,
  options: ImpactOptions,
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  try {
    // Build the project index if not already available
    // In a real agent scenario, you might want to cache this
    const index = await buildProjectIndex(root, { logLevel: "error" });

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
): Promise<{
  status: "ok" | "error";
  report?: ImpactReport | CompactImpactReport;
  error?: string;
}> {
  return tool_impactJSON(root, {
    provider: "raw",
    diffText,
    ...options,
  });
}

/**
 * Generates a high-level markdown overview of a file's structure.
 * Useful for agents to quickly understand a file without reading the raw code.
 */
export async function tool_getFileOverview(
  root: string,
  filePath: string,
): Promise<string> {
  try {
    const index = await buildProjectIndex(root, { logLevel: "error" });
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
      lines.push(
        `Imported symbols: ${uniqueImports.sort().join(", ")}`,
      );
    }

    if (defs.length > 0) {
      lines.push("\n## Definitions");
      // Sort by line number
      defs.sort((a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0));

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
  options: { maxResults?: number } = {},
): Promise<Array<{ name: string; kind: string; file: string; line: number }>> {
  try {
    const index = await buildProjectIndex(root, { logLevel: "error" });
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
