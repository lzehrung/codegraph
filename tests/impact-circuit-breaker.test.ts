import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import { ProjectIndex } from "../src/indexer.js";
import { Readable } from "node:stream";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

describe("Impact Circuit Breaker & Warning Propagation", () => {
  let mockSpawn: Mock;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockSpawn = vi.mocked(cp.spawn);
    vi.clearAllMocks();
  });

  const setupSpawnCall = (output: string, code = 0) => {
    const stdout = Readable.from([output]);
    return {
      stdout,
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(code);
      }),
    };
  };

  const diffContent = (insertions: number, deletions: number) =>
    `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,${deletions} +1,${insertions} @@\n${"-a\n".repeat(
      deletions,
    )}${"+b\n".repeat(insertions)}`;

  const setupDiff = (insertions: number, deletions: number) => {
    mockSpawn.mockReturnValueOnce(setupSpawnCall(diffContent(insertions, deletions)));
  };

  const index: ProjectIndex = {
    files: [],
    byFile: new Map(),
    graph: { nodes: [], edges: [] },
  };

  it("should trigger warning at exactly 50,001 lines", async () => {
    setupDiff(25_001, 25_000);

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("Large diff detected");
    expect(result.warning).toContain("50,001 lines");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("should NOT trigger warning at exactly 50,000 lines", async () => {
    setupDiff(25_000, 25_000);

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toBeUndefined();
  });

  it("should handle diffs with only insertions", async () => {
    setupDiff(60_000, 0);

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("60,000 lines");
  });

  it("should handle diffs with only deletions", async () => {
    setupDiff(0, 60_000);

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("60,000 lines");
  });

  it("should propagate warning to compact report", async () => {
    setupDiff(60_000, 0);

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
      compact: true,
    });

    expect(result).toHaveProperty("files");
    expect(result.warning).toContain("60,000 lines");
  });

  it("recovers after a large diff and clears warning on smaller follow-up diff", async () => {
    setupDiff(60_000, 0);
    const first = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    setupDiff(1, 1);
    const second = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(first.warning).toContain("Large diff detected");
    expect(second.warning).toBeUndefined();
    expect(second.changedFiles).toHaveLength(1);
  });
});
