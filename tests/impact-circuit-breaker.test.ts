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

  const setupMocks = (statOutput: string, diffContent = "") => {
    mockSpawn.mockReturnValueOnce(setupSpawnCall(statOutput)).mockReturnValueOnce(setupSpawnCall(diffContent));
  };

  const index: ProjectIndex = {
    files: [],
    byFile: new Map(),
    graph: { nodes: [], edges: [] },
  };

  it("should trigger warning at exactly 50,001 lines", async () => {
    setupMocks(" 1 file changed, 25001 insertions(+), 25000 deletions(-)");

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("Large diff detected");
    expect(result.warning).toContain("50,001 lines");
  });

  it("should NOT trigger warning at exactly 50,000 lines", async () => {
    setupMocks(" 1 file changed, 25000 insertions(+), 25000 deletions(-)");

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toBeUndefined();
  });

  it("should handle stat output with only insertions", async () => {
    setupMocks(" 1 file changed, 60000 insertions(+)");

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("60,000 lines");
  });

  it("should handle stat output with only deletions", async () => {
    setupMocks(" 1 file changed, 60000 deletions(-)");

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toContain("60,000 lines");
  });

  it("should fallback gracefully if shortstat fails", async () => {
    mockSpawn
      .mockReturnValueOnce(setupSpawnCall("", 1))
      .mockReturnValueOnce(setupSpawnCall("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n"));

    const result = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    expect(result.warning).toBeUndefined();
    expect(result.changedFiles).toHaveLength(1);
  });

  it("should propagate warning to compact report", async () => {
    setupMocks(" 1 file changed, 60000 insertions(+)", "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n");

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
    setupMocks(" 1 file changed, 60000 insertions(+)", "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n");
    const first = await analyzeImpactFromDiff(".", index, {
      provider: "git",
      base: "A",
      head: "B",
    });

    setupMocks(" 1 file changed, 1 insertion(+), 1 deletion(-)", "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n");
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
