import { describe, expect, it } from "vitest";
import {
  isPathUnderIncludeRoots,
  normalizeIncludeRootsRelative,
  restrictGraphToIncludeRoots,
} from "../src/util/includeRoots.js";
import type { Graph } from "../src/types.js";

describe("includeRoots helpers", () => {
  it("normalizes relative include roots", () => {
    expect(normalizeIncludeRootsRelative("/proj", ["./src/", "lib"])).toEqual(["src", "lib"]);
  });

  it("checks path membership", () => {
    expect(isPathUnderIncludeRoots("src/a.ts", ["src"])).toBe(true);
    expect(isPathUnderIncludeRoots("lib/a.ts", ["src"])).toBe(false);
  });

  it("restricts graphs to include roots", () => {
    const graph: Graph = {
      nodes: new Set(["/proj/src/a.ts", "/proj/lib/b.ts"]),
      edges: [{ from: "/proj/src/a.ts", to: { type: "file", path: "/proj/lib/b.ts" }, raw: "../lib/b" }],
    };
    const scoped = restrictGraphToIncludeRoots(graph, ["src"], (file) => file.replace("/proj/", ""));
    expect([...scoped.nodes]).toEqual(["src/a.ts"]);
    expect(scoped.edges).toHaveLength(0);
  });

  it("normalizes retained edge endpoints with scoped nodes", () => {
    const graph: Graph = {
      nodes: new Set(["/proj/src/a.ts", "/proj/src/b.ts", "/proj/lib/c.ts"]),
      edges: [
        { from: "/proj/src/a.ts", to: { type: "file", path: "/proj/src/b.ts" }, raw: "./b" },
        { from: "/proj/src/b.ts", to: { type: "external", name: "react" }, raw: "react" },
        { from: "/proj/src/a.ts", to: { type: "file", path: "/proj/lib/c.ts" }, raw: "../lib/c" },
      ],
    };

    const scoped = restrictGraphToIncludeRoots(graph, ["src"], (file) => file.replace("/proj/", ""));

    expect([...scoped.nodes]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scoped.edges).toEqual([
      { from: "src/a.ts", to: { type: "file", path: "src/b.ts" }, raw: "./b" },
      { from: "src/b.ts", to: { type: "external", name: "react" }, raw: "react" },
    ]);
  });
});
