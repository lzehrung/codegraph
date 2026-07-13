import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { createCodegraphMcpHandlers, listCodegraphMcpTools } from "../src/mcp/server.js";
import { isPlainRecord } from "../src/util/guards.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let handle = "";
let sourceFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-refactor-plan-"));
  sourceFile = path.join(root, "service.ts");
  await fs.writeFile(
    sourceFile,
    [
      "export function helper(): number { return 1; }",
      "export function service(): number { return helper(); }",
      "export function caller(): number { return service(); }",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
  handle = symbols.symbols.find((symbol) => symbol.name === "service")?.handle ?? "";
  if (!handle) throw new Error("Refactor MCP fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("refactor plan MCP tool", () => {
  it("registers one flat bounded read-only schema without root or apply fields", () => {
    const tools = listCodegraphMcpTools();
    const tool = tools.find((entry) => entry.name === "refactor_plan");
    if (!tool) throw new Error("refactor_plan was not registered");

    expect(tool.description).toContain("read-only");
    expect(tool.description).toContain("no apply tool exists");
    const schema: unknown = tool.inputSchema;
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) {
      throw new Error("refactor_plan schema was invalid");
    }
    expect(schema.required).toEqual(["handle"]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "handle",
      "includeSource",
      "maxCallers",
      "maxHierarchy",
      "maxReferences",
      "renameTo",
    ]);
    for (const name of ["maxCallers", "maxHierarchy", "maxReferences"]) {
      expect(schema.properties[name]).toEqual({ type: "integer", minimum: 0, maximum: 500 });
    }
    expect(schema.properties).not.toHaveProperty("root");
    expect(schema.properties).not.toHaveProperty("apply");
    expect(tools.some((entry) => entry.name === "refactor_apply")).toBe(false);
  });

  it("stays available in read-only mode, reuses one session, preserves nested safety, and never writes", async () => {
    const before = await fs.readFile(sourceFile, "utf8");
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session, readOnly: true });

    const response = await handlers.refactor_plan({
      handle,
      renameTo: "not/a/name",
      maxReferences: 20,
      maxCallers: 0,
      maxHierarchy: 0,
      includeSource: true,
    });
    const zeroReferences = await handlers.refactor_plan({
      handle,
      maxReferences: 0,
      maxCallers: 20,
      maxHierarchy: 20,
    });

    expect(counted.loads()).toBe(1);
    expect(response).toMatchObject({
      target: { handle, location: { file: "service.ts" } },
      callers: [],
      callees: [],
      rename: {
        safe: false,
        conflicts: [expect.objectContaining({ reason: "invalid_identifier" })],
      },
    });
    expect(response.references.some((reference) => reference.context?.includes("service()"))).toBe(true);
    expect(response.omittedCounts.callers).toBeGreaterThan(0);
    expect(zeroReferences.references).toEqual([]);
    expect(zeroReferences.callers.map((entry) => entry.symbol.name)).toEqual(["caller"]);
    expect(zeroReferences.callees.map((entry) => entry.symbol.name)).toEqual(["helper"]);
    expect(zeroReferences.omittedCounts.references).toBeGreaterThan(0);
    expect(await fs.readFile(sourceFile, "utf8")).toBe(before);
  });
});
