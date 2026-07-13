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
  it("disambiguates same-named namespace members and excludes unresolved dynamic calls", async () => {
    const root = await mkTmpDir("cg-call-receivers-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export function run(): number { return 1; }\n");
    await fsp.writeFile(path.join(root, "beta.ts"), "export function run(): number { return 2; }\n");
    await fsp.writeFile(
      path.join(root, "receivers.ts"),
      [
        'import * as alpha from "./alpha.js";',
        'import * as beta from "./beta.js";',
        "export function callAlpha(): number { return alpha.run(); }",
        "export function callDynamic(value: { run(): number }): number { return value.run(); }",
        "export function callBeta(): number { return beta.run(); }",
      ].join("\n"),
    );
    const index = await buildProjectIndex(root);
    const graph = await buildSymbolGraphDetailed(index);
    const node = (name: string) => [...graph.nodes.values()].find((candidate) => candidate.name === name);
    const callAlpha = node("callAlpha");
    const callDynamic = node("callDynamic");
    const alphaRun = [...graph.nodes.values()].find(
      (candidate) => candidate.name === "run" && candidate.file.endsWith(`${path.sep}alpha.ts`),
    );
    const betaRun = [...graph.nodes.values()].find(
      (candidate) => candidate.name === "run" && candidate.file.endsWith(`${path.sep}beta.ts`),
    );
    expect(callAlpha).toBeDefined();
    expect(callDynamic).toBeDefined();
    expect(alphaRun).toBeDefined();
    expect(betaRun).toBeDefined();

    const resolved = findCallHierarchy(graph, callAlpha!.id, "outgoing");
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.entries.map((entry) => entry.symbolId)).toContain(alphaRun!.id);
    expect(resolved.entries.map((entry) => entry.symbolId)).not.toContain(betaRun!.id);

    const dynamic = findCallHierarchy(graph, callDynamic!.id, "outgoing");
    expect(dynamic.status).toBe("ok");
    if (dynamic.status !== "ok") return;
    expect(dynamic.entries.map((entry) => entry.symbolId)).not.toContain(alphaRun!.id);
    expect(dynamic.entries.map((entry) => entry.symbolId)).not.toContain(betaRun!.id);
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

  it("orders nodes and callsites by locale-independent code units", () => {
    const site = (file: string, line: number) => ({
      file,
      range: {
        start: { line, column: 1, index: line * 10 },
        end: { line, column: 2, index: line * 10 + 1 },
      },
    });
    const graph = {
      nodes: new Map([
        ["root", { id: "root", file: "root.ts", name: "root", kind: "function" as const }],
        ["upper", { id: "upper", file: "Z.ts", name: "upper", kind: "function" as const }],
        ["lower", { id: "lower", file: "a.ts", name: "lower", kind: "function" as const }],
      ]),
      edges: [
        { from: "root", to: "lower", label: "calls", site: site("a.ts", 3) },
        { from: "root", to: "upper", label: "calls", site: site("a.ts", 2) },
        { from: "root", to: "upper", label: "calls", site: site("Z.ts", 1) },
      ],
    };

    const result = findCallHierarchy(graph, "root", "outgoing");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries.map((entry) => entry.symbolId)).toEqual(["upper", "lower"]);
    expect(result.entries[0]?.callsites.map((callsite) => callsite.file)).toEqual(["Z.ts", "a.ts"]);
  });
});
