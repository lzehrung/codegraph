import { execFile as execFileCallback } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  currentNativeTargetSuffix,
  findLocalNativeBinary,
  loadNativeBinding,
  nativeTargetSuffixFor,
} from "../src/native/bindingLoader.js";
import { hashFileStreaming, prepareNativeRuntimeCache } from "../src/native/runtimeCache.js";

const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-loader-"));
  tempDirs.push(dir);
  return dir;
}

async function makeInstalledNativeFixture(
  version = "1.8.72",
  bytes = "native-binary",
  target = "win32-x64-msvc",
): Promise<{
  packageRoot: string;
  binaryPath: string;
  cacheRoot: string;
  resolveFn: (specifier: string) => string;
}> {
  const root = await makeTempDir();
  const packageRoot = path.join(root, "installed");
  const platformPackageName = `@lzehrung/codegraph-native-${target}`;
  const platformRoot = path.join(packageRoot, "node_modules", "@lzehrung", `codegraph-native-${target}`);
  const binaryPath = path.join(platformRoot, `index.${target}.node`);
  const umbrellaEntry = path.join(packageRoot, "node_modules", "@lzehrung", "codegraph-native", "index.js");
  const cacheRoot = path.join(root, "cache", "v1");
  await fs.mkdir(platformRoot, { recursive: true });
  await fs.mkdir(path.dirname(umbrellaEntry), { recursive: true });
  await fs.writeFile(binaryPath, bytes);
  await fs.writeFile(path.join(platformRoot, "package.json"), JSON.stringify({ name: platformPackageName, version }));
  await fs.writeFile(umbrellaEntry, "module.exports = {};\n");
  return {
    packageRoot,
    binaryPath,
    cacheRoot,
    resolveFn: (specifier: string) => {
      if (specifier === platformPackageName) return binaryPath;
      if (specifier === "@lzehrung/codegraph-native") return umbrellaEntry;
      throw new Error(`unexpected package resolution: ${specifier}`);
    },
  };
}

describe("native binding loader", () => {
  it("finds the current-platform local native binary inside the workspace package", async () => {
    const dir = await makeTempDir();
    const suffix = currentNativeTargetSuffix();
    expect(suffix).toBeTruthy();
    await fs.writeFile(path.join(dir, `index.${suffix}.node`), "");

    expect(findLocalNativeBinary(dir)?.replace(/\\/g, "/")).toMatch(new RegExp(`index\\.${suffix}\\.node$`));
  });

  it("ignores stale local native binaries for other platforms", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "index.win32-x64-msvc.node"), "");

    if (process.platform === "win32" && process.arch === "x64") {
      expect(findLocalNativeBinary(dir)).not.toBeNull();
      return;
    }

    expect(findLocalNativeBinary(dir)).toBeNull();
  });

  it("returns null when the local native package cannot be read or has no binary", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "index.js"), "export {};\n");

    expect(findLocalNativeBinary(path.join(dir, "missing"))).toBeNull();
    expect(findLocalNativeBinary(dir)).toBeNull();
  });

  it("prefers a local workspace binary over the package entrypoint", async () => {
    const dir = await makeTempDir();
    const suffix = currentNativeTargetSuffix();
    expect(suffix).toBeTruthy();
    const binary = path.join(dir, `index.${suffix}.node`);
    await fs.writeFile(binary, "");
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn,
    });

    expect(loaded.binding).toEqual({ specifier: binary });
    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledWith(binary);
  });

  it("reports a build:native hint when a workspace package resolves locally without a binary", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "index.js"), "export {};\n");

    const loaded = loadNativeBinding({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn: vi.fn(),
      resolveFn: () => path.join(dir, "index.js"),
    });

    expect(loaded.binding).toBeNull();
    expect(String(loaded.error)).toContain("npm run build:native");
  });

  it("preserves the local binary load error when the workspace package resolves locally", async () => {
    const dir = await makeTempDir();
    const suffix = currentNativeTargetSuffix();
    expect(suffix).toBeTruthy();
    const binary = path.join(dir, `index.${suffix}.node`);
    const localError = new Error("binary ABI mismatch");
    await fs.writeFile(binary, "");

    const loaded = loadNativeBinding({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn: () => {
        throw localError;
      },
      resolveFn: () => path.join(dir, "index.js"),
    });

    expect(loaded.binding).toBeNull();
    expect(loaded.error).toBe(localError);
  });

  it("falls back to package loading when resolve is missing or fails", async () => {
    const dir = await makeTempDir();
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const withoutResolve = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn,
    });
    const withFailingResolve = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn,
      resolveFn: () => {
        throw new Error("resolve failed");
      },
    });

    expect(withoutResolve.binding).toEqual({ specifier: "@lzehrung/codegraph-native" });
    expect(withFailingResolve.binding).toEqual({ specifier: "@lzehrung/codegraph-native" });
    expect(requireFn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the installed package when no local workspace binary exists", async () => {
    const dir = await makeTempDir();
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn,
      resolveFn: () => path.join("C:/external", "node_modules", "@lzehrung", "codegraph-native", "index.js"),
    });

    expect(loaded.binding).toEqual({
      specifier: "@lzehrung/codegraph-native",
    });
    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledWith("@lzehrung/codegraph-native");
  });

  it("returns the package load error when installed package loading fails", async () => {
    const dir = await makeTempDir();
    const packageError = new Error("package missing");

    const loaded = loadNativeBinding({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot: dir,
      requireFn: () => {
        throw packageError;
      },
      resolveFn: () => path.join("C:/external", "node_modules", "@lzehrung", "codegraph-native", "index.js"),
    });

    expect(loaded.binding).toBeNull();
    expect(loaded.error).toBe(packageError);
  });

  it("derives both supported Windows platform package suffixes", () => {
    expect(nativeTargetSuffixFor("win32", "x64")).toBe("win32-x64-msvc");
    expect(nativeTargetSuffixFor("win32", "arm64")).toBe("win32-arm64-msvc");
  });

  it("loads an installed Windows native addon from a verified cache path", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32",
      arch: "x64",
      cacheRoot: fixture.cacheRoot,
    });

    expect(loaded.binding).not.toBeNull();
    expect(loaded.origin?.mode).toBe("cache");
    expect(loaded.origin?.sourcePath).toBe(fixture.binaryPath.replace(/\\/g, "/"));
    expect(loaded.origin?.loadedPath).toContain("/cache/v1/");
    expect(loaded.origin?.loadedPath).not.toContain("/installed/");
    const requiredPath = requireFn.mock.calls[0]?.[0];
    expect(requiredPath).toBeTruthy();
    await expect(fs.readFile(requiredPath as string, "utf8")).resolves.toBe("native-binary");
  });

  it("resolves the installed Windows arm64 platform package layout", async () => {
    const fixture = await makeInstalledNativeFixture("1.8.72", "arm-native-binary", "win32-arm64-msvc");
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32",
      arch: "arm64",
      cacheRoot: fixture.cacheRoot,
    });

    expect(loaded.origin).toMatchObject({
      mode: "cache",
      packageName: "@lzehrung/codegraph-native-win32-arm64-msvc",
      target: "win32-arm64-msvc",
    });
    expect(requireFn.mock.calls[0]?.[0]).toContain("index.win32-arm64-msvc.node");
  });

  it("reuses an identical immutable entry without rewriting it", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));
    const options = {
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32" as const,
      arch: "x64",
      cacheRoot: fixture.cacheRoot,
    };

    const first = loadNativeBinding<{ specifier: string }>(options);
    const firstPath = requireFn.mock.calls[0]?.[0];
    expect(firstPath).toBeTruthy();
    const firstStats = await fs.stat(firstPath as string);
    await fs.writeFile(`${String(firstPath)}.999.abandoned.tmp`, "partial");
    const second = loadNativeBinding<{ specifier: string }>(options);
    const secondPath = requireFn.mock.calls[1]?.[0];
    const secondStats = await fs.stat(secondPath as string);

    expect(first.origin?.cacheKey).toBe(second.origin?.cacheKey);
    expect(firstPath).toBe(secondPath);
    expect(secondStats.birthtimeMs).toBe(firstStats.birthtimeMs);
    expect(secondStats.mtimeMs).toBe(firstStats.mtimeMs);
  });

  it("uses distinct cache identities when package version or bytes change", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));
    const baseOptions = {
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32" as const,
      arch: "x64",
      cacheRoot: fixture.cacheRoot,
    };

    const first = loadNativeBinding(baseOptions);
    await fs.writeFile(fixture.binaryPath, "different-native-binary");
    const changedBytes = loadNativeBinding(baseOptions);
    const versionedFixture = await makeInstalledNativeFixture("1.8.73");
    const changedVersion = loadNativeBinding({
      ...baseOptions,
      resolveFn: versionedFixture.resolveFn,
      cacheRoot: versionedFixture.cacheRoot,
    });

    expect(first.origin?.cacheKey).not.toBe(changedBytes.origin?.cacheKey);
    expect(first.origin?.cacheKey).not.toBe(changedVersion.origin?.cacheKey);
  });

  it("rejects a source whose size changes while it is being hashed", async () => {
    const root = await makeTempDir();
    const sourcePath = path.join(root, "changing.node");
    await fs.writeFile(sourcePath, Buffer.alloc(2 * 1024 * 1024, 1));
    let changed = false;

    expect(() =>
      hashFileStreaming(sourcePath, () => {
        if (changed) return;
        changed = true;
        fsSync.appendFileSync(sourcePath, "x");
      }),
    ).toThrow(/changed while hashing/);
  });

  it("converges concurrent processes on one verified final path", async () => {
    const fixture = await makeInstalledNativeFixture();
    const moduleUrl = pathToFileURL(path.resolve("src/native/runtimeCache.ts")).href;
    const childSource = `
        import { prepareNativeRuntimeCache } from ${JSON.stringify(moduleUrl)};
        const [sourcePath, cacheRoot] = process.argv.slice(1);
        const result = prepareNativeRuntimeCache({
          sourcePath,
          cacheRoot,
          packageName: "@lzehrung/codegraph-native-win32-x64-msvc",
          packageVersion: "1.8.72",
          target: "win32-x64-msvc",
        });
        process.stdout.write(JSON.stringify(result));
      `;

    const children = Array.from({ length: 8 }, () =>
      execFile(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childSource, fixture.binaryPath, fixture.cacheRoot],
        { cwd: process.cwd() },
      ),
    );
    const results = await Promise.all(children);
    const parsed = results.map(({ stdout }) => JSON.parse(stdout) as { status: string; loadedPath: string });

    expect(new Set(parsed.map((result) => result.loadedPath)).size).toBe(1);
    expect(parsed.every((result) => result.status === "cached" || result.status === "reused")).toBeTruthy();
    await expect(fs.readFile(parsed[0]?.loadedPath ?? "", "utf8")).resolves.toBe("native-binary");
  }, 20_000);
  it("preserves a valid winner published after an initial cache miss", async () => {
    const fixture = await makeInstalledNativeFixture();
    const source = hashFileStreaming(fixture.binaryPath);
    const target = "win32-x64-msvc";
    const entryPath = path.join(fixture.cacheRoot, target, `1.8.72-${source.sha256}`);
    const finalPath = path.join(entryPath, path.basename(fixture.binaryPath));
    const originalExistsSync = fsSync.existsSync;
    let winnerPublished = false;
    const existsSync = vi.spyOn(fsSync, "existsSync").mockImplementation((candidate) => {
      if (!winnerPublished && path.resolve(String(candidate)) === path.resolve(finalPath)) {
        fsSync.copyFileSync(fixture.binaryPath, finalPath);
        winnerPublished = true;
      }
      return originalExistsSync(candidate);
    });

    try {
      const result = prepareNativeRuntimeCache({
        sourcePath: fixture.binaryPath,
        cacheRoot: fixture.cacheRoot,
        packageName: "@lzehrung/codegraph-native-win32-x64-msvc",
        packageVersion: "1.8.72",
        target,
      });
      const entryNames = await fs.readdir(entryPath);

      expect(result).toMatchObject({ status: "reused", loadedPath: finalPath });
      expect(entryNames.some((name) => name.includes(".corrupt."))).toBe(false);
      await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("native-binary");
    } finally {
      existsSync.mockRestore();
    }
  });

  it("never loads corrupt final bytes and repairs the immutable name", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));
    const options = {
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32" as const,
      arch: "x64",
      cacheRoot: fixture.cacheRoot,
    };
    loadNativeBinding(options);
    const cachedPath = requireFn.mock.calls[0]?.[0];
    expect(cachedPath).toBeTruthy();
    await fs.writeFile(cachedPath as string, "corrupt");
    requireFn.mockClear();

    const repaired = loadNativeBinding(options);

    expect(repaired.origin?.mode).toBe("cache");
    expect(requireFn).toHaveBeenCalledWith(cachedPath);
    await expect(fs.readFile(cachedPath as string, "utf8")).resolves.toBe("native-binary");
  });

  it("falls back to direct package loading with a cache diagnostic", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    const unsafeCacheRoot = path.join(await makeTempDir(), "cache-file");
    await fs.mkdir(localPackageRoot);
    await fs.writeFile(unsafeCacheRoot, "not a directory");
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "win32",
      arch: "x64",
      cacheRoot: unsafeCacheRoot,
    });

    expect(loaded.binding).toEqual({ specifier: "@lzehrung/codegraph-native" });
    expect(loaded.origin?.mode).toBe("package");
    expect(loaded.origin?.cacheError).toContain("unsafe native cache path component");
    expect(requireFn).toHaveBeenCalledWith("@lzehrung/codegraph-native");
  });

  it("rejects unsafe package versions before creating cache paths", async () => {
    const fixture = await makeInstalledNativeFixture("../escape");
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const loaded = loadNativeBinding({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn: (specifier: string) => ({ specifier }),
      resolveFn: fixture.resolveFn,
      platform: "win32",
      arch: "x64",
      cacheRoot: fixture.cacheRoot,
    });

    expect(loaded.origin?.mode).toBe("package");
    expect(loaded.origin?.cacheError).toContain("invalid native cache package version");
    await expect(fs.stat(fixture.cacheRoot)).rejects.toThrow();
  });

  it("rejects a linked cache destination and preserves direct loading", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    const actualCacheRoot = path.join(await makeTempDir(), "actual-cache");
    const linkedCacheRoot = path.join(await makeTempDir(), "linked-cache");
    await fs.mkdir(localPackageRoot);
    await fs.mkdir(actualCacheRoot);
    await fs.symlink(actualCacheRoot, linkedCacheRoot, "junction");

    const loaded = loadNativeBinding({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn: (specifier: string) => ({ specifier }),
      resolveFn: fixture.resolveFn,
      platform: "win32",
      arch: "x64",
      cacheRoot: linkedCacheRoot,
    });

    expect(loaded.origin?.mode).toBe("package");
    expect(loaded.origin?.cacheError).toContain("unsafe native cache path component");
  });
  it("keeps installed non-Windows loading on the umbrella package", async () => {
    const fixture = await makeInstalledNativeFixture();
    const localPackageRoot = path.join(await makeTempDir(), "workspace-native");
    await fs.mkdir(localPackageRoot);
    const requireFn = vi.fn((specifier: string) => ({ specifier }));

    const loaded = loadNativeBinding<{ specifier: string }>({
      packageName: "@lzehrung/codegraph-native",
      localPackageRoot,
      requireFn,
      resolveFn: fixture.resolveFn,
      platform: "darwin",
      arch: "arm64",
      cacheRoot: fixture.cacheRoot,
    });

    expect(loaded.binding).toEqual({ specifier: "@lzehrung/codegraph-native" });
    expect(loaded.origin?.mode).toBe("package");
    await expect(fs.stat(fixture.cacheRoot)).rejects.toThrow();
  });
});
