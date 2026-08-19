import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildReviewReport } from "../src/index.js";
import type { ReviewBuildReport } from "../src/review/types.js";
import { runGit } from "./helpers/git.js";
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

  it("only creates duplicate tasks for updated summaries", async () => {
    const root = await tempProject("cg-review-status-duplicate-");
    try {
      const source = [
        "export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {",
        "  const totals: number[] = [];",
        "  const labels: string[] = [];",
        "  for (const row of rows) {",
        "    const subtotal = row.amount + row.tax;",
        "    const rounded = Math.round(subtotal * 100) / 100;",
        '    const label = rounded > 100 ? "large" : "small";',
        "    labels.push(label);",
        "    totals.push(rounded);",
        "  }",
        '  return totals.map((value, index) => labels[index] + ":" + value.toFixed(2)).join(",");',
        "}",
        "",
      ].join("\n");
      await mkdir(path.join(root, "src"), { recursive: true });
      const aPath = path.join(root, "src", "a.ts");
      const bPath = path.join(root, "src", "b.ts");
      await writeFile(aPath, source, "utf8");
      await writeFile(bPath, source, "utf8");
      runGit(root, ["init"]);
      runGit(root, ["config", "user.email", "tests@example.com"]);
      runGit(root, ["config", "user.name", "Tests"]);
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "initial"]);
      await writeFile(aPath, source.replace("large", "huge"), "utf8");

      const updated = await buildReviewReport(root, { gitBase: "HEAD", gitHead: "WORKTREE" });
      expect(updated.changedFiles).toContainEqual(expect.objectContaining({ file: "src/a.ts", status: "updated" }));
      expect(updated.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(true);
      const deletedPath = path.join(root, "src", "deleted.ts");
      const duplicateReport: ReviewBuildReport = { timings: {} };
      const deletedOrMissing = await buildReviewReport(root, {
        files: [deletedPath, path.join(root, "missing.ts")],
        diffText: [
          "diff --git a/src/deleted.ts b/src/deleted.ts",
          "deleted file mode 100644",
          "index 1111111..0000000",
          "--- a/src/deleted.ts",
          "+++ /dev/null",
          "",
        ].join("\n"),
        report: duplicateReport,
      });
      expect(deletedOrMissing.changedFiles).toContainEqual(
        expect.objectContaining({ file: "src/deleted.ts", status: "deleted" }),
      );
      expect(deletedOrMissing.changedFiles).toContainEqual(
        expect.objectContaining({ file: "missing.ts", status: "missing" }),
      );
      expect(deletedOrMissing.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(false);
      expect(duplicateReport.duplicateAnalysis).toBeUndefined();
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
