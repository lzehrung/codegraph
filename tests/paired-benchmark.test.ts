import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { comparePairedSamples, summarizeSamples } from "../scripts/benchmarks/paired-statistics.mjs";
import {
  assertSameWorkload,
  createPairedPlan,
  DEFAULT_PAIRED_ROUNDS,
  formatCheckoutProvenance,
  pairedExitCode,
  pairedRunOrder,
  readCheckoutProvenance,
  resolveCorpusPins,
} from "../scripts/benchmarks/paired-benchmark-lib.mjs";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();
afterEach(() => roots.cleanup());

async function createProvenanceFixture(): Promise<string> {
  const root = await roots.create("cg-paired-provenance-");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "dist", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), fs.readFileSync(path.resolve(".gitignore"), "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "dist", "nested", "module.js"), "export const nested = 1;\n");
  runGit(root, ["init"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "benchmark provenance fixture"]);
  const sourceTime = new Date(Date.now() - 60_000);
  const buildTime = new Date(sourceTime.getTime() + 2_000);
  for (const file of ["src/main.ts", "package.json"]) fs.utimesSync(path.join(root, file), sourceTime, sourceTime);
  for (const file of ["dist/index.js", "dist/nested/module.js"])
    fs.utimesSync(path.join(root, file), buildTime, buildTime);
  return root;
}

const constant = (value: number): number[] => Array.from({ length: 5 }, () => value);

describe("paired real-project benchmark statistics", () => {
  it("computes odd and even medians and full-range spread without sorting the input", () => {
    const values = [5, 1, 3];
    expect(summarizeSamples(values)).toEqual({ medianMs: 3, minMs: 1, maxMs: 5, spreadPercent: (4 / 3) * 100 });
    expect(values).toEqual([5, 1, 3]);
    expect(summarizeSamples([4, 1, 2, 3])).toEqual({ medianMs: 2.5, minMs: 1, maxMs: 4, spreadPercent: 120 });
  });

  it("reports a consistent regression beyond observed noise", () => {
    const result = comparePairedSamples([100, 101, 99, 100, 100], [110, 111, 109, 110, 110]);
    expect(result.regression).toBe(true);
    expect(result.roundsHeadSlower).toBe(5);
    expect(result.slowerPercent).toBeCloseTo(10);
    expect(result.noisePercent).toBe(0);
    expect(result.verdict).toBe("regression");
  });

  it("does not call a faster head, ties, or the exact 2 percent floor a regression", () => {
    for (const head of [constant(90), constant(100), constant(102)]) {
      expect(comparePairedSamples(constant(100), head).regression).toBe(false);
    }
    expect(comparePairedSamples(constant(100), constant(102.1)).regression).toBe(true);
  });

  it.each([
    [[100, 100, 100, 100, 1000], constant(150)],
    [constant(100), [150, 150, 150, 150, 1000]],
  ])("does not let one outlier hide a consistent paired regression", (base, head) => {
    const result = comparePairedSamples(base, head);
    expect(result.regression).toBe(true);
    expect(result.slowerPercent).toBeCloseTo(50);
    expect(result.noisePercent).toBe(0);
  });

  it("keeps the paired ratio visible when series medians disagree and the verdict is inconclusive", () => {
    const result = comparePairedSamples([100, 200, 300, 400, 500], [110, 220, 330, 800, 100]);
    expect(result.head.medianMs).toBeLessThan(result.base.medianMs);
    expect(result.pairedMedianRatio).toBeCloseTo(1.1);
    expect(result.slowerPercent).toBeCloseTo(10);
    expect(result.roundsHeadSlower).toBe(4);
    expect(result.verdict).toBe("inconclusive");
  });

  it("reports wide paired noise as inconclusive, not evidence of no regression", () => {
    const result = comparePairedSamples(constant(100), [80, 90, 110, 130, 150]);
    expect(result.slowerPercent).toBeCloseTo(10);
    expect(result.noisePercent).toBeCloseTo(29.652);
    expect(result.verdict).toBe("inconclusive");
    expect(result.regression).toBe(false);
  });

  it("rejects the contaminated cJSON search row despite its tight paired MAD", () => {
    const result = comparePairedSamples([751, 1921, 746, 772, 737, 1406], [746, 1924, 750, 773, 2266, 2970]);
    expect(result.noisePercent).toBeLessThan(1);
    expect(result.outlierRounds).toBe(2);
    expect(result.medianRatioGapPercent).toBeGreaterThan(5);
    expect(result.verdict).toBe("inconclusive");
  });

  it.for([
    [101, 101, 101, 101, 150, 150],
    [100, 100, 100, 100, 200, 200],
  ])("rejects two contaminated rounds even when the paired median is near one (%j)", (head) => {
    const result = comparePairedSamples([100, 100, 100, 100, 100, 100], head);
    expect(result.noisePercent).toBe(0);
    expect(result.outlierRounds).toBe(2);
    expect(result.verdict).toBe("inconclusive");
  });

  it("detects series-median disagreement even with only one outlier round", () => {
    const result = comparePairedSamples([100, 100, 100, 200, 200, 200], [100, 100, 180, 200, 200, 200]);
    expect(result.pairedMedianRatio).toBe(1);
    expect(result.outlierRounds).toBe(1);
    expect(result.medianRatioGapPercent).toBeGreaterThan(5);
    expect(result.verdict).toBe("inconclusive");
  });

  it("distinguishes an improvement from a result wholly inside the noise floor", () => {
    expect(comparePairedSamples(constant(100), constant(90)).verdict).toBe("improvement");
    expect(comparePairedSamples(constant(100), constant(100)).verdict).toBe("within-noise");
    expect(comparePairedSamples(constant(100), constant(102)).verdict).toBe("within-noise");
  });

  it("counts paired slower rounds without counting ties or rearranging pairs", () => {
    const result = comparePairedSamples([100, 100, 100, 100, 100], [101, 99, 100, 102, 100]);
    expect(result.roundsHeadSlower).toBe(2);
    expect(result.rounds).toBe(5);
    expect(result.regression).toBe(false);
  });

  it("rejects insufficient or unmatched pairs", () => {
    expect(() => comparePairedSamples([1, 2, 3, 4], [1, 2, 3, 4])).toThrow("At least five");
    expect(() => comparePairedSamples(constant(1), [1, 2, 3, 4, 5, 6])).toThrow("equally sized");
  });

  it.each([0, -1, Infinity, NaN])("rejects an invalid duration %s", (value) => {
    expect(() => summarizeSamples([value])).toThrow("finite, positive");
    expect(() => comparePairedSamples(constant(1), [1, 1, 1, 1, value])).toThrow("finite, positive");
  });

  it("rejects empty samples", () => {
    expect(() => summarizeSamples([])).toThrow("finite, positive");
  });

  it("alternates every round and balances the default first-side count", () => {
    expect(DEFAULT_PAIRED_ROUNDS).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_PAIRED_ROUNDS % 2).toBe(0);
    const orders = Array.from({ length: DEFAULT_PAIRED_ROUNDS }, (_, round) => pairedRunOrder(round));
    expect(orders.slice(0, 4)).toEqual([
      ["base", "head"],
      ["head", "base"],
      ["base", "head"],
      ["head", "base"],
    ]);
    expect(orders.filter(([first]) => first === "base")).toHaveLength(DEFAULT_PAIRED_ROUNDS / 2);
    expect(orders.filter(([first]) => first === "head")).toHaveLength(DEFAULT_PAIRED_ROUNDS / 2);
  });

  it("wires both thread pins and the resolved source scope into each operation plan", () => {
    const manifest = [
      { id: "sample", family: "ecmascript", accuracyId: "pinned", touchExtension: ".ts", comment: "//" },
    ];
    const accuracy = [
      {
        id: "pinned",
        url: "https://github.com/example/source",
        commit: "a".repeat(40),
        include: ["src/**"],
        exclude: ["**/*.test.ts"],
      },
    ];
    const [corpus] = resolveCorpusPins(manifest, accuracy);
    expect(corpus).toMatchObject({ ...accuracy[0], family: "ecmascript", touchExtension: ".ts", comment: "//" });
    expect(manifest[0].id).toBe("sample");
    for (const version of ["base", "head"]) {
      expect(createPairedPlan(corpus, { threads: 7, nativeThreads: 3 }), version).toEqual({
        buildOptions: {
          threads: 7,
          nativeThreads: 3,
          discovery: { includeGlobs: ["src/**"], ignoreGlobs: ["**/*.test.ts"] },
        },
        touchExtension: ".ts",
        comment: "//",
      });
    }
    expect(() => resolveCorpusPins(manifest, [])).toThrow("Unknown accuracy corpus pinned");
  });

  it.each([
    ["init", { files: 2 }],
    ["cold", { files: 2 }],
    ["nochange", { files: 2 }],
    ["onefile", { files: 2 }],
    ["graph", { nodes: 2, edges: 3 }],
    ["search-index", { files: 3, filesRead: 2 }],
    ["search", { queries: 2, matches: 3 }],
    ["refs", { sites: 2, found: 2, references: 3 }],
    ["goto", { sites: 2, found: 2, references: 0 }],
  ] as const)("compares every %s workload counter, excluding timing and memory", (operation, counters) => {
    expect(() =>
      assertSameWorkload(operation, { ...counters, ms: 10, memory: 100 }, { ...counters, ms: 20, memory: 200 }),
    ).not.toThrow();
    for (const [key, value] of Object.entries(counters)) {
      expect(() => assertSameWorkload(operation, counters, { ...counters, [key]: value + 1 })).toThrow(
        `workload mismatch for ${key}`,
      );
      expect(() => assertSameWorkload(operation, counters, { ...counters, [key]: undefined })).toThrow(
        `missing or invalid workload counter ${key}`,
      );
    }
  });

  it("returns a nonzero exit code only when a saved operation verdict is a regression", () => {
    for (const verdict of ["improvement", "within-noise", "inconclusive"]) {
      expect(pairedExitCode({ sample: { rows: { cold: { verdict } } } })).toBe(0);
    }
    expect(
      pairedExitCode({
        first: { rows: { cold: { verdict: "within-noise" } } },
        second: { rows: { graph: { verdict: "regression" } } },
      }),
    ).toBe(1);
    expect(pairedExitCode({ sample: { rows: {} } })).toBe(0);
  });

  it.each(["clean", "tracked edit", "untracked source", "stale nested module", "deleted source"])(
    "records real checkout and build provenance for a %s fixture",
    async (scenario) => {
      const root = await createProvenanceFixture();
      let dirty = false;
      let stale = false;
      if (scenario === "tracked edit") {
        fs.writeFileSync(path.join(root, "src", "main.ts"), "export const value = 2;\n");
        dirty = true;
        stale = true;
      } else if (scenario === "untracked source") {
        fs.writeFileSync(path.join(root, "src", "new.ts"), "export const added = 1;\n");
        dirty = true;
        stale = true;
      } else if (scenario === "stale nested module") {
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(path.join(root, "dist", "nested", "module.js"), old, old);
        stale = true;
      } else if (scenario === "deleted source") {
        fs.unlinkSync(path.join(root, "src", "main.ts"));
        dirty = true;
        stale = true;
      }
      const provenance = readCheckoutProvenance(root);
      expect(provenance).toMatchObject({ dirty, distOlderThanSources: stale, version: "1.0.0" });
      expect(provenance.revision).toBe(runGit(root, ["rev-parse", "HEAD"]));
      expect(provenance.missingBuildInputs).toBe(scenario === "deleted source" ? 1 : 0);
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("prints dirty=%s and stale=%s provenance explicitly", (dirty, stale) => {
    const line = formatCheckoutProvenance("head", {
      revision: "a".repeat(40),
      dirty,
      distOlderThanSources: stale,
    });
    expect(line).toContain("[provenance] head revision=");
    expect(line).toContain(`dirty=${dirty}`);
    expect(line).toContain(`distOlderThanSources=${stale}`);
  });

  it("keeps the default benchmark output ignored and out of dirty provenance", async () => {
    const root = await createProvenanceFixture();
    fs.writeFileSync(path.join(root, "paired-benchmark.json"), "{}\n");
    expect(runGit(root, ["check-ignore", "paired-benchmark.json"])).toBe("paired-benchmark.json");
    expect(readCheckoutProvenance(root).dirty).toBe(false);
  });

  it("pins exactly one real project per source family, reusing the accuracy pins", () => {
    type Corpus = { id: string; family?: string; accuracyId?: string; url?: string; commit?: string };
    const corpora = JSON.parse(fs.readFileSync(path.resolve("scripts/benchmarks/corpus.json"), "utf8")) as Corpus[];
    const accuracy = JSON.parse(fs.readFileSync(path.resolve("scripts/accuracy/corpus.json"), "utf8")) as Corpus[];
    expect(corpora.map((entry) => entry.family).sort()).toEqual(
      ["ecmascript", "dotnet", "jvm", "c-cpp", "python", "ruby", "php", "go", "rust", "swift", "zig"].sort(),
    );
    expect(new Set(corpora.map((entry) => entry.id)).size).toBe(corpora.length);
    const resolved = resolveCorpusPins(corpora, accuracy);
    for (const entry of resolved) {
      expect(entry.url).toMatch(/^https:\/\/github\.com\/.+/);
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      const original = corpora.find((candidate) => candidate.family === entry.family);
      if (!original?.accuracyId) continue;
      const pin = accuracy.find((candidate) => candidate.id === original.accuracyId);
      if (!pin) throw new Error(`Missing accuracy pin ${original.accuracyId}.`);
      expect(entry).toMatchObject(pin);
    }
  });
});
