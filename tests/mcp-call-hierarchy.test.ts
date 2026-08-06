import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import { createCodegraphMcpHandlers, listCodegraphMcpTools } from "../src/mcp/server.js";
import { isPlainRecord } from "../src/util/guards.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let snapshot: AgentProjectSnapshot;
let leafHandle = "";
let outerHandle = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-calls-"));
  await fs.writeFile(
    path.join(root, "calls.ts"),
    [
      "export function leaf(): number { return 1; }",
      "export function middle(): number { leaf(); leaf(); return 2; }",
      "export function outer(): number { return middle(); }",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  snapshot = await session.loadProject();
  const leaves = await workspaceSymbolsInSnapshot(snapshot, { query: "leaf" });
  const outers = await workspaceSymbolsInSnapshot(snapshot, { query: "outer" });
  leafHandle = leaves.symbols.find((symbol) => symbol.localName === "leaf")?.handle ?? "";
  outerHandle = outers.symbols.find((symbol) => symbol.localName === "outer")?.handle ?? "";
  if (!leafHandle || !outerHandle) throw new Error("MCP call fixture handles were not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function hierarchyTool(name: string) {
  const tool = listCodegraphMcpTools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

describe("call hierarchy MCP tools", () => {
  it("registers one unified bounded schema and semantic-only description", () => {
    const tool = hierarchyTool("calls");
    expect(tool.description).toContain("proven semantic");
    expect(tool.description).toContain("Use refs");
    const schema: unknown = tool.inputSchema;
    expect(isPlainRecord(schema)).toBe(true);
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) throw new Error("calls schema was invalid");
    expect(schema.required).toEqual(["handle", "direction"]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "depth",
      "direction",
      "handle",
      "includeHeuristic",
      "limit",
    ]);
    expect(schema.properties.direction).toEqual({ type: "string", enum: ["callers", "callees"] });
    expect(schema.properties.depth).toMatchObject({ type: "integer", minimum: 1, maximum: 5, default: 1 });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 25 });
    expect(schema.properties.includeHeuristic).toEqual({ type: "boolean" });
    const names = listCodegraphMcpTools().map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["calls", "type_hierarchy", "file_deps"]));
    expect(names).not.toEqual(
      expect.arrayContaining(["callers", "callees", "supertypes", "subtypes", "deps", "rdeps"]),
    );
  });
  it("registers a unified file dependency schema", () => {
    const tool = hierarchyTool("file_deps");
    const schema: unknown = tool.inputSchema;
    expect(isPlainRecord(schema)).toBe(true);
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) throw new Error("file_deps schema was invalid");
    expect(schema.required).toEqual(["file", "direction"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["depth", "direction", "file", "limit"]);
    expect(schema.properties.direction).toEqual({ type: "string", enum: ["deps", "rdeps"] });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 25 });
  });

  it("uses the supplied freshness gate and preserves grouped callsite and omission counts", async () => {
    const checkFreshness = vi.fn(async () => ({ state: "refreshed" as const, changedFiles: ["calls.ts"] }));
    const loadProject = vi.fn(async () => snapshot);
    const session: AgentSession = {
      root,
      loadProject,
      checkFreshness,
      invalidate: () => undefined,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const response = await handlers.calls({
      direction: "callers",
      handle: leafHandle,
      depth: 2,
      limit: 1,
      includeHeuristic: true,
    });

    expect(checkFreshness).toHaveBeenCalledTimes(1);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(response.freshness).toEqual({ state: "refreshed", changedFiles: ["calls.ts"] });
    expect(response).toMatchObject({
      limits: { symbols: 1, callsitesPerSymbol: 50 },
      omittedCounts: { symbols: 1, callsites: 0, unresolvedSites: 0 },
      entries: [
        {
          symbol: { name: "middle", location: { file: "calls.ts" } },
          depth: 1,
          callsites: [{ file: "calls.ts" }, { file: "calls.ts" }],
        },
      ],
    });
  });

  it("reuses one loaded snapshot across repeated caller and callee handlers", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const callers = await handlers.calls({ direction: "callers", handle: leafHandle, depth: 2 });
    const callees = await handlers.calls({ direction: "callees", handle: outerHandle, depth: 2 });

    expect(callers.entries.map((entry) => entry.symbol.name)).toEqual(["middle", "outer"]);
    expect(callees.entries.map((entry) => entry.symbol.name)).toEqual(["middle", "leaf"]);
    expect(counted.loads()).toBe(1);
  });
});
