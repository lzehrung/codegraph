import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import { ProjectIndex } from "../src/indexer.js";
import { Readable } from "node:stream";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

describe("Impact Circuit Breaker & Warning Propagation", () => {
  let mockExecSync: any;
  let mockSpawn: any;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockExecSync = cp.execSync;
    mockSpawn = cp.spawn;
    vi.clearAllMocks();
  });

  const setupMocks = (statOutput: string, diffContent: string = "") => {
    mockExecSync.mockReturnValue(statOutput);
    
    const mockStdout = Readable.from([diffContent]);
    const mockChild = {
      stdout: mockStdout,
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === "close") cb(0);
      }),
    };
    mockSpawn.mockReturnValue(mockChild);
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
    mockExecSync.mockImplementation(() => { throw new Error("git failed"); });
    
    const mockStdout = Readable.from(["diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n"]);
    const mockChild = {
      stdout: mockStdout,
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === "close") cb(0);
      }),
    };
    mockSpawn.mockReturnValue(mockChild);

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
      compact: true
    });

    expect(result).toHaveProperty("files");
    expect(result.warning).toContain("60,000 lines");
  });
});
