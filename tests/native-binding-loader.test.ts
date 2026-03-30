import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  findLocalNativeBinary,
  loadNativeBinding,
} from "../src/native/bindingLoader.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-loader-"));
  tempDirs.push(dir);
  return dir;
}

describe("native binding loader", () => {
  it("finds a local native binary inside the workspace package", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "index.win32-x64-msvc.node"), "");

    expect(findLocalNativeBinary(dir)?.replace(/\\/g, "/")).toMatch(
      /index\.win32-x64-msvc\.node$/,
    );
  });

  it("prefers a local workspace binary over the package entrypoint", async () => {
    const dir = await makeTempDir();
    const binary = path.join(dir, "index.win32-x64-msvc.node");
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
});
