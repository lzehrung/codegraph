import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { findCallHierarchy } from "../src/indexer/call-hierarchy.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function callFixture() {
  const root = await mkTmpDir("cg-call-hierarchy-");
  const source = [
    "export function leaf(): number { return 1; }",
    "export function outer(): number {",
    "  leaf();",
    "  leaf();",
    "  function inner(): number { return leaf(); }",
    "  inner();",
    "  return 1;",
    "}",
    "export function recursive(): number { return recursive(); }",
  ].join("\n");
  await fsp.writeFile(path.join(root, "calls.ts"), source);
  const index = await buildProjectIndex(root);
  const graph = await buildSymbolGraphDetailed(index);
  const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node]));
  return { graph, nodesByName, source };
}

describe("call hierarchy", () => {
  it("groups exact callsites and attributes nested calls to the nearest function", async () => {
    const { graph, nodesByName, source } = await callFixture();
    const outer = nodesByName.get("outer");
    const leaf = nodesByName.get("leaf");
    const inner = nodesByName.get("inner");
    expect(outer).toBeDefined();
    expect(leaf).toBeDefined();
    expect(inner).toBeDefined();

    const callees = findCallHierarchy(graph, outer!.id, "outgoing");
    expect(callees.status).toBe("ok");
    if (callees.status !== "ok") return;
    const leafEntry = callees.entries.find((entry) => entry.symbolId === leaf!.id);
    const innerEntry = callees.entries.find((entry) => entry.symbolId === inner!.id);
    expect(leafEntry?.callsites).toHaveLength(2);
    expect(innerEntry?.callsites).toHaveLength(1);
    expect(leafEntry?.callsites.map((site) => source.slice(site.range.start.index, site.range.end.index))).toEqual([
      "leaf",
      "leaf",
    ]);

    const callers = findCallHierarchy(graph, leaf!.id, "incoming");
    expect(callers.status).toBe("ok");
    if (callers.status !== "ok") return;
    expect(
      callers.entries.map((entry) => ({ name: graph.nodes.get(entry.symbolId)?.name, sites: entry.callsites.length })),
    ).toEqual([
      { name: "inner", sites: 1 },
      { name: "outer", sites: 2 },
    ]);
  });

  it("reports recursive calls once without traversing forever", async () => {
    const { graph, nodesByName } = await callFixture();
    const recursive = nodesByName.get("recursive");
    expect(recursive).toBeDefined();
    const result = findCallHierarchy(graph, recursive!.id, "outgoing", { depth: 5 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ symbolId: recursive!.id, depth: 1 });
    expect(result.entries[0]?.callsites).toHaveLength(1);
  });

  it("bounds deterministic transitive traversal and separates symbol and callsite omissions", () => {
    const site = (line: number) => ({
      file: "calls.ts",
      range: {
        start: { line, column: 1, index: line * 10 },
        end: { line, column: 2, index: line * 10 + 1 },
      },
    });
    const graph = {
      nodes: new Map([
        ["a", { id: "a", file: "a.ts", name: "a", kind: "function" as const }],
        ["b", { id: "b", file: "b.ts", name: "b", kind: "function" as const }],
        ["c", { id: "c", file: "c.ts", name: "c", kind: "function" as const }],
      ]),
      edges: [
        { from: "a", to: "b", label: "calls", site: site(1) },
        { from: "a", to: "b", label: "calls", site: site(2) },
        { from: "b", to: "c", label: "calls", site: site(3) },
        { from: "c", to: "a", label: "calls", site: site(4) },
      ],
    };
    const result = findCallHierarchy(graph, "a", "outgoing", { depth: 5, limit: 1, callsiteLimit: 1 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries).toEqual([
      {
        symbolId: "b",
        callsites: [site(1)],
        depth: 1,
        omittedCallsites: 1,
      },
    ]);
    expect(result.omittedSymbols).toBe(2);
    expect(result.omittedCallsites).toBe(1);
  });
});
