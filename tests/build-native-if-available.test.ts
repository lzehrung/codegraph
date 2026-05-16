import { describe, expect, it, vi } from "vitest";
import { runBuildNativeIfAvailable } from "../scripts/build-native-if-available-lib.mjs";

describe("build-native-if-available", () => {
  it("skips cleanly when Cargo is unavailable", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cargo is unavailable"));
  });

  it("warns and falls back when the native build fails", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({
      status: 2,
      stderr: "synthetic native build failure",
    });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(2);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("synthetic native build failure"));
  });

  it("fails fast in strict mode when Cargo is unavailable", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 1 });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
      strict: true,
    });

    expect(exitCode).toBe(1);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("required, but Cargo is unavailable"));
  });

  it("fails fast in strict mode when the native build fails", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({
      status: 2,
      stderr: "synthetic native build failure",
    });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
      strict: true,
    });

    expect(exitCode).toBe(2);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("synthetic native build failure"));
  });

  it("returns success without warnings when the native build succeeds", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cleans packaged Windows native artifacts before building", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });
    const readdirSyncImpl = vi.fn((target: string) => {
      if (target.endsWith("packages\\codegraph-native")) {
        return [
          { name: "index.win32-x64-msvc.node", isDirectory: () => false },
          { name: "npm", isDirectory: () => true },
        ];
      }
      if (target.endsWith("packages\\codegraph-native\\npm")) {
        return [
          { name: "win32-x64-msvc", isDirectory: () => true },
          { name: "darwin-arm64", isDirectory: () => true },
        ];
      }
      if (target.endsWith("packages\\codegraph-native\\npm\\win32-x64-msvc")) {
        return [
          { name: "index.win32-x64-msvc.node", isDirectory: () => false },
          { name: "package.json", isDirectory: () => false },
        ];
      }
      return [];
    });
    const rmSyncImpl = vi.fn();

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "win32",
      logger: { warn },
      cwd: "C:\\work\\codegraph",
      readdirSyncImpl,
      rmSyncImpl,
    });

    expect(exitCode).toBe(0);
    expect(rmSyncImpl).toHaveBeenCalledTimes(2);
    expect(rmSyncImpl).toHaveBeenNthCalledWith(
      1,
      "C:\\work\\codegraph\\packages\\codegraph-native\\index.win32-x64-msvc.node",
      {
        force: true,
      },
    );
    expect(rmSyncImpl).toHaveBeenNthCalledWith(
      2,
      "C:\\work\\codegraph\\packages\\codegraph-native\\npm\\win32-x64-msvc\\index.win32-x64-msvc.node",
      { force: true },
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns clearly when a Windows native artifact is locked during cleanup", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({
      status: 1,
      stderr: "copy artifact failed",
    });
    const readdirSyncImpl = vi.fn((target: string) => {
      if (target.endsWith("packages\\codegraph-native")) {
        return [{ name: "index.win32-x64-msvc.node", isDirectory: () => false }];
      }
      return [];
    });
    const rmSyncImpl = vi.fn(() => {
      const error = new Error("The process cannot access the file");
      error.name = "EPERM";
      throw error;
    });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "win32",
      logger: { warn },
      cwd: "C:\\work\\codegraph",
      readdirSyncImpl,
      rmSyncImpl,
    });

    expect(exitCode).toBe(1);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("A packaged native addon appears to be in use"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("copy artifact failed"));
  });
});
