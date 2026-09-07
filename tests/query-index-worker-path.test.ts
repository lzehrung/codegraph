import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQueryIndexWorkerPath } from "../src/agent/query-index/worker-pool.js";
import { resolveRawSqlQueryWorkerPath } from "../src/sqlite/raw-query-worker-pool.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRawSqlQueryWorkerPath", () => {
  it("falls back to the bundled worker when the compiled dist worker is missing", () => {
    const bundledSuffix = path.normalize(path.join("dist", "bin", "raw-query-worker.js"));
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const filePath = path.normalize(typeof candidate === "string" ? candidate : String(candidate));
      return filePath.endsWith(bundledSuffix);
    });

    expect(path.normalize(resolveRawSqlQueryWorkerPath())).toContain(bundledSuffix);
  });
});

describe("resolveQueryIndexWorkerPath", () => {
  it("falls back to the bundled worker when the compiled dist worker is missing", () => {
    const bundledSuffix = path.normalize(path.join("dist", "bin", "query-index-worker.js"));
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const filePath = path.normalize(typeof candidate === "string" ? candidate : String(candidate));
      return filePath.endsWith(bundledSuffix);
    });

    expect(path.normalize(resolveQueryIndexWorkerPath())).toContain(bundledSuffix);
  });
});
