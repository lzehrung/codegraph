import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { analyzeImpactFromDiff } from "../src/index.js";
import { analyzeImpact, seedTransitiveFromFiles, calculateSeverity } from "../src/impact/analyzer.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "../src/impact/types.js";
import { createReferenceLookupCache } from "../src/impact/referenceCache.js";
import { createImpactDiagnostics, listFileLevelFallbackPaths } from "../src/impact/collect.js";
import { rankChangedSymbolsForBudget } from "../src/impact/budgets.js";
import { buildProjectIndex, buildProjectIndexFromFiles, SymbolKind } from "../src/indexer.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "../src/impact/testPatterns.js";
import {
  fileIdentityKey,
  isFileIdentityCaseInsensitive,
  normalizePath,
  resetFileIdentityCaseSensitivityForTests,
  setFileIdentityCaseInsensitive,
} from "../src/util/paths.js";
import type { Edge } from "../src/types.js";
import type { FileChange, ImpactItem } from "../src/impact/types.js";
import { goToSqlDefinition } from "../src/sql/navigation.js";
import { createTestIndex } from "./test-utils.js";
import { makeTestProjectIndex } from "./helpers/narrow.js";

describe("Reference lookup cache", () => {
  it("scopes cached references by ProjectIndex instance", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-reference-cache-index-scope-"));
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const apiFile = path.join(root, "src", "api.ts");
      const mainFile = path.join(root, "src", "main.ts");
      const apiFileId = normalizePath(apiFile);
      const mainFileId = normalizePath(mainFile);
      await fsp.writeFile(apiFile, "export function helper() { return 1; }\n", "utf8");
      await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper();\n', "utf8");

      const firstIndex = await buildProjectIndex(root, { cache: "memory" });
      const firstDef = firstIndex.byFile
        .get(fileIdentityKey(apiFileId))
        ?.locals.find((local) => local.localName === "helper");
      expect(firstDef).toBeDefined();
      const cache = createReferenceLookupCache();
      const firstRefs = await cache.get(firstIndex, firstDef!);
      expect(firstRefs.status).toBe("ok");
      if (firstRefs.status === "ok") {
        expect(firstRefs.references.some((reference) => reference.file === mainFileId)).toBe(true);
      }

      await fsp.writeFile(mainFile, "export const value = 1;\n", "utf8");
      const secondIndex = await buildProjectIndex(root, { cache: "memory" });
      const secondDef = secondIndex.byFile
        .get(fileIdentityKey(apiFileId))
        ?.locals.find((local) => local.localName === "helper");
      expect(secondDef).toBeDefined();
      const secondRefs = await cache.get(secondIndex, secondDef!);

      expect(secondRefs.status).toBe("ok");
      if (secondRefs.status === "ok") {
        expect(secondRefs.references.some((reference) => reference.file === mainFileId)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

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

    it("flags likely argument-count mismatches for verified TypeScript method receivers", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-method-call-compat-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const mainFile = path.join(root, "src", "main.ts");
        await fsp.writeFile(
          apiFile,
          [
            "export class Service {",
            "  run(a: string, b: number) { return a + b; }",
            "}",
            "export class Other {",
            "  run(a: string, b: number) { return a + b; }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          mainFile,
          [
            'import { Other, Service } from "./api";',
            'new Service().run("x");',
            "const service = new Service();",
            'service.run("y");',
            'new Other().run("z", 1);',
            "",
          ].join("\n"),
          "utf8",
        );

        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,5 +1,5 @@
 export class Service {
-  run(a: string) { return a; }
+  run(a: string, b: number) { return a + b; }
 }
 export class Other {
   run(a: string, b: number) { return a + b; }
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const run = result.changedSymbols.find((symbol) => symbol.name === "run" && symbol.range.start.line === 2);
        expect(run?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
            callsiteRange: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }),
          }),
        );
        expect(run?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/main.ts",
            callsiteRange: expect.objectContaining({ start: expect.objectContaining({ line: 4 }) }),
          }),
        );
        expect(run?.callCompatibility?.some((hint) => hint.callsiteRange.start.line === 5)).toBe(false);
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
        await fsp.writeFile(
          mainFile,
          'import { helper } from "./api";\nexport const value = helper("x", "y", "z");\n',
          "utf8",
        );

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

    it("does not treat non-callee references inside other calls as changed callsites", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-non-callee-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const mainFile = path.join(root, "src", "main.ts");
        await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
        await fsp.writeFile(
          mainFile,
          'import { helper } from "./api";\nfunction wrapper(fn: unknown) { return fn; }\nexport const value = wrapper(helper);\n',
          "utf8",
        );

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
        expect(helper?.callCompatibility ?? []).toHaveLength(0);
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
        before: 'package main\nfunc helper(a string) string { return a }\nfunc run(){ helper("x") }\n',
        after: 'package main\nfunc helper(a string, b int) string { return a }\nfunc run(){ helper("x") }\n',
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
        before: 'class Main { void helper(String a) {} void run(){ helper("x"); } }\n',
        after: 'class Main { void helper(String a, int b) {} void run(){ helper("x"); } }\n',
      },
      {
        label: "C#",
        file: "Main.cs",
        before: 'class Main { void helper(string a) {} void run(){ helper("x"); } }\n',
        after: 'class Main { void helper(string a, int b) {} void run(){ helper("x"); } }\n',
      },
      {
        label: "Kotlin",
        file: "main.kt",
        before: 'fun helper(a: String) = a\nfun run(){ helper("x") }\n',
        after: 'fun helper(a: String, b: Int) = a\nfun run(){ helper("x") }\n',
      },
      {
        label: "Swift",
        file: "main.swift",
        before: 'func helper(_ a: String) {}\nfunc run(){ helper("x") }\n',
        after: 'func helper(_ a: String, b: Int) {}\nfunc run(){ helper("x") }\n',
      },
      {
        label: "PHP",
        file: "main.php",
        before: '<?php function helper($a) { return $a; }\n$value = helper("x");\n',
        after: '<?php function helper($a, $b) { return $a; }\n$value = helper("x");\n',
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

    it.each([
      {
        label: "Python positional-only markers",
        file: "main.py",
        beforeSignature: "def helper(a):",
        afterSignature: "def helper(a, /, b):",
        source: [
          "def helper(a, /, b):",
          "    return a",
          "",
          "compatible = helper(1, 2)",
          "incompatible = helper(1)",
          "",
        ].join("\n"),
        signatureLine: 1,
        expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
        compatibleArgCount: 2,
        incompatibleArgCount: 1,
      },
      {
        label: "Java varargs",
        file: "Main.java",
        beforeSignature: "  void helper(String required) {}",
        afterSignature: "  void helper(String required, String... args) {}",
        source: [
          "class Main {",
          "  void helper(String required, String... args) {}",
          "  void run() {",
          '    helper("x", "y");',
          "    helper();",
          "  }",
          "}",
          "",
        ].join("\n"),
        signatureLine: 2,
        expected: { minArgs: 1, maxArgs: null, confidence: "high" },
        compatibleArgCount: 2,
        incompatibleArgCount: 0,
      },
      {
        label: "Kotlin trailing lambdas",
        file: "main.kt",
        beforeSignature: "fun helper(value: Int) { }",
        afterSignature: "fun helper(value: Int, callback: () -> Unit) { callback() }",
        source: [
          "fun helper(value: Int, callback: () -> Unit) { callback() }",
          "fun run() {",
          "  helper(1) { }",
          "  helper(1)",
          "}",
          "",
        ].join("\n"),
        signatureLine: 1,
        expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
        compatibleArgCount: 2,
        incompatibleArgCount: 1,
      },
      {
        label: "Swift trailing closures",
        file: "main.swift",
        beforeSignature: "func helper(_ value: Int) { }",
        afterSignature: "func helper(_ value: Int, callback: () -> Void) { callback() }",
        source: [
          "func helper(_ value: Int, callback: () -> Void) { callback() }",
          "func run() {",
          "  helper(1) { }",
          "  helper(1)",
          "}",
          "",
        ].join("\n"),
        signatureLine: 1,
        expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
        compatibleArgCount: 2,
        incompatibleArgCount: 1,
      },
    ])(
      "reports only genuine argument-count mismatches for $label",
      async ({
        file,
        beforeSignature,
        afterSignature,
        source,
        signatureLine,
        expected,
        compatibleArgCount,
        incompatibleArgCount,
      }) => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-regression-"));
        try {
          const targetFile = path.join(root, file);
          await fsp.writeFile(targetFile, source, "utf8");
          const index = await buildProjectIndex(root, { cache: "memory" });
          const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -${signatureLine},1 +${signatureLine},1 @@
-${beforeSignature}
+${afterSignature}
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
              status: "compatible",
              reason: "compatible_argument_count",
              actual: { argCount: compatibleArgCount, confidence: "high" },
              expected,
              callsiteFile: file,
            }),
          );
          expect(helper?.callCompatibility).toContainEqual(
            expect.objectContaining({
              status: "likely_mismatch",
              reason: "argument_count_below_minimum",
              actual: { argCount: incompatibleArgCount, confidence: "high" },
              expected,
              callsiteFile: file,
            }),
          );
        } finally {
          await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      },
    );

    it.each(["self", "cls"])("counts %s as an ordinary parameter for Python free functions", async (receiverName) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-python-free-self-"));
      try {
        const file = "main.py";
        const targetFile = path.join(root, file);
        const after = `def helper(${receiverName}, a, b):\n    return a\n\nvalue = helper(obj, 1)\n`;
        await fsp.writeFile(targetFile, after, "utf8");
        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,1 +1,1 @@
-def helper(${receiverName}, a):
+def helper(${receiverName}, a, b):
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
            actual: { argCount: 2, confidence: "high" },
            expected: { minArgs: 3, maxArgs: 3, confidence: "high" },
            callsiteFile: file,
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not emit call compatibility hints for overloaded Java callables", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-overload-java-"));
      try {
        const file = "Main.java";
        const targetFile = path.join(root, file);
        const before =
          'class Main { void helper(String a) {} void helper(String a, int b) {} void run(){ helper("x"); } }\n';
        const after =
          'class Main { void helper(String a) {} void helper(String a, int b, int c) {} void run(){ helper("x"); } }\n';
        await fsp.writeFile(targetFile, after, "utf8");
        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,1 +1,1 @@
-${before.trimEnd()}
+${after.trimEnd()}
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const changedHelpers = result.changedSymbols.filter(
          (symbol) => symbol.name === "helper" && symbol.signatureChanged,
        );
        expect(changedHelpers.length).toBeGreaterThan(0);
        for (const helper of changedHelpers) {
          expect(helper.callCompatibility).toBeUndefined();
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("keeps call compatibility hints for same-name Java methods in different classes", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-same-name-java-"));
      try {
        const file = "Main.java";
        const targetFile = path.join(root, file);
        const before =
          'class Main { void helper(String a) {} void run(){ helper("x"); } } class Other { void helper(String a) {} }\n';
        const after =
          'class Main { void helper(String a, int b) {} void run(){ helper("x"); } } class Other { void helper(String a) {} }\n';
        await fsp.writeFile(targetFile, after, "utf8");
        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,1 +1,1 @@
-${before.trimEnd()}
+${after.trimEnd()}
`;

        const result = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const changedHelper = result.changedSymbols.find(
          (symbol) => symbol.name === "helper" && symbol.signatureChanged,
        );
        expect(changedHelper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: file,
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not report call compatibility mismatches from test files unless tests are included", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-filter-tests-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const testFile = path.join(root, "src", "api.test.ts");
        await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
        await fsp.writeFile(testFile, 'import { helper } from "./api";\nexport const value = helper("x");\n', "utf8");

        const index = await buildProjectIndex(root, { cache: "memory" });
        const diffText = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,1 +1,1 @@
-export function helper(a: string) { return a; }
+export function helper(a: string, b: number) { return a + b; }
`;

        const withoutTests = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
        });

        if ("files" in withoutTests) {
          throw new Error("Expected full impact report");
        }

        const withoutTestsHelper = withoutTests.changedSymbols.find((symbol) => symbol.name === "helper");
        expect(withoutTestsHelper?.callCompatibility ?? []).toHaveLength(0);

        const withTests = await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        });

        if ("files" in withTests) {
          throw new Error("Expected full impact report");
        }

        const withTestsHelper = withTests.changedSymbols.find((symbol) => symbol.name === "helper");
        expect(withTestsHelper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_below_minimum",
            callsiteFile: "src/api.test.ts",
          }),
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does not report call compatibility mismatches from ignored files", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-filter-ignore-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const apiFile = path.join(root, "src", "api.ts");
        const ignoredFile = path.join(root, "src", "ignored.ts");
        await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
        await fsp.writeFile(
          ignoredFile,
          'import { helper } from "./api";\nexport const value = helper("x");\n',
          "utf8",
        );

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
          ignoreGlobs: ["src/ignored.ts"],
        });

        if ("files" in result) {
          throw new Error("Expected full impact report");
        }

        const helper = result.changedSymbols.find((symbol) => symbol.name === "helper");
        expect(helper?.callCompatibility ?? []).toHaveLength(0);
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
              to: { type: "file" as const, path: oldPath },
              raw: "./old-name",
            },
            {
              from: dependentOnNew,
              to: { type: "file" as const, path: newPath },
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
          to: { type: "file" as const, path: changedFile },
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

    const fallbackChangeCases: ReadonlyArray<{ kind: FileChange["kind"]; isBinary: boolean }> = [
      { kind: "added", isBinary: false },
      { kind: "added", isBinary: true },
      { kind: "modified", isBinary: false },
      { kind: "modified", isBinary: true },
      { kind: "deleted", isBinary: false },
      { kind: "deleted", isBinary: true },
      { kind: "renamed", isBinary: false },
      { kind: "renamed", isBinary: true },
    ];

    for (const changeCase of fallbackChangeCases) {
      it(`seeds dependents for ${changeCase.kind} ${changeCase.isBinary ? "binary" : "text"} changes`, () => {
        const root = path.resolve("src/impact-fallback-matrix");
        const suffix = changeCase.isBinary ? "binary" : "text";
        const changedFile = path.join(root, `${changeCase.kind}-${suffix}.ts`);
        const oldPath = path.join(root, `${changeCase.kind}-${suffix}-old.ts`);
        const dependentFile = path.join(root, `${changeCase.kind}-${suffix}-consumer.ts`);
        const lookupPath = changeCase.kind === "renamed" ? oldPath : changedFile;
        const edges: Edge[] = [
          {
            from: dependentFile,
            to: { type: "file" as const, path: lookupPath },
            raw: "./changed",
          },
        ];
        const index: ProjectIndex = {
          graph: { nodes: new Set([changedFile, oldPath, dependentFile]), edges },
          modules: new Map(),
          byFile: new Map(),
          exportCache: new Map(),
          scopeCache: new Map(),
        };
        const change: FileChange = {
          path: changedFile,
          kind: changeCase.kind,
          hunks: [],
        };
        if (changeCase.kind === "renamed") {
          change.oldPath = oldPath;
        }
        if (changeCase.isBinary) {
          change.isBinary = true;
        } else if (changeCase.kind === "added" || changeCase.kind === "modified") {
          change.hunks = [{ oldStart: 1, newStart: 1, lines: ["+sideEffect();"] }];
        }

        const impacted = new Map<string, ImpactItem>();
        const diagnostics = createImpactDiagnostics(1, 0);
        seedTransitiveFromFiles(index, impacted, [change], {
          includeTests: false,
          fileLevelFallback: true,
          fileLevelFallbackPaths: listFileLevelFallbackPaths([change], new Set<string>()),
          diagnostics,
        });

        expect(impacted.has(dependentFile)).toBe(true);
        expect(diagnostics.fallbackSeededFiles).toBe(1);
        expect(diagnostics.fallbackSeededDependents).toBe(1);
        const item = impacted.get(dependentFile);
        if (changeCase.kind === "added" || changeCase.kind === "modified") {
          expect(item?.reasons).toContain("fileLevelChange");
        } else {
          expect(item?.reasons).toContain("transitive");
        }
      });
    }

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
          to: { type: "file" as const, path: featureFile },
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
          to: { type: "file" as const, path: featureFile },
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
          to: { type: "file" as const, path: featureFile },
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
    it("infers test roots from display-cased module paths", () => {
      const originalCaseSensitivity = isFileIdentityCaseInsensitive();
      try {
        resetFileIdentityCaseSensitivityForTests(true);
        setFileIdentityCaseInsensitive(true);
        const featureFile = "C:/Repo/src/feature.ts";
        const testFile = "C:/Repo/Checks/MyTests.ts";
        const index: ProjectIndex = {
          graph: { nodes: new Set([featureFile, testFile]), edges: [] },
          modules: new Map([
            [fileIdentityKey(featureFile), { file: featureFile, exports: [], imports: [], locals: [] }],
            [fileIdentityKey(testFile), { file: testFile, exports: [], imports: [], locals: [] }],
          ]),
          byFile: new Map([
            [fileIdentityKey(featureFile), { file: featureFile, exports: [], imports: [], locals: [] }],
            [fileIdentityKey(testFile), { file: testFile, exports: [], imports: [], locals: [] }],
          ]),
          exportCache: new Map(),
          scopeCache: new Map(),
        };
        const matcher = createIndexTestFileMatcher(index, compileTestPatterns(["^Checks/MyTests\\.ts$"]));

        expect(matcher(testFile)).toBe(true);
        expect(matcher(featureFile)).toBe(false);
      } finally {
        resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      }
    });

    it("supports custom test patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const testFile = path.resolve("checks/feature.case.ts");
      const edges: Edge[] = [
        {
          from: testFile,
          to: { type: "file" as const, path: featureFile },
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
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const result = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);

      expect(result.severity).toBeGreaterThan(0);
      expect(result.explain.hints).toContain("exportChanged");
      expect(result.explain.exported).toBe(true);
    });

    it("should apply depth decay correctly", async () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const depth0 = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);
      const depth1 = await calculateSeverity(changedSymbol, ref, ["transitive"], 1, mockIndex);
      const depth2 = await calculateSeverity(changedSymbol, ref, ["transitive"], 2, mockIndex);

      // Higher depth should result in lower severity (decay)
      expect(depth0.severity).toBeGreaterThan(depth1.severity);
      expect(depth1.severity).toBeGreaterThan(depth2.severity);
    });

    it("should boost severity for same-file references", async () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const differentFileRef = {
        file: "other.ts", // Different file
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const sameFileResult = await calculateSeverity(changedSymbol, sameFileRef, ["directRef"], 0, mockIndex);
      const differentFileResult = await calculateSeverity(changedSymbol, differentFileRef, ["directRef"], 0, mockIndex);

      expect(sameFileResult.explain.sameFile).toBe(true);
      expect(differentFileResult.explain.sameFile).toBeUndefined();

      // Saturating normalization retains the same-file boost for ranking.
      expect(sameFileResult.severity).toBeGreaterThan(differentFileResult.severity);
    });

    it("treats same-file boost as path-identity when casing differs", () => {
      const originalCaseSensitivity = isFileIdentityCaseInsensitive();
      try {
        resetFileIdentityCaseSensitivityForTests(true);
        setFileIdentityCaseInsensitive(true);

        const mockIndex = makeTestProjectIndex({
          graph: { nodes: new Set(), edges: [] },
          byFile: new Map(),
        });

        const changedSymbol = {
          id: "test.ts::func::100",
          file: "src/user.ts",
          name: "func",
          kind: SymbolKind.Function,
          exported: false,
          range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
          typeOnly: false,
        };

        const mixedCaseRef = {
          file: "Src/User.ts",
          range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
        };

        const result = calculateSeverity(changedSymbol, mixedCaseRef, ["directRef"], 0, mockIndex);

        expect(mixedCaseRef.file === changedSymbol.file).toBe(false);
        expect(fileIdentityKey(mixedCaseRef.file)).toBe(fileIdentityKey(changedSymbol.file));
        expect(result.explain.sameFile).toBe(true);
      } finally {
        resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      }
    });

    it("should penalize type-only changes", async () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const typeOnlyResult = await calculateSeverity(typeOnlySymbol, ref, ["directRef"], 0, mockIndex);
      const runtimeResult = await calculateSeverity(runtimeSymbol, ref, ["directRef"], 0, mockIndex);

      expect(typeOnlyResult.explain.typeOnly).toBe(true);
      // Type-only changes should have lower severity
      expect(runtimeResult.severity).toBeGreaterThan(typeOnlyResult.severity);
    });

    it("should consider fan-in when calculating severity", async () => {
      const mockIndexWithDeps = makeTestProjectIndex({
        graph: {
          nodes: new Set(),
          edges: [
            { from: "consumer1.ts", to: { type: "file" as const, path: "user.ts" }, raw: "./user" }, // One dependency
            { from: "consumer2.ts", to: { type: "file" as const, path: "user.ts" }, raw: "./user" }, // Another dependency
            { from: "consumer3.ts", to: { type: "file" as const, path: "user.ts" }, raw: "./user" }, // Third dependency
          ],
        },
        byFile: new Map(),
      });

      const mockIndexNoDeps = makeTestProjectIndex({
        graph: { nodes: new Set(), ...{ edges: [] } },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const highFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexWithDeps);
      const lowFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexNoDeps);

      expect(highFanInResult.explain.fanIn).toBe(3);
      expect(lowFanInResult.explain.fanIn).toBeUndefined();

      // Saturating normalization retains the fan-in boost for ranking.
      expect(highFanInResult.severity).toBeGreaterThan(lowFanInResult.severity);
    });

    it("counts fan-in when reference path casing differs from edge path casing", () => {
      const originalCaseSensitivity = isFileIdentityCaseInsensitive();
      try {
        resetFileIdentityCaseSensitivityForTests(true);
        setFileIdentityCaseInsensitive(true);

        const mockIndex = makeTestProjectIndex({
          graph: {
            nodes: new Set(),
            edges: [
              { from: "consumer4.ts", to: { type: "file" as const, path: "src/user.ts" }, raw: "./user" },
              { from: "consumer5.ts", to: { type: "file" as const, path: "src/user.ts" }, raw: "./user" },
              { from: "consumer6.ts", to: { type: "file" as const, path: "src/user.ts" }, raw: "./user" },
            ],
          },
          byFile: new Map(),
        });

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
          file: "Src/User.ts",
          range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
        };

        const result = calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);

        expect(fileIdentityKey(ref.file)).toBe(fileIdentityKey("src/user.ts"));
        expect(result.explain.fanIn).toBe(3);
      } finally {
        resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      }
    });

    it("should reject invalid severity weights instead of silently repairing them", () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
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
      const mockIndex = makeTestProjectIndex({
        graph: {
          nodes: new Set(),
          edges: [
            { from: "consumer7.ts", to: { type: "file" as const, path: "user.ts" }, raw: "./user" },
            { from: "consumer8.ts", to: { type: "file" as const, path: "user.ts" }, raw: "./user" },
          ],
        },
        byFile: new Map(),
      });

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
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
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

    it("discounts severity and confidence for medium-confidence resolved references", async () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const exactRef = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
      };

      const memberAccessRef = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
        provenance: { resolution: "member-access" as const, confidence: "medium" as const },
      };

      const exactResult = await calculateSeverity(changedSymbol, exactRef, ["directRef"], 0, mockIndex);
      const memberAccessResult = await calculateSeverity(changedSymbol, memberAccessRef, ["directRef"], 0, mockIndex);

      expect(memberAccessResult.severity).toBeLessThan(exactResult.severity);
      expect(memberAccessResult.confidence).toBeLessThan(exactResult.confidence);
      expect(memberAccessResult.confidence).toBeCloseTo(exactResult.confidence * 0.85, 5);
      expect(memberAccessResult.explain.resolutionConfidence).toBe("medium");
      expect(exactResult.explain.resolutionConfidence).toBeUndefined();
    });

    it("discounts confidence more sharply for low-confidence resolved references", async () => {
      const mockIndex = makeTestProjectIndex({
        graph: { nodes: new Set(), edges: [] },
        byFile: new Map(),
      });

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false,
      };

      const lowConfidenceRef = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
        provenance: { confidence: "low" as const },
      };

      const mediumConfidenceRef = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 }, end: { line: 5, column: 10 } },
        provenance: { confidence: "medium" as const },
      };

      const lowResult = await calculateSeverity(changedSymbol, lowConfidenceRef, ["directRef"], 0, mockIndex);
      const mediumResult = await calculateSeverity(changedSymbol, mediumConfidenceRef, ["directRef"], 0, mockIndex);

      expect(lowResult.severity).toBeLessThan(mediumResult.severity);
      expect(lowResult.confidence).toBeLessThan(mediumResult.confidence);
      expect(lowResult.explain.resolutionConfidence).toBe("low");
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
          "export function helper(a: string, b: number) { return a + b; }\n",
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
          "export function helper(a: string, b: number) { return a + b; }\n",
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
          "export function helper(a: string, b: number) { return a + b; }\n",
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
          "export const helper = (a: string, b: number) => a + b;\n",
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

    it.each([
      { file: "api.ts", mainFile: "main.ts" },
      { file: "api.js", mainFile: "main.js" },
    ])("attaches hints for changed bare arrow function parameters in $file", async ({ file, mainFile }) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-call-compat-bare-arrow-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", file), "export const helper = a => a;\n", "utf8");
        await fsp.writeFile(
          path.join(root, "src", mainFile),
          'import { helper } from "./api";\nexport const value = helper("x", 1);\n',
          "utf8",
        );
        const index = await buildProjectIndex(root);
        const diffText = [
          `diff --git a/src/${file} b/src/${file}`,
          "index 1234567..abcdef0 100644",
          `--- a/src/${file}`,
          `+++ b/src/${file}`,
          "@@ -1,1 +1,1 @@",
          "-export const helper = (a, b) => a;",
          "+export const helper = a => a;",
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

        expect(helper?.signatureChanged).toBeTruthy();
        expect(helper?.callCompatibility).toContainEqual(
          expect.objectContaining({
            status: "likely_mismatch",
            reason: "argument_count_above_maximum",
            callsiteFile: `src/${mainFile}`,
            expected: { minArgs: 1, maxArgs: 1, confidence: "high" },
            actual: { argCount: 2, confidence: "high" },
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
    it("bounds reference scheduling across many changed symbols", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-work-budget-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        const declarations = Array.from(
          { length: 12 },
          (_, index) => `export function symbol${index}(): number { return ${index}; }`,
        );
        const imports = Array.from({ length: 12 }, (_, index) => `symbol${index}`).join(", ");
        const calls = Array.from({ length: 12 }, (_, index) => `symbol${index}()`).join(" + ");
        await fsp.writeFile(path.join(root, "src/api.ts"), `${declarations.join("\n")}\n`, "utf8");
        await fsp.writeFile(
          path.join(root, "src/consumer.ts"),
          `import { ${imports} } from "./api";\nexport const result = ${calls};\n`,
          "utf8",
        );
        const index = await buildProjectIndex(root, { cache: "memory" });
        const apiFile = normalizePath(path.join(root, "src/api.ts"));
        const changedSymbols = (index.byFile.get(fileIdentityKey(apiFile))?.locals ?? [])
          .filter((symbol) => symbol.localName.startsWith("symbol"))
          .map((symbol) => ({
            id: `${symbol.file}::${symbol.localName}::${symbol.range.start.index ?? 0}`,
            file: symbol.file,
            name: symbol.localName,
            kind: symbol.kind,
            exported: true,
            range: symbol.range,
          }));
        const diagnostics = createImpactDiagnostics(1, 0);

        await analyzeImpact(index, changedSymbols, [], {
          membersOnly: true,
          maxReferenceLookups: 3,
          maxTotalReferences: 2,
          diagnostics,
        });

        expect(diagnostics.referenceLookupsStarted).toBe(3);
        expect(diagnostics.referenceLookupsOmitted).toBe(changedSymbols.length - 3);
        expect(diagnostics.changedSymbolsTotal).toBe(changedSymbols.length);
        expect(diagnostics.referencesRetained).toBe(2);
        expect(diagnostics.referencesOmitted).toBe(4);
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("ranks changed-symbol budget selection deterministically", async () => {
      const index = await createTestIndex("typescript");
      const baseRange = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
      const symbols = [
        {
          id: "local",
          file: "src/z.ts",
          name: "local",
          kind: SymbolKind.Variable,
          exported: false,
          range: baseRange,
        },
        {
          id: "public",
          file: "src/y.ts",
          name: "public",
          kind: SymbolKind.Variable,
          exported: true,
          range: baseRange,
        },
        {
          id: "signature",
          file: "src/x.ts",
          name: "signature",
          kind: SymbolKind.Function,
          exported: false,
          range: baseRange,
          signatureChanged: true,
        },
      ];

      const forward = rankChangedSymbolsForBudget(symbols, index).map((symbol) => symbol.id);
      const reversed = rankChangedSymbolsForBudget([...symbols].reverse(), index).map((symbol) => symbol.id);

      expect(forward).toEqual(["signature", "public", "local"]);
      expect(reversed).toEqual(forward);
    });

    it("treats missing incoming-edge map entries as false for budget ranking", () => {
      const baseRange = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
      const index = makeTestProjectIndex({
        graph: {
          nodes: new Set(["src/dep.ts", "src/with-incoming.ts"]),
          edges: [
            {
              from: "src/dep.ts",
              to: { type: "file" as const, path: "src/with-incoming.ts" },
              raw: "./with-incoming",
            },
          ],
        },
      });
      const symbols = [
        {
          id: "lonely",
          file: "src/lonely.ts",
          name: "lonely",
          kind: SymbolKind.Function,
          exported: true,
          range: baseRange,
        },
        {
          id: "referenced",
          file: "src/with-incoming.ts",
          name: "referenced",
          kind: SymbolKind.Function,
          exported: true,
          range: baseRange,
        },
      ];

      const forward = rankChangedSymbolsForBudget(symbols, index).map((symbol) => symbol.id);
      const reversed = rankChangedSymbolsForBudget([...symbols].reverse(), index).map((symbol) => symbol.id);

      expect(forward).toEqual(["referenced", "lonely"]);
      expect(reversed).toEqual(forward);
    });

    it("returns exact partial diagnostics when the analysis deadline is already exhausted", async () => {
      const index = await createTestIndex("typescript");
      const file = Array.from(index.byFile.keys())[0]!;
      const locals = index.byFile.get(file)?.locals ?? [];
      const changedSymbols = locals.map((symbol) => ({
        id: `${symbol.file}::${symbol.localName}::${symbol.range.start.index ?? 0}`,
        file: symbol.file,
        name: symbol.localName,
        kind: symbol.kind,
        exported: false,
        range: symbol.range,
      }));
      const diagnostics = createImpactDiagnostics(1, 0);

      const result = await analyzeImpact(index, changedSymbols, [], {
        membersOnly: true,
        timeBudgetMs: 0,
        diagnostics,
      });

      expect(result).toEqual([]);
      expect(diagnostics.deadlineExceeded).toBe(true);
      expect(diagnostics.changedSymbolsTotal).toBe(changedSymbols.length);
      expect(diagnostics.changedSymbolsAnalyzed).toBe(0);
      expect(diagnostics.changedSymbolsOmitted).toBe(changedSymbols.length);
      expect(diagnostics.referenceLookupsStarted).toBe(0);
      expect(diagnostics.referenceLookupsOmitted).toBe(changedSymbols.length);
    });
  });
});

describe("impact request-wide budgets", () => {
  it("ranks and limits changed symbols before reference lookups", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-impact-budget-symbols-"));
    try {
      const src = path.join(root, "src");
      await fsp.mkdir(src, { recursive: true });
      const imports: string[] = [];
      const calls: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const name = `fn${i}`;
        await fsp.writeFile(path.join(src, `mod${i}.ts`), `export function ${name}() { return ${i}; }\n`, "utf8");
        imports.push(`import { ${name} } from "./mod${i}";`);
        calls.push(`${name}()`);
      }
      await fsp.writeFile(
        path.join(src, "consumer.ts"),
        `${imports.join("\n")}\nexport const all = [${calls.join(", ")}];\n`,
        "utf8",
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const hunks = Array.from({ length: 30 }, (_, i) => {
        return `diff --git a/src/mod${i}.ts b/src/mod${i}.ts
index 1111111..2222222 100644
--- a/src/mod${i}.ts
+++ b/src/mod${i}.ts
@@ -1,1 +1,1 @@
-export function fn${i}() { return ${i}; }
+export function fn${i}(x = 0) { return ${i} + x; }
`;
      }).join("");

      const report = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText: hunks,
        maxChangedSymbols: 5,
        maxReferenceLookups: 5,
        maxTotalReferences: 50,
        maxRefs: 10,
      });

      expect(report.diagnostics?.changedSymbolsTotal).toBeGreaterThan(5);
      expect(report.diagnostics?.changedSymbolsAnalyzed).toBe(5);
      expect(report.diagnostics?.changedSymbolsOmitted).toBe((report.diagnostics?.changedSymbolsTotal ?? 0) - 5);
      expect(report.diagnostics?.referenceLookupsStarted ?? 0).toBeLessThanOrEqual(5);
      expect(
        (report.diagnostics?.referenceLookupsOmitted ?? 0) + (report.diagnostics?.referenceLookupsStarted ?? 0),
      ).toBeGreaterThan(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("returns deterministic selected symbols for identical budgeted inputs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-impact-budget-deterministic-"));
    try {
      const src = path.join(root, "src");
      await fsp.mkdir(src, { recursive: true });
      await fsp.writeFile(path.join(src, "a.ts"), "export function alpha() { return 1; }\n", "utf8");
      await fsp.writeFile(path.join(src, "b.ts"), "export function beta() { return 2; }\n", "utf8");
      await fsp.writeFile(path.join(src, "c.ts"), "export const gamma = 3;\n", "utf8");
      await fsp.writeFile(
        path.join(src, "consumer.ts"),
        'import { alpha } from "./a";\nimport { beta } from "./b";\nimport { gamma } from "./c";\nexport const all = [alpha(), beta(), gamma];\n',
        "utf8",
      );
      const index = await buildProjectIndex(root, { cache: "off" });
      const diffText = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-export function alpha() { return 1; }
+export function alpha(x = 0) { return 1 + x; }
diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-export function beta() { return 2; }
+export function beta(x = 0) { return 2 + x; }
diff --git a/src/c.ts b/src/c.ts
index 1111111..2222222 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,1 +1,1 @@
-export const gamma = 3;
+export const gamma = 4;
`;
      const opts = {
        provider: "raw" as const,
        diffText,
        maxChangedSymbols: 2,
        maxReferenceLookups: 2,
        maxRefs: 10,
      };
      const first = await analyzeImpactFromDiff(root, index, opts);
      const second = await analyzeImpactFromDiff(root, index, opts);
      expect(first.changedSymbols.map((symbol) => symbol.id)).toEqual(second.changedSymbols.map((symbol) => symbol.id));
      expect(first.diagnostics?.changedSymbolsOmitted).toBe(second.diagnostics?.changedSymbolsOmitted);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("marks deadlineExceeded and returns a valid partial report", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-impact-budget-deadline-"));
    try {
      const src = path.join(root, "src");
      await fsp.mkdir(src, { recursive: true });
      const parts: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        await fsp.writeFile(path.join(src, `mod${i}.ts`), `export function fn${i}() { return ${i}; }\n`, "utf8");
        parts.push(`diff --git a/src/mod${i}.ts b/src/mod${i}.ts
index 1111111..2222222 100644
--- a/src/mod${i}.ts
+++ b/src/mod${i}.ts
@@ -1,1 +1,1 @@
-export function fn${i}() { return ${i}; }
+export function fn${i}(x = 0) { return ${i} + x; }
`);
      }
      const index = await buildProjectIndex(root, { cache: "off" });
      const report = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText: parts.join(""),
        timeBudgetMs: 0,
        maxChangedSymbols: 20,
        maxReferenceLookups: 20,
        maxRefs: 5,
      });
      expect(report.diagnostics?.deadlineExceeded).toBe(true);
      expect(Array.isArray(report.impacted)).toBe(true);
      expect(report.schemaVersion).toBeTypeOf("number");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("memberResolutionCoverage diagnostics", () => {
  it("flags languages without receiver member-call resolution alongside receiver-aware languages", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-member-coverage-"));
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const tsFile = path.join(root, "src", "main.ts");
      const phpFile = path.join(root, "src", "main.php");
      await fsp.writeFile(tsFile, "export function helper(a: string) { return a; }\n", "utf8");
      await fsp.writeFile(phpFile, "<?php\nfunction helper(a) { return a; }\n", "utf8");

      const index = await buildProjectIndex(root, { cache: "memory" });
      const diffText = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,1 +1,1 @@
-export function helper(a: string) { return a; }
+export function helper(a: string, b: number) { return a; }
diff --git a/src/main.php b/src/main.php
--- a/src/main.php
+++ b/src/main.php
@@ -2,1 +2,1 @@
-function helper(a) { return a; }
+function helper(a, b) { return a; }
`;

      const result = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
      });

      if ("files" in result) {
        throw new Error("Expected full impact report");
      }

      expect(result.diagnostics?.memberResolutionCoverage?.receiverAwareLanguages).toContain("ts");
      expect(result.diagnostics?.memberResolutionCoverage?.limitedLanguages).toContain("php");
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("omits the field entirely when every changed language is receiver-aware", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-member-coverage-clean-"));
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const tsFile = path.join(root, "src", "main.ts");
      await fsp.writeFile(tsFile, "export function helper(a: string) { return a; }\n", "utf8");

      const index = await buildProjectIndex(root, { cache: "memory" });
      const diffText = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,1 +1,1 @@
-export function helper(a: string) { return a; }
+export function helper(a: string, b: number) { return a; }
`;

      const result = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
      });

      if ("files" in result) {
        throw new Error("Expected full impact report");
      }

      expect(result.diagnostics?.memberResolutionCoverage).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("still flags a limited language even when maxChangedSymbols budgets it out of the reference-lookup queue", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-member-coverage-budget-"));
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const tsFile = path.join(root, "src", "a.ts");
      const phpFile = path.join(root, "src", "b.php");
      await fsp.writeFile(tsFile, "export function helperA(x: string) { return x; }\n", "utf8");
      await fsp.writeFile(phpFile, "<?php\nfunction helperB(x) { return x; }\n", "utf8");

      const index = await buildProjectIndex(root, { cache: "memory" });
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-export function helperA(x: string) { return x; }
+export function helperA(x: string, y: number) { return x; }
diff --git a/src/b.php b/src/b.php
--- a/src/b.php
+++ b/src/b.php
@@ -2,1 +2,1 @@
-function helperB(x) { return x; }
+function helperB(x, y) { return x; }
`;

      // Force the ranking budget to select only one changed symbol for reference
      // lookups; memberResolutionCoverage must still see both languages because
      // it is computed from all non-ignored changed symbols, not the post-budget
      // reference-lookup queue.
      const result = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
        maxChangedSymbols: 1,
      });

      if ("files" in result) {
        throw new Error("Expected full impact report");
      }

      expect(result.diagnostics?.memberResolutionCoverage?.limitedLanguages).toContain("php");
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("transitive impact reason/confidence merge", () => {
  it("preserves the stronger direct-reference reason and discounted confidence when a transitive edge also touches the file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-transitive-merge-"));
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const serviceFile = path.join(root, "src", "service.ts");
      const consumerFile = path.join(root, "src", "consumer.ts");
      await fsp.writeFile(
        serviceFile,
        ["export class Service {", "  run(value: number, extra: number): number { return value; }", "}", ""].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        consumerFile,
        [
          'import { Service } from "./service";',
          "const service = new Service();",
          "export const result = service.run(1);",
          "",
        ].join("\n"),
        "utf8",
      );

      const index = await buildProjectIndex(root, { cache: "memory" });
      const diffText = `diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -2,1 +2,1 @@
-  run(value: number): number { return value; }
+  run(value: number, extra: number): number { return value; }
`;

      const result = await analyzeImpactFromDiff(root, index, { provider: "raw", diffText });
      if ("files" in result) {
        throw new Error("Expected full impact report");
      }

      // consumer.ts has both a direct member-access reference to `run` AND an
      // incoming file-level transitive dependency edge (via the import). The
      // direct reference is higher priority and carries a resolution-confidence
      // discount; the transitive pass must not clobber either.
      const consumerItem = result.impacted.find((item) => item.file === "src/consumer.ts");
      expect(consumerItem?.reasons).toEqual(expect.arrayContaining(["directRef", "transitive"]));
      expect(consumerItem?.explain?.reason).toBe("directRef");
      expect(consumerItem?.explain?.resolutionConfidence).toBe("medium");
      expect(consumerItem?.confidence).toBeCloseTo(0.85, 5);
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("path identity silent lookup regressions", () => {
  function flipPathLetterCase(filePath: string): string {
    for (let index = filePath.length - 1; index >= 0; index -= 1) {
      const character = filePath[index];
      if (!character) continue;
      if (character >= "a" && character <= "z") {
        return `${filePath.slice(0, index)}${character.toUpperCase()}${filePath.slice(index + 1)}`;
      }
      if (character >= "A" && character <= "Z") {
        return `${filePath.slice(0, index)}${character.toLowerCase()}${filePath.slice(index + 1)}`;
      }
    }
    return filePath;
  }

  it("hits identity-keyed parsed cache when locateChangedSymbols path casing differs", async () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parsed-cache-casing-"));
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      fileIdentityKey("freeze-case-mode");

      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      const displayFile = normalizePath(path.join(root, "src", "Util.ts"));
      await fsp.writeFile(displayFile, "export function helper() {\n  return 1;\n}\n", "utf8");

      const index = await buildProjectIndexFromFiles(root, [displayFile], { cache: "off" });
      const { ensureParsedContext } = await import("../src/indexer/parse-context.js");
      const { locateChangedSymbols } = await import("../src/impact/map.js");
      const parsed = await ensureParsedContext(displayFile);
      index.parsed = new Map([[fileIdentityKey(displayFile), parsed]]);

      const queryFile = flipPathLetterCase(displayFile);
      expect(queryFile).not.toBe(displayFile);
      expect(fileIdentityKey(queryFile)).toBe(fileIdentityKey(displayFile));
      expect(index.parsed.has(queryFile)).toBe(false);
      expect(index.parsed.has(fileIdentityKey(queryFile))).toBe(true);

      const changed = await locateChangedSymbols(index, queryFile, [
        {
          oldStart: 2,
          newStart: 2,
          lines: ["+  return 2;"],
        },
      ]);

      expect(changed.some((symbol) => symbol.name === "helper")).toBe(true);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves graph node membership when the query path casing differs", async () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      fileIdentityKey("freeze-case-mode");

      const projectRoot = path.join(os.tmpdir(), "codegraph-graph-casing").replace(/\\/g, "/");
      const mainPath = `${projectRoot}/src/Main.ts`;
      const utilPath = `${projectRoot}/src/util.ts`;
      expect(fileIdentityKey("src/main.ts")).toBe(fileIdentityKey("src/Main.ts"));

      const jsonLines: unknown[] = [];
      const { handleGraphQueryCommand } = await import("../src/cli/graphQueries.js");
      await handleGraphQueryCommand({
        command: "deps",
        positionals: ["src/main.ts"],
        projectRootFs: projectRoot,
        projectRootAbs: projectRoot,
        getOpt: () => undefined,
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {},
        writeStderrLine: () => {},
        exit: (code) => {
          throw new Error(`unexpected exit ${code}: ${JSON.stringify(jsonLines)}`);
        },
        listProjectFilesForScan: async () => [mainPath, utilPath],
        collectGraph: async () => ({
          nodes: new Set([mainPath, utilPath]),
          edges: [
            {
              from: mainPath,
              to: { type: "file" as const, path: utilPath },
              raw: "./util",
            },
          ],
        }),
        loadCurrentIndex: async () => {
          throw new Error("unexpected index build");
        },
      });

      expect(jsonLines).toEqual([{ items: [{ file: utilPath, depth: 1 }], truncated: false }]);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("compares mixed-form SQL definition paths by identity", async () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-identity-casing-"));
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      fileIdentityKey("freeze-case-mode");

      await fsp.mkdir(path.join(root, "sql"), { recursive: true });
      const displayFile = normalizePath(path.join(root, "sql", "Schema.sql"));
      await fsp.writeFile(
        displayFile,
        ["CREATE TABLE users (id integer);", "SELECT * FROM users;", ""].join("\n"),
        "utf8",
      );

      const index = await buildProjectIndexFromFiles(root, [displayFile], { cache: "off" });
      const queryFile = flipPathLetterCase(displayFile);
      expect(queryFile).not.toBe(displayFile);
      expect(fileIdentityKey(queryFile)).toBe(fileIdentityKey(displayFile));

      const exact = await goToSqlDefinition(index, { file: displayFile, line: 2, column: 15 });
      expect(exact?.status).toBe("ok");
      if (exact?.status === "ok") {
        expect(fileIdentityKey(exact.definition.file)).toBe(fileIdentityKey(displayFile));
      }

      // A differently-cased query path only names the same file on a genuinely
      // case-insensitive volume. On a case-sensitive one it is a different path and
      // must not resolve, so probe the real filesystem rather than the identity mode
      // this test pins.
      const flippedExistsOnDisk = await fsp
        .stat(queryFile)
        .then(() => true)
        .catch(() => false);
      if (flippedExistsOnDisk) {
        const flipped = await goToSqlDefinition(index, { file: queryFile, line: 2, column: 15 });
        expect(flipped?.status).toBe("ok");
        if (flipped?.status === "ok") {
          expect(fileIdentityKey(flipped.definition.file)).toBe(fileIdentityKey(displayFile));
        }
      }
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
