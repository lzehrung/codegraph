import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCalleesWithSession, findCallersWithSession } from "../src/agent/callHierarchy.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import type { SymbolEdge } from "../src/graphs/symbol-graph.js";
import { countingSession } from "./helpers/agent.js";

const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "call-hierarchy-warm");

describe("call hierarchy warm-query benchmark fixture", () => {
  it("reuses one loaded project and one adjacency build across repeated warm calls", async () => {
    const baseSession = createAgentSession({
      root: fixtureRoot,
      buildOptions: { cache: "off" },
      freshness: { policy: "manual" },
    });
    const counted = countingSession(baseSession);
    const snapshot = await counted.session.loadProject();
    const leaves = await workspaceSymbolsInSnapshot(snapshot, { query: "leaf" });
    const roots = await workspaceSymbolsInSnapshot(snapshot, { query: "root" });
    const leafHandle = leaves.symbols.find((symbol) => symbol.localName === "leaf")?.handle;
    const rootHandle = roots.symbols.find((symbol) => symbol.localName === "root")?.handle;
    if (!leafHandle || !rootHandle) throw new Error("Warm-query fixture handles were not indexed");

    const edges = snapshot.symbolGraph.edges;
    const edgeStorage = [...edges];
    let edgeIterations = 0;
    Object.defineProperty(edges, Symbol.iterator, {
      configurable: true,
      value: function* iterateEdges(): IterableIterator<SymbolEdge> {
        edgeIterations += 1;
        yield* edgeStorage;
      },
    });

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const callers = await findCallersWithSession(counted.session, {
        root: fixtureRoot,
        handle: leafHandle,
        depth: 3,
      });
      const callees = await findCalleesWithSession(counted.session, {
        root: fixtureRoot,
        handle: rootHandle,
        depth: 3,
      });
      expect(callers.entries.map((entry) => entry.symbol.name)).toEqual(["left", "right", "branch", "root"]);
      expect(callees.entries.map((entry) => entry.symbol.name)).toEqual(["branch", "left", "leaf", "right"]);
    }

    expect(counted.loads()).toBe(1);
    expect(edgeIterations).toBe(1);
  });
});
