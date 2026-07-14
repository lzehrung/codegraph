import { describe, expect, it, vi } from "vitest";

import { createInstalledVersionChecker, type CodegraphRuntimeIdentity } from "../src/runtimeIdentity.js";

function runtimeIdentity(): CodegraphRuntimeIdentity {
  return {
    startedAt: "2026-07-14T00:00:00.000Z",
    runningVersion: "1.8.93",
    packageRoot: "C:/codegraph",
    packageJsonPath: "C:/codegraph/package.json",
  };
}

describe("installed Codegraph version drift", () => {
  it("throttles reads and warns once for each observed installed version", () => {
    let now = 0;
    let installedVersion = "1.8.93";
    const readFile = vi.fn(() => JSON.stringify({ version: installedVersion }));
    const warn = vi.fn();
    const checker = createInstalledVersionChecker(runtimeIdentity(), {
      now: () => now,
      readFile,
      warn,
      intervalMs: 30_000,
    });

    expect(checker.check()).toMatchObject({ restartRequired: false, installedVersion: "1.8.93" });
    installedVersion = "1.8.94";
    now = 10_000;
    expect(checker.check()).toMatchObject({ restartRequired: false, installedVersion: "1.8.93" });
    expect(readFile).toHaveBeenCalledTimes(1);

    now = 30_000;
    expect(checker.check()).toMatchObject({
      restartRequired: true,
      runningVersion: "1.8.93",
      installedVersion: "1.8.94",
    });
    expect(warn).toHaveBeenCalledTimes(1);

    now = 60_000;
    checker.check();
    expect(warn).toHaveBeenCalledTimes(1);

    installedVersion = "1.8.95";
    now = 90_000;
    expect(checker.check()).toMatchObject({ restartRequired: true, installedVersion: "1.8.95" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reports transient package replacement without throwing", () => {
    const warn = vi.fn();
    const checker = createInstalledVersionChecker(runtimeIdentity(), {
      readFile: () => {
        throw new Error("package temporarily missing");
      },
      warn,
      intervalMs: 0,
    });

    expect(() => checker.check()).not.toThrow();
    expect(checker.check()).toEqual({
      restartRequired: true,
      runningVersion: "1.8.93",
      reason: "Codegraph installation changed while this process was running",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
