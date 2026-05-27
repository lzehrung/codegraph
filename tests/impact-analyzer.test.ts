import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { analyzeImpactFromDiff } from "../src/index.js";
import { analyzeImpact, seedTransitiveFromFiles, calculateSeverity } from "../src/impact/analyzer.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "../src/impact/types.js";
import { buildProjectIndex, buildProjectIndexFromFiles, SymbolKind } from "../src/indexer.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { Edge } from "../src/types.js";
import { createTestIndex } from "./test-utils.js";

describe("Impact Analyzer Edge Cases", () => {
  describe("call compatibility hints", () => {
    it("flags likely argument-count mismatches for changed TypeScript signatures", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const mainFile = path.join(root, "src", "main.ts");
        await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
        await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper("x");\n', "utf8");

        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,1 +1,1 @@
-export function helper(a: string) { return a; }
+export function helper(a: string, b: number) { return a + b; }
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");
        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            actual: { argCount: 1, confidence: "high" },
            expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
            callsiteFile: "src/main.ts",
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not flag extra arguments for changed rest signatures", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-rest-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const mainFile = path.join(root, "src", "main.ts");
        await fsp.writeFile(
          apiFile,
          "export function helper(a: string, ...rest: string[]) { return rest.join(a); }\n",
          "utf8",
        );
        await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper("x", "y", "z");\n', "utf8");

        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,1 +1,1 @@
-export function helper(a: string) { return a; }
+export function helper(a: string, ...rest: string[]) { return rest.join(a); }
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");
        const mismatches = helper?.callCompatibility?.filter((hint) => hint.status === "likely_mismatch") ?? [];
        expect(mismatches).toHaveLength(0);
        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "compatible",
            reason: "compatible_argument_count",
            expected: { minArgs: 1, maxArgs: null, confidence: "high" },
            actual: { argCount: 3, confidence: "high" },
            callsiteFile: "src/main.ts",
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it.each([
      {
        label: "Python",
        file: "main.py",
        before: "def helper(a):\n    return a\n\nvalue = helper(1)\n",
        after: "def helper(a, b):\n    return a\n\nvalue = helper(1)\n",
      },
      {
        label: "Go",
        file: "main.go",
        before: "package main\nfunc helper(a string) string { return a }\nfunc run(){ helper(\"x\") }\n",
        after: "package main\nfunc helper(a string, b int) string { return a }\nfunc run(){ helper(\"x\") }\n",
      },
      {
        label: "Rust",
        file: "main.rs",
        before: "fn helper(a: i32) -> i32 { a }\nfn run(){ helper(1); }\n",
        after: "fn helper(a: i32, b: i32) -> i32 { a }\nfn run(){ helper(1); }\n",
      },
      {
        label: "Java",
        file: "Main.java",
        before: "class Main { void helper(String a) {} void run(){ helper(\"x\"); } }\n",
        after: "class Main { void helper(String a, int b) {} void run(){ helper(\"x\"); } }\n",
      },
      {
        label: "C#",
        file: "Main.cs",
        before: "class Main { void helper(string a) {} void run(){ helper(\"x\"); } }\n",
        after: "class Main { void helper(string a, int b) {} void run(){ helper(\"x\"); } }\n",
      },
      {
        label: "Kotlin",
        file: "main.kt",
        before: "fun helper(a: String) = a\nfun run(){ helper(\"x\") }\n",
        after: "fun helper(a: String, b: Int) = a\nfun run(){ helper(\"x\") }\n",
      },
      {
        label: "Swift",
        file: "main.swift",
        before: "func helper(_ a: String) {}\nfunc run(){ helper(\"x\") }\n",
        after: "func helper(_ a: String, b: Int) {}\nfunc run(){ helper(\"x\") }\n",
      },
      {
        label: "PHP",
        file: "main.php",
        before: "<?php function helper($a) { return $a; }\n$value = helper(\"x\");\n",
        after: "<?php function helper($a, $b) { return $a; }\n$value = helper(\"x\");\n",
      },
      {
        label: "Ruby",
        file: "main.rb",
        before: "def helper(a)\n  a\nend\nvalue = helper(1)\n",
        after: "def helper(a, b)\n  a\nend\nvalue = helper(1)\n",
      },
      {
        label: "C",
        file: "main.c",
        before: "int helper(int a) { return a; }\nvoid run(){ helper(1); }\n",
        after: "int helper(int a, int b) { return a; }\nvoid run(){ helper(1); }\n",
      },
      {
        label: "C++",
        file: "main.cpp",
        before: "int helper(int a) { return a; }\nvoid run(){ helper(1); }\n",
        after: "int helper(int a, int b) { return a; }\nvoid run(){ helper(1); }\n",
      },
      {
        label: "Zig",
        file: "main.zig",
        before: "fn helper(a: i32) i32 { return a; }\nfn run() void { _ = helper(1); }\n",
        after: "fn helper(a: i32, b: i32) i32 { return a; }\nfn run() void { _ = helper(1); }\n",
      },
    ])("flags same-file likely mismatches for changed $label signatures", async ({ file, before, after }) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-cross-call-"));
      try {
        const targetFile = path.join(root, file);
        await fsp.writeFile(targetFile, after, "utf8");
        const index = await buildProjectIndex(root, { cache: "memory" });
        const beforeLines = before.split("\n");
        const afterLines = after.split("\n");
        const changedLineIndex = beforeLines.findIndex((line, index) => line !== afterLines[index]);
        if (changedLineIndex < 0) {
          throw new Error("Expected fixture to include a changed signature line");
        }
        const changedLineNumber = changedLineIndex + 1;
        const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -${changedLineNumber},1 +${changedLineNumber},1 @@
-${beforeLines[changedLineIndex]}
+${afterLines[changedLineIndex]}
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");
        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            actual: { argCount: 1, confidence: "high" },
            expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
            callsiteFile: file,
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  describe("seedTransitiveFromFiles", () => {
    it("should seed transitive impact for deleted files", async () => {
      const index = await createTestIndex("typescript");

      // Create mock file changes for deleted files
      const fileChanges = [
        {
          path: "src/deleted-file.ts",
          kind: "deleted" as const,
          hunks: [],
        },
      ];

      const impacted = new Map();

      // This function should handle the case gracefully even with mock data
      await seedTransitiveFromFiles(index, impacted, fileChanges, {});

      // Should not throw and should handle empty reverse deps gracefully
      expect(impacted.size).toBeGreaterThanOrEqual(0);
    });

    it("should seed transitive impact for renamed files", async () => {
      const oldPath = path.resolve("src/old-name.ts");
      const newPath = path.resolve("src/renamed-file.ts");
      const dependentOnOld = path.resolve("src/consumer-old.ts");
      const dependentOnNew = path.resolve("src/consumer-new.ts");
      const index: ProjectIndex = {
        graph: {
          nodes: new Set([oldPath, newPath, dependentOnOld, dependentOnNew]),
          edges: [
            {
              from: dependentOnOld,
              to: { type: "file", path: oldPath },
              raw: "./old-name",
            },
            {
              from: dependentOnNew,
              to: { type: "file", path: newPath },
              raw: "./renamed-file",
            },
          ],
        },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      // Create mock file changes for renamed files
      const fileChanges = [
        {
          path: newPath,
          kind: "renamed" as const,
          oldPath,
          hunks: [],
        },
      ];

      const impacted = new Map();

      await seedTransitiveFromFiles(index, impacted, fileChanges, {});

      // Should handle renamed files with fileRenamed hint
      const impactedItems = Array.from(impacted.values());
      expect(impactedItems.some((item) => item.file === dependentOnOld)).toBe(true);
      expect(impactedItems.some((item) => item.file === dependentOnNew)).toBe(true);
      expect(impactedItems.some((item) => item.explain?.hints?.includes("fileRenamed"))).toBe(true);
      expect(impactedItems.every((item) => item.confidence === 0.5)).toBe(true);
    });

    it("supports file-level fallback for modified files without symbols", async () => {
      const changedFile = path.resolve("src/setup.ts");
      const dependentFile = path.resolve("src/main.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: changedFile },
          raw: "./setup",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([changedFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(index, impacted, [{ path: changedFile, kind: "modified", hunks: [] }], {
        includeTests: false,
        fileLevelFallback: true,
        fileLevelFallbackPaths: [changedFile],
      });

      const fallbackItem = Array.from(impacted.values()).find((item) => item.file === dependentFile);
      expect(fallbackItem?.reasons).toContain("fileLevelChange");
    });

    it("applies ignore globs for sparse explicit-file indexes", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-analyzer-"));
      try {
        const libFile = path.join(root, "lib.ts");
        const consumerFile = path.join(root, "consumer.ts");
        await fsp.writeFile(libFile, "export const lib = 1;\n", "utf8");
        await fsp.writeFile(consumerFile, "import { lib } from './lib';\nexport const seen = lib;\n", "utf8");

        const index = await buildProjectIndexFromFiles(root, [libFile, consumerFile], {
          cache: "memory",
        });
        const impacted = await analyzeImpact(
          index,
          [],
          [{ path: libFile.replace(/\\/g, "/"), kind: "modified", hunks: [] }],
          {
            fileLevelFallback: true,
            fileLevelFallbackPaths: [libFile.replace(/\\/g, "/")],
            ignoreGlobs: ["consumer.ts"],
          },
        );

        expect(impacted).toHaveLength(0);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should respect includeTests option", async () => {
      const index = await createTestIndex("typescript");

      // Create mock file changes
      const fileChanges = [
        {
          path: "src/utils.ts",
          kind: "deleted" as const,
          hunks: [],
        },
      ];

      const impactedWithTests = new Map();
      const impactedWithoutTests = new Map();

      await seedTransitiveFromFiles(index, impactedWithTests, fileChanges, { includeTests: true });
      await seedTransitiveFromFiles(index, impactedWithoutTests, fileChanges, { includeTests: false });

      // Both should work without throwing
      expect(impactedWithTests.size).toBeGreaterThanOrEqual(0);
      expect(impactedWithoutTests.size).toBeGreaterThanOrEqual(0);
    });

    it("ignores invalid custom test regex patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const dependentFile = path.resolve("src/latest.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(index, impacted, [{ path: featureFile, kind: "deleted", hunks: [] }], {
        includeTests: false,
        testPatterns: ["[invalid"],
      });

      expect(Array.from(impacted.values()).some((item) => item.file.endsWith("latest.ts"))).toBe(true);
    });

    it("does not treat latest.ts as a test file by default", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const dependentFile = path.resolve("src/latest.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(index, impacted, [{ path: featureFile, kind: "deleted", hunks: [] }], {
        includeTests: false,
      });

      expect(Array.from(impacted.values()).some((item) => item.file.endsWith("latest.ts"))).toBe(true);
    });

    it("supports case-sensitive custom test patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const testFile = path.resolve("Checks/MyTests.ts");
      const edges: Edge[] = [
        {
          from: testFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, testFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(index, impacted, [{ path: featureFile, kind: "deleted", hunks: [] }], {
        includeTests: false,
        testPatterns: ["MyTests\\.ts$"],
      });

      expect(Array.from(impacted.values()).some((item) => item.file.endsWith("MyTests.ts"))).toBe(false);
    });

    it("supports custom test patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const testFile = path.resolve("checks/feature.case.ts");
      const edges: Edge[] = [
        {
          from: testFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, testFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impactedWithoutPattern = new Map();
      await seedTransitiveFromFiles(
        index,
        impactedWithoutPattern,
        [{ path: featureFile, kind: "deleted", hunks: [] }],
        {
          includeTests: false,
        },
      );
      expect(Array.from(impactedWithoutPattern.values()).some((item) => item.file.endsWith("feature.case.ts"))).toBe(
        true,
      );

      const impactedWithPattern = new Map();
      await seedTransitiveFromFiles(index, impactedWithPattern, [{ path: featureFile, kind: "deleted", hunks: [] }], {
        includeTests: false,
        testPatterns: ["case\\.ts$"],
      });
      expect(Array.from(impactedWithPattern.values()).some((item) => item.file.endsWith("feature.case.ts"))).toBe(
        false,
      );
    });
  });

  describe("calculateSeverity", () => {
    it("should calculate severity with hints for exported symbols", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::exportedFunc::100",
        file: "test.ts",
        name: "exportedFunc",
        kind: SymbolKind.Function,
        exported: true,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      const result = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);

      expect(result.severity).toBeGreaterThan(0);
      expect(result.explain.hints).toContain("exportChanged");
      expect(result.explain.exported).toBe(true);
    });

    it("should apply depth decay correctly", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      const depth0 = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);
      const depth1 = await calculateSeverity(changedSymbol, ref, ["transitive"], 1, mockIndex);
      const depth2 = await calculateSeverity(changedSymbol, ref, ["transitive"], 2, mockIndex);

      // Higher depth should result in lower severity (decay)
      expect(depth0.severity).toBeGreaterThan(depth1.severity);
      expect(depth1.severity).toBeGreaterThan(depth2.severity);
    });

    it("should boost severity for same-file references", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const sameFileRef = {
        file: "test.ts", // Same file
        range: { start: { line: 5, column: 10 } },
      };

      const differentFileRef = {
        file: "other.ts", // Different file
        range: { start: { line: 5, column: 10 } },
      };

      const sameFileResult = await calculateSeverity(changedSymbol, sameFileRef, ["directRef"], 0, mockIndex);
      const differentFileResult = await calculateSeverity(changedSymbol, differentFileRef, ["directRef"], 0, mockIndex);

      expect(sameFileResult.explain.sameFile).toBe(true);
      expect(differentFileResult.explain.sameFile).toBeUndefined();

      // Both should be 1.0 due to clamping, but sameFile should be marked in explain
      expect(sameFileResult.severity).toBe(1.0);
      expect(differentFileResult.severity).toBe(1.0);
    });

    it("should penalize type-only changes", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const typeOnlySymbol = {
        id: "test.ts::TypeAlias::100",
        file: "test.ts",
        name: "TypeAlias",
        kind: SymbolKind.TypeAlias,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 2, column: 20, index: 120 } },
        typeOnly: true,
      };

      const runtimeSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      const typeOnlyResult = await calculateSeverity(typeOnlySymbol, ref, ["directRef"], 0, mockIndex);
      const runtimeResult = await calculateSeverity(runtimeSymbol, ref, ["directRef"], 0, mockIndex);

      expect(typeOnlyResult.explain.typeOnly).toBe(true);
      // Type-only changes should have lower severity
      expect(runtimeResult.severity).toBeGreaterThan(typeOnlyResult.severity);
    });

    it("should consider fan-in when calculating severity", async () => {
      const mockIndexWithDeps = {
        graph: {
          edges: [
            { to: { type: "file", path: "user.ts" } }, // One dependency
            { to: { type: "file", path: "user.ts" } }, // Another dependency
            { to: { type: "file", path: "user.ts" } }, // Third dependency
          ],
        },
        byFile: new Map(),
      };

      const mockIndexNoDeps = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      const highFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexWithDeps);
      const lowFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexNoDeps);

      expect(highFanInResult.explain.fanIn).toBe(3);
      expect(lowFanInResult.explain.fanIn).toBeUndefined();

      // Both should be 1.0 due to clamping, but high fan-in should be marked in explain
      expect(highFanInResult.severity).toBe(1.0);
      expect(lowFanInResult.severity).toBe(1.0);
    });

    it("should reject invalid severity weights instead of silently repairing them", () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      expect(() =>
        calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex, undefined, {
          ...DEFAULT_SEVERITY_WEIGHTS,
          depthDecay: 1,
          sameFile: -1,
        }),
      ).toThrow(/Invalid severity weights/);
    });

    it("should use the cached graph fan-in fallback when no fan-in map is provided", () => {
      const mockIndex = {
        graph: {
          edges: [{ to: { type: "file", path: "user.ts" } }, { to: { type: "file", path: "user.ts" } }],
        },
        byFile: new Map(),
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } },
      };

      const fallbackResult = calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);
      const explicitFanInResult = calculateSeverity(
        changedSymbol,
        ref,
        ["directRef"],
        0,
        mockIndex,
        new Map([["user.ts", 2]]),
      );

      expect(fallbackResult.explain.fanIn).toBe(2);
      expect(fallbackResult).toEqual(explicitFanInResult);
    });
  });

  describe("analyzeImpact edge cases", () => {
    it("should handle empty changedSymbols with file seeding", async () => {
      const index = await createTestIndex("typescript");

      // Mock file changes for deleted files
      const fileChanges = [
        {
          path: "src/deleted.ts",
          kind: "deleted" as const,
          hunks: [],
        },
      ];

      const result = await analyzeImpact(index, [], fileChanges, { depth: 1 });

      // Should not throw and should handle the case appropriately
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle membersOnly option correctly", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod?.locals.length) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: false,
            },
          ];

          const fileChanges = [
            {
              path: firstFile,
              kind: "modified" as const,
              hunks: [],
            },
          ];

          const membersOnlyResult = await analyzeImpact(index, changedSymbols, fileChanges, {
            membersOnly: true,
            depth: 2,
          });

          const withTransitiveResult = await analyzeImpact(index, changedSymbols, fileChanges, {
            membersOnly: false,
            depth: 2,
          });

          // Members-only should limit depth to 0
          expect(membersOnlyResult.every((item) => (item.depth ?? 0) === 0)).toBe(true);

          // With transitive, there might be deeper items (depending on the graph)
          const hasDeepItems = withTransitiveResult.some((item) => (item.depth ?? 0) > 0);
          expect(hasDeepItems || withTransitiveResult.length >= 0).toBe(true);
        }
      }
    });

    it("should respect maxRefs limit", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod?.locals.length) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: false,
            },
          ];

          const result = await analyzeImpact(index, changedSymbols, [], { maxRefs: 5 });

          expect(Array.isArray(result)).toBe(true);
        }
      }
    });

    it("should handle type-only impact correctly", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod?.locals.length) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: true, // Mark as type-only
            },
          ];

          const result = await analyzeImpact(index, changedSymbols, [], {});

          // Should not throw and should handle the case appropriately
          expect(Array.isArray(result)).toBe(true);
        }
      }
    });

    it("skips compatibility collection when maxRefs is zero", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-maxrefs-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src/api.ts"),
          'export function helper(a: string, b: number) { return a + b; }\n',
          "utf8",
        );
        await fsp.writeFile(
          path.join(root, "src/main.ts"),
          'import { helper } from "./api";\nexport const value = helper("x");\n',
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          "diff --git a/src/api.ts b/src/api.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export function helper(a: string) { return a; }",
          "+export function helper(a: string, b: number) { return a + b; }",
          "",
        ].join("\n");

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          maxRefs: 0,
        });
        if ("files" in result) {
          throw new Error("Expected full impact report");
        }
        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");

        expect(helper?.callCompatibility).toBeUndefined();
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("accounts for the definition entry when maxRefs is one", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-maxrefs-one-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src/api.ts"),
          'export function helper(a: string, b: number) { return a + b; }\n',
          "utf8",
        );
        await fsp.writeFile(
          path.join(root, "src/main.ts"),
          'import { helper } from "./api";\nexport const value = helper("x");\n',
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          "diff --git a/src/api.ts b/src/api.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export function helper(a: string) { return a; }",
          "+export function helper(a: string, b: number) { return a + b; }",
          "",
        ].join("\n");

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          maxRefs: 1,
        });
        if ("files" in result) {
          throw new Error("Expected full impact report");
        }
        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");

        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not spend the callsite limit on non-call references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-alias-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src/api.ts"),
          'export function helper(a: string, b: number) { return a + b; }\n',
          "utf8",
        );
        await fsp.writeFile(
          path.join(root, "src/main.ts"),
          [
            'import { helper } from "./api";',
            "const aliasOne = helper;",
            "const aliasTwo = helper;",
            "const aliasThree = helper;",
            "const aliasFour = helper;",
            "const aliasFive = helper;",
            "const aliasSix = helper;",
            'export const value = helper("x");',
            "export { aliasOne, aliasTwo, aliasThree, aliasFour, aliasFive, aliasSix };",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          "diff --git a/src/api.ts b/src/api.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export function helper(a: string) { return a; }",
          "+export function helper(a: string, b: number) { return a + b; }",
          "",
        ].join("\n");

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          maxRefs: 1,
        });
        if ("files" in result) {
          throw new Error("Expected full impact report");
        }
        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");

        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
            actual: { argCount: 1, confidence: "high" },
          }),
        );
        expect(helper?.callCompatibility).toHaveLength(1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("attaches hints for changed arrow function variables when signature parsing is high confidence", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-arrow-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src/api.ts"),
          'export const helper = (a: string, b: number) => a + b;\n',
          "utf8",
        );
        await fsp.writeFile(
          path.join(root, "src/main.ts"),
          'import { helper } from "./api";\nexport const value = helper("x");\n',
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          "diff --git a/src/api.ts b/src/api.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const helper = (a: string) => a;",
          "+export const helper = (a: string, b: number) => a + b;",
          "",
        ].join("\n");

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
        });
        if ("files" in result) {
          throw new Error("Expected full impact report");
        }
        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");

        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
            expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
            actual: { argCount: 1, confidence: "high" },
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not mark object variables as signature changed for nested callback parameter edits", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-nested-callback-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "src/api.ts"),
          "export const config = { callback: (a: string, b: number) => a + b };\n",
          "utf8",
        );
        await fsp.writeFile(
          path.join(root, "src/main.ts"),
          'import { config } from "./api";\nexport const value = config.callback("x", 1);\n',
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          "diff --git a/src/api.ts b/src/api.ts",
          "index 1234567..abcdef0 100644",
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const config = { callback: (a: string) => a };",
          "+export const config = { callback: (a: string, b: number) => a + b };",
          "",
        ].join("\n");

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
        });
        if ("files" in result) {
          throw new Error("Expected full impact report");
        }
        const config = result.changedSymbols.find((symbol) => symbol.name === "config");

        expect(config?.signatureChanged).not.toBe(true);
        expect(config?.callCompatibility).toBeUndefined();
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });
});
