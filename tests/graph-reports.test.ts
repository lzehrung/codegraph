import { describe, it, expect } from "vitest";
import { getUnresolvedImports, getHotspots, getApiSurface, SymbolKind } from "../src/index.js";

describe("graph reports", () => {
  const root = "/root";
  const nodes = new Set([`${root}/a.ts`, `${root}/b.ts`]);
  const edges = [
    { from: `${root}/a.ts`, to: { type: "file" as const, path: `${root}/b.ts` }, raw: "./b" },
    { from: `${root}/a.ts`, to: { type: "external" as const, name: "react" }, raw: "react" },
    { from: `${root}/b.ts`, to: { type: "external" as const, name: "react" }, raw: "react" },
  ];
  const graph = { nodes, edges };

  it("should get unresolved imports", () => {
    const unresolved = getUnresolvedImports(graph);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].name).toBe("react");
    expect(unresolved[0].importers.length).toBe(2);
  });

  it("should get hotspots", () => {
    const hotspots = getHotspots(graph);
    expect(hotspots.length).toBe(2);
    expect(hotspots[0].file).toBe(`${root}/b.ts`);
    expect(hotspots[0].fanIn).toBe(1);
  });

  it("should limit and filter hotspots by include roots", () => {
    const scopedGraph = {
      nodes: new Set([`${root}/src/a.ts`, `${root}/src/b.ts`, `${root}/src/c.ts`, `${root}/tests/spec.ts`]),
      edges: [
        {
          from: `${root}/src/a.ts`,
          to: { type: "file" as const, path: `${root}/src/b.ts` },
          raw: "./b",
        },
        {
          from: `${root}/src/c.ts`,
          to: { type: "file" as const, path: `${root}/src/b.ts` },
          raw: "./b",
        },
        {
          from: `${root}/tests/spec.ts`,
          to: { type: "file" as const, path: `${root}/src/a.ts` },
          raw: "../src/a",
        },
      ],
    };

    const hotspots = getHotspots(scopedGraph, {
      includeRoots: [`${root}/src`],
      limit: 2,
    });

    expect(hotspots).toEqual([
      {
        file: `${root}/src/b.ts`,
        fanIn: 2,
        fanOut: 0,
        score: 4,
      },
      {
        file: `${root}/src/a.ts`,
        fanIn: 0,
        fanOut: 1,
        score: 1,
      },
    ]);
  });

  it("should get API surface", () => {
    const mockIndex = {
      byFile: new Map([
        [
          `${root}/a.ts`,
          {
            file: `${root}/a.ts`,
            exports: [
              {
                type: "local" as const,
                exportedAs: "foo",
                target: { localName: "foo", kind: SymbolKind.Function, range: {}, file: `${root}/a.ts` },
              },
            ],
            imports: [],
            locals: [],
          },
        ],
      ]),
    };
    const api = getApiSurface(mockIndex);
    expect(api.length).toBe(1);
    expect(api[0].file).toBe(`${root}/a.ts`);
    expect(api[0].exports[0].exportedAs).toBe("foo");
  });

  it("should handle complex re-export chains in apisurface", () => {
    const mockIndex = {
      byFile: new Map([
        [
          `${root}/lib.ts`,
          {
            file: `${root}/lib.ts`,
            exports: [
              {
                type: "local",
                exportedAs: "base",
                target: { localName: "base", kind: SymbolKind.Variable, file: `${root}/lib.ts`, range: {} },
              },
            ],
            imports: [],
            locals: [],
          },
        ],
        [
          `${root}/barrel.ts`,
          {
            file: `${root}/barrel.ts`,
            exports: [
              { type: "reexport", exportedAs: "aliased", fromModule: `${root}/lib.ts`, sourceSpecifier: "base" },
              { type: "exportStar", fromModule: `${root}/lib.ts` },
            ],
            imports: [],
            locals: [],
          },
        ],
      ]),
    };
    const api = getApiSurface(mockIndex);
    const barrel = api.find((a) => a.file === `${root}/barrel.ts`);
    expect(barrel).toBeDefined();
    expect(barrel!.exports.some((e) => e.exportedAs === "aliased" && e.kind === "reexport")).toBe(true);
    expect(barrel!.exports.some((e) => e.kind === "exportStar")).toBe(true);
  });
});
