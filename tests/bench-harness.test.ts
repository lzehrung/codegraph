import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const rootDir = path.resolve(__dirname, "..");
const benchScript = path.join(rootDir, "scripts", "bench-native.mjs");
const distEntry = path.join(rootDir, "dist", "index.js");
const longBenchTimeoutMs = 70_000;

function runBenchResult(args: string[], timeout = 60_000) {
  return spawnSync(process.execPath, [benchScript, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    timeout,
  });
}

function runBench(args: string[], timeout = 60_000): string {
  const result = runBenchResult(args, timeout);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `Bench script exited with ${result.status}`);
  }
  return result.stdout;
}

describe("bench-native harness", () => {
  beforeAll(() => {
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        "bench-native harness requires dist/index.js; run npm run build before this suite.",
      );
    }
  });

  it("runs a single-fixture smoke benchmark and produces JSON output", () => {
    const output = runBench(
      [
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=graph",
        "--temperatures=cold",
        "--json",
      ],
      60_000,
    );
    const parsed = JSON.parse(output);
    expect(parsed.runs).toBe(1);
    expect(parsed.environment).toBeDefined();
    expect(parsed.environment.node).toMatch(/^v/);
    expect(parsed.results).toHaveLength(1);
    const result = parsed.results[0];
    expect(result.fixture).toBe("typescript");
    expect(result.workloads.graph).toBeDefined();
    expect(result.workloads.graph.cold).toBeDefined();
    expect(result.workloads.graph.cold.native.averageElapsedMs).toBeGreaterThan(0);
    expect(result.workloads.graph.cold.js.averageElapsedMs).toBeGreaterThan(0);
  });

  it("saves and loads baselines", () => {
    const baselinesDir = path.join(rootDir, ".bench-baselines");
    const baselineName = `test-harness-${process.pid}-${randomUUID()}`;
    const baselineFile = path.join(baselinesDir, `${baselineName}.json`);
    try {
      runBench(
        [
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          `--save-baseline=${baselineName}`,
          "--json",
        ],
        60_000,
      );

      expect(fs.existsSync(baselineFile)).toBe(true);
      const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
      expect(baseline._meta.name).toBe(baselineName);
      expect(baseline._meta.date).toMatch(/^\d{4}-/);
      expect(baseline.results).toHaveLength(1);

      // Compare against itself
      const compareOutput = runBench(
        [
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          `--compare-baseline=${baselineName}`,
        ],
        60_000,
      );
      expect(compareOutput).toContain("Comparing against baseline:");
      expect(compareOutput).toContain(baselineName);
    } finally {
      if (fs.existsSync(baselineFile)) {
        fs.rmSync(baselineFile);
      }
      // Clean up baselines dir if empty
      try {
        if (fs.existsSync(baselinesDir) && fs.readdirSync(baselinesDir).length === 0) {
          fs.rmdirSync(baselinesDir);
        }
      } catch {
        // ignore
      }
    }
  });

  it("rejects unknown fixture names", () => {
    const result = runBenchResult(["--fixtures=nonexistent", "--runs=1"], 10_000);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown fixture");
  });

  it("rejects unknown workload names", () => {
    const result = runBenchResult(["--workloads=invalid", "--runs=1"], 10_000);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown workload");
  });

  it("reports vs JS column in table output", () => {
    const output = runBench(
      [
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=graph",
        "--temperatures=cold",
      ],
      60_000,
    );
    expect(output).toContain("vs JS");
    // native row should have a speedup indicator
    expect(output).toMatch(/\d+(?:\.\d+)?x (faster|slower)/);
  }, longBenchTimeoutMs);

  it("reports vs Native column when --workers is used", () => {
    const output = runBench(
      [
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=full",
        "--temperatures=cold",
        "--workers",
      ],
      60_000,
    );
    expect(output).toContain("vs Native");
    // workers row should show comparison against both JS and native
    const lines = output.split("\n");
    const workersLine = lines.find((l) => /\bworkers\b/.test(l));
    expect(workersLine).toBeDefined();
    // workers line should contain at least one speedup/slowdown indicator
    expect(workersLine).toMatch(/\d+(?:\.\d+)?x (faster|slower)/);
  }, longBenchTimeoutMs);

  it("produces JSON output with workers mode included", () => {
    const output = runBench(
      [
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=full",
        "--temperatures=cold",
        "--workers",
        "--json",
      ],
      60_000,
    );
    const parsed = JSON.parse(output);
    expect(parsed.results).toHaveLength(1);
    const result = parsed.results[0];
    expect(result.workloads.full.cold.native.averageElapsedMs).toBeGreaterThan(0);
    expect(result.workloads.full.cold.js.averageElapsedMs).toBeGreaterThan(0);
    expect(result.workloads.full.cold.workers.averageElapsedMs).toBeGreaterThan(0);
  }, longBenchTimeoutMs);

  it("enforces --max-slowdown threshold", () => {
    // max-slowdown of 0.001 should always fail since native can't be 1000x faster
    expect(() =>
      runBench(
        [
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          "--max-slowdown=0.001",
        ],
        60_000,
      ),
    ).toThrow();
  }, longBenchTimeoutMs);
});
