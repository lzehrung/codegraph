import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndexFromFiles, collectGraph, type BuildReport } from "../src/index.js";
import { extractDynamicImportSpecifiers, extractJsTsSpecifiers, stripJsLikeComments } from "../src/util.js";
import {
  getNativeTreeSitterSupportedLanguageIds,
  isNativeTreeSitterAvailable,
} from "../src/native/tree-sitter-native.js";
import * as nativeRuntime from "../src/native/tree-sitter-native.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { supportById } from "../src/languages.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { collectImportsForFile } from "../src/indexer/imports.js";
import type { ImportBinding } from "../src/indexer/types.js";
import { isJsTsTypeOnlySpecifierStatement } from "../src/util/specifiers.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

type TokenRange = {
  start: { line: number; column: number; index: number };
  end: { line: number; column: number; index: number };
};

function positionForIndex(source: string, index: number): TokenRange["start"] {
  const prefix = source.slice(0, index);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.split("\n").length, column: index - lineStart + 1, index };
}

/** Exact UTF-16 range of the first occurrence of `token` in `source`. */
function rangeForToken(source: string, token: string): TokenRange {
  const index = source.indexOf(token);
  if (index < 0) throw new Error(`token not found: ${token}`);
  return { start: positionForIndex(source, index), end: positionForIndex(source, index + token.length) };
}

function localNameOf(binding: ImportBinding): string {
  if (binding.kind === "default") return binding.local;
  if (binding.kind === "namespace") return binding.localNS;
  if (binding.kind === "named") return binding.local;
  return "";
}

/** Stable lookup key covering the binding shape compared between native and text extraction. */
function bindingRangeKey(binding: ImportBinding): string {
  const imported = binding.kind === "named" ? binding.imported : "";
  return `${binding.kind}:${localNameOf(binding)}:${imported}`;
}

function bindingRanges(bindings: ImportBinding[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const binding of bindings) {
    out[bindingRangeKey(binding)] = {
      importedRange: binding.kind === "named" ? binding.importedRange : undefined,
      localRange: binding.kind === "star" ? undefined : binding.localRange,
    };
  }
  return out;
}

const nativeTsDescribe =
  isNativeTreeSitterAvailable() && getNativeTreeSitterSupportedLanguageIds().includes("ts") ? describe : describe.skip;

nativeTsDescribe("native TypeScript import binding recovery", () => {
  it("preserves CommonJS value require bindings in native mode", async () => {
    const root = await mkTmpDir("cg-native-ts-require-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const dep = 1;\n", "utf8");
    await fsp.writeFile(
      main,
      [
        "const dep = /* webpackChunkName: 'dep' */",
        "  require /* webpackMode: 'eager' */ ('./dep');",
        "const example = \"const fake = require('./fake')\";",
        "const pattern = /const fake = require ('react')/;",
        "const emoji = '😀';",
        "if (dep) /const branchFake = require ('branch-fake')/.test(String(dep));",
        "const docs = `\\n  import { fake } from './fake';\\n  const alsoFake = require('./also-fake');\\n`;",
        "console.log(dep, example);",
      ].join("\n"),
      "utf8",
    );

    try {
      const index = await buildProjectIndexFromFiles(root, [main, dep]);
      const mod = index.byFile.get(fileIdentityKey(main));
      expect(mod?.imports).toEqual([
        expect.objectContaining({ kind: "default", local: "dep", from: "./dep", mechanism: "cjs" }),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps exported CommonJS require bindings in reduced mode", async () => {
    const root = await mkTmpDir("cg-reduced-exported-require-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const dep = 1;\n", "utf8");
    await fsp.writeFile(
      main,
      "const before = 1; export const depRef = require('./dep');\nconsole.log(before, depRef);\n",
      "utf8",
    );

    try {
      const index = await buildProjectIndexFromFiles(root, [main, dep], { native: "off" });
      const mod = index.byFile.get(fileIdentityKey(main));
      expect(mod?.imports).toEqual([
        expect.objectContaining({ kind: "default", local: "depRef", from: "./dep", mechanism: "cjs" }),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("carries the same exact token ranges through native and text fallback extraction", async () => {
    const root = await mkTmpDir("cg-native-range-parity-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    const source = [
      'import def from "./dep";',
      'import { alpha } from "./dep";',
      'import { beta as gamma } from "./dep";',
      'import type { Delta } from "./dep";',
      'import * as nsBinding from "./dep";',
      'import mixed, { epsilon as zeta } from "./dep";',
      'const cjsDefault = require("./dep");',
      'const { cjsTarget: cjsLocal } = require("./dep");',
      "export const use = [def, alpha, gamma, mixed, zeta, nsBinding, cjsDefault, cjsLocal] as const;",
    ].join("\n");
    await fsp.writeFile(dep, "export const dep = 1;\n", "utf8");

    const sup = supportById("ts");
    if (!sup) throw new Error("TypeScript language support unavailable");

    const expected: Record<string, unknown> = {
      "default:def:": { localRange: rangeForToken(source, "def") },
      "named:alpha:alpha": {
        importedRange: rangeForToken(source, "alpha"),
        localRange: rangeForToken(source, "alpha"),
      },
      "named:gamma:beta": {
        importedRange: rangeForToken(source, "beta"),
        localRange: rangeForToken(source, "gamma"),
      },
      "named:Delta:Delta": {
        importedRange: rangeForToken(source, "Delta"),
        localRange: rangeForToken(source, "Delta"),
      },
      "namespace:nsBinding:": { localRange: rangeForToken(source, "nsBinding") },
      "default:mixed:": { localRange: rangeForToken(source, "mixed") },
      "named:zeta:epsilon": {
        importedRange: rangeForToken(source, "epsilon"),
        localRange: rangeForToken(source, "zeta"),
      },
      "default:cjsDefault:": { localRange: rangeForToken(source, "cjsDefault") },
      "named:cjsLocal:cjsTarget": {
        importedRange: rangeForToken(source, "cjsTarget"),
        localRange: rangeForToken(source, "cjsLocal"),
      },
    };

    try {
      const nativeImports = await collectImportsForFile(main, root, { source, sup, native: "auto" });
      const fallbackImports = await collectImportsForFile(main, root, { source, sup, native: "off" });

      expect(bindingRanges(nativeImports)).toEqual(expected);
      expect(bindingRanges(fallbackImports)).toEqual(expected);
      expect(bindingRanges(fallbackImports)).toEqual(bindingRanges(nativeImports));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("reduced/text-fallback named and default import token ranges", () => {
  it("attributes binding ranges without consuming CommonJS destructuring defaults", async () => {
    const root = await mkTmpDir("cg-cjs-destructure-range-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    const source = 'const { cjsTarget: cjsLocal = fallbackValue } = require("./dep");\ncjsLocal();\n';
    await fsp.writeFile(dep, "export const cjsTarget = 1;\n", "utf8");
    const sup = supportById("ts");
    if (!sup) throw new Error("TypeScript language support unavailable");
    const importedRange = rangeForToken(source, "cjsTarget");
    const localRange = rangeForToken(source, "cjsLocal");

    try {
      for (const native of ["auto", "off"] as const) {
        const bindings = await collectImportsForFile(main, root, { source, sup, native });
        expect(bindings).toEqual([
          expect.objectContaining({
            kind: "named",
            imported: "cjsTarget",
            local: "cjsLocal",
            from: "./dep",
            importedRange,
            localRange,
          }),
        ]);
        expect(source.slice(importedRange.start.index, importedRange.end.index)).toBe("cjsTarget");
        expect(source.slice(localRange.start.index, localRange.end.index)).toBe("cjsLocal");
        expect(importedRange.start.index).toBe(8);
        expect(localRange.start.index).toBe(19);
        expect(importedRange.start).toEqual({ line: 1, column: 9, index: 8 });
        expect(localRange.start).toEqual({ line: 1, column: 20, index: 19 });
        expect(localRange.start.column).not.toBe(importedRange.start.column);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps bindings after object-literal defaults in CommonJS destructuring", async () => {
    const root = await mkTmpDir("cg-cjs-object-default-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    const source = 'const { x = { value: 1, nested: true }, y: localY } = require("./dep");\n';
    await fsp.writeFile(dep, "export const x = 1;\nexport const y = 2;\n", "utf8");
    const sup = supportById("ts");
    if (!sup) throw new Error("TypeScript language support unavailable");

    try {
      const bindings = await collectImportsForFile(main, root, { source, sup, native: "off" });
      expect(bindings).toEqual([
        expect.objectContaining({
          kind: "named",
          imported: "x",
          local: "x",
          from: "./dep",
          importedRange: rangeForToken(source, "x"),
          localRange: rangeForToken(source, "x"),
        }),
        expect.objectContaining({
          kind: "named",
          imported: "y",
          local: "localY",
          from: "./dep",
          importedRange: rangeForToken(source, "y"),
          localRange: rangeForToken(source, "localY"),
        }),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  const namedDefaultFallbackCases: Array<{
    label: string;
    languageId: string;
    file: string;
    source: string;
    imported: string;
    local: string;
    from: string;
    kind: "named" | "default";
  }> = [
    {
      label: "Java unaliased import",
      languageId: "java",
      file: "Consumer.java",
      source: "import pkg.Target;\n",
      imported: "Target",
      local: "Target",
      from: "pkg.Target",
      kind: "named",
    },
    {
      label: "Kotlin explicit alias",
      languageId: "kotlin",
      file: "Consumer.kt",
      source: "import pkg.Target as LocalTarget;\n",
      imported: "Target",
      local: "LocalTarget",
      from: "pkg.Target",
      kind: "named",
    },
    {
      label: "Python explicit alias",
      languageId: "python",
      file: "consumer.py",
      source: "from source import target as local_target\n",
      imported: "target",
      local: "local_target",
      from: "source",
      kind: "named",
    },
    {
      label: "Rust grouped alias",
      languageId: "rust",
      file: "consumer.rs",
      source: "use source::{target as local_target};\n",
      imported: "target",
      local: "local_target",
      from: "source",
      kind: "named",
    },
  ];

  for (const testCase of namedDefaultFallbackCases) {
    it(`attributes imported/local UTF-16 ranges for ${testCase.label} in native and reduced extraction`, async () => {
      const root = await mkTmpDir(`cg-fallback-${testCase.label.toLowerCase().replace(/\s+/g, "-")}-`);
      const file = path.join(root, testCase.file);
      const sup = supportById(testCase.languageId);
      if (!sup) throw new Error(`${testCase.languageId} language support unavailable`);
      const importedRange = rangeForToken(testCase.source, testCase.imported);
      const localRange = rangeForToken(testCase.source, testCase.local);
      const nativeLanguageIds = getNativeTreeSitterSupportedLanguageIds();

      try {
        for (const native of ["auto", "off"] as const) {
          if (
            native === "auto" &&
            (!isNativeTreeSitterAvailable() || !nativeLanguageIds.includes(testCase.languageId))
          ) {
            continue;
          }
          const bindings = await collectImportsForFile(file, root, { source: testCase.source, sup, native });
          const match = bindings.find(
            (binding) =>
              binding.kind === testCase.kind &&
              (binding.kind === "named"
                ? binding.imported === testCase.imported && binding.local === testCase.local
                : binding.kind === "default" && binding.local === testCase.local),
          );
          expect(match).toBeDefined();
          expect(match).toEqual(
            expect.objectContaining({
              kind: testCase.kind,
              from: testCase.from,
              ...(testCase.kind === "named"
                ? { imported: testCase.imported, local: testCase.local }
                : { local: testCase.local }),
              importedRange: testCase.kind === "named" ? importedRange : undefined,
              localRange,
            }),
          );
          expect(testCase.source.slice(importedRange.start.index, importedRange.end.index)).toBe(testCase.imported);
          expect(testCase.source.slice(localRange.start.index, localRange.end.index)).toBe(testCase.local);
          if (testCase.imported === testCase.local) {
            expect(localRange).toEqual(importedRange);
          } else {
            expect(localRange.start.index).not.toBe(importedRange.start.index);
          }
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }
});

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
    const mod = index.byFile.get(fileIdentityKey(normalizedMain));
    const importBinding = mod?.imports.find(
      (entry) => entry.kind === "default" && entry.local === "util" && entry.from === "./dep",
    );
    const edge = index.graph.edges.find(
      (entry) => entry.from === normalizedMain && entry.to.type === "file" && entry.to.path === normalizedDep,
    );
    expect(importBinding).toBeTruthy();
    expect(edge).toBeTruthy();
  });

  it("does not emit default bindings for type-only named imports in reduced mode", async () => {
    const root = await mkTmpDir("cg-type-import-fallback-");
    const main = path.join(root, "main.ts");
    const types = path.join(root, "types.ts");
    await fsp.writeFile(types, "export type Foo = { value: string };\nexport const bar = 1;\n", "utf8");
    await fsp.writeFile(
      main,
      "import { type Foo, bar } from './types';\nconst value: Foo = { value: String(bar) };\n",
      "utf8",
    );

    try {
      const index = await buildProjectIndexFromFiles(root, [main, types], { native: "off" });
      const mod = index.byFile.get(fileIdentityKey(main));
      expect(mod?.imports).toEqual([
        expect.objectContaining({ kind: "named", imported: "Foo", local: "Foo", typeOnly: true }),
        expect.objectContaining({ kind: "named", imported: "bar", local: "bar", typeOnly: false }),
      ]);
      expect(mod?.imports).not.toEqual([expect.objectContaining({ kind: "default", local: "type" })]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records exact token ranges for fallback import bindings", async () => {
    const root = await mkTmpDir("cg-fallback-range-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    const source = [
      'import def from "./dep";',
      'import { alpha } from "./dep";',
      'import { beta as gamma } from "./dep";',
      'import type { Delta } from "./dep";',
      'import * as nsBinding from "./dep";',
      'import { type Epsilon, zeta } from "./dep";',
      'const cjsDefault = require("./dep");',
      'const { cjsTarget: cjsLocal } = require("./dep");',
      "export const use = [def, alpha, gamma, Delta, nsBinding, Epsilon, zeta, cjsDefault, cjsLocal] as const;",
    ].join("\n");
    await fsp.writeFile(dep, "export const dep = 1;\n", "utf8");
    const sup = supportById("ts");
    if (!sup) throw new Error("TypeScript language support unavailable");

    try {
      const bindings = await collectImportsForFile(main, root, { source, sup, native: "off" });
      expect(bindingRanges(bindings)).toEqual({
        "default:def:": { localRange: rangeForToken(source, "def") },
        "named:alpha:alpha": {
          importedRange: rangeForToken(source, "alpha"),
          localRange: rangeForToken(source, "alpha"),
        },
        "named:gamma:beta": {
          importedRange: rangeForToken(source, "beta"),
          localRange: rangeForToken(source, "gamma"),
        },
        "named:Delta:Delta": {
          importedRange: rangeForToken(source, "Delta"),
          localRange: rangeForToken(source, "Delta"),
        },
        "namespace:nsBinding:": { localRange: rangeForToken(source, "nsBinding") },
        "named:Epsilon:Epsilon": {
          importedRange: rangeForToken(source, "Epsilon"),
          localRange: rangeForToken(source, "Epsilon"),
        },
        "named:zeta:zeta": {
          importedRange: rangeForToken(source, "zeta"),
          localRange: rangeForToken(source, "zeta"),
        },
        "default:cjsDefault:": { localRange: rangeForToken(source, "cjsDefault") },
        "named:cjsLocal:cjsTarget": {
          importedRange: rangeForToken(source, "cjsTarget"),
          localRange: rangeForToken(source, "cjsLocal"),
        },
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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
      "import legacy = require('./legacy')",
      'declare module "typed-ambient" {}',
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
      "./legacy",
      "typed-ambient",
    ]);
    expect(specs[0]?.typeOnly).toBe(true);
    expect(specs.at(-1)?.typeOnly).toBe(true);
    expect(specs.slice(4, 6).map((entry) => entry.exportCondition)).toEqual(["require", "require"]);
    expect(specs[6]?.exportCondition).toBeUndefined();
    expect(specs[7]?.exportCondition).toBe("require");
  });

  it("ignores import and require examples inside string literals", () => {
    const source = [
      'const loggedRequire = "call require(\\"./not-real\\") in docs";',
      "const loggedImport = 'call import(\"./also-not-real\") in docs';",
      'const loggedExport = `export { thing } from "./template-doc"`;',
      'const loggedRegex = /require("\\.\\/regex-not-real")/;',
      'if (ready) /import\\("\\.\\/branch-not-real"\\)/.test(source);',
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
      "const nestedString = `skip ${\"import('./not-real')\"}`;",
      'const nestedTemplate = `skip ${`require("./also-not-real")`}`;',
      "const literalText = `skip import('./literal-only')`;",
    ].join("\n");

    const specs = extractJsTsSpecifiers(source);

    expect(specs.map((entry) => entry.spec)).toEqual(["./dep", "./req"]);
  });

  it("ignores dynamic import heuristic examples inside string literals", () => {
    const source = [
      'const loggedPath = "call import(path.join(process.cwd(), \\"src/inside-string\\")) in docs";',
      "const loggedUrl = `call require(new URL('./inside-template', import.meta.url)) in docs`;",
      "const actual = import(path.join(process.cwd(), 'src/actual'));",
    ].join("\n");
    const fromFile = path.join(process.cwd(), "src", "main.ts");
    const projectRoot = process.cwd();

    const specs = extractDynamicImportSpecifiers("js", source, fromFile, projectRoot);

    expect(specs.map((entry) => entry.spec)).toEqual(["./actual"]);
  });

  it("extracts file-relative dynamic specifiers from path and URL helpers", () => {
    const projectRoot = path.join(process.cwd(), "fixture-root");
    const fromFile = path.join(projectRoot, "src", "loaders", "main.ts");
    const source = [
      "const fromDirname = require(path.join(__dirname, '..', 'shared'));",
      'const fromImportMeta = import(new URL("./asset.json", import.meta.url));',
      'const fromFilename = require(path.resolve(__filename, "..", "sibling"));',
      "const duplicate = import(path.join(__dirname, '..', 'shared'));",
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("js", source, fromFile, projectRoot);

    expect(specs.map((entry) => entry.spec)).toEqual(["../shared", "./sibling", "./asset.json"]);
    expect(specs.every((entry) => entry.resolved === "heuristic")).toBeTruthy();
  });

  it("ignores dynamic specifier helpers that require runtime evaluation", () => {
    const projectRoot = process.cwd();
    const fromFile = path.join(projectRoot, "src", "main.ts");
    const source = [
      "const computed = import(path.join(process.cwd(), `src/${name}`));",
      "const missingBase = require(path.join('src', 'dep'));",
      "const mixedBase = require(path.join(process.cwd(), __dirname, 'dep'));",
      "const brokenArgs = import(path.join(process.cwd(), ['src'));",
      "const unsupportedUrlBase = require(new URL('./dep', process.cwd()));",
    ].join("\n");

    const specs = extractDynamicImportSpecifiers("js", source, fromFile, projectRoot);

    expect(specs).toEqual([]);
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

  it("does not route graph-only documents through native query reporting", async () => {
    const root = await mkTmpDir("cg-native-doc-report-");
    const page = path.join(root, "page.md");
    const guide = path.join(root, "guide.md");
    await fsp.writeFile(page, "[Guide](./guide.md)\n", "utf8");
    await fsp.writeFile(guide, "# Guide\n", "utf8");

    const indexReport: BuildReport = { timings: {} };
    const graphReport: BuildReport = { timings: {} };
    const index = await buildProjectIndexFromFiles(root, [page, guide], { report: indexReport });
    const graph = await collectGraph(root, [page, guide], { report: graphReport });

    expect(
      index.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === guide.replace(/\\/g, "/")),
    ).toBe(true);
    expect(graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === guide.replace(/\\/g, "/"))).toBe(
      true,
    );
    expect(indexReport.backend?.native.byLanguage.markdown).toBeUndefined();
    expect(graphReport.backend?.native.byLanguage.markdown).toBeUndefined();
  });

  it("does not require native availability for graph-only documents", async () => {
    const root = await mkTmpDir("cg-native-doc-required-");
    const page = path.join(root, "page.md");
    const guide = path.join(root, "guide.md");
    await fsp.writeFile(page, "[Guide](./guide.md)\n", "utf8");
    await fsp.writeFile(guide, "# Guide\n", "utf8");
    const requiredError = "native tree-sitter required by explicit option but unavailable";

    const nativeRequiredSpy = vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation(() => {
      throw new Error(requiredError);
    });
    try {
      const index = await buildProjectIndexFromFiles(root, [page, guide], { native: "on" });
      const graph = await collectGraph(root, [page, guide], { native: "on" });

      expect(
        index.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === guide.replace(/\\/g, "/")),
      ).toBe(true);
      expect(graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === guide.replace(/\\/g, "/"))).toBe(
        true,
      );
      expect(nativeRequiredSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
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

  it("reports the same fallback reason to graph and import-binding consumers", async () => {
    const root = await mkTmpDir("cg-fallback-reason-parity-");
    const cases = [
      { file: "app.ts", source: 'import { a } from "./other";\n', language: "ts", expected: "reduced-mode" },
      { file: "mod.py", source: "import pkg\n", language: "python", expected: "unavailable" },
      { file: "style.scss", source: '@use "variables";\n', language: "scss", expected: "unavailable" },
    ];
    try {
      await fsp.writeFile(path.join(root, "other.ts"), "export const a = 1;\n", "utf8");
      await fsp.mkdir(path.join(root, "pkg"));
      await fsp.writeFile(path.join(root, "pkg", "__init__.py"), "x = 1\n", "utf8");
      await fsp.writeFile(path.join(root, "_variables.scss"), "$c: red;\n", "utf8");

      for (const testCase of cases) {
        const file = path.join(root, testCase.file);
        await fsp.writeFile(file, testCase.source, "utf8");
        const support = supportById(testCase.language);
        expect(support).toBeDefined();
        if (!support) continue;

        const graphReasons: string[] = [];
        collectModuleSpecifiersFromSource(support, testCase.source, {
          file,
          native: "off",
          onFallbackImportExtraction: (event) => graphReasons.push(event.reason),
        });
        const bindingReasons: string[] = [];
        await collectImportsForFile(file, root, {
          native: "off",
          onFallbackImportExtraction: (event) => bindingReasons.push(event.reason),
        });

        expect(graphReasons).toEqual([testCase.expected]);
        expect(bindingReasons).toEqual([testCase.expected]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("treats inline-only named specifiers as type-only and mixed clauses as runtime", () => {
    const source = [
      "import { type Foo } from './only'",
      "import { type Foo, bar } from './mixed'",
      "import { type Foo, type Bar } from './all-inline'",
      "import type { Foo } from './types'",
      "import './side'",
      "import {} from './empty'",
      "export { type Baz } from './exp-only'",
      "export { type Baz, qux } from './exp-mixed'",
      "export type { Baz } from './exp-stmt'",
    ].join("\n");

    const specs = extractJsTsSpecifiers(source);
    const bySpec = Object.fromEntries(specs.map((entry) => [entry.spec, Boolean(entry.typeOnly)]));
    expect(bySpec).toMatchObject({
      "./only": true,
      "./mixed": false,
      "./all-inline": true,
      "./types": true,
      "./side": false,
      "./empty": false,
      "./exp-only": true,
      "./exp-mixed": false,
      "./exp-stmt": true,
    });
  });

  it("treats comments as whitespace around type modifiers", () => {
    expect(isJsTsTypeOnlySpecifierStatement('import { type/* erased */Foo } from "./types";')).toBe(true);
    expect(isJsTsTypeOnlySpecifierStatement('export type{Foo}from "./types";')).toBe(true);
  });
});

async function writeReducedFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
  }
}

function normalizedAbsolute(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

describe("reduced-mode text import extraction registry", () => {
  it("recovers module specifiers without the native addon for every wired language", () => {
    const cases: Array<{ language: string; file: string; source: string; expected: string[] }> = [
      {
        language: "java",
        file: "Consumer.java",
        source: "import pkg.Target;\nimport static pkg.Util.helper;\n",
        expected: ["pkg.Target", "pkg.Util.helper"],
      },
      {
        language: "kotlin",
        file: "Consumer.kt",
        source: "import pkg.Target\nimport pkg.Beta as B\nimport pkg.inner.*\n",
        expected: ["pkg.Target", "pkg.Beta", "pkg.inner"],
      },
      {
        language: "rust",
        file: "consumer.rs",
        source: "use crate::helper::Thing;\nmod sibling;\n",
        expected: ["crate::helper", "sibling"],
      },
      {
        language: "csharp",
        file: "Consumer.cs",
        source: "using Pkg;\nusing Beta = Pkg.Beta;\n",
        expected: ["Pkg", "Pkg.Beta"],
      },
      {
        language: "php",
        file: "Consumer.php",
        source: "<?php\nuse Pkg\\Target;\nuse Pkg\\{Beta, Gamma};\n",
        expected: ["Pkg\\Target", "Pkg\\Beta", "Pkg\\Gamma"],
      },
      {
        language: "python",
        file: "consumer.py",
        source: "import pkg\nfrom other import thing\n",
        expected: ["pkg", "other"],
      },
      {
        language: "go",
        file: "main.go",
        source: 'package main\n\nimport "example/app"\n',
        expected: ["example/app"],
      },
      {
        language: "go",
        file: "grouped.go",
        source: 'package main\n\nimport (\n\t"fmt"\n\talias "example/app"\n)\n',
        expected: ["fmt", "example/app"],
      },
      {
        language: "ruby",
        file: "main.rb",
        source: 'require "set"\nrequire_relative "./lib/target"\nautoload :Lazy, "lazy/thing"\n',
        expected: ["set", "./lib/target", "lazy/thing"],
      },
      {
        language: "c",
        file: "main.c",
        source: '#include <stdio.h>\n#include "./dep.h"\n',
        expected: ["stdio.h", "./dep.h"],
      },
      {
        language: "cpp",
        file: "main.cpp",
        source: '#include <vector>\n#include "./dep.h"\n',
        expected: ["vector", "./dep.h"],
      },
      {
        language: "swift",
        file: "main.swift",
        source: "import Foundation\nimport struct Nested.Thing\n",
        expected: ["Foundation", "Nested.Thing"],
      },
      {
        language: "zig",
        file: "main.zig",
        source: 'const std = @import("std");\n',
        expected: ["std"],
      },
    ];
    for (const testCase of cases) {
      const support = supportById(testCase.language);
      expect(support, testCase.language).toBeDefined();
      if (!support) continue;
      const specifiers = collectModuleSpecifiersFromSource(support, testCase.source, {
        file: testCase.file,
        native: "off",
      }).map((entry) => entry.spec);
      expect(specifiers, `${testCase.language} ${testCase.file}`).toEqual(testCase.expected);
    }
  });

  it("reports an empty list for a language with no text extractor", () => {
    const support = supportById("sql");
    expect(support).toBeDefined();
    if (!support) return;
    expect(collectModuleSpecifiersFromSource(support, "SELECT 1;\n", { file: "q.sql", native: "off" })).toEqual([]);
  });

  const edgeFixtures: Array<{
    label: string;
    entry: string;
    indexFiles: string[];
    files: Record<string, string>;
    target: string;
    binding?: Record<string, unknown>;
    options?: { graph?: { resolutionHints: string[] } };
  }> = [
    {
      label: "java",
      entry: "Consumer.java",
      indexFiles: ["Consumer.java", "pkg/Target.java"],
      files: {
        "pkg/Target.java": "package pkg;\n\npublic class Target {}\n",
        "Consumer.java": "import pkg.Target;\n\npublic class Consumer {}\n",
      },
      target: "pkg/Target.java",
      binding: { kind: "named", local: "Target", imported: "Target", from: "pkg.Target" },
    },
    {
      label: "kotlin",
      entry: "Consumer.kt",
      indexFiles: ["Consumer.kt", "pkg/Target.kt"],
      files: {
        "pkg/Target.kt": "package pkg\n\nclass Target\n",
        "Consumer.kt": "import pkg.Target\n\nclass Consumer\n",
      },
      target: "pkg/Target.kt",
      binding: { kind: "named", local: "Target", imported: "Target", from: "pkg.Target" },
    },
    {
      label: "rust",
      entry: "src/consumer.rs",
      indexFiles: ["src/lib.rs", "src/helper.rs", "src/consumer.rs"],
      files: {
        "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"\n',
        "src/lib.rs": "mod helper;\npub mod consumer;\n",
        "src/helper.rs": "pub struct Thing;\n",
        "src/consumer.rs": "use crate::helper::Thing;\n",
      },
      target: "src/helper.rs",
      binding: { kind: "named", local: "Thing", imported: "Thing", from: "crate::helper" },
    },
    {
      label: "csharp",
      entry: "Consumer.cs",
      indexFiles: ["Consumer.cs", "pkg/Target.cs"],
      files: {
        "pkg/Target.cs": "namespace Pkg\n{\n    public class Target {}\n}\n",
        "Consumer.cs": "using Pkg;\n\nnamespace App\n{\n    public class Consumer {}\n}\n",
      },
      target: "pkg/Target.cs",
      binding: { kind: "star", from: "Pkg" },
    },
    {
      label: "php",
      entry: "Consumer.php",
      indexFiles: ["Consumer.php", "Pkg/Target.php"],
      files: {
        "Pkg/Target.php": "<?php\n\nnamespace Pkg;\n\nclass Target {}\n",
        "Consumer.php": "<?php\n\nuse Pkg\\Target;\n",
      },
      target: "Pkg/Target.php",
      binding: { kind: "named", local: "Target", imported: "Target", from: "Pkg\\Target" },
    },
    {
      label: "python",
      entry: "consumer.py",
      indexFiles: ["consumer.py", "pkg/__init__.py"],
      files: {
        "pkg/__init__.py": "value = 1\n",
        "consumer.py": "import pkg\n",
      },
      target: "pkg/__init__.py",
      binding: { kind: "namespace", localNS: "pkg", from: "pkg" },
    },
    {
      label: "go",
      entry: "main.go",
      indexFiles: ["main.go", "app/target.go"],
      files: {
        "go.mod": "module example\n\ngo 1.22\n",
        "app/target.go": "package app\n",
        "main.go": 'package main\n\nimport "example/app"\n',
      },
      target: "app/target.go",
    },
    {
      label: "ruby",
      entry: "main.rb",
      indexFiles: ["main.rb", "lib/target.rb"],
      files: {
        "lib/target.rb": "class Target\nend\n",
        "main.rb": 'require_relative "./lib/target"\n',
      },
      target: "lib/target.rb",
    },
    {
      label: "c",
      entry: "main.c",
      indexFiles: ["main.c", "dep.h"],
      files: {
        "dep.h": "int dep(void);\n",
        "main.c": '#include "./dep.h"\n\nint main(void) { return dep(); }\n',
      },
      target: "dep.h",
    },
    {
      label: "cpp",
      entry: "main.cpp",
      indexFiles: ["main.cpp", "dep.h"],
      files: {
        "dep.h": "int dep();\n",
        "main.cpp": '#include "./dep.h"\n\nint main() { return dep(); }\n',
      },
      target: "dep.h",
    },
    {
      label: "swift",
      entry: "main.swift",
      indexFiles: ["main.swift", "Dep.swift"],
      files: {
        "Dep.swift": "public struct Dep {}\n",
        "main.swift": "import Dep\n",
      },
      target: "Dep.swift",
    },
    {
      label: "zig",
      entry: "main.zig",
      indexFiles: ["main.zig", "dep.zig"],
      files: {
        "dep.zig": "pub const value = 1;\n",
        "main.zig": 'const dep = @import("dep.zig");\n',
      },
      target: "dep.zig",
      options: { graph: { resolutionHints: ["."] } },
    },
  ];

  for (const fixture of edgeFixtures) {
    const expectation = fixture.binding ? "an import binding" : "no fabricated binding";
    it(`recovers ${fixture.label} file edges and ${expectation} without the native addon`, async () => {
      const root = await mkTmpDir(`cg-reduced-registry-${fixture.label}-`);
      try {
        await writeReducedFixture(root, fixture.files);
        const entry = path.join(root, fixture.entry);
        const index = await buildProjectIndexFromFiles(
          root,
          fixture.indexFiles.map((file) => path.join(root, file)),
          { native: "off", ...(fixture.options ?? {}) },
        );

        const targetPath = normalizedAbsolute(path.join(root, fixture.target));
        expect(
          index.graph.edges.some(
            (edge) => edge.from === normalizedAbsolute(entry) && edge.to.type === "file" && edge.to.path === targetPath,
          ),
          `${fixture.label} edge to ${fixture.target}`,
        ).toBe(true);

        const imports = index.byFile.get(fileIdentityKey(entry))?.imports ?? [];
        if (fixture.binding) {
          expect(imports).toEqual([expect.objectContaining(fixture.binding)]);
        } else {
          expect(imports).toEqual([]);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("recovers no import from a forged import inside a string or a comment", async () => {
    const root = await mkTmpDir("cg-reduced-forged-import-");
    const cases: Array<{
      language: string;
      file: string;
      source: string;
      expected: string[];
      expectedBindings: string[];
    }> = [
      {
        language: "go",
        file: "main.go",
        source: [
          "package main",
          "",
          '// import "fake/comment"',
          'var doc = `import "fake/raw"`',
          'var interp = "start import \\"fake/string\\" end"',
          'import "real/pkg"',
          "",
        ].join("\n"),
        expected: ["real/pkg"],
        expectedBindings: [],
      },
      {
        language: "ruby",
        file: "main.rb",
        source: [
          '# require "fake/comment"',
          "=begin",
          'require "fake/block"',
          "=end",
          "doc = \"require 'fake/string'\"",
          'require "real/gem"',
          "",
        ].join("\n"),
        expected: ["real/gem"],
        expectedBindings: [],
      },
      {
        language: "php",
        file: "Consumer.php",
        source: [
          "<?php",
          "// use Fake\\Comment;",
          "/* require 'fake/block.php'; */",
          '$doc = "use Fake\\\\String;";',
          "use Real\\Target;",
          "",
        ].join("\n"),
        expected: ["Real\\Target"],
        expectedBindings: ["Real\\Target"],
      },
    ];

    try {
      for (const testCase of cases) {
        const support = supportById(testCase.language);
        expect(support, testCase.language).toBeDefined();
        if (!support) continue;
        const specifiers = collectModuleSpecifiersFromSource(support, testCase.source, {
          file: path.join(root, testCase.file),
          native: "off",
        }).map((entry) => entry.spec);
        expect(specifiers, `${testCase.language} graph specifiers`).toEqual(testCase.expected);

        const bindings = await collectImportsForFile(path.join(root, testCase.file), root, {
          source: testCase.source,
          sup: support,
          native: "off",
        });
        expect(
          bindings.map((binding) => binding.from),
          `${testCase.language} bindings`,
        ).toEqual(testCase.expectedBindings);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a Rust #[path] attribute from the raw statement in reduced mode", async () => {
    const root = await mkTmpDir("cg-reduced-rust-path-attribute-");
    try {
      await writeReducedFixture(root, {
        "Cargo.toml": '[package]\nname = "path-attr"\nversion = "0.1.0"\n',
        "src/lib.rs": '#[path = "custom.rs"]\nmod external;\npub mod consumer;\n',
        "src/custom.rs": "pub struct Thing;\n",
        "src/external.rs": "pub struct Decoy;\n",
        "src/consumer.rs": "use crate::external::Thing;\n",
      });
      const lib = path.join(root, "src/lib.rs");
      const custom = path.join(root, "src/custom.rs");
      const index = await buildProjectIndexFromFiles(
        root,
        [lib, custom, path.join(root, "src/external.rs"), path.join(root, "src/consumer.rs")],
        { native: "off" },
      );

      expect(
        index.graph.edges.some(
          (edge) =>
            edge.from === normalizedAbsolute(lib) &&
            edge.to.type === "file" &&
            edge.to.path === normalizedAbsolute(custom),
        ),
        "lib.rs edge to the #[path] module",
      ).toBe(true);
      expect(index.byFile.get(fileIdentityKey(lib))?.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "namespace",
            localNS: "external",
            from: "external",
            resolved: normalizedAbsolute(custom),
          }),
        ]),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("agrees between the graph path and the indexer path for the same source", async () => {
    const root = await mkTmpDir("cg-reduced-path-agreement-");
    const cases: Array<{ language: string; file: string; source: string }> = [
      { language: "java", file: "Consumer.java", source: "import pkg.Target;\nimport pkg.Other;\n" },
      { language: "kotlin", file: "Consumer.kt", source: "import pkg.Target\nimport pkg.Other as Alias\n" },
      { language: "rust", file: "consumer.rs", source: "use crate::helper::Thing;\nuse crate::helper::Other;\n" },
      { language: "csharp", file: "Consumer.cs", source: "using Pkg;\nusing Alias = Pkg.Beta;\n" },
      { language: "php", file: "Consumer.php", source: "<?php\nuse Pkg\\Target;\nuse Pkg\\Beta;\n" },
    ];

    try {
      for (const testCase of cases) {
        const support = supportById(testCase.language);
        expect(support, testCase.language).toBeDefined();
        if (!support) continue;
        const file = path.join(root, testCase.file);
        const graphSpecifiers = collectModuleSpecifiersFromSource(support, testCase.source, {
          file,
          native: "off",
        })
          .map((entry) => entry.spec)
          .sort();
        const bindings = await collectImportsForFile(file, root, {
          source: testCase.source,
          sup: support,
          native: "off",
        });
        const bindingSources = Array.from(new Set(bindings.map((binding) => binding.from))).sort();
        expect(bindingSources, `${testCase.language} specifiers`).toEqual(graphSpecifiers);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("reduced-mode C-family include form extraction", () => {
  type IncludeExtraction = { spec: string; includeForm: "literal" | "angle" | "macro" | undefined };

  function reducedIncludeSpecifiers(language: string, source: string, file: string): IncludeExtraction[] {
    const support = supportById(language);
    expect(support, language).toBeDefined();
    if (!support) return [];
    return collectModuleSpecifiersFromSource(support, source, { file, native: "off" }).map((entry) => ({
      spec: entry.spec,
      includeForm: entry.includeForm,
    }));
  }

  const firstTokenCases: Array<{
    label: string;
    language: string;
    file: string;
    source: string;
    expected: IncludeExtraction[];
  }> = [
    {
      label: "quoted",
      language: "c",
      file: "main.c",
      source: '#include "x.h"\n',
      expected: [{ spec: "x.h", includeForm: "literal" }],
    },
    {
      label: "quoted subdirectory",
      language: "cpp",
      file: "main.cpp",
      source: '#include "inc/x.h"\n',
      expected: [{ spec: "inc/x.h", includeForm: "literal" }],
    },
    {
      label: "quoted after a comment",
      language: "c",
      file: "main.c",
      source: '#include /* note */ "x.h"\n',
      expected: [{ spec: "x.h", includeForm: "literal" }],
    },
    {
      label: "angle",
      language: "c",
      file: "main.c",
      source: "#include <stdio.h>\n",
      expected: [{ spec: "stdio.h", includeForm: "angle" }],
    },
    {
      label: "angle with a path",
      language: "cpp",
      file: "main.cpp",
      source: "#include <sys/types.h>\n",
      expected: [{ spec: "sys/types.h", includeForm: "angle" }],
    },
    {
      label: "spaced directive",
      language: "cpp",
      file: "main.cpp",
      source: "#  include\t<vector>\n",
      expected: [{ spec: "vector", includeForm: "angle" }],
    },
    {
      label: "identifier macro",
      language: "c",
      file: "main.c",
      source: "#include HEADER\n",
      expected: [{ spec: "HEADER", includeForm: "macro" }],
    },
    {
      label: "identifier macro after a comment",
      language: "cpp",
      file: "main.cpp",
      source: "#include /* guard */ HEADER\n",
      expected: [{ spec: "HEADER", includeForm: "macro" }],
    },
    {
      label: "identifier macro with a trailing comment",
      language: "c",
      file: "main.c",
      source: "#include HEADER // guard\n",
      expected: [{ spec: "HEADER", includeForm: "macro" }],
    },
  ];

  it("classifies every include by its first token after the directive", () => {
    for (const testCase of firstTokenCases) {
      const extracted = reducedIncludeSpecifiers(testCase.language, testCase.source, testCase.file);
      expect(extracted, testCase.label).toEqual(testCase.expected);
    }
  });

  it("rejects a function-like include macro instead of the string nested inside it", () => {
    const sources = [
      '#include MACRO("x.h")\n',
      '#include MACRO ("x.h")\n',
      "#include MACRO(<x.h>)\n",
      '#include MACRO("x.h", 1)\n',
      "#include HEADER trailing\n",
    ];
    for (const language of ["c", "cpp"]) {
      for (const source of sources) {
        const extracted = reducedIncludeSpecifiers(language, source, language === "c" ? "main.c" : "main.cpp");
        expect(extracted, `${language} ${JSON.stringify(source)}`).toEqual([]);
        expect(extracted.map((entry) => entry.spec)).not.toContain("x.h");
      }
    }
  });

  it("keeps mixed include occurrences in source order with their own form", () => {
    const source = [
      '#include "local.h"',
      "#include <system.h>",
      "#include HEADER",
      '#include MACRO("ignored.h")',
      "int main(void) { return 0; }",
      "",
    ].join("\n");

    expect(reducedIncludeSpecifiers("c", source, "main.c")).toEqual([
      { spec: "local.h", includeForm: "literal" },
      { spec: "system.h", includeForm: "angle" },
      { spec: "HEADER", includeForm: "macro" },
    ]);
  });

  it("keeps the same include text once literal and once as a macro", () => {
    const source = ['#include "HEADER"', "#include HEADER", "int main(void) { return 0; }", ""].join("\n");

    expect(reducedIncludeSpecifiers("c", source, "main.c")).toEqual([
      { spec: "HEADER", includeForm: "literal" },
      { spec: "HEADER", includeForm: "macro" },
    ]);
  });

  it("binds only the literal occurrence and keeps a macro include external in reduced mode", async () => {
    const root = await mkTmpDir("cg-reduced-include-forms-");
    try {
      await writeReducedFixture(root, {
        HEADER: "int header_decl(void);\n",
        "x.h": "int decoy(void);\n",
        "main.c": [
          '#include "HEADER"',
          "#include HEADER",
          '#include MACRO("x.h")',
          "int main(void) { return 0; }",
          "",
        ].join("\n"),
      });
      const main = path.join(root, "main.c");
      const index = await buildProjectIndexFromFiles(
        root,
        ["HEADER", "x.h", "main.c"].map((relative) => path.join(root, relative)),
        { native: "off" },
      );

      const edges = index.graph.edges.filter((edge) => normalizedAbsolute(edge.from) === normalizedAbsolute(main));
      expect(edges).toContainEqual(
        expect.objectContaining({ to: { type: "file", path: normalizedAbsolute(path.join(root, "HEADER")) } }),
      );
      expect(edges).toContainEqual(expect.objectContaining({ to: { type: "external", name: "HEADER" } }));

      const decoy = normalizedAbsolute(path.join(root, "x.h"));
      const decoyEdges = edges.filter((edge) =>
        edge.to.type === "file" ? edge.to.path === decoy : edge.to.name.includes("x.h"),
      );
      expect(decoyEdges).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
