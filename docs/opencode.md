# Opencode Integration

This guide describes how to add [codegraph](https://github.com/lzehrung/codegraph) capabilities to [Opencode](https://opencode.ai) agents.

## Quick Start

To give your Opencode agents semantic code intelligence, create a custom tool file in your project or global configuration.

**File Location:**
- Project-specific: `.opencode/tools/codegraph.ts`
- Global: `~/.config/opencode/tools/codegraph.ts`

**Content:**

```typescript
import { tool } from "@opencode-ai/plugin";

// Try to import the library for direct usage
let codegraph: typeof import("@lzehrung/codegraph") | undefined;
try {
  codegraph = await import("@lzehrung/codegraph");
} catch (e) {
  // Library not available, will fall back to CLI
}

// Helper to run codegraph via library or CLI
async function runCodegraph(
  cliArgs: string[],
  libFn?: () => Promise<any>
) {
  // 1. Try library API if available
  if (codegraph && libFn) {
    try {
      const result = await libFn();
      // Ensure we return the 'report' property if the tool wrapper returns { status, report }
      // or the raw result if it matches the expected shape.
      if (result && typeof result === 'object' && 'report' in result) {
        return result.report;
      }
      return result;
    } catch (e) {
      // If library call fails, fall back to CLI
      console.warn("Codegraph library call failed, falling back to CLI:", e);
    }
  }

  // 2. Fallback to CLI
  const cmd = ["npx", "codegraph", ...cliArgs];
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });

  const text = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();

  if (err && !text) {
    throw new Error(`Codegraph error: ${err}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    return text; // Return raw text if not JSON
  }
}

export const graph = tool({
  description: "Get the dependency graph of the project",
  args: {
    format: tool.schema.enum(["json", "mermaid"]).optional().describe("Output format (default: json)"),
  },
  async execute(args) {
    return await runCodegraph(
      ["graph", ".", ...(args.format === "mermaid" ? ["--mermaid"] : ["--json", "--compact-json"])],
      async () => {
        if (!codegraph) throw new Error("Library not loaded");
        if (args.format === "mermaid") {
           // The library export for mermaid graph generation isn't directly exposed as a simple tool wrapper yet
           // but we can use the raw graph object
           const g = await codegraph.tool_getGraph(process.cwd());
           return codegraph.graphToMermaid({ nodes: new Set(g.graph?.nodes), edges: g.graph?.edges || [] });
        }
        return codegraph.tool_getGraph(process.cwd());
      }
    );
  },
});

export const definition = tool({
  description: "Go to definition of a symbol",
  args: {
    file: tool.schema.string().describe("Source file path"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args) {
    return await runCodegraph(
      ["goto", args.file, String(args.line), String(args.column)],
      async () => {
        if (!codegraph) throw new Error("Library not loaded");
        return codegraph.tool_goToDefinition(process.cwd(), args.file, args.line, args.column);
      }
    );
  },
});

export const references = tool({
  description: "Find references to a symbol",
  args: {
    file: tool.schema.string().describe("Source file path"),
    line: tool.schema.number().describe("Line number (1-based)"),
    column: tool.schema.number().describe("Column number (1-based)"),
  },
  async execute(args) {
    return await runCodegraph(
      ["refs", "--file", args.file, "--line", String(args.line), "--col", String(args.column)],
      async () => {
        if (!codegraph) throw new Error("Library not loaded");
        return codegraph.tool_findReferences(process.cwd(), args.file, args.line, args.column);
      }
    );
  },
});

export const overview = tool({
  description: "Get a high-level overview of a file (imports and definitions)",
  args: {
    file: tool.schema.string().describe("Source file path"),
  },
  async execute(args) {
    return await runCodegraph(
      ["dumpmod", args.file],
      async () => {
        if (!codegraph) throw new Error("Library not loaded");
        return codegraph.tool_getFileOverview(process.cwd(), args.file);
      }
    );
  },
});

export const impact = tool({
  description: "Analyze impact of changes (compare git revisions)",
  args: {
    base: tool.schema.string().describe("Base commit (e.g. main)"),
    head: tool.schema.string().describe("Head commit (e.g. HEAD)"),
  },
  async execute(args) {
    return await runCodegraph(
      ["impact", "--base", args.base, "--head", args.head, "--compact"],
      async () => {
        if (!codegraph) throw new Error("Library not loaded");
        return codegraph.tool_impactJSON(process.cwd(), {
          provider: 'git',
          base: args.base,
          head: args.head
        });
      }
    );
  },
});

export const grep = tool({
  description: "Search for symbols or patterns using Tree-sitter query or regex",
  args: {
    query: tool.schema.string().optional().describe("Tree-sitter query"),
    pattern: tool.schema.string().optional().describe("Regex pattern"),
  },
  async execute(args) {
    if (args.query) {
      return await runCodegraph(["grep", "--query", args.query]);
    } else if (args.pattern) {
      return await runCodegraph(["grep", "--pattern", args.pattern]);
    }
    return "Please provide either a query or a pattern.";
  },
});
```

## Benefits

*   **Robust Navigation**: Works on code that doesn't compile or has missing dependencies.
*   **Multi-language**: Unified interface for TS, JS, Python, Go, Java, C#, Ruby, Rust.
*   **Fast**: Uses incremental caching and Tree-sitter for speed.

## Tips for Agents

Add this to your agent's system prompt to help it use the tools effectively:

> You have access to `codegraph` tools.
> *   Use `codegraph_graph` to understand the project structure and file dependencies.
> *   Use `codegraph_definition` to find where functions/classes are defined.
> *   Use `codegraph_references` to find usages before renaming or refactoring.
> *   Use `codegraph_impact` to see what might break before you edit code.

## Prerequisites

*   Node.js 18+ installed in the environment.
*   `npx` available in the path.
*   (Optional) `@lzehrung/codegraph` installed in the project for faster execution (avoids npx download overhead).
