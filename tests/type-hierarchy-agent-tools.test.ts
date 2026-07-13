import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tool_findImplementations,
  tool_findSubtypes,
  tool_findSupertypes,
} from "../src/agent-tools.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";

let root = "";
let baseHandle = "";
let serviceHandle = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-tools-hierarchy-"));
  await fs.writeFile(
    path.join(root, "types.ts"),
    [
      "export interface Service {}",
      "export class Base {}",
      "export class Worker extends Base implements Service {}",
    ].join("\n"),
  );
  const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });
  const snapshot = await session.loadProject();
  const bases = await workspaceSymbolsInSnapshot(snapshot, { query: "Base" });
  const services = await workspaceSymbolsInSnapshot(snapshot, { query: "Service" });
  baseHandle = bases.symbols.find((symbol) => symbol.localName === "Base")?.handle ?? "";
  serviceHandle = services.symbols.find((symbol) => symbol.localName === "Service")?.handle ?? "";
  if (!baseHandle || !serviceHandle) throw new Error("Tool fixture handles were not indexed");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("type hierarchy agent tools", () => {
  it("uses a supplied warm session for each idiomatic wrapper", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

    const subtypes = await tool_findSubtypes(root, { handle: baseHandle }, { session });
    const supertypes = await tool_findSupertypes(root, { handle: subtypes.relations[0]!.type.handle, depth: 2 }, { session });
    const implementations = await tool_findImplementations(root, { handle: serviceHandle }, { session });

    expect(subtypes.relations.map((entry) => entry.type.name)).toEqual(["Worker"]);
    expect(supertypes.relations.map((entry) => entry.type.name)).toEqual(["Base", "Service"]);
    expect(implementations.implementations.map((entry) => entry.symbol.name)).toEqual(["Worker"]);
  });

  it("rejects ambiguous runtime configuration", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

    await expect(
      tool_findSupertypes(root, { handle: baseHandle }, { session, buildOptions: { cache: "off" } }),
    ).rejects.toThrow("Type hierarchy tool options cannot combine a prebuilt session with buildOptions.");
  });
});
