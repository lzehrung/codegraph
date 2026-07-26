import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveCliCompileCacheDirectory,
  resolveCodegraphUserCacheRoot,
} from "../src/cli/compileCache.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledCli = path.join(rootDir, "dist", "bin", "cli.js");
const bootstrapSource = path.join(rootDir, "src", "cliBootstrap.ts");

describe("CLI compile cache", () => {
  it("resolves under the per-user codegraph cache, never project .codegraph dirs", () => {
    const win = resolveCodegraphUserCacheRoot(
      { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` },
      String.raw`C:\Users\me`,
      "win32",
    );
    expect(win.replaceAll("\\", "/")).toBe("C:/Users/me/AppData/Local/codegraph");

    const linux = resolveCodegraphUserCacheRoot({ XDG_CACHE_HOME: "/var/cache" }, "/home/me", "linux");
    expect(linux.replaceAll("\\", "/")).toBe("/var/cache/codegraph");

    const linuxDefault = resolveCodegraphUserCacheRoot({}, "/home/me", "linux");
    expect(linuxDefault.replaceAll("\\", "/")).toBe("/home/me/.cache/codegraph");

    const compileDir = resolveCliCompileCacheDirectory(
      { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` },
      String.raw`C:\Users\me`,
      "win32",
    );
    expect(compileDir.replaceAll("\\", "/")).toBe("C:/Users/me/AppData/Local/codegraph/compile-cache");
    expect(compileDir).not.toContain(".codegraph-cache");
    expect(compileDir.includes(`${path.sep}.codegraph${path.sep}`) || compileDir.endsWith(`${path.sep}.codegraph`)).toBe(
      false,
    );
  });

  it("honors NODE_COMPILE_CACHE override", () => {
    expect(
      resolveCliCompileCacheDirectory({ NODE_COMPILE_CACHE: "/tmp/custom-cc" }, "/home/me", "linux"),
    ).toBe("/tmp/custom-cc");
  });

  it("treats NODE_DISABLE_COMPILE_CACHE as a hard opt-out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-compile-cache-disabled-"));
    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probe,
      `import { enableCliCompileCache } from ${JSON.stringify(pathToFileURL(path.join(rootDir, "dist/cli/compileCache.js")).href)};
import module from "node:module";
const result = enableCliCompileCache({ NODE_DISABLE_COMPILE_CACHE: "1", NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE });
if (result !== null) {
  console.error("EXPECTED_NULL", JSON.stringify(result));
  process.exit(2);
}
const dirAfter = typeof module.getCompileCacheDir === "function" ? module.getCompileCacheDir() : undefined;
console.log(JSON.stringify({ result, dirAfter: dirAfter ?? null }));
`,
    );
    try {
      const result = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: { ...process.env, NODE_COMPILE_CACHE: dir, NODE_DISABLE_COMPILE_CACHE: "1" },
      });
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload.result).toBeNull();
      // Best-effort: our helper must not arm a cache. If Node already enabled one
      // earlier in this process tree, getCompileCacheDir may still be set.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables the compile cache into an isolated directory without throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-compile-cache-unit-"));
    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probe,
      `import { enableCliCompileCache } from ${JSON.stringify(pathToFileURL(path.join(rootDir, "dist/cli/compileCache.js")).href)};
const result = enableCliCompileCache({ NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE });
if (!result) {
  console.error("ENABLE_FAILED");
  process.exit(2);
}
console.log(JSON.stringify({ status: result.status, directory: result.directory }));
`,
    );
    try {
      const result = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: { ...process.env, NODE_COMPILE_CACHE: dir, NODE_DISABLE_COMPILE_CACHE: undefined },
      });
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload.directory === dir || String(payload.directory).startsWith(`${dir}${path.sep}`)).toBe(true);
      expect([0, 1, 2, 3]).toContain(payload.status);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ships a bootstrap entry that enables compile cache before importing the CLI", async () => {
    const source = await fs.promises.readFile(bootstrapSource, "utf8");
    expect(source).toMatch(/enableCliCompileCache\s*\(/);
    expect(source).toMatch(/await import\(["']\.\/cli\.js["']\)/);
    expect(source.indexOf("enableCliCompileCache")).toBeLessThan(source.indexOf("await import"));
  });

  it("keeps --version behavior when the compile cache directory is deleted", () => {
    expect(fs.existsSync(bundledCli)).toBe(true);
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-compile-cache-run-"));
    try {
      const withCache = spawnSync(process.execPath, [bundledCli, "--version"], {
        encoding: "utf8",
        env: { ...process.env, NODE_COMPILE_CACHE: cacheDir, NODE_DISABLE_COMPILE_CACHE: undefined },
      });
      expect(withCache.status).toBe(0);
      expect(withCache.stdout.trim().length).toBeGreaterThan(0);

      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });

      const afterDelete = spawnSync(process.execPath, [bundledCli, "--version"], {
        encoding: "utf8",
        env: { ...process.env, NODE_COMPILE_CACHE: cacheDir, NODE_DISABLE_COMPILE_CACHE: undefined },
      });
      expect(afterDelete.status).toBe(0);
      expect(afterDelete.stdout).toBe(withCache.stdout);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
