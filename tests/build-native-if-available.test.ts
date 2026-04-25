import { describe, expect, it, vi } from "vitest";
import { runBuildNativeIfAvailable } from "../scripts/build-native-if-available-lib.mjs";

describe("build-native-if-available", () => {
  it("skips cleanly when Cargo is unavailable", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Cargo is unavailable"),
    );
  });

  it("warns and falls back when the native build fails", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({
        status: 2,
        stderr: "synthetic native build failure",
      });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("synthetic native build failure"),
    );
  });

  it("returns success without warnings when the native build succeeds", () => {
    const warn = vi.fn();
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    const exitCode = runBuildNativeIfAvailable({
      spawnSyncImpl,
      platform: "linux",
      logger: { warn },
    });

    expect(exitCode).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
