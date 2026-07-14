import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

type ChildMessage = {
  type: "loaded" | "verified";
  origin?: {
    mode?: string;
    sourcePath?: string;
    loadedPath?: string;
    cacheKey?: string;
    sha256?: string;
  };
  languages: number;
};

function waitForChildMessage(child: ChildProcess, expectedType: ChildMessage["type"]): Promise<ChildMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildMessage>();
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== expectedType) return;
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("message", onMessage);
    resolve(message as ChildMessage);
  };
  const onError = (error: Error): void => {
    reject(error);
  };
  const onExit = (code: number | null): void => {
    reject(new Error(`native cache child exited before ${expectedType}: ${String(code)}`));
  };
  child.on("message", onMessage);
  child.once("error", onError);
  child.once("exit", onExit);
  return promise;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const windowsX64 = process.platform === "win32" && process.arch === "x64";

describe.runIf(windowsX64)("Windows native runtime cache integration", () => {
  it("keeps native parsing alive after the installed package source is renamed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-cache-live-"));
    tempDirs.push(root);
    const packageRoot = path.join(root, "installed", "node_modules", "@lzehrung", "codegraph");
    const platformPackageRoot = path.join(packageRoot, "node_modules", "@lzehrung", "codegraph-native-win32-x64-msvc");
    const umbrellaRoot = path.join(packageRoot, "node_modules", "@lzehrung", "codegraph-native");
    const sourceBinary = path.resolve("packages/codegraph-native/index.win32-x64-msvc.node");
    const syntheticBinary = path.join(platformPackageRoot, "index.win32-x64-msvc.node");
    const cacheRoot = path.join(root, "cache", "v1");
    await fs.mkdir(platformPackageRoot, { recursive: true });
    await fs.mkdir(umbrellaRoot, { recursive: true });
    await fs.copyFile(sourceBinary, syntheticBinary);
    await fs.writeFile(
      path.join(platformPackageRoot, "package.json"),
      JSON.stringify({ name: "@lzehrung/codegraph-native-win32-x64-msvc", version: "1.8.72" }),
    );
    await fs.writeFile(path.join(umbrellaRoot, "index.js"), "module.exports = {};\n");

    const child = fork(
      path.resolve("tests/fixtures/native-cache-live-child.mjs"),
      [JSON.stringify({ packageRoot, platformPackageRoot, cacheRoot })],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );

    try {
      const loaded = await waitForChildMessage(child, "loaded");
      expect(loaded.languages).toBeGreaterThan(0);
      expect(loaded.origin).toMatchObject({ mode: "cache" });
      expect(loaded.origin?.sourcePath).toContain("/installed/");
      expect(loaded.origin?.loadedPath).toContain("/cache/v1/");
      expect(loaded.origin?.loadedPath).not.toContain("/installed/");
      expect(loaded.origin?.cacheKey).toBeTruthy();
      expect(loaded.origin?.sha256).toMatch(/^[a-f0-9]{64}$/);

      const retiredRoot = `${packageRoot}.retired`;
      await fs.rename(packageRoot, retiredRoot);
      child.send("verify");
      const verified = await waitForChildMessage(child, "verified");
      expect(verified.languages).toBe(loaded.languages);
      await fs.rename(retiredRoot, packageRoot);
    } finally {
      if (child.exitCode === null) {
        if (child.connected) child.send("stop");
        await once(child, "exit");
      }
    }
  }, 30_000);
});
