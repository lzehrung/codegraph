import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerThreadCount } from "../src/util/workerThreads.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkerThreadCount", () => {
  it("clamps an explicit request above the maximum", () => {
    expect(resolveWorkerThreadCount({ requested: 10, max: 4 })).toBe(4);
  });

  it("falls back to the fixed default for non-positive requests", () => {
    expect(resolveWorkerThreadCount({ requested: 0, defaultCount: 6, max: 64 })).toBe(6);
    expect(resolveWorkerThreadCount({ requested: -2, defaultCount: 6, max: 64 })).toBe(6);
  });

  it("sizes from available parallelism when no request or default is given", () => {
    vi.spyOn(os, "availableParallelism").mockReturnValue(6);
    const max = 64;

    expect(resolveWorkerThreadCount({ max })).toBe(Math.min(Math.max(6 - 1, 1), max));
  });

  it("clamps a fixed default above the maximum", () => {
    expect(resolveWorkerThreadCount({ defaultCount: 12, max: 4 })).toBe(4);
  });
});
