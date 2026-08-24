import { describe, expect, it } from "vitest";
import type { Edge, FileId } from "../src/types.js";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { calculateSeverity, calculateTransitiveSeverity, normalizeSeverityWeights } from "../src/impact/severity.js";
import { buildCallerRangeIndex, findCallerSymbolId } from "../src/impact/callCompatibility.js";
import { analyzeTransitiveImpact } from "../src/impact/transitive.js";
import type { ChangedSymbol, ImpactItem } from "../src/impact/types.js";
import type { Reference } from "../src/indexer/types.js";
import { SymbolKind, buildProjectIndexFromFiles } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const file = (name: string): FileId => path.resolve("/tmp", name).replace(/\\/g, "/");

function transitiveItem(filePath: FileId, typeOnly: boolean): ImpactItem {
  return {
    file: filePath,
    symbols: [],
    reasons: ["directRef"],
    severity: 0.8,
    depth: 0,
    explain: { reason: "directRef", typeOnly },
    confidence: 1,
    typeOnly,
  };
}

describe("PR4 impact audit regressions", () => {
  it("applies custom weights to direct and transitive severity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-impact-weights-"));
    try {
      const source = path.join(root, "source.ts");
      const consumer = path.join(root, "consumer.ts");
      await writeFile(source, "export function run() { return 1; }\n", "utf8");
      await writeFile(consumer, 'import { run } from "./source.js";\nrun();\n', "utf8");
      const index = await buildProjectIndexFromFiles(root, [source, consumer], { cache: "off" });
      const definition = index.byFile.get(fileIdentityKey(source))?.locals.find((entry) => entry.localName === "run");
      expect(definition).toBeDefined();
      const changed: ChangedSymbol = {
        id: `${source}::run::1::1`,
        file: source,
        name: "run",
        kind: SymbolKind.Function,
        exported: true,
        range: definition!.range,
      };
      const reference: Reference = { file: consumer, range: definition!.range };
      const defaultDirect = calculateSeverity(changed, reference, ["directRef"], 0, index);
      const customDirect = calculateSeverity(changed, reference, ["directRef"], 0, index, undefined, { directRef: 10 });
      expect(customDirect.severity).toBeGreaterThan(defaultDirect.severity);

      const edge: Edge = { from: consumer, to: { type: "file", path: source }, raw: source };
      expect(calculateTransitiveSeverity(edge, 1, { transitive: 10 })).toBeGreaterThan(
        calculateTransitiveSeverity(edge, 1),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the same severity options object once", () => {
    const weights = { directRef: 2 };
    expect(normalizeSeverityWeights(weights)).toBe(normalizeSeverityWeights(weights));
  });

  it.each([null, 0, "invalid"])("rejects non-object severity weights at runtime: %s", (value) => {
    expect(() => Reflect.apply(normalizeSeverityWeights, undefined, [value])).toThrow(
      new RangeError("Invalid severity weights: expected an object"),
    );
  });

  it("keeps runtime evidence dominant over a type-only edge", () => {
    const seed = file("seed.ts");
    const consumer = file("consumer.ts");
    const impacted = new Map<FileId, ImpactItem>([
      [seed, transitiveItem(seed, false)],
      [consumer, transitiveItem(consumer, false)],
    ]);
    const edge: Edge = { from: consumer, to: { type: "file", path: seed }, raw: seed, typeOnly: true };
    const reverseDeps = new Map([[fileIdentityKey(seed), [edge]]]);
    analyzeTransitiveImpact(impacted, 1, {}, () => false, reverseDeps);
    expect(impacted.get(consumer)?.typeOnly).toBe(false);
  });

  it("labels ordinary two-hop imports as transitive, not exportChain", () => {
    const seed = file("seed.ts");
    const middle = file("middle.ts");
    const leaf = file("leaf.ts");
    const impacted = new Map<FileId, ImpactItem>([[seed, transitiveItem(seed, false)]]);
    const first: Edge = { from: middle, to: { type: "file", path: seed }, raw: seed };
    const second: Edge = { from: leaf, to: { type: "file", path: middle }, raw: middle };
    const reverseDeps = new Map([
      [fileIdentityKey(seed), [first]],
      [fileIdentityKey(middle), [second]],
    ]);
    analyzeTransitiveImpact(impacted, 3, {}, () => false, reverseDeps);
    expect(impacted.get(leaf)?.reasons).toEqual(["transitive"]);
    expect(impacted.get(leaf)?.explain?.reason).toBe("transitive");
  });

  it("reports detailed graph edge truncation metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-impact-graph-cap-"));
    try {
      const files = [path.join(root, "file.ts")];
      await writeFile(
        files[0]!,
        "export function leaf() { return 1; }\n" +
          "export function a() { return leaf(); }\n" +
          "export function b() { return a(); }\n" +
          "export function c() { return b(); }\n",
        "utf8",
      );
      const index = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index, { maxEdges: 1 });
      expect(graph.truncated).toBe(true);
      expect(graph.limits).toEqual({ edges: 1 });
      expect(graph.omittedCounts?.edges).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P11 preserves caller attribution selected by the legacy range rule", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-impact-caller-range-"));
    try {
      const source = path.join(root, "callers.ts");
      await writeFile(source, "export function outer() { function inner() { return 1; } return inner(); }\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [source], { cache: "off" });
      const locals = index.byFile.get(fileIdentityKey(source))?.locals ?? [];
      const inner = locals.find((local) => local.localName === "inner");
      expect(inner).toBeDefined();
      const expected = `${inner!.file}::${inner!.localName}::${inner!.range.start.index}`;
      const caller = findCallerSymbolId(buildCallerRangeIndex(index), {
        file: source,
        range: inner!.range,
      });

      expect(caller).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
