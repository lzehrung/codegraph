import { describe, expect, it } from "vitest";
import { buildReviewReport } from "../src/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function tempProject(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("PR4 review audit regressions", () => {
  it("preserves modeChanged in review transport data and skips duplicate work", async () => {
    const root = await tempProject("cg-review-mode-transport-");
    try {
      await writeFile(path.join(root, "script.ts"), "export const value = 1;\n", "utf8");
      const report = await buildReviewReport(root, {
        diffText: ["diff --git a/script.ts b/script.ts", "old mode 100644", "new mode 100755", ""].join("\n"),
        duplicateTasks: true,
      });
      expect(report.changedFiles).toContainEqual(expect.objectContaining({ file: "script.ts", modeChanged: true }));
      expect(report.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create duplicate work for a pure rename", async () => {
    const root = await tempProject("cg-review-rename-duplicate-");
    try {
      await writeFile(path.join(root, "old.ts"), "export const value = 1;\n", "utf8");
      await writeFile(path.join(root, "new.ts"), "export const value = 1;\n", "utf8");
      const report = await buildReviewReport(root, {
        diffText: [
          "diff --git a/old.ts b/new.ts",
          "similarity index 100%",
          "rename from old.ts",
          "rename to new.ts",
          "",
        ].join("\n"),
        duplicateTasks: true,
      });
      expect(report.changedFiles).toContainEqual(expect.objectContaining({ file: "new.ts", oldFile: "old.ts" }));
      expect(report.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes negative public candidate limits instead of widening results", async () => {
    const root = await tempProject("cg-review-negative-candidates-");
    try {
      await writeFile(path.join(root, "changed.ts"), "export const value = 1;\n", "utf8");
      await writeFile(path.join(root, "changed.test.ts"), "import { value } from './changed.js';\nvalue;\n", "utf8");
      const report = await buildReviewReport(root, {
        files: [path.join(root, "changed.ts")],
        maxCandidates: -1,
      });
      expect(report.candidateTests).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
