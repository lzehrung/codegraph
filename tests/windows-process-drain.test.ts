import { afterEach, describe, expect, it } from "vitest";
import {
  drainWindowsProcessHandles,
  markWindowsProcessDrainRequired,
  resetWindowsProcessDrainForTests,
  WINDOWS_LIBUV_EXIT_DRAIN_MS,
  windowsProcessDrainIsRequired,
} from "../src/util/windowsProcessDrain.js";

describe("Windows process-handle drain", () => {
  afterEach(() => {
    resetWindowsProcessDrainForTests();
  });

  it("does not wait off Windows even after native handles were used", async () => {
    markWindowsProcessDrainRequired();
    const waits: number[] = [];
    await drainWindowsProcessHandles({
      platform: "linux",
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(windowsProcessDrainIsRequired()).toBe(true);
    expect(waits).toEqual([]);
  });

  it("does not wait on Windows when no sqlite, native addon, or worker pool was used", async () => {
    const waits: number[] = [];
    await drainWindowsProcessHandles({
      platform: "win32",
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(windowsProcessDrainIsRequired()).toBe(false);
    expect(waits).toEqual([]);
  });

  it("waits on Windows after native handles were used", async () => {
    markWindowsProcessDrainRequired();
    const waits: number[] = [];
    await drainWindowsProcessHandles({
      platform: "win32",
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([WINDOWS_LIBUV_EXIT_DRAIN_MS]);
  });

  it("registers a one-shot beforeExit hook only on Windows", () => {
    const before = process.listeners("beforeExit").length;
    markWindowsProcessDrainRequired();
    const after = process.listeners("beforeExit").length;
    if (process.platform === "win32") {
      expect(after).toBe(before + 1);
      markWindowsProcessDrainRequired();
      expect(process.listeners("beforeExit").length).toBe(before + 1);
      return;
    }
    expect(after).toBe(before);
  });
});
