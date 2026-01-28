import { tool, type ToolContext } from "@opencode-ai/plugin/tool";
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
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  const json = JSON.stringify(value, null, 2);
  return json ?? "";
};

const formatResponse = (response: ToolResponse): string =>
  stringifyResult(response);

// Helper to run codegraph via library or CLI
async function runCodegraph(
  context: ToolContext,
  cliArgs: string[],
  libFn?: () => Promise<unknown>,
): Promise<string> {
  const root = normalizeRoot(context);
  // 1. Try library API if available
  if (codegraph && libFn) {
    try {
      const result = await libFn();
      return formatResponse({
        status: "ok",
        source: "library",
        root,
        result,
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

    return formatResponse({
      status: "ok",
      source: "cli",
      root,
      command: cmd,
      result: tryParseJson(text),
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
        resolve(
          formatResponse({
            status: "ok",
            source: "cli",
            root,
            command: cmd,
            result: tryParseJson(stdout),
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
    format: tool.schema
      .enum(["json", "mermaid"])
      .optional()
      .describe("Output format (default: json)"),
  },
  async execute(args, context) {
    const format = args.format ?? "json";
    return runCodegraph(
      context,
      [
        "graph",
        ".",
        ...(format === "mermaid"
          ? ["--mermaid"]
          : ["--json", "--compact-json"]),
      ],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        const root = normalizeRoot(context);
        if (format === "mermaid") {
          const graphOutput = await codegraph.tool_getGraph(root);
          const graph = graphOutput.graph;
          if (!graph) {
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
    file: tool.schema
      .string()
      .describe("Source file path (relative to worktree preferred)"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const filePath = normalizeFilePath(root, args.file);
    return runCodegraph(
      context,
      ["goto", filePath, String(args.line), String(args.column)],
      async () => {
        if (!codegraph) {
          throw new Error("Library not loaded");
        }
        return codegraph.tool_goToDefinition(root, filePath, args.line, args.column);
      },
    );
  },
});

export const references = tool({
  description:
    "Find references to a symbol. Provide a file path (relative to worktree is best) plus 1-based line/column.",
  args: {
    file: tool.schema
      .string()
      .describe("Source file path (relative to worktree preferred)"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
    const filePath = normalizeFilePath(root, args.file);
    return runCodegraph(
      context,
      [
        "refs",
        "--file",
        filePath,
        "--line",
        String(args.line),
        "--col",
        String(args.column),
      ],
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
    file: tool.schema
      .string()
      .describe("Source file path (relative to worktree preferred)"),
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
    );
  },
});

export const impact = tool({
  description:
    "Analyze impact between git revisions. Use before large edits to see affected symbols/files.",
  args: {
    base: tool.schema.string().describe("Base commit (e.g. main)"),
    head: tool.schema.string().describe("Head commit (e.g. HEAD)"),
  },
  async execute(args, context) {
    const root = normalizeRoot(context);
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
    );
  },
});

export const grep = tool({
  description:
    "Search for symbols or patterns. Provide either a Tree-sitter query or a regex pattern.",
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
