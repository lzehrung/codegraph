import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import { buildProjectIndexIncremental } from "../src/indexer/build-index.js";
import type { BuildReport } from "../src/indexer/types.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("config hash cache validation", () => {
  it("rebuilds instead of reusing a manifest when a config probe fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-config-probe-failure-"));
    tempDirs.push(root);
    const gitignorePath = path.join(root, ".gitignore");
    await fs.writeFile(path.join(root, "sample.ts"), "export const answer = 42;\n", "utf8");
    await fs.writeFile(gitignorePath, ".codegraph-cache/\n", "utf8");

    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (path.resolve(String(file)) === path.resolve(gitignorePath)) {
        const error = new Error("synthetic config probe failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return await originalReadFile(file, options as never);
    });
    const report: BuildReport = { timings: {} };
    try {
      await buildProjectIndexIncremental(root, { cache: "disk", native: "off", report });
    } finally {
      readFileSpy.mockRestore();
    }

    expect(report.manifest?.configHashError).toContain("synthetic config probe failure");
    expect(report.manifest?.reused).toBe(false);
    expect(report.manifest?.reason).toBe("configChanged");
  });
});
