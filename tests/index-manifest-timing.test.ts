import fsp from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import * as buildCache from "../src/indexer/build-cache.js";
import { buildProjectIndexIncremental } from "../src/indexer/build-index.js";
import type { BuildReport, BuildTimingStep } from "../src/indexer/types.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const temps = createTempRootRegistry();

afterAll(async () => {
  await temps.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
}

async function writeEntry(root: string, content: string): Promise<string> {
  const entry = path.join(root, "entry.ts");
  await fsp.writeFile(entry, content, "utf8");
  return entry;
}

function stepNames(report: BuildReport): string[] {
  return (report.timings?.steps ?? []).map((step) => step.name);
}

function topLevelStepSum(steps: BuildTimingStep[] | undefined): number {
  // Sub-steps sit inside `index-manifest`. `snapshot-write` is recorded after
  // finalize assigns `totalMs`, so neither belongs in this coverage check.
  const excluded = new Set([
    "git-head",
    "config-hash",
    "manifest-transform",
    "manifest-write",
    "cache-prune",
    "snapshot-write",
  ]);
  let sum = 0;
  let countedPreambleConfigHash = false;
  for (const step of steps ?? []) {
    if (step.name === "config-hash") {
      if (countedPreambleConfigHash) continue;
      countedPreambleConfigHash = true;
      sum += step.ms;
      continue;
    }
    if (excluded.has(step.name)) continue;
    sum += step.ms;
  }
  return sum;
}

describe("index manifest config-hash reuse and timing", () => {
  it("computes the config hash exactly once for a cold incremental build with no manifest", async () => {
    const root = await temps.create("cg-config-hash-cold-");
    await writeEntry(root, "export const value = 1;\n");
    const hashSpy = vi.spyOn(buildCache, "computeConfigHash");
    const report: BuildReport = { timings: {} };

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

    expect(hashSpy).toHaveBeenCalledTimes(1);
    expect(report.manifest?.reason).toBe("missing");
  });

  it("computes the config hash exactly once for a warm incremental update that rewrites the manifest", async () => {
    const root = await temps.create("cg-config-hash-warm-");
    const entry = await writeEntry(root, "export const value = 1;\n");
    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
    await fsp.writeFile(entry, "export const value = 2;\n", "utf8");
    const hashSpy = vi.spyOn(buildCache, "computeConfigHash");
    const report: BuildReport = { timings: {} };

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

    expect(hashSpy).toHaveBeenCalledTimes(1);
    expect(report.timings?.writeManifestMs).toEqual(expect.any(Number));
  });

  it("writes the preamble config hash into the manifest", async () => {
    const root = await temps.create("cg-config-hash-written-");
    await writeEntry(root, "export const value = 1;\n");
    const hashSpy = vi.spyOn(buildCache, "computeConfigHash");

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });

    expect(hashSpy).toHaveBeenCalledTimes(1);
    const preamble = await hashSpy.mock.results[0]?.value;
    if (!preamble || typeof preamble.hash !== "string") {
      throw new Error("expected computeConfigHash to return a hash");
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPathFor(root), "utf8")) as { configHash?: string };
    expect(manifest.configHash).toBe(preamble.hash);
  });

  it("records config-hash, manifest-write, and index-manifest steps", async () => {
    const root = await temps.create("cg-config-hash-steps-");
    await writeEntry(root, "export const value = 1;\n");
    const report: BuildReport = { timings: {} };

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

    const names = stepNames(report);
    expect(names).toEqual(expect.arrayContaining(["config-hash", "manifest-write", "index-manifest"]));
  });

  it("reports totalMs covering preamble work for a cold delegated rebuild", async () => {
    const root = await temps.create("cg-config-hash-total-");
    await writeEntry(root, "export const value = 1;\n");
    const report: BuildReport = { timings: {} };

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

    const names = new Set(stepNames(report));
    expect(names.has("file-identity")).toBe(true);
    expect(names.has("load-manifest")).toBe(true);
    expect(names.has("index-manifest")).toBe(true);
    const totalMs = report.timings?.totalMs;
    expect(totalMs).toEqual(expect.any(Number));
    expect(totalMs).toBeGreaterThanOrEqual(topLevelStepSum(report.timings?.steps));
  });

  it("records index-manifest sub-steps when rebuilding over a pre-existing disk cache", async () => {
    const root = await temps.create("cg-config-hash-prune-");
    const fileCount = 120;
    await Promise.all(
      Array.from({ length: fileCount }, async (_, index) => {
        await fsp.writeFile(path.join(root, `f${index}.ts`), `export const v${index} = ${index};\n`, "utf8");
      }),
    );
    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        await fsp.rm(path.join(root, `f${index}.ts`));
      }),
    );
    await fsp.rm(manifestPathFor(root));
    const report: BuildReport = { timings: {} };

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });

    const names = stepNames(report);
    expect(names).toEqual(
      expect.arrayContaining([
        "git-head",
        "config-hash",
        "manifest-transform",
        "manifest-write",
        "cache-prune",
        "index-manifest",
      ]),
    );
  });
});
