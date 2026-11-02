import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { defNodeId, type SymbolEdge, type SymbolGraph, type SymbolNode } from "../src/graphs/symbol-graph.js";
import { findCallHierarchy, MAX_CALL_HIERARCHY_DEPTH } from "../src/indexer/call-hierarchy.js";
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
  it("resolves nested calls at their lexical use site instead of a module local or import alias", async () => {
    const root = await mkTmpDir("cg-call-lexical-scope-");
    const source = [
      'import { helper as importedHelper } from "./dependency.js";',
      "export function helper(): number { return 1; }",
      "export function outer(): number {",
      "  function helper(): number { return 2; }",
      "  return helper();",
      "}",
      "export function outerImport(): number {",
      "  function importedHelper(): number { return 3; }",
      "  return importedHelper();",
      "}",
    ].join("\n");
    await fsp.writeFile(path.join(root, "dependency.ts"), "export function helper(): number { return 0; }\n");
    await fsp.writeFile(path.join(root, "calls.ts"), source);
    const index = await buildProjectIndex(root);
    const graph = await buildSymbolGraphDetailed(index);
    const calls = index.byFile.get([...index.byFile.keys()].find((file) => file.endsWith("/calls.ts"))!);
    const dependency = index.byFile.get([...index.byFile.keys()].find((file) => file.endsWith("/dependency.ts"))!);
    const outer = calls?.locals.find((local) => local.localName === "outer");
    const nestedHelper = calls?.locals.find(
      (local) =>
        local.localName === "helper" && local.range.start.index === source.indexOf("helper", source.indexOf("outer")),
    );
    const outerImport = calls?.locals.find((local) => local.localName === "outerImport");
    const nestedImportedHelper = calls?.locals.find(
      (local) =>
        local.localName === "importedHelper" &&
        local.range.start.index === source.indexOf("importedHelper", source.indexOf("outerImport")),
    );
    const importedHelper = dependency?.locals.find((local) => local.localName === "helper");
    expect(outer).toBeDefined();
    expect(nestedHelper).toBeDefined();
    expect(outerImport).toBeDefined();
    expect(nestedImportedHelper).toBeDefined();
    expect(importedHelper).toBeDefined();

    const nestedCall = graph.edges.find(
      (edge) => edge.from === defNodeId(outer!) && edge.to === defNodeId(nestedHelper!) && edge.label === "calls",
    );
    expect(nestedCall?.site && source.slice(nestedCall.site.range.start.index, nestedCall.site.range.end.index)).toBe(
      "helper",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === defNodeId(outerImport!) && edge.to === defNodeId(importedHelper!) && edge.label === "calls",
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === defNodeId(outerImport!) &&
          edge.to === defNodeId(nestedImportedHelper!) &&
          edge.label === "calls",
      ),
    ).toBe(true);
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
      (candidate) => candidate.name === "run" && candidate.file.endsWith("/alpha.ts"),
    );
    const betaRun = [...graph.nodes.values()].find(
      (candidate) => candidate.name === "run" && candidate.file.endsWith("/beta.ts"),
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

  it("rejects invalid depth, limit, and callsite limit options by name", () => {
    const graph = {
      nodes: new Map([["a", { id: "a", file: "a.ts", name: "a", kind: "function" as const }]]),
      edges: [],
    };
    expect(() => findCallHierarchy(graph, "a", "outgoing", { depth: -1 })).toThrow(
      "Call hierarchy depth must be a non-negative integer.",
    );
    expect(() => findCallHierarchy(graph, "a", "outgoing", { depth: 0 })).toThrow(
      "Call hierarchy depth must be a positive integer.",
    );
    expect(() => findCallHierarchy(graph, "a", "outgoing", { limit: 1.5 })).toThrow(
      "Call hierarchy limit must be a non-negative integer.",
    );
    expect(() => findCallHierarchy(graph, "a", "outgoing", { callsiteLimit: -1 })).toThrow(
      "Callsite limit must be a non-negative integer.",
    );
    expect(findCallHierarchy(graph, "a", "outgoing", { depth: 99, limit: 0, callsiteLimit: 0 })).toMatchObject({
      status: "ok",
      limit: 0,
      callsiteLimit: 0,
    });
  });
});

/**
 * `layers` layers of `width` functions: every function of a layer calls every function of the next one, so a walk
 * that expands a function once per path has `width ** layers` paths to follow. With `cycles`, each function of layer
 * L + 1 (L >= 1) also calls the first function of layer L.
 */
function ladderGraph(options: { layers: number; width: number; cycles?: boolean }): SymbolGraph {
  const id = (layer: number, index: number): string => `n${String(layer).padStart(2, "0")}_${index}`;
  const nodes = new Map<string, SymbolNode>();
  for (let layer = 0; layer < options.layers; layer += 1) {
    for (let index = 0; index < options.width; index += 1) {
      nodes.set(id(layer, index), {
        id: id(layer, index),
        file: `l${String(layer).padStart(2, "0")}.ts`,
        name: id(layer, index),
        kind: "function",
      });
    }
  }
  const edges: SymbolEdge[] = [];
  let line = 0;
  const call = (from: string, to: string): void => {
    line += 1;
    edges.push({
      from,
      to,
      label: "calls",
      site: {
        file: "sites.ts",
        range: { start: { line, column: 1, index: line * 10 }, end: { line, column: 2, index: line * 10 + 1 } },
      },
    });
  };
  for (let layer = 0; layer + 1 < options.layers; layer += 1) {
    for (let from = 0; from < options.width; from += 1) {
      for (let to = 0; to < options.width; to += 1) call(id(layer, from), id(layer + 1, to));
      if (options.cycles && layer >= 1) call(id(layer + 1, from), id(layer, 0));
    }
  }
  return { nodes, edges };
}

describe("call hierarchy at the depth cap", () => {
  it("raises the cap to 15 levels", () => {
    expect(MAX_CALL_HIERARCHY_DEPTH).toBe(15);
  });

  it("reports every symbol of fifteen levels once, nearest first, without following each path", () => {
    // Four functions per layer give 4 ** 15 paths from the first layer to the sixteenth; one visit per symbol is 60.
    const graph = ladderGraph({ layers: 20, width: 4 });
    const result = findCallHierarchy(graph, "n00_0", "outgoing", { depth: 15, limit: 500 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const expected = Array.from({ length: 15 }, (_, level) =>
      Array.from({ length: 4 }, (_, index) => `n${String(level + 1).padStart(2, "0")}_${index}`),
    );
    expect(result.entries.map((entry) => [entry.depth, entry.symbolId])).toEqual(
      expected.flatMap((level, levelIndex) => level.map((symbolId) => [levelIndex + 1, symbolId])),
    );
    expect(result.omittedSymbols).toBe(0);
    expect(result.unresolvedEdges).toBe(0);
    // The first level is called from the start only; every deeper symbol from the four functions above it.
    expect(result.entries.slice(0, 4).map((entry) => entry.callsites.length)).toEqual([1, 1, 1, 1]);
    expect(result.entries.slice(4).every((entry) => entry.callsites.length === 4)).toBe(true);
  });

  it("walks callers upward the same way and stops at the cap", () => {
    const graph = ladderGraph({ layers: 20, width: 4 });
    const result = findCallHierarchy(graph, "n19_0", "incoming", { depth: MAX_CALL_HIERARCHY_DEPTH, limit: 500 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.entries).toHaveLength(60);
    expect(result.entries.map((entry) => entry.depth)).toEqual(
      Array.from({ length: 60 }, (_, position) => Math.floor(position / 4) + 1),
    );
    // Level 15 is layer 4; the layers above it are beyond the cap.
    expect(result.entries.at(-1)?.symbolId).toBe("n04_3");
    expect(result.entries.some((entry) => entry.symbolId.startsWith("n03_"))).toBe(false);
  });

  it("terminates on cycles and reports each member once", () => {
    const graph = ladderGraph({ layers: 20, width: 4, cycles: true });
    const result = findCallHierarchy(graph, "n00_0", "outgoing", { depth: 15, limit: 500 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const symbols = result.entries.map((entry) => entry.symbolId);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols).toHaveLength(60);
    expect(Math.max(...result.entries.map((entry) => entry.depth))).toBe(15);
    // The first function of a layer is also called by the four functions of the layer below it, which adds four
    // callsites to the four forward ones.
    const first = result.entries.find((entry) => entry.symbolId === "n03_0");
    expect(first?.depth).toBe(3);
    expect(first?.callsites).toHaveLength(8);
  });

  it("bounds a fifteen-level result by the symbol limit and reports what it left out", () => {
    const graph = ladderGraph({ layers: 20, width: 4 });
    const result = findCallHierarchy(graph, "n00_0", "outgoing", { depth: 15, limit: 10, callsiteLimit: 2 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.limit).toBe(10);
    expect(result.entries.map((entry) => entry.symbolId)).toEqual([
      "n01_0",
      "n01_1",
      "n01_2",
      "n01_3",
      "n02_0",
      "n02_1",
      "n02_2",
      "n02_3",
      "n03_0",
      "n03_1",
    ]);
    expect(result.omittedSymbols).toBe(50);
    expect(result.entries.map((entry) => entry.omittedCallsites)).toEqual([0, 0, 0, 0, 2, 2, 2, 2, 2, 2]);
    expect(result.omittedCallsites).toBe(12);
  });

  it("leaves results to depth 5 unchanged by a deeper cap and clamps a larger request to it", () => {
    const graph = ladderGraph({ layers: 20, width: 4, cycles: true });
    const deep = findCallHierarchy(graph, "n00_0", "outgoing", { depth: 15, limit: 500 });
    const shallow = findCallHierarchy(graph, "n00_0", "outgoing", { depth: 5, limit: 500 });
    expect(deep.status).toBe("ok");
    expect(shallow.status).toBe("ok");
    if (deep.status !== "ok" || shallow.status !== "ok") return;

    expect(shallow.entries).toHaveLength(20);
    // Callsites of a function on level 5 that a deeper level calls again are only counted by the deeper walk, so
    // compare the symbols and depths, which a deeper cap must not change.
    expect(shallow.entries.map((entry) => [entry.symbolId, entry.depth])).toEqual(
      deep.entries.filter((entry) => entry.depth <= 5).map((entry) => [entry.symbolId, entry.depth]),
    );
    expect(findCallHierarchy(graph, "n00_0", "outgoing", { depth: 99, limit: 500 })).toEqual(deep);
  });
});
