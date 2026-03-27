import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const rootDir = path.resolve(__dirname, "..");
const benchScript = path.join(rootDir, "scripts", "bench-native.mjs");
const distEntry = path.join(rootDir, "dist", "index.js");

const hasDist = fs.existsSync(distEntry);
const benchDescribe = hasDist ? describe : describe.skip;

benchDescribe("bench-native harness", () => {
  it("runs a single-fixture smoke benchmark and produces JSON output", () => {
    const output = execFileSync(
      process.execPath,
      [
        benchScript,
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=graph",
        "--temperatures=cold",
        "--json",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 60_000,
      },
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
    const baselineName = `test-harness-${process.pid}`;
    const baselineFile = path.join(baselinesDir, `${baselineName}.json`);
    try {
      execFileSync(
        process.execPath,
        [
          benchScript,
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          `--save-baseline=${baselineName}`,
          "--json",
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 60_000,
        },
      );

      expect(fs.existsSync(baselineFile)).toBe(true);
      const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
      expect(baseline._meta.name).toBe(baselineName);
      expect(baseline._meta.date).toMatch(/^\d{4}-/);
      expect(baseline.results).toHaveLength(1);

      // Compare against itself
      const compareOutput = execFileSync(
        process.execPath,
        [
          benchScript,
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          `--compare-baseline=${baselineName}`,
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 60_000,
        },
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
    expect(() =>
      execFileSync(
        process.execPath,
        [benchScript, "--fixtures=nonexistent", "--runs=1"],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 10_000,
        },
      ),
    ).toThrow();
  });

  it("rejects unknown workload names", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [benchScript, "--workloads=invalid", "--runs=1"],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 10_000,
        },
      ),
    ).toThrow();
  });

  it("reports vs JS column in table output", () => {
    const output = execFileSync(
      process.execPath,
      [
        benchScript,
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=graph",
        "--temperatures=cold",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(output).toContain("vs JS");
    // native row should have a speedup indicator
    expect(output).toMatch(/\d+(?:\.\d+)?x (faster|slower)/);
  });

  it("reports vs Native column when --workers is used", () => {
    const output = execFileSync(
      process.execPath,
      [
        benchScript,
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=full",
        "--temperatures=cold",
        "--workers",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(output).toContain("vs Native");
    // workers row should show comparison against both JS and native
    const lines = output.split("\n");
    const workersLine = lines.find((l) => /\bworkers\b/.test(l));
    expect(workersLine).toBeDefined();
    // workers line should contain at least one speedup/slowdown indicator
    expect(workersLine).toMatch(/\dx (faster|slower)/);
  });

  it("produces JSON output with workers mode included", () => {
    const output = execFileSync(
      process.execPath,
      [
        benchScript,
        "--runs=1",
        "--fixtures=typescript",
        "--workloads=full",
        "--temperatures=cold",
        "--workers",
        "--json",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const parsed = JSON.parse(output);
    expect(parsed.results).toHaveLength(1);
    const result = parsed.results[0];
    expect(result.workloads.full.cold.native.averageElapsedMs).toBeGreaterThan(0);
    expect(result.workloads.full.cold.js.averageElapsedMs).toBeGreaterThan(0);
    expect(result.workloads.full.cold.workers.averageElapsedMs).toBeGreaterThan(0);
  });

  it("enforces --max-slowdown threshold", () => {
    // max-slowdown of 0.001 should always fail since native can't be 1000x faster
    expect(() =>
      execFileSync(
        process.execPath,
        [
          benchScript,
          "--runs=1",
          "--fixtures=typescript",
          "--workloads=graph",
          "--temperatures=cold",
          "--max-slowdown=0.001",
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 60_000,
        },
      ),
    ).toThrow();
  });
});
