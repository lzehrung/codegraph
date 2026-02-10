import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import type { ImpactReport } from "../src/impact/types.js";
import { buildProjectIndex } from "../src/index.js";

const samplePath = path.resolve(
  process.cwd(),
  "tests",
  "samples",
  "impact-suggestions",
);

async function buildSampleReport(
  diffText: string,
  options?: {
    maxSuggestions?: number;
    configImpactRules?: boolean;
    detectBreakingChanges?: boolean;
    testCoverageSuggestions?: boolean;
    verifyReferences?: boolean;
  },
): Promise<ImpactReport> {
  const index = await buildProjectIndex(samplePath);
  const report = (await analyzeImpactFromDiff(samplePath, index, {
    provider: "raw",
    diffText,
    verifyReferences: options?.verifyReferences ?? true,
    ...(options?.maxSuggestions !== undefined
      ? { maxSuggestions: options.maxSuggestions }
      : {}),
    ...(options?.configImpactRules ? { configImpactRules: true } : {}),
    ...(options?.detectBreakingChanges ? { detectBreakingChanges: true } : {}),
    ...(options?.testCoverageSuggestions
      ? { testCoverageSuggestions: true }
      : {}),
  })) as ImpactReport;
  return report;
}

describe("Impact Suggestions", () => {
  it("detects missing imports, exports, and declarations in changed lines", async () => {
    const diffText = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -1,5 +1,8 @@
 import { helperFunction } from "./helpers";
+import { missingExport } from "./helpers";
 
 const result = helperFunction();
+const missingImportResult = anotherHelper();
+const sharedUtilResult = sharedUtil();
+const missingDeclarationResult = undeclaredFunction();
`;

    const report = await buildSampleReport(diffText);

    const suggestions = report.suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);

    const missingImport = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingImport" &&
        suggestion.symbol === "anotherHelper" &&
        suggestion.relatedFile === "helpers.ts",
    );
    expect(missingImport).toBeDefined();
    expect(missingImport?.confidence).toBe("high");

    const missingExport = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingExport" &&
        suggestion.symbol === "missingExport" &&
        suggestion.relatedFile === "helpers.ts",
    );
    expect(missingExport).toBeDefined();
    expect(missingExport?.confidence).toBe("medium");

    const sharedUtilImport = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingImport" &&
        suggestion.symbol === "sharedUtil",
    );
    expect(sharedUtilImport).toBeDefined();
    expect(sharedUtilImport?.confidence).toBe("low");

    const missingDeclaration = suggestions.find(
      (suggestion) =>
        suggestion.kind === "missingDeclaration" &&
        suggestion.symbol === "undeclaredFunction",
    );
    expect(missingDeclaration).toBeDefined();
    expect(missingDeclaration?.confidence).toBe("medium");
  });

  it("returns no suggestions when changed lines are valid", async () => {
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

    const report = await buildSampleReport(diffText);

    expect(report.suggestions ?? []).toHaveLength(0);
  });

  it("respects maxSuggestions limits", async () => {
    const diffText = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -1,5 +1,8 @@
 import { helperFunction } from "./helpers";
+import { missingExport } from "./helpers";
 
 const result = helperFunction();
+const missingImportResult = anotherHelper();
+const sharedUtilResult = sharedUtil();
+const missingDeclarationResult = undeclaredFunction();
`;

    const report = await buildSampleReport(diffText, { maxSuggestions: 1 });

    expect(report.suggestions ?? []).toHaveLength(1);
  });

  it("adds config-impact suggestions for changed config files", async () => {
    const diffText = `diff --git a/tsconfig.json b/tsconfig.json
index 1111111..2222222 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,5 +1,5 @@
 {
-  "compilerOptions": { "strict": false }
+  "compilerOptions": { "strict": true }
 }
`;

    const report = await buildSampleReport(diffText, {
      verifyReferences: false,
      configImpactRules: true,
    });
    const suggestions = report.suggestions ?? [];
    const config = suggestions.find((entry) => entry.kind === "configImpact");
    expect(config).toBeDefined();
    expect(config?.confidence).toBe("high");
  });

  it("adds semantic config-impact details for package dependency changes", async () => {
    const diffText = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,9 @@
 {
+  "dependencies": {
+    "left-pad": "1.3.0"
+  }
 }
`;

    const report = await buildSampleReport(diffText, {
      verifyReferences: false,
      configImpactRules: true,
    });

    const config = (report.suggestions ?? []).find(
      (entry) => entry.kind === "configImpact",
    );
    expect(config).toBeDefined();
    expect(config?.details?.toLowerCase().includes("dependency")).toBe(true);
  });

  it("adds breaking-change suggestions when exported symbol overlaps removed lines", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,7 +1,7 @@
 export function helperFunction(): string {
-  return "helper";
+  return "helper-updated";
 }
 
 export function anotherHelper(): number {
   return 42;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
    });
    const suggestions = report.suggestions ?? [];
    const breaking = suggestions.find(
      (entry) => entry.kind === "breakingChange",
    );
    expect(breaking).toBeDefined();
  });

  it("adds untested-change suggestions when changed symbols have no test references", async () => {
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

    const report = await buildSampleReport(diffText, {
      testCoverageSuggestions: true,
    });
    const suggestions = report.suggestions ?? [];
    const untested = suggestions.find(
      (entry) =>
        entry.kind === "untestedChange" && entry.symbol === "helperFunction",
    );
    expect(untested).toBeDefined();
    expect(untested?.details?.includes("Consider adding or updating tests")).toBe(
      true,
    );
  });
});
