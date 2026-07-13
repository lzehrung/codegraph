import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tool_previewRename } from "../src/agent-tools.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let handle = "";
let sourceFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-tools-rename-"));
  sourceFile = path.join(root, "Service.ts");
  await fs.writeFile(sourceFile, "export class Service {}\n");
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "Service", exportedOnly: true });
  handle = symbols.symbols[0]?.handle ?? "";
  if (!handle) throw new Error("Rename tool fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("rename preview agent tool", () => {
  it("reuses the supplied caller session and returns the shared response without writing", async () => {
    const before = await fs.readFile(sourceFile, "utf8");
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);

    const response = await tool_previewRename(
      root,
      { handle, newName: "RenamedService", includeFilenames: true },
      { session: counted.session },
    );

    expect(counted.loads()).toBe(1);
    expect(response).toMatchObject({
      safe: true,
      newName: "RenamedService",
      target: { name: "Service", location: { file: "Service.ts" } },
      edits: [{ file: "Service.ts", oldText: "Service", newText: "RenamedService", kind: "definition" }],
      filenameSuggestions: [{ from: "Service.ts", to: "RenamedService.ts", caseOnlyRisk: false }],
    });
    expect(await fs.readFile(sourceFile, "utf8")).toBe(before);
  });

  it("rejects ambiguous session and build configuration", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

    await expect(
      tool_previewRename(root, { handle, newName: "RenamedService" }, { session, buildOptions: { cache: "off" } }),
    ).rejects.toThrow("Rename preview tool options cannot combine a prebuilt session with buildOptions.");
  });
});
