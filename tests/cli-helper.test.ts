import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureTsxScript } from "./helpers/cli.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("CLI subprocess helpers", () => {
  it("captures delayed large payloads through child close", async () => {
    const root = await mkTmpDir("cg-cli-capture-");
    try {
      const script = path.join(root, "delayed.ts");
      const payload = "payload-".repeat(32_768);
      await fsp.writeFile(script, `setImmediate(() => process.stdout.write(${JSON.stringify(payload)}));\n`, "utf8");

      const result = await captureTsxScript(script);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(payload);
      expect(result.stderr).toBe("");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
