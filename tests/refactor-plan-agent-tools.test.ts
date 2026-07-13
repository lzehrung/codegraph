import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tool_buildRefactorPlan } from "../src/agent-tools.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let handle = "";
let sourceFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-tools-refactor-plan-"));
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
  if (!handle) throw new Error("Refactor tool fixture handle was not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("refactor plan agent tool", () => {
  it("reuses the supplied caller session and returns authoritative read-only rename evidence", async () => {
    const before = await fs.readFile(sourceFile, "utf8");
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);

    const response = await tool_buildRefactorPlan(
      root,
      { handle, renameTo: "renamedService", includeSource: true },
      { session: counted.session },
    );

    expect(counted.loads()).toBe(1);
    expect(response).toMatchObject({
      target: { name: "service", handle, location: { file: "service.ts" } },
      callers: [{ symbol: { name: "caller" } }],
      callees: [{ symbol: { name: "helper" } }],
      rename: { safe: true, newName: "renamedService" },
    });
    expect(response.references.some((reference) => reference.context?.includes("service()"))).toBe(true);
    expect(await fs.readFile(sourceFile, "utf8")).toBe(before);
  });

  it("rejects ambiguous session and build configuration", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

    await expect(tool_buildRefactorPlan(root, { handle }, { session, buildOptions: { cache: "off" } })).rejects.toThrow(
      "Refactor plan tool options cannot combine a prebuilt session with buildOptions.",
    );
  });
});
