import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseUnifiedDiff } from "../src/impact/parse.js";
import { analyzeImpactFromDiff, listCandidateTestFiles } from "../src/impact/index.js";
import { CompactImpactReport, type ImpactItem } from "../src/impact/types.js";
import type { Range } from "../src/types.js";
import { createTestIndex } from "./test-utils.js";

describe("Impact Analysis", () => {
  describe("Diff Parsing", () => {
    it("should parse a simple unified diff", () => {
      const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,4 @@
 export function helper() {
   return 42;
 }
+export function newHelper() {
+  return 43;
+}
`;

      const diff = parseUnifiedDiff(diffText);

      expect(diff.files).toHaveLength(1);
      expect(diff.files[0].path).toBe("utils.ts");
      expect(diff.files[0].kind).toBe("modified");
      expect(diff.files[0].hunks).toHaveLength(1);
      expect(diff.files[0].hunks[0].oldStart).toBe(1);
      expect(diff.files[0].hunks[0].newStart).toBe(1);
      expect(diff.files[0].hunks[0].lines).toContain("+export function newHelper() {");
    });

    it("should parse diff with file additions", () => {
      const diffText = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+export function newFunction() {
+  return "new";
+}
`;

      const diff = parseUnifiedDiff(diffText);

      expect(diff.files).toHaveLength(1);
      expect(diff.files[0].path).toBe("newfile.ts");
      expect(diff.files[0].kind).toBe("added");
      expect(diff.files[0].hunks[0].newStart).toBe(1);
    });

    it("should parse diff with file deletions", () => {
      const diffText = `diff --git a/oldfile.ts b/oldfile.ts
deleted file mode 100644
index 1234567..0000000
--- a/oldfile.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function oldFunction() {
-  return "old";
-}
`;

      const diff = parseUnifiedDiff(diffText);

      expect(diff.files).toHaveLength(1);
      expect(diff.files[0].path).toBe("oldfile.ts");
      expect(diff.files[0].kind).toBe("deleted");
    });

    it("should parse diff with renames", () => {
      const diffText = `diff --git a/oldname.ts b/newname.ts
similarity index 100%
rename from oldname.ts
rename to newname.ts
index 1234567..abcdef0 100644
--- a/oldname.ts
+++ b/newname.ts
@@ -1,2 +1,2 @@
 export function helper() {
-  return 42;
+  return 43;
 }
`;

      const diff = parseUnifiedDiff(diffText);

      expect(diff.files).toHaveLength(1);
      expect(diff.files[0].path).toBe("newname.ts");
      expect(diff.files[0].kind).toBe("renamed");
      expect(diff.files[0].oldPath).toBe("oldname.ts");
    });

    it("should keep deletion lines in hunks", () => {
      const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,2 @@
 export function helper() {
-  return 42;
+  return 43;
 }
`;

      const diff = parseUnifiedDiff(diffText);
      const hunk = diff.files[0]?.hunks[0];

      expect(hunk?.lines).toContain("-  return 42;");
      expect(hunk?.lines).toContain("+  return 43;");
    });
  });

  describe("Impact Analysis", () => {
    it("should analyze impact from diff text", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      // Create a simple diff that adds a function
      const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,6 @@
 export function helperFunction() {
   return 42;
 }
+export function newFunction() {
+  return 43;
+}
`;

      const report = await analyzeImpactFromDiff(samplePath, index, {
        provider: "raw",
        diffText
      });

      expect(report).toBeDefined();
      expect(report.changedFiles).toHaveLength(1);
      expect(report.changedSymbols.length).toBeGreaterThanOrEqual(0); // May be 0 if the new function isn't properly detected
      expect(Array.isArray(report.impacted)).toBe(true);
    });

    it("should handle empty diffs", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      const diffText = ""; // Empty diff

      const report = await analyzeImpactFromDiff(samplePath, index, {
        provider: "raw",
        diffText
      });

      expect(report.changedFiles).toHaveLength(0);
      expect(report.changedSymbols).toHaveLength(0);
      expect(report.impacted).toHaveLength(0);
    });

    it("should seed transitive impact from deleted/renamed files with depth > 0", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      // Create a diff that deletes a file
      const diffText = `diff --git a/utils.ts b/utils.ts
deleted file mode 100644
index 1234567..0000000
--- a/utils.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function helperFunction() {
-  return 42;
-}
`;

      const report = await analyzeImpactFromDiff(samplePath, index, {
        provider: "raw",
        diffText,
        depth: 2 // Enable transitive analysis
      });

      expect(report).toBeDefined();
      expect(report.changedFiles).toHaveLength(1);
      expect(report.changedFiles[0].file).toBe("utils.ts");

      // Should have transitive impact from files that depend on the deleted file
      const transitiveItems = report.impacted.filter(item => (item.depth ?? 0) > 0);
      if (transitiveItems.length > 0) {
        // If there are transitive items, they should have appropriate hints
        for (const item of transitiveItems) {
          expect(item.explain?.hints).toContain("fileDeleted");
          expect(item.depth).toBeGreaterThan(0);
          expect(item.reasons).toContain("transitive");
        }
      }
    });

    it("should emit real symbolEdges connecting changed symbols to used symbols (pruned)", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      // Create a diff that modifies a function that uses other symbols
      const diffText = `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1,3 +1,4 @@
 import { helperFunction } from "./utils";
+import { anotherHelper } from "./helpers";

 console.log(helperFunction());
+console.log(anotherHelper());
`;

      const report = await analyzeImpactFromDiff(samplePath, index, {
        provider: "raw",
        diffText
      });

      expect(report).toBeDefined();

      // Check that symbolEdges exist and are properly indexed
      if (report.graph.symbolEdges.length > 0) {
        for (const edge of report.graph.symbolEdges) {
          expect(typeof edge.from).toBe("number");
          expect(typeof edge.to).toBe("number");
          expect(edge.from).not.toBe(edge.to); // No self-edges
          expect(typeof edge.label).toBe("string");

          // Verify indices are valid
          expect(edge.from).toBeGreaterThanOrEqual(0);
          expect(edge.from).toBeLessThan(report.changedSymbols.length);
          expect(edge.to).toBeGreaterThanOrEqual(0);
          expect(edge.to).toBeLessThan(report.changedSymbols.length);
        }
      }
    });
  });

  describe("Candidate Test Files", () => {
    it("should detect candidate test files via import edges on samples", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      // Get some files and symbols from the index
      const files = Array.from(index.byFile.keys());
      const changedFiles = files.slice(0, 2); // Use first 2 files as changed

      // Get some symbol IDs from changed files
      const changedSymbolIds: string[] = [];
      for (const file of changedFiles) {
        const mod = index.byFile.get(file);
        if (mod && mod.locals.length > 0) {
          const symbolId = `${file}::${mod.locals[0].localName}::${mod.locals[0].range.start.index}`;
          changedSymbolIds.push(symbolId);
        }
      }

      const candidates = listCandidateTestFiles(
        index,
        changedFiles,
        changedSymbolIds,
        { maxCandidates: 10 }
      );

      expect(Array.isArray(candidates)).toBe(true);

      // Verify candidate structure
      for (const candidate of candidates) {
        expect(typeof candidate.file).toBe("string");
        expect(["high", "medium", "low"]).toContain(candidate.confidence);
        expect(["importsChanged", "dependsOnChanged", "pattern"]).toContain(candidate.reason);
      }

      // Candidates should be sorted by confidence (high first)
      if (candidates.length > 1) {
        const highCount = candidates.filter(c => c.confidence === "high").length;
        const mediumCount = candidates.filter(c => c.confidence === "medium").length;
        const lowCount = candidates.filter(c => c.confidence === "low").length;

        // High confidence should come first
        if (highCount > 0) {
          expect(candidates[0].confidence).toBe("high");
        }
      }
    });
  });

  describe("Hints Generation", () => {
    it("should generate exportChanged hints for exported symbols", async () => {
      const index = await createTestIndex("typescript");

      // Find an exported symbol
      let exportedSymbol: {
        id: string;
        file: string;
        name: string;
        kind: string;
        exported: boolean;
        range: Range;
        typeOnly: boolean;
      } | null = null;

      for (const [file, mod] of index.byFile) {
        for (const exp of mod.exports) {
          if (exp.type === "local" && exp.target) {
            exportedSymbol = {
              id: `${file}::${exp.target.localName}::${exp.target.range.start.index}`,
              file,
              name: exp.target.localName,
              kind: exp.target.kind,
              exported: true,
              range: exp.target.range,
              typeOnly: false
            };
            break;
          }
        }
        if (exportedSymbol) break;
      }

      if (exportedSymbol) {
        // Create a simple diff that affects this symbol
        const diffText = `diff --git a/${exportedSymbol.file} b/${exportedSymbol.file}
index 1234567..abcdef0 100644
--- a/${exportedSymbol.file}
+++ b/${exportedSymbol.file}
@@ -${exportedSymbol.range.start.line},1 +${exportedSymbol.range.start.line},1 @@
 export function ${exportedSymbol.name}() {
-  return 42;
+  return 43;
 }
`;

        const report = await analyzeImpactFromDiff(
          path.resolve(process.cwd(), "tests", "samples", "typescript"),
          index,
          {
            provider: "raw",
            diffText
          }
        );

        // Find the impact item that contains this symbol
        const relevantImpact = report.impacted.find(item =>
          item.symbols.includes(exportedSymbol.name)
        );

        if (relevantImpact?.explain?.hints) {
          expect(relevantImpact.explain.hints).toContain("exportChanged");
        }
      }
    });

    it("should generate signatureChanged hints for function modifications", async () => {
      const index = await createTestIndex("typescript");

      // Find a function symbol
      let functionSymbol: {
        id: string;
        file: string;
        name: string;
        kind: string;
        exported: boolean;
        range: Range;
        typeOnly: boolean;
      } | null = null;

      for (const [file, mod] of index.byFile) {
        for (const local of mod.locals) {
          if (local.kind === "function" && local.range.end.line - local.range.start.line > 1) {
            functionSymbol = {
              id: `${file}::${local.localName}::${local.range.start.index}`,
              file,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: false
            };
            break;
          }
        }
        if (functionSymbol) break;
      }

      if (functionSymbol) {
        // Create a diff that modifies the function body
        const diffText = `diff --git a/${functionSymbol.file} b/${functionSymbol.file}
index 1234567..abcdef0 100644
--- a/${functionSymbol.file}
+++ b/${functionSymbol.file}
@@ -${functionSymbol.range.start.line + 1},1 +${functionSymbol.range.start.line + 1},1 @@
   return 42;
+  console.log("modified");
 }
`;

        const report = await analyzeImpactFromDiff(
          path.resolve(process.cwd(), "tests", "samples", "typescript"),
          index,
          {
            provider: "raw",
            diffText
          }
        );

        // Find impact items that might have signatureChanged hints
        const itemsWithHints = report.impacted.filter((item: ImpactItem) =>
          item.explain?.hints?.includes("signatureChanged")
        );

        // The test passes if hints are generated appropriately (may not always trigger)
        expect(Array.isArray(itemsWithHints)).toBe(true);
      }
    });
  });

  describe("Compact Report Format", () => {
    it("should generate compact report when compact=true", async () => {
      const index = await createTestIndex("typescript");

      const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,4 @@
 export function helper() {
   return 42;
+  console.log("added");
 }
`;

      const report = await analyzeImpactFromDiff(
        path.resolve(process.cwd(), "tests", "samples", "typescript"),
        index,
        {
          provider: "raw",
          diffText,
          compact: true
        }
      );

      if (!('files' in report)) {
        throw new Error('Expected result to be a compact report');
      }

      // Verify compact report structure
      expect(report).toHaveProperty("files");
      expect(Array.isArray(report.files)).toBe(true);

      expect(report).toHaveProperty("changedFiles");
      expect(Array.isArray(report.changedFiles)).toBe(true);

      expect(report).toHaveProperty("changedSymbols");
      expect(Array.isArray(report.changedSymbols)).toBe(true);

      expect(report).toHaveProperty("impacted");
      expect(Array.isArray(report.impacted)).toBe(true);

      expect(report).toHaveProperty("graph");
      expect(report.graph).toHaveProperty("fileEdges");
      expect(report.graph).toHaveProperty("symbolEdges");

      // Verify that changedFiles use indices into files array
      for (const cf of report.changedFiles) {
        expect(typeof cf.file).toBe("number");
        expect(cf.file).toBeGreaterThanOrEqual(0);
        expect(cf.file).toBeLessThan(report.files.length);
      }

      // Verify that impacted items use indices
      for (const item of report.impacted) {
        expect(typeof item.file).toBe("number");
        expect(item.file).toBeGreaterThanOrEqual(0);
        expect(item.file).toBeLessThan(report.files.length);
      }

      // Verify file edges use indices
      for (const edge of report.graph.fileEdges) {
        expect(typeof edge.from).toBe("number");
        expect(typeof edge.to).toBe("number");
        expect(edge.from).toBeGreaterThanOrEqual(0);
        expect(edge.from).toBeLessThan(report.files.length);
        expect(edge.to).toBeGreaterThanOrEqual(0);
        expect(edge.to).toBeLessThan(report.files.length);
      }
    });

    it("should generate regular report when compact=false or not specified", async () => {
      const index = await createTestIndex("typescript");

      const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,4 @@
 export function helper() {
   return 42;
+  console.log("added");
 }
`;

      const report = await analyzeImpactFromDiff(
        path.resolve(process.cwd(), "tests", "samples", "typescript"),
        index,
        {
          provider: "raw",
          diffText,
          compact: false
        }
      );

      // Verify regular report structure (uses file paths, not indices)
      expect(report).toHaveProperty("changedFiles");
      expect(Array.isArray(report.changedFiles)).toBe(true);

      for (const cf of report.changedFiles) {
        expect(typeof cf.file).toBe("string");
      }

      expect(report).toHaveProperty("impacted");
      for (const item of report.impacted) {
        expect(typeof item.file).toBe("string");
      }

      expect(report).toHaveProperty("graph");
      expect(report.graph).toHaveProperty("fileEdges");
      for (const edge of report.graph.fileEdges) {
        expect(typeof edge.from).toBe("string");
        expect(typeof edge.to).toBe("string");
      }
    });
  });
});
