import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeImpactFromDiff, buildProjectIndex } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer.js";

describe("Impact diagnostics", () => {
  it("includes diagnostics counters and direct-impact confidence", async () => {
    const root = path.resolve("tests/samples/typescript");
    const index = await buildProjectIndex(root);

    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "helper";
+  return "helper-updated";
 }
`;

    const report = await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
      refContext: "line",
      maxRefs: 20,
    });

    expect(report.diagnostics).toBeDefined();
    expect((report.diagnostics?.changedFilesTotal ?? 0) >= 1).toBe(true);
    expect((report.diagnostics?.refsScanned ?? 0) >= 1).toBe(true);

    expect(Array.isArray(report.impacted)).toBe(true);
  });

  it("does not count deleted-file symbol mapping as parser failures", async () => {
    const root = path.resolve("tests/samples/typescript");
    const index = await buildProjectIndex(root);

    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..0000000 100644
--- a/helpers.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function helperFunction(): string {
-  return "helper";
-}
`;

    const report = await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
      maxRefs: 10,
    });

    expect(report.diagnostics).toBeDefined();
    expect(report.diagnostics?.symbolMappingParseFailures ?? 0).toBe(0);
  });

  it("does not reconstruct syntax trees for graph-only document changes", async () => {
    const root = path.resolve("tests/samples/markdown");
    const missingMarkdownFile = path.join(root, "context-budgeting.md");
    const index = {
      graph: { nodes: new Set<string>(), edges: [] },
      byFile: new Map(),
      symbols: new Map(),
      scopeCache: new Map(),
      projectRoot: root,
      projectFiles: [],
      parsed: new Map(),
    } satisfies ProjectIndex;

    const diffText = `diff --git a/context-budgeting.md b/context-budgeting.md
index 1111111..2222222 100644
--- a/context-budgeting.md
+++ b/context-budgeting.md
@@ -1,3 +1,3 @@
 # Context budgeting
-Initial text.
+Updated text.
`;

    const report = await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
      maxRefs: 10,
    });

    expect(report.changedFiles.map((file) => file.file)).toEqual(["context-budgeting.md"]);
    expect(report.changedSymbols).toEqual([]);
    expect(report.diagnostics?.changedFilesWithoutSymbols).toBe(1);
    expect(report.diagnostics?.symbolMappingParseFailures).toBe(0);
    expect(fs.existsSync(missingMarkdownFile)).toBe(false);
  });

  it("keeps impact symbol names aligned after earlier non-ASCII source text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dg-impact-unicode-offset-"));
    try {
      const sourceFile = path.join(root, "feature.ts");
      const source = [
        "// unicode marker: \u2192 \u2014 ok",
        "export function afterUnicode() {",
        "  return 1;",
        "}",
      ].join("\n");
      fs.writeFileSync(sourceFile, source, "utf8");
      const index = await buildProjectIndex(root);

      const diffText = `diff --git a/feature.ts b/feature.ts
index 1111111..2222222 100644
--- a/feature.ts
+++ b/feature.ts
@@ -2,3 +2,3 @@
 export function afterUnicode() {
-  return 1;
+  return 2;
 }
`;

      const report = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
        maxRefs: 10,
      });

      expect(report.changedSymbols.map((symbol) => symbol.name)).toEqual(["afterUnicode"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
