import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_SQLITE_ROW_LIMIT, MAX_SQLITE_ROW_LIMIT } from "./sqliteGuard.js";

export const DEFAULT_FILE_BYTES = 80_000;
export const MAX_FILE_BYTES = 500_000;
export const DEFAULT_MCP_COLLECTION_LIMIT = 100;
export const MAX_MCP_COLLECTION_LIMIT = 500;

function objectSchema(properties: Record<string, object>, required: string[] = []): Tool["inputSchema"] {
  return required.length ? { type: "object", properties, required } : { type: "object", properties };
}

const stringProperty = { type: "string" };
const booleanProperty = { type: "boolean" };
const orientBudgetProperty = { type: "string", enum: ["small", "medium", "large"] };

function dependencyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
    {
      file: stringProperty,
      depth: { type: "integer", minimum: 0, default: 1 },
      limit: {
        type: "integer",
        minimum: 0,
        maximum: MAX_MCP_COLLECTION_LIMIT,
        default: DEFAULT_MCP_COLLECTION_LIMIT,
      },
    },
    ["file"],
  );
}

export const MCP_TOOLS: Tool[] = [
  {
    name: "search",
    description: "Deterministic ranked search across files, symbols, chunks, SQL objects, and graph context.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        mode: { type: "string", enum: ["hybrid", "symbol", "path", "text", "graph", "sql"] },
        from: stringProperty,
        depth: { type: "integer", minimum: 0, default: 1, description: "Graph neighborhood depth." },
        limit: { type: "integer", minimum: 0, maximum: 100, default: 20 },
      },
      ["query"],
    ),
  },
  {
    name: "orient",
    description: "Build a compact first-turn packet for agent repo context.",
    inputSchema: objectSchema({
      includeRoots: { type: "array", items: stringProperty },
      budget: orientBudgetProperty,
    }),
  },
  {
    name: "packet_get",
    description: "Retrieve a bounded evidence packet by stable handle.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        maxSymbols: { type: "integer", minimum: 1, maximum: 200 },
        maxSnippets: { type: "integer", minimum: 1, maximum: 50 },
      },
      ["handle"],
    ),
  },
  {
    name: "get_file",
    description: "Read a bounded project file by relative path.",
    inputSchema: objectSchema(
      { file: stringProperty, maxBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES } },
      ["file"],
    ),
  },
  {
    name: "get_symbol",
    description: "Resolve a stable search or explain handle.",
    inputSchema: objectSchema({ handle: stringProperty }, ["handle"]),
  },
  {
    name: "goto",
    description: "Resolve the definition at a file position.",
    inputSchema: objectSchema(
      { file: stringProperty, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 0 } },
      ["file", "line", "column"],
    ),
  },
  {
    name: "refs",
    description: "Find references by stable handle or file position.",
    inputSchema: {
      type: "object",
      properties: {
        handle: stringProperty,
        file: stringProperty,
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 0 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      oneOf: [
        {
          required: ["handle"],
          not: {
            anyOf: [{ required: ["file"] }, { required: ["line"] }, { required: ["column"] }],
          },
        },
        {
          required: ["file", "line", "column"],
          not: { required: ["handle"] },
        },
      ],
    },
  },
  {
    name: "deps",
    description: "List file dependencies.",
    inputSchema: dependencyInputSchema(),
  },
  {
    name: "rdeps",
    description: "List reverse file dependencies.",
    inputSchema: dependencyInputSchema(),
  },
  {
    name: "path",
    description: "Find the shortest dependency path between two files.",
    inputSchema: objectSchema({ from: stringProperty, to: stringProperty }, ["from", "to"]),
  },
  {
    name: "impact",
    description: "Build compact impact context for a git range.",
    inputSchema: objectSchema({ base: stringProperty, head: stringProperty }, ["base", "head"]),
  },
  {
    name: "review",
    description: "Build review context for a git range.",
    inputSchema: objectSchema(
      {
        base: stringProperty,
        head: stringProperty,
        reviewDepth: { type: "string", enum: ["minimal", "standard", "deep"] },
      },
      ["base", "head"],
    ),
  },
  {
    name: "query_sqlite",
    description: "Run a bounded read-only SQL query against the graph SQLite artifact.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        params: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        },
        limit: { type: "integer", minimum: 0, maximum: MAX_SQLITE_ROW_LIMIT, default: DEFAULT_SQLITE_ROW_LIMIT },
      },
      ["query"],
    ),
  },
  {
    name: "artifact_build",
    description: "Build Codegraph artifacts when write tools are explicitly enabled.",
    inputSchema: objectSchema({
      outDir: stringProperty,
      sqlite: booleanProperty,
      graphJson: booleanProperty,
      report: booleanProperty,
      questions: booleanProperty,
      force: booleanProperty,
    }),
  },
];

export function listCodegraphMcpTools(): Tool[] {
  return MCP_TOOLS.map((tool) => ({ ...tool }));
}
