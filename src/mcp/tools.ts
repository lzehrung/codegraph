import type { Tool } from "@modelcontextprotocol/server";

import {
  DEFAULT_FILE_VIEW_BYTES,
  DEFAULT_FILE_VIEW_LINES,
  MAX_FILE_VIEW_BYTES,
  MAX_FILE_VIEW_LINES,
} from "../agent/fileView.js";
import { DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT } from "../indexer/workspace-symbols.js";
import { SymbolKind } from "../indexer/types.js";

import { DEFAULT_SQLITE_ROW_LIMIT, MAX_SQLITE_ROW_LIMIT } from "./sqliteGuard.js";

export const DEFAULT_MCP_COLLECTION_LIMIT = 25;
export const DEFAULT_RENAME_PREVIEW_EDITS = 5_000;
export const MAX_RENAME_PREVIEW_EDITS = 10_000;
export const MAX_MCP_COLLECTION_LIMIT = 500;
export const MAX_REFACTOR_PLAN_LIMIT = 500;
export const DEFAULT_TYPE_HIERARCHY_LIMIT = 25;
export const MAX_TYPE_HIERARCHY_LIMIT = 500;
export const MAX_TYPE_HIERARCHY_DEPTH = 10;
export const DEFAULT_CALL_HIERARCHY_LIMIT = 25;
export const MAX_CALL_HIERARCHY_LIMIT = 500;
export const MAX_CALL_HIERARCHY_DEPTH = 5;

type ToolInputSchemaProperties = NonNullable<Tool["inputSchema"]["properties"]>;

function objectSchema(properties: ToolInputSchemaProperties, required: string[] = []): Tool["inputSchema"] {
  const schema = required.length
    ? { type: "object" as const, properties, required, additionalProperties: false as const }
    : { type: "object" as const, properties, additionalProperties: false as const };
  return schema;
}

const stringProperty = { type: "string" };
const dependencyFileProperty = {
  type: "string",
  description: "File path, qualified file::symbol path, or portable symbol handle.",
};
const booleanProperty = { type: "boolean" };
const orientBudgetProperty = { type: "string", enum: ["small", "medium", "large"] };

function dependencyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
    {
      direction: { type: "string", enum: ["deps", "rdeps"] },
      file: dependencyFileProperty,
      depth: { type: "integer", minimum: 0, default: 1 },
      limit: {
        type: "integer",
        minimum: 0,
        maximum: MAX_MCP_COLLECTION_LIMIT,
        default: DEFAULT_MCP_COLLECTION_LIMIT,
      },
    },
    ["file", "direction"],
  );
}

function typeHierarchyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
    {
      direction: { type: "string", enum: ["supertypes", "subtypes"] },
      handle: stringProperty,
      depth: { type: "integer", minimum: 1, maximum: MAX_TYPE_HIERARCHY_DEPTH, default: 1 },
      limit: {
        type: "integer",
        minimum: 0,
        maximum: MAX_TYPE_HIERARCHY_LIMIT,
        default: DEFAULT_TYPE_HIERARCHY_LIMIT,
      },
    },
    ["handle", "direction"],
  );
}

function callHierarchyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
    {
      direction: { type: "string", enum: ["callers", "callees"] },
      handle: stringProperty,
      depth: { type: "integer", minimum: 1, maximum: MAX_CALL_HIERARCHY_DEPTH, default: 1 },
      limit: {
        type: "integer",
        minimum: 0,
        maximum: MAX_CALL_HIERARCHY_LIMIT,
        default: DEFAULT_CALL_HIERARCHY_LIMIT,
      },
      includeHeuristic: booleanProperty,
    },
    ["handle", "direction"],
  );
}

function navigationInputSchema(includeLimit: boolean): Tool["inputSchema"] {
  const properties: ToolInputSchemaProperties = {
    handle: stringProperty,
    file: stringProperty,
    line: { type: "integer", minimum: 1 },
    column: { type: "integer", minimum: 0 },
    ...(includeLimit
      ? {
          limit: {
            type: "integer",
            minimum: 0,
            maximum: MAX_MCP_COLLECTION_LIMIT,
            default: DEFAULT_MCP_COLLECTION_LIMIT,
          },
        }
      : {}),
  };
  return {
    ...objectSchema(properties),
    additionalProperties: false,
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
  };
}

export type McpToolDispatch =
  | { handler: "search" }
  | { handler: "workspace_symbols" }
  | { handler: "rename_preview" }
  | { handler: "refactor_plan" }
  | { handler: "calls"; direction?: "callers" | "callees" }
  | { handler: "type_hierarchy"; direction?: "supertypes" | "subtypes" }
  | { handler: "implementations" }
  | { handler: "explore" }
  | { handler: "orient" }
  | { handler: "packet_get" }
  | { handler: "get_file" }
  | { handler: "get_symbol" }
  | { handler: "goto" }
  | { handler: "refs" }
  | { handler: "file_deps"; direction?: "deps" | "rdeps" }
  | { handler: "path" }
  | { handler: "impact" }
  | { handler: "review" }
  | { handler: "query_sqlite" }
  | { handler: "refresh_index" }
  | { handler: "artifact_build" };

export type McpToolDefinition = Tool & { dispatch: McpToolDispatch };

export const MCP_TOOL_REGISTRY: McpToolDefinition[] = [
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
    dispatch: { handler: "search" },
  },
  {
    name: "workspace_symbols",
    description:
      "Deterministic symbol-identity lookup with exact locations and filters. Use hybrid search instead for paths, prose, SQL, snippets, or graph evidence.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        kinds: { type: "array", items: { type: "string", enum: Object.values(SymbolKind) } },
        exportedOnly: booleanProperty,
        includeImports: booleanProperty,
        fileGlob: stringProperty,
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WORKSPACE_SYMBOL_LIMIT,
          default: DEFAULT_WORKSPACE_SYMBOL_LIMIT,
        },
      },
      ["query"],
    ),
    dispatch: { handler: "workspace_symbols" },
  },
  {
    name: "rename_preview",
    description:
      "Preview a semantic rename by portable symbol handle without changing files. Filename results are suggestions only; no apply tool exists.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        newName: stringProperty,
        includeComments: booleanProperty,
        includeStrings: booleanProperty,
        includeFilenames: booleanProperty,
        maxEdits: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RENAME_PREVIEW_EDITS,
          default: DEFAULT_RENAME_PREVIEW_EDITS,
        },
      },
      ["handle", "newName"],
    ),
    dispatch: { handler: "rename_preview" },
  },
  {
    name: "refactor_plan",
    description:
      "Build a read-only refactor evidence packet by symbol handle from one snapshot. Optional rename evidence is authoritative and no apply tool exists.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        renameTo: stringProperty,
        maxReferences: { type: "integer", minimum: 0, maximum: MAX_REFACTOR_PLAN_LIMIT },
        maxCallers: { type: "integer", minimum: 0, maximum: MAX_REFACTOR_PLAN_LIMIT },
        maxHierarchy: { type: "integer", minimum: 0, maximum: MAX_REFACTOR_PLAN_LIMIT },
        includeSource: booleanProperty,
      },
      ["handle"],
    ),
    dispatch: { handler: "refactor_plan" },
  },
  {
    name: "calls",
    description:
      "Find proven semantic callers or callees and exact grouped callsites for a portable symbol handle. Use refs for every symbol reference and file_deps for file-level dependencies.",
    inputSchema: callHierarchyInputSchema(),
    dispatch: { handler: "calls" },
  },
  {
    name: "type_hierarchy",
    description:
      "Find proven direct or transitive supertypes or subtypes for a portable symbol handle. Returns currently extracted extends and implements relationships only.",
    inputSchema: typeHierarchyInputSchema(),
    dispatch: { handler: "type_hierarchy" },
  },
  {
    name: "implementations",
    description:
      "Find proven implementations for a type or supported interface/trait member handle without name-only inference.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TYPE_HIERARCHY_LIMIT,
          default: DEFAULT_TYPE_HIERARCHY_LIMIT,
        },
      },
      ["handle"],
    ),
    dispatch: { handler: "implementations" },
  },
  {
    name: "explore",
    description:
      "Recommended first tool for broad repo questions; returns bounded anchors, source packets, paths, blast radius, tests, and follow-ups.",
    inputSchema: objectSchema(
      {
        query: stringProperty,
        limit: { type: "integer", minimum: 0, maximum: 50, default: 5 },
        maxPackets: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        maxPaths: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        includeSource: { type: "boolean", default: true },
      },
      ["query"],
    ),
    dispatch: { handler: "explore" },
  },
  {
    name: "orient",
    description: "Build a compact first-turn packet for agent repo context.",
    inputSchema: objectSchema({
      includeRoots: { type: "array", items: stringProperty },
      budget: orientBudgetProperty,
    }),
    dispatch: { handler: "orient" },
  },
  {
    name: "packet_get",
    description: "Retrieve a bounded evidence packet by file path, symbol name, SQL object name, or stable target.",
    inputSchema: objectSchema(
      {
        target: stringProperty,
        maxSymbols: { type: "integer", minimum: 1, maximum: 200 },
        maxSnippets: { type: "integer", minimum: 1, maximum: 50 },
        maxDuplicates: { type: "integer", minimum: 1, maximum: 20 },
      },
      ["target"],
    ),
    dispatch: { handler: "packet_get" },
  },
  {
    name: "get_file",
    description: "Read a bounded project file by relative path with line pagination and optional graph context.",
    inputSchema: objectSchema(
      {
        file: stringProperty,
        offset: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_FILE_VIEW_LINES, default: DEFAULT_FILE_VIEW_LINES },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_VIEW_BYTES, default: DEFAULT_FILE_VIEW_BYTES },
        includeGraphContext: { type: "boolean", default: false },
        allowSensitive: { type: "boolean", default: false },
      },
      ["file"],
    ),
    dispatch: { handler: "get_file" },
  },
  {
    name: "get_symbol",
    description: "Resolve a stable search or explain handle.",
    inputSchema: objectSchema({ handle: stringProperty }, ["handle"]),
    dispatch: { handler: "get_symbol" },
  },
  {
    name: "goto",
    description: "Resolve a definition by portable handle, qualified file::symbol path, or file position.",
    inputSchema: navigationInputSchema(false),
    dispatch: { handler: "goto" },
  },
  {
    name: "refs",
    description: "Find references by portable handle, qualified file::symbol path, or file position.",
    inputSchema: navigationInputSchema(true),
    dispatch: { handler: "refs" },
  },
  {
    name: "file_deps",
    description:
      "List file dependencies or reverse file dependencies by file path, qualified file::symbol path, or portable handle.",
    inputSchema: dependencyInputSchema(),
    dispatch: { handler: "file_deps" },
  },
  {
    name: "path",
    description: "Find the shortest dependency path between two files.",
    inputSchema: objectSchema({ from: stringProperty, to: stringProperty }, ["from", "to"]),
    dispatch: { handler: "path" },
  },
  {
    name: "impact",
    description: "Build compact impact context for a git range.",
    inputSchema: objectSchema({ base: stringProperty, head: stringProperty }, ["base", "head"]),
    dispatch: { handler: "impact" },
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
    dispatch: { handler: "review" },
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
    dispatch: { handler: "query_sqlite" },
  },
  {
    name: "refresh_index",
    description: "Invalidate the in-memory Codegraph session and optionally rebuild it.",
    inputSchema: objectSchema({
      warmup: { type: "string", enum: ["off", "base", "symbols"] },
    }),
    dispatch: { handler: "refresh_index" },
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
    dispatch: { handler: "artifact_build" },
  },
  {
    name: "callers",
    description: "Legacy alias for calls with direction callers.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        depth: { type: "integer", minimum: 1, maximum: MAX_CALL_HIERARCHY_DEPTH, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_CALL_HIERARCHY_LIMIT,
          default: DEFAULT_CALL_HIERARCHY_LIMIT,
        },
        includeHeuristic: booleanProperty,
      },
      ["handle"],
    ),
    dispatch: { handler: "calls", direction: "callers" },
  },
  {
    name: "callees",
    description: "Legacy alias for calls with direction callees.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        depth: { type: "integer", minimum: 1, maximum: MAX_CALL_HIERARCHY_DEPTH, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_CALL_HIERARCHY_LIMIT,
          default: DEFAULT_CALL_HIERARCHY_LIMIT,
        },
        includeHeuristic: booleanProperty,
      },
      ["handle"],
    ),
    dispatch: { handler: "calls", direction: "callees" },
  },
  {
    name: "supertypes",
    description: "Legacy alias for type_hierarchy with direction supertypes.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        depth: { type: "integer", minimum: 1, maximum: MAX_TYPE_HIERARCHY_DEPTH, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TYPE_HIERARCHY_LIMIT,
          default: DEFAULT_TYPE_HIERARCHY_LIMIT,
        },
      },
      ["handle"],
    ),
    dispatch: { handler: "type_hierarchy", direction: "supertypes" },
  },
  {
    name: "subtypes",
    description: "Legacy alias for type_hierarchy with direction subtypes.",
    inputSchema: objectSchema(
      {
        handle: stringProperty,
        depth: { type: "integer", minimum: 1, maximum: MAX_TYPE_HIERARCHY_DEPTH, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TYPE_HIERARCHY_LIMIT,
          default: DEFAULT_TYPE_HIERARCHY_LIMIT,
        },
      },
      ["handle"],
    ),
    dispatch: { handler: "type_hierarchy", direction: "subtypes" },
  },
  {
    name: "deps",
    description: "Legacy alias for file_deps with direction deps.",
    inputSchema: objectSchema(
      {
        file: dependencyFileProperty,
        depth: { type: "integer", minimum: 0, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      ["file"],
    ),
    dispatch: { handler: "file_deps", direction: "deps" },
  },
  {
    name: "rdeps",
    description: "Legacy alias for file_deps with direction rdeps.",
    inputSchema: objectSchema(
      {
        file: dependencyFileProperty,
        depth: { type: "integer", minimum: 0, default: 1 },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_MCP_COLLECTION_LIMIT,
          default: DEFAULT_MCP_COLLECTION_LIMIT,
        },
      },
      ["file"],
    ),
    dispatch: { handler: "file_deps", direction: "rdeps" },
  },
];

export function listCodegraphMcpTools(): Tool[] {
  return MCP_TOOL_REGISTRY.map(({ dispatch: _dispatch, ...tool }) => tool);
}
