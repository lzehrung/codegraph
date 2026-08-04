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

export const DEFAULT_MCP_COLLECTION_LIMIT = 100;
export const DEFAULT_RENAME_PREVIEW_EDITS = 5_000;
export const MAX_RENAME_PREVIEW_EDITS = 10_000;
export const MAX_MCP_COLLECTION_LIMIT = 500;
export const MAX_REFACTOR_PLAN_LIMIT = 500;
export const DEFAULT_TYPE_HIERARCHY_LIMIT = 100;
export const MAX_TYPE_HIERARCHY_LIMIT = 500;
export const MAX_TYPE_HIERARCHY_DEPTH = 10;
export const DEFAULT_CALL_HIERARCHY_LIMIT = 100;
export const MAX_CALL_HIERARCHY_LIMIT = 500;
export const MAX_CALL_HIERARCHY_DEPTH = 5;

type ToolInputSchemaProperties = NonNullable<Tool["inputSchema"]["properties"]>;

function objectSchema(properties: ToolInputSchemaProperties, required: string[] = []): Tool["inputSchema"] {
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

function typeHierarchyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
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
  );
}

function callHierarchyInputSchema(): Tool["inputSchema"] {
  return objectSchema(
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
  },
  {
    name: "callers",
    description:
      "Find proven semantic callers and exact grouped callsites for a portable symbol handle. Use refs for every symbol reference and deps for file-level dependencies.",
    inputSchema: callHierarchyInputSchema(),
  },
  {
    name: "callees",
    description:
      "Find proven semantic callees and exact grouped callsites for a portable symbol handle. Use refs for every symbol reference and deps for file-level dependencies.",
    inputSchema: callHierarchyInputSchema(),
  },
  {
    name: "supertypes",
    description:
      "Find proven direct or transitive supertypes for a portable symbol handle. Returns currently extracted extends and implements relationships only.",
    inputSchema: typeHierarchyInputSchema(),
  },
  {
    name: "subtypes",
    description:
      "Find proven direct or transitive subtypes for a portable symbol handle. Returns currently extracted extends and implements relationships only.",
    inputSchema: typeHierarchyInputSchema(),
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
    inputSchema: objectSchema({
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
    }),
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
    name: "refresh_index",
    description: "Invalidate the in-memory Codegraph session and optionally rebuild it.",
    inputSchema: objectSchema({
      warmup: { type: "string", enum: ["off", "base", "symbols"] },
    }),
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
