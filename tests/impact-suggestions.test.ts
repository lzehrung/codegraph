import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
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
    lcovPaths?: string[];
    coveragePaths?: string[];
    testCommandTemplate?: string;
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
    ...(options?.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
    ...(options?.coveragePaths ? { coveragePaths: options.coveragePaths } : {}),
    ...(options?.testCommandTemplate
      ? { testCommandTemplate: options.testCommandTemplate }
      : {}),
  })) as ImpactReport;
  return report;
}



async function buildReportForRoot(
  root: string,
  diffText: string,
  options?: {
    maxSuggestions?: number;
    configImpactRules?: boolean;
    detectBreakingChanges?: boolean;
    testCoverageSuggestions?: boolean;
    verifyReferences?: boolean;
    lcovPaths?: string[];
    coveragePaths?: string[];
    testCommandTemplate?: string;
  },
): Promise<ImpactReport> {
  const index = await buildProjectIndex(root);
  const report = (await analyzeImpactFromDiff(root, index, {
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
    ...(options?.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
    ...(options?.coveragePaths ? { coveragePaths: options.coveragePaths } : {}),
    ...(options?.testCommandTemplate
      ? { testCommandTemplate: options.testCommandTemplate }
      : {}),
  })) as ImpactReport;
  return report;
}

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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

  it("detects exported function signature arity changes as high-confidence breaking changes", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,7 +1,7 @@
-export function helperFunction(): string {
+export function helperFunction(input: string): string {
   return "helper";
 }
 
 export function anotherHelper(): number {
   return 42;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const breaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("signature changed"),
    );
    expect(breaking).toBeDefined();
    expect(breaking?.confidence).toBe("high");
  });

  it("detects exported default function arity changes", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export default function (input: string): string {
+export default function (input: string, extra: number): string {
   return input;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const breaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "default" &&
        entry.confidence === "high",
    );
    expect(breaking).toBeDefined();
  });

  it("detects exported arrow function signature changes for single-parameter form", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export const helperFunction = input => input;
+export const helperFunction = (input, extra) => input;
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const breaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.confidence === "high",
    );
    expect(breaking).toBeDefined();
  });

  it("handles TS parameter commas in nested types without false arity changes", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export function helperFunction(input: { a: string, b: number }): string {
+export function helperFunction(input: { a: string, b: number, c?: boolean }): string {
   return String(input.a);
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const signatureBreaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("signature changed"),
    );
    expect(signatureBreaking).toBeUndefined();
  });

  it("detects arity changes for exported generic functions", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export function helperFunction<T>(input: T): T {
+export function helperFunction<T>(input: T, fallback: T): T {
   return input;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const signatureBreaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("signature changed") &&
        entry.confidence === "high",
    );
    expect(signatureBreaking).toBeDefined();
  });

  it("does not miscount params when default values use comparison operators", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export function helperFunction(a = x < y ? 1 : 2, b = 0): number {
+export function helperFunction(a = x < y ? 1 : 2, b = 1): number {
   return a + b;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const signatureBreaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("signature changed"),
    );
    expect(signatureBreaking).toBeUndefined();
  });

  it("detects exported symbol rename candidates as medium-confidence breaking changes", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,7 +1,7 @@
-export function helperFunction(): string {
+export function helperRenamed(): string {
   return "helper";
 }
 
 export function anotherHelper(): number {
   return 42;
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const breaking = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("removed or renamed"),
    );
    expect(breaking).toBeDefined();
    expect(breaking?.confidence).toBe("medium");
  });

  it("does not include unrelated rename examples from other hunks", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export function helperFunction(): string {
+export function helperUpdated(): string {
   return "helper";
 }
@@ -10,3 +10,3 @@
-export function olderName(): string {
+export function totallyDifferentName(): string {
   return "x";
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const renameForFirst = (report.suggestions ?? []).find(
      (entry) =>
        entry.kind === "breakingChange" &&
        entry.symbol === "helperFunction" &&
        entry.details?.includes("totallyDifferentName"),
    );
    expect(renameForFirst).toBeUndefined();
  });

  it("deduplicates breaking-change suggestions and keeps highest confidence", async () => {
    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
-export function helperFunction(a: number): string {
+export function helperFunction(a: number, b: string): string {
   return String(a);
 }
`;

    const report = await buildSampleReport(diffText, {
      detectBreakingChanges: true,
      verifyReferences: false,
    });

    const helperBreakings = (report.suggestions ?? []).filter(
      (entry) =>
        entry.kind === "breakingChange" && entry.symbol === "helperFunction",
    );
    expect(helperBreakings).toHaveLength(1);
    expect(helperBreakings[0]?.confidence).toBe("high");
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
    expect(untested?.details?.includes("Candidate tests:")).toBe(true);
  });

  it("uses LCOV coverage to upgrade untested suggestions and includes a test command hint", async () => {
    const lcovPath = path.join(samplePath, "coverage.lcov");
    const lcovText = `TN:\nSF:${path.join(samplePath, "helpers.ts").replace(/\\/g, "/")}\nDA:1,0\nDA:2,0\nend_of_record\n`;
    await fsp.writeFile(lcovPath, lcovText, "utf8");
    try {
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
        lcovPaths: [lcovPath],
      });

      const untested = (report.suggestions ?? []).find(
        (entry) =>
          entry.kind === "untestedChange" && entry.symbol === "helperFunction",
      );
      expect(untested).toBeDefined();
      expect(untested?.confidence).toBe("high");
      expect(untested?.details?.includes("Coverage currently exercises 0/")).toBe(
        true,
      );
      expect(untested?.details?.includes("Suggested command:")).toBe(true);
      expect(untested?.details?.includes("npm run test -- helpers.test.ts.")).toBe(
        false,
      );
    } finally {
      await fsp.rm(lcovPath, { force: true });
    }
  });


  it("adds tsconfig alias blast-radius details when path keys change", async () => {
    const root = await mkTmpDir("dg-impact-tsconfig-");
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["src/shared/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.mkdir(path.join(root, "src", "shared"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "src", "shared", "util.ts"),
      `export const util = 1;
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "src", "main.ts"),
      `import { util } from "@shared/util";
export const run = util;
`,
      "utf8",
    );

    const diffText = `diff --git a/tsconfig.json b/tsconfig.json
index 1111111..2222222 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,7 +1,7 @@
 {
   "compilerOptions": {
     "paths": {
-      "@shared/*": ["src/shared/*"]
+      "@core/*": ["src/shared/*"]
     }
   }
 }
`;
    const report = await buildReportForRoot(root, diffText, {
      verifyReferences: false,
      configImpactRules: true,
    });
    const config = (report.suggestions ?? []).find(
      (entry) => entry.kind === "configImpact",
    );
    expect(config?.details?.includes("@shared/*")).toBe(true);
    expect(config?.details?.includes("main.ts")).toBe(true);
  });

  it("adds semantic config-impact details for build and monorepo tool configs", async () => {
    const viteDiff = `diff --git a/vite.config.ts b/vite.config.ts
index 1111111..2222222 100644
--- a/vite.config.ts
+++ b/vite.config.ts
@@ -1,4 +1,7 @@
 export default {
+  resolve: { alias: { "@app": "./src" } },
+  build: { rollupOptions: { input: "./src/main.ts", output: { dir: "dist2" } } },
+  plugins: [],
 };
`;
    const viteReport = await buildSampleReport(viteDiff, {
      verifyReferences: false,
      configImpactRules: true,
    });
    const viteConfig = (viteReport.suggestions ?? []).find(
      (entry) => entry.kind === "configImpact",
    );
    expect(viteConfig?.details?.toLowerCase().includes("entrypoint")).toBe(true);

    const nxDiff = `diff --git a/nx.json b/nx.json
index 1111111..2222222 100644
--- a/nx.json
+++ b/nx.json
@@ -1,3 +1,7 @@
 {
+  "tasksRunnerOptions": {},
+  "targetDefaults": {
+    "build": { "dependsOn": ["^build"], "outputs": ["dist"] }
+  },
 }
`;
    const nxReport = await buildSampleReport(nxDiff, {
      verifyReferences: false,
      configImpactRules: true,
    });
    const nxConfig = (nxReport.suggestions ?? []).find(
      (entry) => entry.kind === "configImpact",
    );
    expect(nxConfig?.details?.toLowerCase().includes("monorepo")).toBe(true);
  });

  it("ingests Istanbul JSON coverage for untested-change suggestions", async () => {
    const coveragePath = path.join(samplePath, "coverage-final.json");
    const helperPath = path.join(samplePath, "helpers.ts").replace(/\\/g, "/");
    const jsonCoverage = {
      [helperPath]: {
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 2, column: 10 } },
        },
        s: {
          "0": 0,
        },
      },
    };
    await fsp.writeFile(coveragePath, JSON.stringify(jsonCoverage), "utf8");
    try {
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
        coveragePaths: [coveragePath],
      });
      const untested = (report.suggestions ?? []).find(
        (entry) => entry.kind === "untestedChange" && entry.symbol === "helperFunction",
      );
      expect(untested?.details?.includes("Coverage currently exercises 0/")).toBe(
        true,
      );
    } finally {
      await fsp.rm(coveragePath, { force: true });
    }
  });

  it("calibrates confidence with fan-in and exported symbol signals and honors test command template", async () => {
    const root = await mkTmpDir("dg-impact-confidence-");
    await fsp.writeFile(
      path.join(root, "helpers.ts"),
      `export function helperFunction(): string {
  return "helper";
}
`,
      "utf8",
    );
    await fsp.writeFile(path.join(root, "a.ts"), `import { helperFunction } from "./helpers";
export const a = helperFunction();
`, "utf8");
    await fsp.writeFile(path.join(root, "b.ts"), `import { helperFunction } from "./helpers";
export const b = helperFunction();
`, "utf8");
    await fsp.writeFile(path.join(root, "c.ts"), `import { helperFunction } from "./helpers";
export const c = helperFunction();
`, "utf8");

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
    const report = await buildReportForRoot(root, diffText, {
      testCoverageSuggestions: true,
      testCommandTemplate: "pnpm vitest {files}",
    });
    const untested = (report.suggestions ?? []).find(
      (entry) => entry.kind === "untestedChange" && entry.symbol === "helperFunction",
    );
    expect(untested?.confidence).toBe("high");
    expect(untested?.details?.includes("Suggested command: pnpm vitest")).toBe(
      true,
    );
  });
});
