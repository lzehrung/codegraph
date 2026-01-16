import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import type { ImpactReport } from "../src/impact/types.js";
import { buildProjectIndex } from "../src/index.js";

describe("Impact Suggestions", () => {
  it("detects missing imports, exports, and declarations in changed lines", async () => {
    const samplePath = path.resolve(
      process.cwd(),
      "tests",
      "samples",
      "impact-suggestions",
    );
    const index = await buildProjectIndex(samplePath);

    const diffText = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -1,5 +1,7 @@
 import { helperFunction } from "./helpers";
+import { missingExport } from "./helpers";
 
 const result = helperFunction();
+const missingImportResult = anotherHelper();
+const missingDeclarationResult = undeclaredFunction();
`;

    const report = (await analyzeImpactFromDiff(samplePath, index, {
      provider: "raw",
      diffText,
      verifyReferences: true,
    })) as ImpactReport;

    const suggestions = report.suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);

    const missingImport = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingImport" &&
        suggestion.symbol === "anotherHelper" &&
        suggestion.relatedFile === "helpers.ts",
    );
    expect(missingImport).toBeDefined();

    const missingExport = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingExport" &&
        suggestion.symbol === "missingExport" &&
        suggestion.relatedFile === "helpers.ts",
    );
    expect(missingExport).toBeDefined();

    const missingDeclaration = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingDeclaration" &&
        suggestion.symbol === "undeclaredFunction",
    );
    expect(missingDeclaration).toBeDefined();
  });

  it("returns no suggestions when changed lines are valid", async () => {
    const samplePath = path.resolve(
      process.cwd(),
      "tests",
      "samples",
      "impact-suggestions",
    );
    const index = await buildProjectIndex(samplePath);

    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,4 @@
 export function helperFunction(): string {
   return "helper";
 }
+// harmless change
`;

    const report = (await analyzeImpactFromDiff(samplePath, index, {
      provider: "raw",
      diffText,
      verifyReferences: true,
    })) as ImpactReport;

    expect(report.suggestions ?? []).toHaveLength(0);
  });

  it("respects maxSuggestions limits", async () => {
    const samplePath = path.resolve(
      process.cwd(),
      "tests",
      "samples",
      "impact-suggestions",
    );
    const index = await buildProjectIndex(samplePath);

    const diffText = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -1,5 +1,7 @@
 import { helperFunction } from "./helpers";
+import { missingExport } from "./helpers";
 
 const result = helperFunction();
+const missingImportResult = anotherHelper();
+const missingDeclarationResult = undeclaredFunction();
`;

    const report = (await analyzeImpactFromDiff(samplePath, index, {
      provider: "raw",
      diffText,
      verifyReferences: true,
      maxSuggestions: 1,
    })) as ImpactReport;

    expect(report.suggestions ?? []).toHaveLength(1);
  });
});
