import { describe, it, expect } from "vitest";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import { createTestIndex } from "./test-utils.js";

describe("Impact Analysis Context Snippets", () => {
  describe("Default behavior (no context)", () => {
    it("should not include refs field when refContext is not specified", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
      });

      // Check that no impact items have refs field
      for (const item of report.impacted) {
        if ("refs" in item) {
          expect(item.refs).toBeUndefined();
        }
      }
    });
  });

  describe("Line context mode", () => {
    it("should include line context snippets when refContext is 'line'", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "line",
        refContextLines: 1,
      });

      // Find items with refs (only present in regular reports, not compact)
      const itemsWithRefs = report.impacted.filter((item) => {
        return "refs" in item && Boolean(item.refs) && !!item.refs?.length;
      }) as Array<{ refs: NonNullable<any> }>;
      if (itemsWithRefs.length) {
        for (const item of itemsWithRefs) {
          expect(item.refs).toBeDefined();
          expect(Array.isArray(item.refs)).toBe(true);

          for (const ref of item.refs) {
            expect(ref.range).toBeDefined();
            expect(typeof ref.context).toBe("string");
            // Should have at most 11 lines (5 before + target + 5 after)
            const lines = ref.context!.split(/\r?\n/);
            expect(lines.length).toBeLessThanOrEqual(11);
          }
        }
      }
    });

    it("should respect refContextLines parameter", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "line",
        refContextLines: 2, // More context lines
      });

      const itemsWithRefs = report.impacted.filter((item) => {
        return "refs" in item && Boolean(item.refs) && !!item.refs?.length;
      }) as Array<{ refs: NonNullable<any> }>;
      if (itemsWithRefs.length) {
        for (const item of itemsWithRefs) {
          for (const ref of item.refs) {
            // Should have at most 5 lines (2 before + target + 2 after)
            const lines = ref.context!.split(/\r?\n/);
            expect(lines.length).toBeLessThanOrEqual(5);
          }
        }
      }
    });
  });

  describe("Block context mode", () => {
    it("should include block context snippets when refContext is 'block'", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "block",
        refBlockMaxLines: 10,
      });

      const itemsWithRefs = report.impacted.filter((item) => {
        return "refs" in item && Boolean(item.refs) && !!item.refs?.length;
      }) as Array<{ refs: NonNullable<any> }>;
      if (itemsWithRefs.length) {
        for (const item of itemsWithRefs) {
          expect(item.refs).toBeDefined();

          for (const ref of item.refs) {
            expect(ref.range).toBeDefined();
            expect(typeof ref.context).toBe("string");
            // Should contain a meaningful scoped snippet, either a block or
            // the fallback line window when no enclosing block exists.
            expect(ref.context!).toMatch(/function|export|class|import|const/);
            // Should be limited by max lines
            const lines = ref.context!.split(/\r?\n/);
            expect(lines.length).toBeLessThanOrEqual(10);
          }
        }
      }
    });

    it("should respect refBlockMaxLines parameter and truncate long blocks", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "block",
        refBlockMaxLines: 5, // Small limit
      });

      const itemsWithRefs = report.impacted.filter((item) => {
        return "refs" in item && Boolean(item.refs) && !!item.refs?.length;
      }) as Array<{ refs: NonNullable<any> }>;
      if (itemsWithRefs.length) {
        for (const item of itemsWithRefs) {
          for (const ref of item.refs) {
            const lines = ref.context!.split(/\r?\n/);
            expect(lines.length).toBeLessThanOrEqual(5);
          }
        }
      }
    });
  });

  describe("Integration with maxRefs", () => {
    it("should respect maxRefs limit when collecting contexts", async () => {
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

      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "line",
        maxRefs: 2, // Limit refs
      });

      for (const item of report.impacted) {
        if ("refs" in item && item.refs) {
          expect(item.refs.length).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  describe("Compact report compatibility", () => {
    it("preserves reference context in compact format", async () => {
      const index = await createTestIndex("typescript");
      const diffText = [
        "diff --git a/utils.ts b/utils.ts",
        "index 1234567..abcdef0 100644",
        "--- a/utils.ts",
        "+++ b/utils.ts",
        "@@ -1,3 +1,4 @@",
        " export function helperFunction(): string {",
        '   return "Hello from utils";',
        '+  console.log("added");',
        " }",
        "",
      ].join("\n");
      const report = await analyzeImpactFromDiff(process.cwd() + "/tests/samples/typescript", index, {
        provider: "raw",
        diffText,
        refContext: "line",
        compact: true,
      });
      if (!("files" in report)) {
        throw new Error("Expected compact report");
      }
      expect(report.impacted.flatMap((item) => item.refs ?? [])).not.toHaveLength(0);
    });
  });
});
