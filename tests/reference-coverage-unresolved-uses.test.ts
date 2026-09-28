import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import * as indexer from "../src/indexer.js";
import type { FindReferencesResult, ProjectIndex, SymbolDef } from "../src/indexer.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTestIndexFromFiles } from "./test-utils.js";

function definitionFor(index: ProjectIndex, file: string, localName: string): SymbolDef {
  const def = index.byFile.get(fileIdentityKey(file))?.locals.find((local) => local.localName === localName);
  if (!def) throw new Error(`Expected a definition for ${localName} in ${file}`);
  return def;
}

/**
 * A same-name use in a scanned candidate file that resolves to nothing must
 * never leave coverage `complete` - it has to become `partial` with a reason, naming the file.
 * A follow-up resolution fix that makes the use fully navigable is an even better outcome than
 * the honest `partial` this item requires, so accept either: `complete` must come with the real
 * usage in the reference list, `partial` must name the file through `strategy_unavailable`.
 */
function expectHonestCoverageForUnverifiedUse(
  result: FindReferencesResult,
  consumerFile: string,
  consumerLine: number,
): void {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  const foundUsage = result.references.some(
    (reference) => reference.file === consumerFile && reference.range.start.line === consumerLine,
  );
  if (result.referenceCoverage.state === "complete") {
    expect(foundUsage).toBe(true);
    return;
  }
  expect(result.referenceCoverage.state).toBe("partial");
  expect(result.referenceCoverage.reasons).toContain("strategy_unavailable");
  expect(result.referenceCoverage.affectedFiles).toContain(consumerFile);
}

describe("no complete coverage while a same-name use resolves to nothing", () => {
  it("marks a JS require() whole-module member access partial instead of silently complete", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-require-"));
    try {
      const utilFile = path.join(root, "util.js").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.js").replace(/\\/g, "/");
      await fsp.writeFile(utilFile, "exports.helper = function helper() {\n  return 42;\n};\n", "utf8");
      await fsp.writeFile(
        consumerFile,
        ['const util = require("./util");', "function run() {", "  return util.helper();", "}", ""].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [utilFile, consumerFile]);
      const def = definitionFor(index, utilFile, "helper");

      const result = await indexer.findReferences(index, { def });
      expectHonestCoverageForUnverifiedUse(result, consumerFile, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("marks a TS dynamic import() whole-module member access partial instead of silently complete", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-dynamic-import-"));
    try {
      const lazyFile = path.join(root, "lazy.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(lazyFile, 'export function thing(): string {\n  return "lazy";\n}\n', "utf8");
      // The fixture below is source text written to disk for the indexer to parse, not a real
      // dynamic import in this test file's own module graph.
      const dynamicImportCall = ["await", "import"].join(" ");
      await fsp.writeFile(
        consumerFile,
        [
          "export async function run(): Promise<string> {",
          `  const mod = ${dynamicImportCall}("./lazy");`,
          "  return mod.thing();",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [lazyFile, consumerFile]);
      const def = definitionFor(index, lazyFile, "thing");

      const result = await indexer.findReferences(index, { def });
      expectHonestCoverageForUnverifiedUse(result, consumerFile, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete coverage when a dynamic-import consumer's only same-name node is an unrelated exported declaration", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-decoy-dynamic-import-"));
    try {
      const lazyFile = path.join(root, "lazy.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(lazyFile, 'export function thing(): string {\n  return "lazy";\n}\n', "utf8");
      // consumer.ts dynamically imports lazy.ts (the same unmodeled-binding shape as the test
      // above), which is exactly what makes the file-dependency-graph fallback add it as a scan
      // candidate; but consumer.ts never calls mod.thing() at all - it has its own unrelated,
      // same-named EXPORTED declaration, so every "thing" node here must resolve to that local
      // export and stay excluded, proving the fallback never adds a reference resolveDefinition
      // did not independently prove.
      const dynamicImportCall = ["await", "import"].join(" ");
      await fsp.writeFile(
        consumerFile,
        [
          "export function thing(): string {",
          '  return "local";',
          "}",
          "export async function run(): Promise<string> {",
          `  const mod = ${dynamicImportCall}("./lazy");`,
          "  return thing() + JSON.stringify(mod);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [lazyFile, consumerFile]);
      const def = definitionFor(index, lazyFile, "thing");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.every((reference) => reference.file !== consumerFile)).toBe(true);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete coverage when a require() consumer's only same-name node is an unrelated local declaration", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-decoy-require-"));
    try {
      const utilFile = path.join(root, "util.js").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.js").replace(/\\/g, "/");
      await fsp.writeFile(utilFile, "exports.helper = function helper() {\n  return 42;\n};\n", "utf8");
      // consumer.js requires util.js under the same whole-module shape as the first test above,
      // but never calls util.helper() at all - its own `helper` is an unrelated, same-named
      // local function, so it must resolve to that local declaration and stay excluded.
      await fsp.writeFile(
        consumerFile,
        [
          'const util = require("./util");',
          "function helper() {",
          '  return "local";',
          "}",
          "function run() {",
          "  return helper() + util.other;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [utilFile, consumerFile]);
      const def = definitionFor(index, utilFile, "helper");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.every((reference) => reference.file !== consumerFile)).toBe(true);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete coverage when a candidate file only mentions the name in a string or comment", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-decoy-text-"));
    try {
      const utilFile = path.join(root, "util.js").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.js").replace(/\\/g, "/");
      await fsp.writeFile(utilFile, "exports.helper = function helper() {\n  return 42;\n};\n", "utf8");
      await fsp.writeFile(
        consumerFile,
        [
          'const util = require("./util");',
          "// this file does not call helper() at all",
          'const message = "call helper if needed";',
          "module.exports = util;",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [utilFile, consumerFile]);
      const def = definitionFor(index, utilFile, "helper");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.every((reference) => reference.file !== consumerFile)).toBe(true);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("does not report complete coverage when a default-imported constructor call fails to resolve its member", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-jsts-default-"));
    try {
      const widgetFile = path.join(root, "widget.ts").replace(/\\/g, "/");
      const useFile = path.join(root, "use.ts").replace(/\\/g, "/");
      await fsp.writeFile(
        widgetFile,
        [
          "export default class Widget {",
          "  static create() { return new Widget(); }",
          "  render() { return 1; }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        useFile,
        ['import Widget from "./widget";', "Widget.create();", "new Widget().render();", ""].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [widgetFile, useFile]);
      const def = definitionFor(index, widgetFile, "render");

      const result = await indexer.findReferences(index, { def });
      expectHonestCoverageForUnverifiedUse(result, useFile, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete coverage when a constructed call resolves to another class's own render", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-other-render-"));
    try {
      const widgetFile = path.join(root, "widget.ts").replace(/\\/g, "/");
      const useFile = path.join(root, "use.ts").replace(/\\/g, "/");
      await fsp.writeFile(widgetFile, "export class Widget {\n  render() { return 1; }\n}\n", "utf8");
      await fsp.writeFile(
        useFile,
        [
          'import { Widget } from "./widget";',
          "class Other {",
          "  render() { return 2; }",
          "}",
          "new Other().render();",
          "void Widget;",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [widgetFile, useFile]);
      const def = definitionFor(index, widgetFile, "render");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.some((reference) => reference.file === useFile)).toBe(false);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete coverage when a fully known local class has no render and no base", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-other-empty-"));
    try {
      const widgetFile = path.join(root, "widget.ts").replace(/\\/g, "/");
      const useFile = path.join(root, "use.ts").replace(/\\/g, "/");
      await fsp.writeFile(widgetFile, "export class Widget {\n  render() { return 1; }\n}\n", "utf8");
      // Other resolves in this file, declares no render, and has no supertype, so the call is a
      // proven non-reference rather than an unresolved member of Widget.
      await fsp.writeFile(
        useFile,
        ['import { Widget } from "./widget";', "class Other {}", "new Other().render();", "void Widget;", ""].join(
          "\n",
        ),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [widgetFile, useFile]);
      const def = definitionFor(index, widgetFile, "render");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.some((reference) => reference.file === useFile)).toBe(false);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps partial coverage when a Kotlin extension is called on an unresolvable receiver", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-kotlin-extension-"));
    try {
      const file = path.join(root, "widget.kt").replace(/\\/g, "/");
      await fsp.writeFile(
        file,
        [
          "package demo",
          "fun Widget.describe(): Int = 1",
          "class Widget",
          "fun show(x: Any): Int = x.describe()",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [file]);
      const def = definitionFor(index, file, "describe");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.some((reference) => reference.range.start.line === 4)).toBe(false);
      expect(result.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["strategy_unavailable"],
        affectedFiles: [file],
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
