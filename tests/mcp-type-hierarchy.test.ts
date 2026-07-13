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
let baseHandle = "";
let specializedHandle = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-hierarchy-"));
  await fs.writeFile(
    path.join(root, "types.ts"),
    [
      "export interface Service { run(): void }",
      "export class Base {}",
      "export class Worker extends Base implements Service { run(): void {} }",
      "export class Specialized extends Worker {}",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  snapshot = await session.loadProject();
  const bases = await workspaceSymbolsInSnapshot(snapshot, { query: "Base" });
  const specialized = await workspaceSymbolsInSnapshot(snapshot, { query: "Specialized" });
  baseHandle = bases.symbols.find((symbol) => symbol.localName === "Base")?.handle ?? "";
  specializedHandle = specialized.symbols.find((symbol) => symbol.localName === "Specialized")?.handle ?? "";
  if (!baseHandle || !specializedHandle) throw new Error("Hierarchy fixture handles were not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function hierarchyTool(name: string) {
  const tool = listCodegraphMcpTools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

describe("type hierarchy MCP tools", () => {
  it("registers flat bounded schemas and precise descriptions", () => {
    for (const name of ["supertypes", "subtypes"]) {
      const tool = hierarchyTool(name);
      expect(tool.description).toContain("proven");
      const schema: unknown = tool.inputSchema;
      expect(isPlainRecord(schema)).toBe(true);
      if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) throw new Error(`${name} schema was invalid`);
      expect(schema.required).toEqual(["handle"]);
      expect(Object.keys(schema.properties).sort()).toEqual(["depth", "handle", "limit"]);
      expect(schema.properties.depth).toMatchObject({ type: "integer", minimum: 1, maximum: 10, default: 1 });
      expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 100 });
    }

    const implementations = hierarchyTool("implementations");
    expect(implementations.description).toContain("without name-only inference");
    const schema: unknown = implementations.inputSchema;
    expect(isPlainRecord(schema)).toBe(true);
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) {
      throw new Error("implementations schema was invalid");
    }
    expect(schema.required).toEqual(["handle"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["handle", "limit"]);
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 100 });
  });

  it("uses the supplied session freshness gate and preserves bounded omissions", async () => {
    const checkFreshness = vi.fn(async () => ({ state: "refreshed" as const, changedFiles: ["types.ts"] }));
    const loadProject = vi.fn(async () => snapshot);
    const session: AgentSession = {
      root,
      loadProject,
      checkFreshness,
      invalidate: () => undefined,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const response = await handlers.subtypes({ handle: baseHandle, depth: 10, limit: 1 });

    expect(checkFreshness).toHaveBeenCalledTimes(1);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(response.freshness).toEqual({ state: "refreshed", changedFiles: ["types.ts"] });
    expect(response).toMatchObject({
      limits: { relations: 1 },
      omittedCounts: { relations: 1 },
      relations: [{ type: { name: "Worker", location: { file: "types.ts" } }, depth: 1 }],
    });
  });

  it("reuses one warm session across repeated hierarchy handlers", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const first = await handlers.supertypes({ handle: specializedHandle, depth: 3 });
    const second = await handlers.subtypes({ handle: baseHandle, depth: 3 });

    expect(first.relations.map((entry) => entry.type.name)).toEqual(["Worker", "Base", "Service"]);
    expect(second.relations.map((entry) => entry.type.name)).toEqual(["Worker", "Specialized"]);
    expect(counted.loads()).toBe(1);
  });
});
