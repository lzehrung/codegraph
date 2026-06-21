import path from "node:path";
import { describe, expect, it } from "vitest";
import { tool_getDependencies } from "../src/agent-tools.js";

describe("tool_getDependencies ordering", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

  it("returns dependencies sorted by file then depth before truncation", async () => {
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
  });
});
