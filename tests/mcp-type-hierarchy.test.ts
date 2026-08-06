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
let serviceHandle = "";
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
  const services = await workspaceSymbolsInSnapshot(snapshot, { query: "Service" });
  const specialized = await workspaceSymbolsInSnapshot(snapshot, { query: "Specialized" });
  baseHandle = bases.symbols.find((symbol) => symbol.localName === "Base")?.handle ?? "";
  serviceHandle = services.symbols.find((symbol) => symbol.localName === "Service")?.handle ?? "";
  specializedHandle = specialized.symbols.find((symbol) => symbol.localName === "Specialized")?.handle ?? "";
  if (!baseHandle || !serviceHandle || !specializedHandle)
    throw new Error("Hierarchy fixture handles were not indexed");
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
  it("registers one unified bounded schema and precise descriptions", () => {
    const tool = hierarchyTool("type_hierarchy");
    expect(tool.description).toContain("proven");
    const schema: unknown = tool.inputSchema;
    expect(isPlainRecord(schema)).toBe(true);
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties))
      throw new Error("type_hierarchy schema was invalid");
    expect(schema.required).toEqual(["handle", "direction"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["depth", "direction", "handle", "limit"]);
    expect(schema.properties.direction).toEqual({ type: "string", enum: ["supertypes", "subtypes"] });
    expect(schema.properties.depth).toMatchObject({ type: "integer", minimum: 1, maximum: 10, default: 1 });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 500, default: 25 });

    const implementations = hierarchyTool("implementations");
    expect(implementations.description).toContain("without name-only inference");
    const implementationSchema: unknown = implementations.inputSchema;
    expect(isPlainRecord(implementationSchema)).toBe(true);
    if (!isPlainRecord(implementationSchema) || !isPlainRecord(implementationSchema.properties)) {
      throw new Error("implementations schema was invalid");
    }
    expect(implementationSchema.required).toEqual(["handle"]);
    expect(Object.keys(implementationSchema.properties).sort()).toEqual(["handle", "limit"]);
    expect(implementationSchema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 500,
      default: 25,
    });
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

    const response = await handlers.type_hierarchy({ direction: "subtypes", handle: baseHandle, depth: 10, limit: 1 });
    expect(checkFreshness).toHaveBeenCalledTimes(1);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(response.freshness).toEqual({ state: "refreshed", changedFiles: ["types.ts"] });
    expect(response).toMatchObject({
      limits: { relations: 1 },
      omittedCounts: { relations: 1 },
      relations: [
        {
          type: { name: "Worker", location: { file: "types.ts" } },
          declarationSite: { file: "types.ts" },
          depth: 1,
        },
      ],
    });
  });
  it("runs implementation queries through the supplied session and rejects concrete targets", async () => {
    const checkFreshness = vi.fn(async () => ({ state: "fresh" as const }));
    const loadProject = vi.fn(async () => snapshot);
    const session: AgentSession = {
      root,
      loadProject,
      checkFreshness,
      invalidate: () => undefined,
    };
    const handlers = createCodegraphMcpHandlers({ root, session });

    const response = await handlers.implementations({ handle: serviceHandle, limit: 1 });

    expect(checkFreshness).toHaveBeenCalledTimes(1);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      limits: { relations: 1 },
      omittedCounts: { relations: 1 },
      implementations: [
        {
          symbol: { name: "Specialized", location: { file: "types.ts" } },
          relationSite: { file: "types.ts" },
        },
      ],
    });
    await expect(handlers.implementations({ handle: baseHandle })).rejects.toThrow(/interface|abstract/i);
  });

  it("reuses one warm session across repeated hierarchy handlers", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const first = await handlers.type_hierarchy({ direction: "supertypes", handle: specializedHandle, depth: 3 });
    const second = await handlers.type_hierarchy({ direction: "subtypes", handle: baseHandle, depth: 3 });
    expect(first.relations.map((entry) => entry.type.name)).toEqual(["Worker", "Base", "Service"]);
    expect(second.relations.map((entry) => entry.type.name)).toEqual(["Worker", "Specialized"]);
    expect(counted.loads()).toBe(1);
  });
});
