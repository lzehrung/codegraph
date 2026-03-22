import { describe, it, expect } from "vitest";
import {
  shortLabel,
  normalizeToKey,
  edgeKey,
  buildGraph,
  FILE_NODE_COLOR,
  EXTERNAL_NODE_COLOR,
  SYMBOL_NODE_COLOR,
} from "../../docs/graph-visualization/graph-builder.js";
import compactPayload from "./fixtures/compact-payload.json";
import legacyPayload from "./fixtures/legacy-payload.json";

describe("shortLabel", () => {
  it("extracts basename from forward-slash path", () => {
    expect(shortLabel("src/utils/helper.ts")).toBe("helper.ts");
  });

  it("extracts basename from backslash path", () => {
    expect(shortLabel("src\\utils\\helper.ts")).toBe("helper.ts");
  });

  it("strips ext: prefix", () => {
    expect(shortLabel("ext:lodash")).toBe("lodash");
  });

  it("truncates names longer than 28 characters", () => {
    const long = "a".repeat(40);
    const result = shortLabel(long);
    expect(result.length).toBe(28);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("returns short names unchanged", () => {
    expect(shortLabel("index.ts")).toBe("index.ts");
  });

  it("returns empty string for non-string input", () => {
    expect(shortLabel(undefined as unknown as string)).toBe("");
    expect(shortLabel(null as unknown as string)).toBe("");
    expect(shortLabel(42 as unknown as string)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(shortLabel("")).toBe("");
  });
});

describe("normalizeToKey", () => {
  it("wraps a plain string as file type", () => {
    expect(normalizeToKey("src/a.ts")).toEqual({ key: "src/a.ts", type: "file" });
  });

  it("extracts path from file-type object", () => {
    expect(normalizeToKey({ type: "file", path: "src/a.ts" })).toEqual({
      key: "src/a.ts",
      type: "file",
    });
  });

  it("prefixes external-type with ext:", () => {
    expect(normalizeToKey({ type: "external", name: "lodash" })).toEqual({
      key: "ext:lodash",
      type: "external",
    });
  });

  it("returns null for null/undefined", () => {
    expect(normalizeToKey(null)).toBe(null);
    expect(normalizeToKey(undefined)).toBe(null);
  });

  it("returns null for unrecognised object", () => {
    expect(normalizeToKey({ type: "unknown" })).toBe(null);
    expect(normalizeToKey({ foo: "bar" })).toBe(null);
  });
});

describe("edgeKey", () => {
  it("produces a directed key", () => {
    expect(edgeKey("a", "b")).toBe("a->b");
  });
});

describe("buildGraph -- compact format", () => {
  it("creates file nodes keyed as f:N", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasNode("f:0")).toBe(true);
    expect(graph.hasNode("f:4")).toBe(true);
    expect(graph.getNodeAttribute("f:0", "kind")).toBe("file");
  });

  it("creates file-to-file edges", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasEdge("f:0->f:1")).toBe(true);
    expect(graph.hasEdge("f:0->f:2")).toBe(true);
    expect(graph.hasEdge("f:3->f:1")).toBe(true);
  });

  it("excludes external nodes when showExternal is false", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasNode("ext:react")).toBe(false);
  });

  it("includes external nodes when showExternal is true", () => {
    const graph = buildGraph(compactPayload, { showExternal: true, includeSymbols: false });
    expect(graph.hasNode("ext:react")).toBe(true);
    expect(graph.getNodeAttribute("ext:react", "color")).toBe(EXTERNAL_NODE_COLOR);
  });

  it("excludes symbol nodes when includeSymbols is false", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasNode("s:0")).toBe(false);
  });

  it("includes symbol nodes when includeSymbols is true", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: true });
    expect(graph.hasNode("s:0")).toBe(true);
    expect(graph.getNodeAttribute("s:0", "color")).toBe(SYMBOL_NODE_COLOR);
    expect(graph.getNodeAttribute("s:0", "kind")).toBe("symbol");
  });

  it("creates contains edges from file to symbol", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: true });
    expect(graph.hasEdge("f:0->s:0")).toBe(true);
    expect(graph.hasEdge("f:0->s:1")).toBe(true);
  });

  it("creates symbol-to-symbol edges", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: true });
    expect(graph.hasEdge("s:0->s:2")).toBe(true);
    expect(graph.hasEdge("s:0->s:4")).toBe(true);
  });

  it("does not create duplicate edges", () => {
    const payload = {
      files: ["a.ts", "b.ts"],
      fileEdges: [
        { from: 0, to: { type: "file", path: 1 }, raw: "./b" },
        { from: 0, to: { type: "file", path: 1 }, raw: "./b" },
      ],
      symbols: [],
      symbolEdges: [],
    };
    const graph = buildGraph(payload, { showExternal: false, includeSymbols: false });
    expect(graph.size).toBe(1);
  });

  it("adjusts node sizes based on degree", () => {
    const graph = buildGraph(compactPayload, { showExternal: false, includeSymbols: false });
    const size0 = graph.getNodeAttribute("f:0", "size");
    // f:0 has degree > 0 (multiple edges) so size should be >= base
    expect(size0).toBeGreaterThanOrEqual(3);
  });
});

describe("buildGraph -- legacy format", () => {
  it("creates nodes from string array", () => {
    const graph = buildGraph(legacyPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasNode("src/a.ts")).toBe(true);
    expect(graph.hasNode("src/b.ts")).toBe(true);
    expect(graph.hasNode("src/c.ts")).toBe(true);
  });

  it("creates edges from edge array", () => {
    const graph = buildGraph(legacyPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasDirectedEdge("src/a.ts", "src/b.ts")).toBe(true);
    expect(graph.hasDirectedEdge("src/b.ts", "src/c.ts")).toBe(true);
  });

  it("includes external nodes when showExternal is true", () => {
    const graph = buildGraph(legacyPayload, { showExternal: true, includeSymbols: false });
    expect(graph.hasNode("ext:lodash")).toBe(true);
  });

  it("excludes external nodes when showExternal is false", () => {
    const graph = buildGraph(legacyPayload, { showExternal: false, includeSymbols: false });
    expect(graph.hasNode("ext:lodash")).toBe(false);
  });
});

describe("buildGraph -- edge cases", () => {
  it("throws on unsupported payload", () => {
    expect(() => buildGraph({}, { showExternal: false, includeSymbols: false })).toThrow(
      "Unsupported graph payload",
    );
  });

  it("handles empty compact payload", () => {
    const graph = buildGraph(
      { files: [], fileEdges: [], symbols: [], symbolEdges: [] },
      { showExternal: false, includeSymbols: false },
    );
    expect(graph.order).toBe(0);
    expect(graph.size).toBe(0);
  });

  it("skips edges with missing source nodes", () => {
    const payload = {
      files: ["a.ts"],
      fileEdges: [{ from: 99, to: { type: "file", path: 0 }, raw: "?" }],
      symbols: [],
      symbolEdges: [],
    };
    const graph = buildGraph(payload, { showExternal: false, includeSymbols: false });
    expect(graph.size).toBe(0);
  });

  it("skips edges with missing target nodes", () => {
    const payload = {
      files: ["a.ts"],
      fileEdges: [{ from: 0, to: { type: "file", path: 99 }, raw: "?" }],
      symbols: [],
      symbolEdges: [],
    };
    const graph = buildGraph(payload, { showExternal: false, includeSymbols: false });
    expect(graph.size).toBe(0);
  });

  it("skips malformed edges gracefully", () => {
    const payload = {
      files: ["a.ts"],
      fileEdges: [null, undefined, { from: "bad" }, { from: 0, to: null }],
      symbols: [],
      symbolEdges: [],
    };
    const graph = buildGraph(payload, { showExternal: false, includeSymbols: false });
    expect(graph.order).toBe(1);
    expect(graph.size).toBe(0);
  });

  it("skips malformed symbol edges", () => {
    const payload = {
      files: ["a.ts"],
      fileEdges: [],
      symbols: [{ id: 0, file: 0, name: "foo", kind: "function" }],
      symbolEdges: [null, { from: "bad" }, { from: 0, to: 99 }],
    };
    const graph = buildGraph(payload, { showExternal: false, includeSymbols: true });
    // s:0 should exist (from symbol), but edge s:0->s:99 should be skipped
    expect(graph.hasNode("s:0")).toBe(true);
    expect(graph.size).toBe(1); // only the "contains" edge f:0->s:0
  });
});
