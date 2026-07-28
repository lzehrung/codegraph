import { describe, expect, it } from "vitest";
import { tool_getDependencies } from "../src/agent-tools.js";
import { readOnlySamplePath, withCopiedFixture } from "./helpers/filesystem.js";
describe("tool_getDependencies ordering", () => {
  it("returns dependencies sorted by file then depth before truncation", async () => {
    await withCopiedFixture(
      readOnlySamplePath("typescript"),
      async (samplePath) => {
        const baseline = await tool_getDependencies(samplePath, "main.ts", { depth: 1, limit: 20 });
        expect(baseline.status).toBe("ok");
        if (baseline.status !== "ok") return;

        const limited = await tool_getDependencies(samplePath, "main.ts", { depth: 1, limit: 1 });
        expect(limited.status).toBe("ok");
        if (limited.status !== "ok") return;

        const sorted = [...baseline.dependencies].sort((left, right) => {
          const fileDelta = left.file.localeCompare(right.file);
          if (fileDelta !== 0) return fileDelta;
          return left.depth - right.depth;
        });
        expect(limited.dependencies[0]).toEqual(sorted[0]);
      },
      { prefix: "codegraph-agent-tool-order-" },
    );
  });
});
