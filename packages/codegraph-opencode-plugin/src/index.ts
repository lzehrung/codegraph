import { tool, type ToolContext } from "@opencode-ai/plugin/tool";
import type { ImpactStreamChunk } from "@lzehrung/codegraph";
import { spawn } from "node:child_process";
import path from "node:path";

// Try to import the library for direct usage
// In workspace environment, this should resolve to the local package
let codegraph: typeof import("@lzehrung/codegraph") | undefined;
try {
  codegraph = await import("@lzehrung/codegraph");
} catch (e) {
  // Library not available, will fall back to CLI
}

type ToolResponse = {
  status: "ok" | "error";
  source: "library" | "cli";
  root: string;
  result?: unknown;
  error?: string;
  command?: string[];
};

type RunCodegraphOptions = {
  normalizeResult?: (result: unknown) => unknown;
};

const normalizeRoot = (context: ToolContext): string => {
  if (context.worktree) {
    return context.worktree;
  }
  return context.directory;
};

const normalizeFilePath = (root: string, filePath: string): string => {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(root, filePath);
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return text;
  }
};

const stringifyResult = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
};

const formatResponse = (response: ToolResponse): string => stringifyResult(response);

const formatOverviewFromDumpmod = (result: { file?: unknown; locals?: unknown; imports?: unknown }): string => {
  const file = typeof result.file === "string" ? result.file : "unknown file";
  const locals = Array.isArray(result.locals) ? result.locals : [];
  const imports = Array.isArray(result.imports) ? result.imports : [];
  const lines: string[] = [`# Overview of ${file}`];

  if (imports.length > 0) {
    const importedSymbols = imports
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        if ("local" in entry && typeof entry.local === "string") {
          return entry.local;
        }
        if ("localNS" in entry && typeof entry.localNS === "string") {
          return entry.localNS;
        }
        if ("from" in entry && typeof entry.from === "string") {
          return entry.from;
        }
        return null;
      })
      .filter((entry): entry is string => typeof entry === "string");
    if (importedSymbols.length > 0) {
      lines.push("\n## Imports");
      lines.push(`Imported symbols: ${Array.from(new Set(importedSymbols)).sort().join(", ")}`);
    }
  }

  lines.push("\n## Definitions");
  if (locals.length === 0) {
    lines.push("No definitions found.");
    lines.push("\nNo symbols found.");
    return lines.join("\n");
  }

  for (const entry of locals) {
    if (!entry || typeof entry !== "object") continue;
    const name = "name" in entry && typeof entry.name === "string" ? entry.name : "unknown";
    const kind = "kind" in entry && typeof entry.kind === "string" ? entry.kind : "symbol";
    const start = "start" in entry && entry.start && typeof entry.start === "object" ? entry.start : undefined;
    const line = start && "line" in start && typeof start.line === "number" ? start.line : null;
    lines.push(`### ${kind} \`${name}\` ${line ? `(line ${line})` : ""}`.trim());
  }

  return lines.join("\n");
};

const normalizeOverviewResult = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && "status" in result) {
    const overviewResult = result as {
      status?: unknown;
      overview?: unknown;
      error?: unknown;
    };
    if (overviewResult.status === "ok" && typeof overviewResult.overview === "string") {
      return overviewResult.overview;
    }
    if (typeof overviewResult.error === "string") {
      return overviewResult.error;
    }
  }
  if (result && typeof result === "object") {
    return formatOverviewFromDumpmod(result);
  }
  return stringifyResult(result);
};

// Helper to run codegraph via library or CLI
async function runCodegraph(
  context: ToolContext,
  cliArgs: string[],
  libFn?: () => Promise<unknown>,
  options?: RunCodegraphOptions,
): Promise<string> {
  const root = normalizeRoot(context);
  const normalizeResult = options?.normalizeResult;
  // 1. Try library API if available
  if (codegraph && libFn) {
    try {
      const result = await libFn();
      const normalizedResult = normalizeResult ? normalizeResult(result) : result;
      return formatResponse({
        status: "ok",
        source: "library",
        root,
        result: normalizedResult,
      });
    } catch (e) {
      // If library call fails, fall back to CLI
      console.warn("Codegraph library call failed, falling back to CLI:", e);
    }
  }

  // 2. Fallback to CLI
  // We assume npx codegraph is available in the environment if the library isn't directly importable
  const cmd = ["npx", "codegraph", ...cliArgs];

  if (typeof Bun !== "undefined") {
    // Use Bun spawn if available (preferred in OpenCode)
    const proc = Bun.spawn(cmd, {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });

    const text = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();

    if (err && !text) {
      return formatResponse({
        status: "error",
        source: "cli",
        root,
        command: cmd,
        error: err,
      });
    }

    const parsedResult = tryParseJson(text);
    const normalizedResult = normalizeResult ? normalizeResult(parsedResult) : parsedResult;
    return formatResponse({
      status: "ok",
      source: "cli",
      root,
      command: cmd,
      result: normalizedResult,
    });
  } else {
    // Fallback to Node.js child_process
    return new Promise((resolve) => {
      const proc = spawn("npx", ["codegraph", ...cliArgs], {
        cwd: root,
        shell: true, // Needed for npx in some environments
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0 && stderr && !stdout) {
          resolve(
            formatResponse({
              status: "error",
              source: "cli",
              root,
              command: cmd,
              error: `Codegraph error (exit code ${code}): ${stderr}`,
            }),
          );
          return;
        }
        const parsedResult = tryParseJson(stdout);
        const normalizedResult = normalizeResult ? normalizeResult(parsedResult) : parsedResult;
        resolve(
          formatResponse({
            status: "ok",
            source: "cli",
            root,
            command: cmd,
            result: normalizedResult,
          }),
        );
      });

      proc.on("error", (err) => {
        resolve(
          formatResponse({
            status: "error",
            source: "cli",
            root,
            command: cmd,
            error: String(err),
          }),
        );
      });
    });
  }
}

export const graph = tool({
  description:
    "Get the project dependency graph. Use this to understand module/file relationships before refactors. Returns JSON (status/source/root/result) or Mermaid text.",
  args: {
    format: tool.schema.enum(["json", "mermaid"]).optional().describe("Output format (default: json)"),
  },
  async execute(args, context) {
    const format = args.format ?? "json";
    return runCodegraph(
      context,
      ["graph", ".", ...(format === "mermaid" ? ["--mermaid"] : ["--json", "--compact-json"])],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        const root = normalizeRoot(context);
        if (format === "mermaid") {
          const graphOutput = await codegraph.tool_getGraph(root);
          const graph = graphOutput.graph;
          if (!graph) {
            // If the library could not produce a structured graph, return the
            // raw JSON output instead of attempting Mermaid rendering.
            return graphOutput;
          }
          return codegraph.graphToMermaid({
            nodes: new Set(graph.nodes),
            edges: graph.edges ?? [],
          });
        }
        return codegraph.tool_getGraph(root);
      },
    );
  },
});

export const definition = tool({
  description:
    "Find the definition location for a symbol. Provide a file path (relative to worktree is best) plus 1-based line/column.",
  args: {
    file: tool.schema.string().describe("Source file path (relative to worktree preferred)"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const filePath = normalizeFilePath(root, args.file);
    return runCodegraph(context, ["goto", filePath, String(args.line), String(args.column)], async () => {
      if (!codegraph) {
        throw new Error("Library not loaded");
      }
      return codegraph.tool_goToDefinition(root, filePath, args.line, args.column);
    });
  },
});

export const references = tool({
  description:
    "Find references to a symbol. Provide a file path (relative to worktree is best) plus 1-based line/column.",
  args: {
    file: tool.schema.string().describe("Source file path (relative to worktree preferred)"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const filePath = normalizeFilePath(root, args.file);
    return runCodegraph(
      context,
      ["refs", "--file", filePath, "--line", String(args.line), "--col", String(args.column)],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        return codegraph.tool_findReferences(root, filePath, args.line, args.column);
      },
    );
  },
});

export const overview = tool({
  description:
    "Summarize a file's imports and definitions for fast onboarding. Provide a file path (relative to worktree is best).",
  args: {
    file: tool.schema.string().describe("Source file path (relative to worktree preferred)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const filePath = normalizeFilePath(root, args.file);
    return runCodegraph(
      context,
      ["dumpmod", filePath],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        return codegraph.tool_getFileOverview(root, filePath);
      },
      { normalizeResult: normalizeOverviewResult },
    );
  },
});

export const impact = tool({
  description: "Analyze impact between git revisions. Use before large edits to see affected symbols/files.",
  args: {
    base: tool.schema.string().describe("Base commit (e.g. main)"),
    head: tool.schema.string().describe("Head commit (e.g. HEAD)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const normalizeImpact = (result: unknown): unknown => {
      if (result && typeof result === "object" && "report" in result) {
        return result;
      }
      return { report: result };
    };
    return runCodegraph(
      context,
      ["impact", "--base", args.base, "--head", args.head, "--compact"],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        return codegraph.tool_impactJSON(root, {
          provider: "git",
          base: args.base,
          head: args.head,
        });
      },
      { normalizeResult: normalizeImpact },
    );
  },
});

export const impact_stream = tool({
  description: "Stream impact analysis progress and items via tool metadata; returns a summary once complete.",
  args: {
    base: tool.schema.string().describe("Base commit (e.g. main)"),
    head: tool.schema.string().describe("Head commit (e.g. HEAD)"),
  },
  async execute(args, context) {
    if (!codegraph) {
      return formatResponse({
        status: "error",
        source: "library",
        root: normalizeRoot(context),
        error: "Library not loaded",
      });
    }

    const root = normalizeRoot(context);
    const index = await codegraph.buildProjectIndex(root, {
      logLevel: "error",
    });
    const chunks: Array<{
      type: ImpactStreamChunk["type"];
      payload: ImpactStreamChunk;
    }> = [];

    for await (const chunk of codegraph.analyzeImpactStreaming(root, index, {
      provider: "git",
      base: args.base,
      head: args.head,
    })) {
      chunks.push({ type: chunk.type, payload: chunk });
      context.metadata({
        title: "impact_stream",
        metadata: { chunk },
      });
    }

    const summaryChunk = chunks.find((item) => item.type === "complete");
    return formatResponse({
      status: "ok",
      source: "library",
      root,
      result: {
        summary: summaryChunk?.payload ?? null,
        streamedChunks: chunks.length,
      },
    });
  },
});

export const grep = tool({
  description: "Search for symbols or patterns. Provide either a Tree-sitter query or a regex pattern.",
  args: {
    query: tool.schema.string().optional().describe("Tree-sitter query"),
    pattern: tool.schema.string().optional().describe("Regex pattern"),
  },
  async execute(args, context) {
    const hasQuery = Boolean(args.query);
    const hasPattern = Boolean(args.pattern);
    if (hasQuery) {
      return runCodegraph(context, ["grep", "--query", args.query!]);
    }
    if (hasPattern) {
      return runCodegraph(context, ["grep", "--pattern", args.pattern!]);
    }
    return formatResponse({
      status: "error",
      source: "library",
      root: normalizeRoot(context),
      error: "Provide either query or pattern.",
    });
  },
});
