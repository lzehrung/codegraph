import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  type BuildReport,
} from "../src/index.js";
import { logWithLevel } from "../src/logging.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("logging behavior", () => {
  it("suppresses manifest mismatch warnings when logLevel is silent", async () => {
    const root = await mkTmpDir("dg-logging-manifest-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await buildProjectIndex(root, { cache: "disk" });

      const report: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, {
        cache: "disk",
        incrementalStrict: true,
        logLevel: "silent",
        report,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(report.manifest?.optionsMismatch).toContain("incrementalStrict");
    } finally {
      warnSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records config hash read failures without bypassing logLevel", async () => {
    const root = await mkTmpDir("dg-logging-config-hash-");
    const gitignorePath = path.join(root, ".gitignore");
    await fsp.writeFile(gitignorePath, "dist/\n", "utf8");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );

    const originalReadFile = fsp.readFile.bind(fsp);
    const readSpy = vi
      .spyOn(fsp, "readFile")
      .mockImplementation(async (filePath, options) => {
        if (String(filePath).endsWith(".gitignore")) {
          throw new Error("mocked config hash read failure");
        }
        return await originalReadFile(filePath, options as never);
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    try {
      const report: BuildReport = { timings: {} };
      await buildProjectIndex(root, {
        logLevel: "silent",
        report,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
      expect(report.manifest?.configHashError).toContain(".gitignore");
      expect(report.manifest?.configHashError).toContain(
        "mocked config hash read failure",
      );
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      readSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("routes info and debug severities to their matching console methods", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      logWithLevel("info", "info", "info message");
      logWithLevel("debug", "debug", "debug message");

      expect(infoSpy).toHaveBeenCalledOnce();
      expect(debugSpy).toHaveBeenCalledOnce();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
