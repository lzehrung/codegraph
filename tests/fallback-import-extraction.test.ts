import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndexFromFiles, collectGraph, type BuildReport } from "../src/index.js";
import { extractJsTsSpecifiers, stripJsLikeComments } from "../src/util.js";
import {
  getNativeTreeSitterSupportedLanguageIds,
  isNativeTreeSitterAvailable,
} from "../src/native/treeSitterNative.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Import extraction fallback reporting", () => {
  it("avoids regex fallback for TypeScript import equals", async () => {
    const root = await mkTmpDir("cg-import-equals-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const value = 1;\n", "utf8");
    await fsp.writeFile(main, "import util = require('./dep');\nconsole.log(util);\n", "utf8");

    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndexFromFiles(root, [main], { report });
    const fallback = report.graph?.fallbackImportExtraction;

    expect(fallback).toBeDefined();
    expect(fallback?.total ?? 0).toBe(0);

    const normalizedMain = main.replace(/\\/g, "/");
    const normalizedDep = dep.replace(/\\/g, "/");
    const mod = index.byFile.get(normalizedMain);
    const importBinding = mod?.imports.find(
      (entry) => entry.kind === "default" && entry.local === "util" && entry.from === "./dep",
    );
    const edge = index.graph.edges.find(
      (entry) => entry.from === normalizedMain && entry.to.type === "file" && entry.to.path === normalizedDep,
    );
    expect(importBinding).toBeTruthy();
    expect(edge).toBeTruthy();
  });

  it("preserves // inside string literals while stripping comments", () => {
    const source = [
      'const cdn = "//cdn.example.com/lib.js";',
      'const api = "https://api.example.com/v1";',
      "const tpl = `${base}//path`;",
      "// remove me",
      "const keep = 1; /* also remove */",
    ].join("\n");

    const stripped = stripJsLikeComments(source);

    expect(stripped).toContain('"//cdn.example.com/lib.js"');
    expect(stripped).toContain('"https://api.example.com/v1"');
    expect(stripped).toContain("`${base}//path`");
    expect(stripped).not.toContain("// remove me");
    expect(stripped).not.toContain("/* also remove */");
  });

  it("extracts mixed JS/TS specifiers in one scan", () => {
    const source = [
      "import type { Foo } from './types'",
      "import { bar } from './bar'",
      "import './side'",
      "export { baz } from './baz'",
      "const req = require('./req')",
      "const { pick } = require('./pick')",
      "const dyn = import('./dyn')",
    ].join("\n");

    const specs = extractJsTsSpecifiers(source);
    expect(specs.map((entry) => entry.spec)).toEqual([
      "./types",
      "./bar",
      "./side",
      "./baz",
      "./req",
      "./pick",
      "./dyn",
    ]);
    expect(specs[0]?.typeOnly).toBe(true);
  });

  it("ignores import and require examples inside string literals", () => {
    const source = [
      'const loggedRequire = "call require(\\"./not-real\\") in docs";',
      "const loggedImport = 'call import(\"./also-not-real\") in docs';",
      "const loggedExport = `export { thing } from \"./template-doc\"`;",
      "const actual = require('./real')",
      "const dynamic = import('./dynamic')",
    ].join("\n");

    const specs = extractJsTsSpecifiers(source);

    expect(specs.map((entry) => entry.spec)).toEqual(["./real", "./dynamic"]);
  });

  it("extracts import calls inside template literal interpolations", () => {
    const source = [
      "const dynamic = `load ${import('./dep')}`;",
      'const required = `load ${require("./req")}`;',
      'const nestedString = `skip ${"import(\'./not-real\')"}`;',
      'const nestedTemplate = `skip ${`require("./also-not-real")`}`;',
      "const literalText = `skip import('./literal-only')`;",
    ].join("\n");

    const specs = extractJsTsSpecifiers(source);

    expect(specs.map((entry) => entry.spec)).toEqual(["./dep", "./req"]);
  });

  it("reports native backend availability and usage", async () => {
    const root = await mkTmpDir("cg-native-report-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const value = 1;\n", "utf8");
    await fsp.writeFile(main, "import { value } from './dep';\nconsole.log(value);\n", "utf8");

    const report: BuildReport = { timings: {} };
    await buildProjectIndexFromFiles(root, [main, dep], { report });

    const native = report.backend?.native;
    expect(native).toBeDefined();
    expect(native?.available).toBe(isNativeTreeSitterAvailable());
    expect(native?.supportedLanguageIds).toEqual(getNativeTreeSitterSupportedLanguageIds());
    expect(native?.byLanguage.ts?.filesSeen).toBe(2);

    const nativeSupportsTs = isNativeTreeSitterAvailable() && getNativeTreeSitterSupportedLanguageIds().includes("ts");
    if (nativeSupportsTs) {
      expect((native?.filesUsed ?? 0) + (native?.fallbackReasons.queryFailure ?? 0)).toBeGreaterThan(0);
      if ((native?.filesUsed ?? 0) > 0) {
        expect(native?.enabled).toBe(true);
        expect(native?.byLanguage.ts?.filesUsed).toBeGreaterThan(0);
      }
    } else {
      expect(native?.filesFellBack).toBeGreaterThan(0);
      expect(
        (native?.fallbackReasons.unavailable ?? 0) +
          (native?.fallbackReasons.unsupportedLanguage ?? 0) +
          (native?.fallbackReasons.queryFailure ?? 0),
      ).toBeGreaterThan(0);
      expect(native?.byLanguage.ts?.filesFellBack).toBeGreaterThan(0);
    }
  });

  it("reports native backend availability and usage for graph-only builds", async () => {
    const root = await mkTmpDir("cg-native-graph-report-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const value = 1;\n", "utf8");
    await fsp.writeFile(main, "import { value } from './dep';\nconsole.log(value);\n", "utf8");

    const report: BuildReport = { timings: {} };
    const graph = await collectGraph(root, [main, dep], { report });

    expect(graph.edges.length).toBeGreaterThan(0);
    const native = report.backend?.native;
    expect(native).toBeDefined();
    expect(native?.available).toBe(isNativeTreeSitterAvailable());
    expect(native?.supportedLanguageIds).toEqual(getNativeTreeSitterSupportedLanguageIds());
    expect(native?.byLanguage.ts?.filesSeen).toBe(2);

    const nativeSupportsTs = isNativeTreeSitterAvailable() && getNativeTreeSitterSupportedLanguageIds().includes("ts");
    if (nativeSupportsTs) {
      expect(native?.byLanguage.ts?.filesUsed).toBe(2);
      expect(native?.filesUsed).toBe(2);
      expect(native?.enabled).toBe(true);
    } else {
      expect(native?.filesFellBack).toBeGreaterThan(0);
      expect(native?.byLanguage.ts?.filesFellBack).toBeGreaterThan(0);
    }
  });

  it("avoids Python query-empty fallback warnings for __future__ imports", async () => {
    const root = await mkTmpDir("cg-python-future-import-");
    const main = path.join(root, "main.py");
    await fsp.writeFile(main, "from __future__ import annotations\n", "utf8");

    const report: BuildReport = { timings: {} };
    const graph = await collectGraph(root, [main], { report });

    const fallback = report.graph?.fallbackImportExtraction;
    expect(fallback?.total ?? 0).toBe(0);

    const normalizedMain = main.replace(/\\/g, "/");
    const futureEdge = graph.edges.find(
      (entry) => entry.from === normalizedMain && entry.to.type === "external" && entry.to.name === "__future__",
    );
    expect(futureEdge).toBeTruthy();
  });
});
