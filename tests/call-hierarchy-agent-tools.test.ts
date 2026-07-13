import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tool_findCallees, tool_findCallers } from "../src/agent-tools.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let leafHandle = "";
let outerHandle = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-tools-calls-"));
  await fs.writeFile(
    path.join(root, "calls.ts"),
    [
      "export function leaf(): number { return 1; }",
      "export function middle(): number {",
      "  leaf();",
      "  leaf();",
      "  function inner(): number { return leaf(); }",
      "  inner();",
      "  return 2;",
      "}",
      "export function outer(): number { return middle(); }",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const snapshot = await session.loadProject();
  const leaves = await workspaceSymbolsInSnapshot(snapshot, { query: "leaf" });
  const outers = await workspaceSymbolsInSnapshot(snapshot, { query: "outer" });
  leafHandle = leaves.symbols.find((symbol) => symbol.localName === "leaf")?.handle ?? "";
  outerHandle = outers.symbols.find((symbol) => symbol.localName === "outer")?.handle ?? "";
  if (!leafHandle || !outerHandle) throw new Error("Call tool fixture handles were not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("call hierarchy agent tools", () => {
  it("uses one supplied warm session for caller and callee wrappers", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
    const counted = countingSession(session);

    const callers = await tool_findCallers(
      root,
      { handle: leafHandle, depth: 1, includeHeuristic: true },
      { session: counted.session },
    );
    const callees = await tool_findCallees(root, { handle: outerHandle, depth: 2 }, { session: counted.session });

    expect(callers.entries.map((entry) => [entry.symbol.name, entry.depth, entry.callsites.length])).toEqual([
      ["inner", 1, 1],
      ["middle", 1, 2],
    ]);
    expect(callers.entries[1]?.callsites.map((site) => site.file)).toEqual(["calls.ts", "calls.ts"]);
    expect(callees.entries.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
      ["middle", 1],
      ["inner", 2],
      ["leaf", 2],
    ]);
    expect(counted.loads()).toBe(1);
  });

  it("rejects ambiguous runtime configuration", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

    await expect(
      tool_findCallers(root, { handle: leafHandle }, { session, buildOptions: { cache: "off" } }),
    ).rejects.toThrow("Call hierarchy tool options cannot combine a prebuilt session with buildOptions.");
  });
});
