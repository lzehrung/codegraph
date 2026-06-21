import { describe, expect, it } from "vitest";
import type { Edge } from "../src/types.js";
import { analyzeTransitiveImpact } from "../src/impact/transitive.js";
import type { ImpactItem } from "../src/impact/types.js";

function buildReverseDeps(edges: Edge[]): Map<string, Edge[]> {
  const reverseDeps = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (edge.to.type !== "file") continue;
    const bucket = reverseDeps.get(edge.to.path) ?? [];
    bucket.push(edge);
    reverseDeps.set(edge.to.path, bucket);
  }
  return reverseDeps;
}

function runDiamondAnalysis(edgeOrder: Edge[]): Map<string, ImpactItem> {
  const root = "/proj/root.ts";
  const mid = "/proj/mid.ts";
  const leaf = "/proj/leaf.ts";
  const edges: Edge[] = [{ from: mid, to: { type: "file", path: root }, raw: "./root" }, ...edgeOrder];
  const reverseDeps = buildReverseDeps(edges);
  const impacted = new Map<string, ImpactItem>([
    [
      root,
      {
        file: root,
        symbols: [],
        reasons: ["directRef"],
        severity: 0.9,
        depth: 0,
        confidence: 0.9,
      },
    ],
  ]);

  analyzeTransitiveImpact(impacted, 5, {}, () => false, reverseDeps);
  return impacted;
}

describe("analyzeTransitiveImpact order independence", () => {
  it("prefers the shortest path when a direct and longer route both reach the same file", () => {
    const root = "/proj/root.ts";
    const mid = "/proj/mid.ts";
    const leaf = "/proj/leaf.ts";
    const direct = { from: leaf, to: { type: "file", path: root }, raw: "./root" } as const;
    const viaMid = { from: leaf, to: { type: "file", path: mid }, raw: "./mid" } as const;

    const directFirst = runDiamondAnalysis([direct, viaMid]);
    const viaMidFirst = runDiamondAnalysis([viaMid, direct]);

    expect(directFirst.get(leaf)?.depth).toBe(1);
    expect(viaMidFirst.get(leaf)?.depth).toBe(1);
    expect(directFirst.get(leaf)?.severity).toBe(viaMidFirst.get(leaf)?.severity);
  });

  it("keeps the stronger path when a deeper value edge beats a shallow type-only edge", () => {
    const root = "/proj/root.ts";
    const mid = "/proj/mid.ts";
    const leaf = "/proj/leaf.ts";
    const edges: Edge[] = [
      { from: leaf, to: { type: "file", path: root }, raw: "./root", typeOnly: true },
      { from: mid, to: { type: "file", path: root }, raw: "./root" },
      { from: leaf, to: { type: "file", path: mid }, raw: "./mid" },
    ];
    const impacted = new Map<string, ImpactItem>([
      [
        root,
        {
          file: root,
          symbols: [],
          reasons: ["directRef"],
          severity: 0.9,
          depth: 0,
          confidence: 0.9,
        },
      ],
    ]);

    analyzeTransitiveImpact(impacted, 5, {}, () => false, buildReverseDeps(edges));

    expect(impacted.get(leaf)?.depth).toBe(1);
    expect(impacted.get(leaf)?.severity).toBeGreaterThan(0.14);
  });

  it("does not mutate shared reasons arrays across updates", () => {
    const root = "/proj/root.ts";
    const child = "/proj/child.ts";
    const edges: Edge[] = [{ from: child, to: { type: "file", path: root }, raw: "./root" }];
    const reverseDeps = buildReverseDeps(edges);
    const sharedReasons = ["transitive"] as ImpactItem["reasons"];
    const impacted = new Map<string, ImpactItem>([
      [
        root,
        {
          file: root,
          symbols: [],
          reasons: ["directRef"],
          severity: 0.9,
          depth: 0,
          confidence: 0.9,
        },
      ],
      [
        child,
        {
          file: child,
          symbols: [],
          reasons: sharedReasons,
          severity: 0.2,
          depth: 2,
          confidence: 0.2,
        },
      ],
    ]);

    analyzeTransitiveImpact(impacted, 5, {}, () => false, reverseDeps);

    sharedReasons.push("exportChain");
    expect(impacted.get(child)?.reasons).not.toContain("exportChain");
    expect(impacted.get(child)?.depth).toBe(1);
  });
});
