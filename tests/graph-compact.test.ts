import { describe, expect, it } from "vitest";
import { compactFileGraph, compactGraphWithSymbols, compactSymbolsOnly } from "../src/cli/graph.js";
import type { SymbolGraph, SymbolNode } from "../src/graphs/symbol-graph.js";
import type { Graph } from "../src/types.js";

function makeFileGraph(): Graph {
  return {
    nodes: new Set(["/root/a.ts", "/root/b.ts", "/root/c.ts"]),
    edges: [
      { from: "/root/a.ts", to: { type: "file", path: "/root/b.ts" }, raw: "./b" },
      {
        from: "/root/a.ts",
        to: { type: "file", path: "/root/c.ts" },
        raw: "./c-dynamic",
        typeOnly: false,
        resolved: "heuristic",
        confidence: 0.8,
      },
      { from: "/root/b.ts", to: { type: "external", name: "react" }, raw: "react" },
    ],
  };
}

function makeSymbolGraph(): SymbolGraph {
  const nodes = new Map<string, SymbolNode>();
  nodes.set("/root/a.ts::foo::0", {
    id: "/root/a.ts::foo::0",
    file: "/root/a.ts",
    name: "foo",
    kind: "function",
    docstring: "does foo things",
    lineSpan: 4,
    complexity: 2,
    visibility: "public",
    implementationTarget: true,
    memberArity: 1,
  });
  nodes.set("/root/b.ts::bar::0", {
    id: "/root/b.ts::bar::0",
    file: "/root/b.ts",
    name: "bar",
    kind: "function",
  });
  return {
    nodes,
    edges: [{ from: "/root/a.ts::foo::0", to: "/root/b.ts::bar::0", label: "calls" }],
  };
}

describe("compactFileGraph", () => {
  it("replaces repeated file paths in edges with indices into files[]", () => {
    const { files, fileEdges } = compactFileGraph(makeFileGraph(), false);
    expect(files).toEqual(["/root/a.ts", "/root/b.ts", "/root/c.ts"]);
    const aIndex = files.indexOf("/root/a.ts");
    const bIndex = files.indexOf("/root/b.ts");
    const cIndex = files.indexOf("/root/c.ts");

    expect(fileEdges).toContainEqual({ from: aIndex, to: { type: "file", path: bIndex }, raw: "./b" });
    expect(fileEdges).toContainEqual({
      from: aIndex,
      to: { type: "file", path: cIndex },
      raw: "./c-dynamic",
      typeOnly: false,
      resolved: "heuristic",
      confidence: 0.8,
    });
    expect(fileEdges).toContainEqual({ from: bIndex, to: { type: "external", name: "react" }, raw: "react" });
  });

  it("never repeats a full file path string inside an edge", () => {
    const { fileEdges } = compactFileGraph(makeFileGraph(), false);
    for (const edge of fileEdges) {
      expect(typeof edge.from).toBe("number");
      if (edge.to.type === "file") {
        expect(typeof edge.to.path).toBe("number");
      }
    }
  });

  it("sorts files regardless of stable, so index assignment does not depend on Set insertion order", () => {
    // fgraph.nodes insertion order can vary run to run under concurrent extraction (files
    // finish parsing in different orders across worker threads); index assignment must not
    // depend on it, or two runs over an unchanged repo could disagree on what index N means.
    const insertedOutOfOrder: Graph = {
      nodes: new Set(["/root/b.ts", "/root/a.ts"]),
      edges: [{ from: "/root/b.ts", to: { type: "file", path: "/root/a.ts" }, raw: "./a" }],
    };
    const unstable = compactFileGraph(insertedOutOfOrder, false);
    const stable = compactFileGraph(insertedOutOfOrder, true);
    expect(unstable.files).toEqual(["/root/a.ts", "/root/b.ts"]);
    expect(stable.files).toEqual(unstable.files);
  });

  it("only sorts the fileEdges array order when stable is true", () => {
    const graph: Graph = {
      nodes: new Set(["/root/a.ts", "/root/b.ts"]),
      edges: [
        { from: "/root/b.ts", to: { type: "file", path: "/root/a.ts" }, raw: "./a" },
        { from: "/root/a.ts", to: { type: "external", name: "zeta" }, raw: "zeta" },
      ],
    };
    const unstable = compactFileGraph(graph, false);
    const stable = compactFileGraph(graph, true);
    // Insertion order preserved when not stable: the b->a edge came first in the source graph.
    expect(unstable.fileEdges[0]?.from).toBe(unstable.files.indexOf("/root/b.ts"));
    // Sorted by from-index when stable: the a->zeta edge (from index 0) comes first.
    expect(stable.fileEdges[0]?.from).toBe(0);
  });
});

describe("compactGraphWithSymbols", () => {
  it("preserves all symbol node metadata fields when compacting", () => {
    const result = compactGraphWithSymbols(makeFileGraph(), makeSymbolGraph(), false);
    const fooSymbol = result.symbols.find((s) => s.name === "foo");
    expect(fooSymbol).toMatchObject({
      docstring: "does foo things",
      lineSpan: 4,
      complexity: 2,
      visibility: "public",
      implementationTarget: true,
      memberArity: 1,
    });
    expect(typeof fooSymbol?.id).toBe("number");
    expect(typeof fooSymbol?.file).toBe("number");
  });

  it("preserves symbol edge labels and resolves from/to to numeric indices", () => {
    const result = compactGraphWithSymbols(makeFileGraph(), makeSymbolGraph(), false);
    expect(result.symbolEdges).toHaveLength(1);
    const edge = result.symbolEdges[0]!;
    expect(edge.label).toBe("calls");
    expect(typeof edge.from).toBe("number");
    expect(typeof edge.to).toBe("number");
  });

  it("exposes symbolIdIndex to recover original string symbol ids", () => {
    const result = compactGraphWithSymbols(makeFileGraph(), makeSymbolGraph(), false);
    const fooSymbol = result.symbols.find((s) => s.name === "foo")!;
    expect(result.symbolIdIndex[fooSymbol.id]).toBe("/root/a.ts::foo::0");
  });

  it("shares the same files array/order as compactFileGraph", () => {
    const fgraph = makeFileGraph();
    const { files: expectedFiles } = compactFileGraph(fgraph, true);
    const result = compactGraphWithSymbols(fgraph, makeSymbolGraph(), true);
    expect(result.files).toEqual(expectedFiles);
  });
});

describe("compactSymbolsOnly", () => {
  it("returns files/symbols/symbolEdges/symbolIdIndex without fileEdges", () => {
    const files = [...makeFileGraph().nodes];
    const result = compactSymbolsOnly(files, makeSymbolGraph(), false);
    expect(result.files).toEqual(files);
    expect(result.symbols).toHaveLength(2);
    expect(result.symbolEdges).toHaveLength(1);
    expect("fileEdges" in result).toBe(false);
  });
});
