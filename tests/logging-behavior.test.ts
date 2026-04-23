import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  type BuildReport,
} from "../src/index.js";

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
});
