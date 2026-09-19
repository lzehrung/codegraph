import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { createTestIndexFromFiles, findSymbolsByName } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { findReferences, goToDefinition } from "../../src/index.js";

const definition: LanguageTestDefinition = {
  id: "javascript",
  samples: [
    {
      name: "chunks basic JavaScript structures",
      sourceFile: "javascript.sample.js",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 2 },
        { type: "imports", startLine: 3, endLine: 4 },
        { type: "module_var", name: "API_BASE_URL", startLine: 5, endLine: 6 },
        { type: "class", name: "Foo", startLine: 7, endLine: 18 },
        { type: "method", name: "constructor", startLine: 8, endLine: 10 },
        { type: "method", name: "bar", startLine: 12, endLine: 17 },
        { type: "misc", startLine: 18, endLine: 19 },
        { type: "comment", startLine: 20, endLine: 20 },
        { type: "function", name: "baz", startLine: 21, endLine: 23 },
      ],
    },
  ],
  parity: {
    sampleDir: "javascript",
    exact: {
      dependencyGraph: [
        {
          from: "dynamic-import.js",
          to: { type: "file", path: "helpers.js" },
        },
        {
          from: "main.js",
          to: { type: "file", path: "helpers.js" },
        },
        {
          from: "main.js",
          to: { type: "file", path: "utils.js" },
        },
        {
          from: "utils.js",
          to: { type: "file", path: "helpers.js" },
        },
      ],
      references: [
        {
          name: "find references for helpers.js helperFunction distinguishes the same-named utils.js export",
          file: "helpers.js",
          line: 1,
          column: 17,
          references: [
            { file: "helpers.js", line: 1 },
            { file: "helpers.js", line: 18 },
            { file: "main.js", line: 25 },
            { file: "main.js", line: 33 },
          ],
        },
        {
          name: "find references for UtilityClass.getValue resolves through the receiver",
          file: "utils.js",
          line: 10,
          column: 3,
          references: [
            { file: "main.js", line: 13 },
            { file: "utils.js", line: 10 },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);

describe("CommonJS spread exports", () => {
  it("resolves static sources and reports unresolved spread sources", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "javascript");
    const baseFile = path.join(fixturePath, "spread-base.js").replace(/\\/g, "/");
    const barrelFile = path.join(fixturePath, "spread-exports.js").replace(/\\/g, "/");
    const consumerFile = path.join(fixturePath, "spread-consumer.js").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(fixturePath, [baseFile, barrelFile, consumerFile]);
    const barrel = index.byFile.get(fileIdentityKey(barrelFile));

    expect(barrel).toBeDefined();
    if (!barrel) return;
    expect(barrel.exports).toContainEqual({
      type: "exportStar",
      fromModule: baseFile,
      moduleSpecifier: "./spread-base",
      sourceSpecifier: "./spread-base",
    });
    expect(barrel.exports).toContainEqual({
      type: "namespaceReexport",
      exportedAs: "<unresolved cjs spread: dynamic>",
      fromModule: "<unresolved cjs spread: dynamic>",
    });
    expect(barrel.exports.map((entry) => (entry.type === "local" ? entry.exportedAs : entry.type))).toContain(
      "localFunction",
    );
    const baseResult = await goToDefinition(index, { file: consumerFile, line: 3, column: 2 });
    expect(baseResult.status).toBe("ok");
    if (baseResult.status === "ok") {
      expect(baseResult.definition.file).toBe(baseFile);
      expect(baseResult.definition.range.start.line).toBe(1);
    }
    const localResult = await goToDefinition(index, { file: consumerFile, line: 4, column: 2 });
    expect(localResult.status).toBe("ok");
    if (localResult.status === "ok") {
      expect(localResult.definition.file).toBe(barrelFile);
      expect(localResult.definition.range.start.line).toBe(3);
    }
  });
});

describe("JavaScript CommonJS export and static-block scopes", () => {
  it("does not publish object properties as CommonJS exports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-js-export-filter-"));
    const file = path.join(root, "exports.js");
    const source = [
      "const local = 1;",
      "other.foo = local;",
      "config.setting = local;",
      "module.foo = function () {};",
      "module.bar = () => {};",
      "module.exports.real = local;",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));

      expect(module?.exports).toContainEqual(expect.objectContaining({ type: "local", exportedAs: "real" }));
      expect(module?.exports).not.toContainEqual(expect.objectContaining({ type: "local", exportedAs: "foo" }));
      expect(module?.exports).not.toContainEqual(expect.objectContaining({ type: "local", exportedAs: "setting" }));
      expect(module?.exports).not.toContainEqual(expect.objectContaining({ type: "local", exportedAs: "bar" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve static-block locals from sibling methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-js-static-block-scope-"));
    const file = path.join(root, "scope.js");
    const source = "class C { static { let hidden = 1; } method() { return hidden; } }";
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);

      expect(await goToDefinition(index, { file, line: 1, column: source.lastIndexOf("hidden") + 1 })).toMatchObject({
        status: "not_found",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JavaScript variable_declarator initializer references", () => {
  it("finds a reference to an imported symbol used as a bare initializer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-js-decl-init-"));
    const aFile = path.join(root, "a.js");
    const bFile = path.join(root, "b.js");
    try {
      await writeFile(aFile, "export function helper() {\n  return 1;\n}\n", "utf8");
      await writeFile(bFile, "import { helper } from './a.js';\n\nconst alias = helper;\n", "utf8");
      const index = await createTestIndexFromFiles(root, [aFile, bFile]);

      const references = await findReferences(index, { file: aFile, line: 1, column: 17 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((entry) => entry.range.start.line)).toContain(3);
      }

      // Regression: the declarator's own name (`alias`) must still be classified as a
      // legitimate declaration, not swallowed by the initializer-identity check.
      expect(findSymbolsByName(index, "alias", bFile)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JavaScript class field navigation", () => {
  it("resolves class fields and keeps initializer reads as references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-js-field-"));
    const apiFile = path.join(root, "api.js").replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer.js").replace(/\\/g, "/");
    const apiSource = ["export const source = 1;", "export class Box {", "  static value = source;", "}", ""].join(
      "\n",
    );
    const consumerSource = ['import { Box } from "./api.js";', "Box.value;", ""].join("\n");
    try {
      await Promise.all([writeFile(apiFile, apiSource, "utf8"), writeFile(consumerFile, consumerSource, "utf8")]);
      const index = await createTestIndexFromFiles(root, [apiFile, consumerFile]);

      const field = await goToDefinition(index, {
        file: consumerFile,
        line: 2,
        column: consumerSource.split("\n")[1]!.indexOf("value") + 1,
      });
      expect(field.status).toBe("ok");
      if (field.status === "ok") {
        expect(field.definition.file).toBe(apiFile);
        expect(field.definition.range.start.line).toBe(3);
      }

      const references = await findReferences(index, {
        file: apiFile,
        line: 1,
        column: apiSource.split("\n")[0]!.indexOf("source") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((reference) => reference.range.start.line)).toContain(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
