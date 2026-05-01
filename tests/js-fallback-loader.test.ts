import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.doUnmock("node:module");
  vi.resetModules();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-js-fallback-"));
  tempDirs.push(dir);
  return dir;
}

async function importJsFallbackWithAttemptRecorder(attempts: string[]) {
  vi.doMock("node:module", async () => {
    const actual = await vi.importActual<typeof import("node:module")>("node:module");
    return {
      ...actual,
      createRequire: () => {
        return (specifier: string) => {
          attempts.push(specifier);
          throw new Error(`Cannot find module '${specifier}'`);
        };
      },
    };
  });
  return import("../src/jsFallback.js");
}

describe("js fallback loader", () => {
  it("does not probe fallback packages under the caller cwd", async () => {
    const callerRoot = await makeTempDir();
    const fakeFallbackRoot = path.join(callerRoot, "packages", "codegraph-js-fallback");
    await fs.mkdir(fakeFallbackRoot, { recursive: true });
    await fs.writeFile(path.join(fakeFallbackRoot, "js-fallback.cjs"), "module.exports = {};\n");
    process.chdir(callerRoot);

    const attempts: string[] = [];
    const jsFallback = await importJsFallbackWithAttemptRecorder(attempts);

    expect(jsFallback.isJsFallbackAvailable()).toBe(false);
    expect(attempts).toContain("@lzehrung/codegraph-js-fallback");
    expect(attempts.some((specifier) => specifier.includes(callerRoot))).toBe(false);
  });
});
