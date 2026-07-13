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
let consumerFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-rename-"));
  sourceFile = path.join(root, "Service.ts");
  consumerFile = path.join(root, "consumer.ts");
  await fs.writeFile(sourceFile, "export class Service {}\n");
  await fs.writeFile(
    consumerFile,
    [
      'import { Service } from "./Service.js";',
      "export const value = new Service();",
      "// Service documentation",
      'export const label = "Service";',
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "Service", exportedOnly: true });
  handle = symbols.symbols.find((symbol) => symbol.name === "Service")?.handle ?? "";
  if (!handle) throw new Error("Rename MCP fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("rename preview MCP tool", () => {
  it("registers an exact read-only bounded schema with no apply tool", () => {
    const tools = listCodegraphMcpTools();
    const tool = tools.find((entry) => entry.name === "rename_preview");
    if (!tool) throw new Error("rename_preview was not registered");

    expect(tool.description).toContain("without changing files");
    expect(tool.description).toContain("no apply tool exists");
    const schema: unknown = tool.inputSchema;
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) {
      throw new Error("rename_preview schema was invalid");
    }
    expect(schema.required).toEqual(["handle", "newName"]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "handle",
      "includeComments",
      "includeFilenames",
      "includeStrings",
      "maxEdits",
      "newName",
    ]);
    expect(schema.properties.includeComments).toEqual({ type: "boolean" });
    expect(schema.properties.includeStrings).toEqual({ type: "boolean" });
    expect(schema.properties.includeFilenames).toEqual({ type: "boolean" });
    expect(schema.properties.maxEdits).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10_000,
      default: 5_000,
    });
    expect(tools.filter((entry) => entry.name.includes("rename")).map((entry) => entry.name)).toEqual([
      "rename_preview",
    ]);
  });

  it("stays available in read-only mode, reuses one session, preserves booleans, and never writes", async () => {
    const beforeSource = await fs.readFile(sourceFile, "utf8");
    const beforeConsumer = await fs.readFile(consumerFile, "utf8");
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session, readOnly: true });

    const response = await handlers.rename_preview({
      handle,
      newName: "RenamedService",
      includeComments: false,
      includeStrings: true,
      includeFilenames: true,
      maxEdits: 10,
    });
    const invalid = await handlers.rename_preview({ handle, newName: "not/a/name" });

    expect(counted.loads()).toBe(1);
    expect(response).toMatchObject({
      safe: true,
      target: { location: { file: "Service.ts" } },
      filenameSuggestions: [{ from: "Service.ts", to: "RenamedService.ts" }],
    });
    expect(response.edits.some((edit) => edit.kind === "comment")).toBe(false);
    expect(response.edits.filter((edit) => edit.kind === "string")).toHaveLength(1);
    expect(response.edits.every((edit) => !path.isAbsolute(edit.file))).toBe(true);
    expect(invalid).toMatchObject({
      safe: false,
      conflicts: [expect.objectContaining({ reason: "invalid_identifier" })],
    });
    expect(await fs.readFile(sourceFile, "utf8")).toBe(beforeSource);
    expect(await fs.readFile(consumerFile, "utf8")).toBe(beforeConsumer);
  });
});
