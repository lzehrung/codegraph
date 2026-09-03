import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

function stepNames(report: BuildReport): string[] {
  return (report.timings?.steps ?? []).map((step) => step.name);
}

describe("incremental snapshot-write report", () => {
  it("records snapshot-write when an incremental update rewrites the project snapshot", async () => {
    const root = await roots.create("cg-incr-snapshot-write-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "beta.ts"), "export const beta = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 2;\n", "utf8");

    const report: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report });

    expect(stepNames(report).includes("snapshot-write")).toBe(true);
    const snapshotWrite = report.timings?.steps?.find((step) => step.name === "snapshot-write");
    expect(snapshotWrite?.ms).toEqual(expect.any(Number));
  });

  it("skips snapshot-write when the unchanged snapshot is reused", async () => {
    const root = await roots.create("cg-incr-snapshot-reuse-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const report: BuildReport = { timings: {} };
    await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report });

    expect(stepNames(report).includes("snapshot-write")).toBe(false);
  });
});
