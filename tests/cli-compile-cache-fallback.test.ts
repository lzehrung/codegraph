import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

const originalEnable = module.enableCompileCache;

describe("enableCliCompileCache failure and fallback paths", () => {
  afterEach(() => {
    module.enableCompileCache = originalEnable;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns null when enableCompileCache is unavailable", async () => {
    // @ts-expect-error deliberate unavailable shape
    module.enableCompileCache = undefined;
    const { enableCliCompileCache } = await import("../src/cli/compileCache.js");
    const result = enableCliCompileCache({ NODE_COMPILE_CACHE: path.join(os.tmpdir(), "cc-missing") });
    expect(result).toBeNull();
  });

  it("falls back to string directory when portable options object throws", async () => {
    const calls: unknown[] = [];
    module.enableCompileCache = ((arg: unknown) => {
      calls.push(arg);
      if (arg && typeof arg === "object") {
        throw new Error("cacheDir should be a string");
      }
      return { status: 0, directory: String(arg) };
    }) as typeof module.enableCompileCache;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cc-fallback-"));
    try {
      const { enableCliCompileCache } = await import("../src/cli/compileCache.js");
      const result = enableCliCompileCache({ NODE_COMPILE_CACHE: dir });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ directory: dir, portable: true });
      expect(calls[1]).toBe(dir);
      expect(result).toMatchObject({ status: 0, directory: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when mkdirSync fails for the default cache directory", async () => {
    const enable = vi.fn(() => ({ status: 0, directory: "unused" }));
    module.enableCompileCache = enable as typeof module.enableCompileCache;
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("mkdir failed");
    });
    const { enableCliCompileCache } = await import("../src/cli/compileCache.js");
    const result = enableCliCompileCache({}, path.join(os.tmpdir(), "cg-cc-home"), "linux");
    expect(result).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });
});
