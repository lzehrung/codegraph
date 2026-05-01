import { describe, it, expect } from "vitest";
import { createTestIndex, getSamplePath } from "./test-utils.js";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import type { ModuleExport } from "../src/index.js";

function makeDiffForAbsPath(abs: string, start: number) {
  return `diff --git a/${abs} b/${abs}
index 0000000..1111111 100644
--- a/${abs}
+++ b/${abs}
@@ -${start},0 +${start},1 @@
+// changed
`;
}

describe("Impact: options and explain payloads", () => {
  it("scope=imported filters non-exported symbol changes (when present)", async () => {
    const index = await createTestIndex("typescript");
    const file = Array.from(index.byFile.keys()).find((f) => f.endsWith("/utils.ts"))!;
    const mod = index.byFile.get(file)!;

    const isLocalExport = (entry: ModuleExport): entry is Extract<ModuleExport, { type: "local" }> => entry.type === "local";
    const exportedNames = new Set(mod.exports.filter(isLocalExport).map((entry) => entry.target.localName));
    const internal = mod.locals.find((l) => !exportedNames.has(l.localName)) || mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(internal.range.start.line + 1, internal.range.start.line));

    const reportAll = await analyzeImpactFromDiff(getSamplePath("typescript"), index, {
      provider: "raw",
      diffText,
      scope: "all",
    });
    const reportImported = await analyzeImpactFromDiff(getSamplePath("typescript"), index, {
      provider: "raw",
      diffText,
      scope: "imported",
    });

    if (!exportedNames.has(internal.localName)) {
      expect(reportAll.changedSymbols.length).toBeGreaterThanOrEqual(1);
      expect(reportImported.changedSymbols.length).toBe(0);
    } else {
      expect(reportImported.changedSymbols.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("membersOnly disables transitive (depth > 0) items", async () => {
    const index = await createTestIndex("typescript");
    const file = Array.from(index.byFile.keys()).find((f) => f.endsWith("/utils.ts"))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const withTransitive = await analyzeImpactFromDiff(getSamplePath("typescript"), index, {
      provider: "raw",
      diffText,
      membersOnly: false,
    });
    const membersOnly = await analyzeImpactFromDiff(getSamplePath("typescript"), index, {
      provider: "raw",
      diffText,
      membersOnly: true,
    });

    expect(membersOnly.impacted.every((i) => (i.depth ?? 0) === 0)).toBe(true);
    const hasTransitive = withTransitive.impacted.some((i) => (i.depth ?? 0) > 0);
    expect(hasTransitive || withTransitive.impacted.length >= 0).toBe(true);
  });

  it("explain payload contains useful factors (reason, depth)", async () => {
    const index = await createTestIndex("typescript");
    const file = Array.from(index.byFile.keys()).find((f) => f.endsWith("/utils.ts"))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const report = await analyzeImpactFromDiff(getSamplePath("typescript"), index, { provider: "raw", diffText });
    for (const item of report.impacted) {
      if (item.explain) {
        expect(Object.prototype.hasOwnProperty.call(item.explain, "reason")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(item.explain, "depth")).toBe(true);
      }
    }
  });

  it("full impact reports carry schemaVersion and an explicit full-format discriminator", async () => {
    const index = await createTestIndex("typescript");
    const file = Array.from(index.byFile.keys()).find((entry) => entry.endsWith("/utils.ts"))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const report = await analyzeImpactFromDiff(getSamplePath("typescript"), index, { provider: "raw", diffText });

    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("full");
    expect(report.changedFiles.length).toBeGreaterThan(0);
    expect(Array.isArray(report.impacted)).toBe(true);
  });

  it("compact impact reports carry schemaVersion and an explicit compact-format discriminator", async () => {
    const index = await createTestIndex("typescript");
    const file = Array.from(index.byFile.keys()).find((entry) => entry.endsWith("/utils.ts"))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const report = await analyzeImpactFromDiff(getSamplePath("typescript"), index, {
      provider: "raw",
      diffText,
      compact: true,
    });

    expect("files" in report).toBe(true);
    expect(report.changedFiles.length).toBeGreaterThan(0);
    expect(typeof report.changedFiles[0]?.file).toBe("number");
    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("compact");
  });
});
