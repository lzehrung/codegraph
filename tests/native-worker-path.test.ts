import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveNativeWorkerPath } from "../src/worker/nativeWorkerPool.js";

describe("native worker path resolution", () => {
  it("does not probe dist workers under the caller cwd", () => {
    const originalCwd = process.cwd();
    const callerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-worker-cwd-"));
    process.chdir(callerRoot);
    const cwdWorkerPath = path.resolve(callerRoot, "dist", "worker", "nativeExtractWorker.js");
    const existingPaths = new Set<string>();
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const filePath = typeof candidate === "string" ? candidate : String(candidate);
      return existingPaths.has(filePath);
    });

    try {
      expect(() => resolveNativeWorkerPath()).toThrowError(/Native worker file not found/);
      expect(existsSync).not.toHaveBeenCalledWith(cwdWorkerPath);
    } finally {
      process.chdir(originalCwd);
      existsSync.mockRestore();
    }
  });
});
