import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { buildProjectIndex, collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { expectFileInIndex, findSymbolsByName } from "../test-utils.js";
import { findReferences, goToDefinition } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

const definition: LanguageTestDefinition = {
  id: "python",
  samples: [
    {
      name: "chunks Python with docstrings",
      sourceFile: "python.sample.py",
      exactChunks: [
        { type: "docstring", startLine: 1, endLine: 2 },
        { type: "imports", startLine: 3, endLine: 3 },
        { type: "imports", startLine: 4, endLine: 5 },
        { type: "module_var", name: "CONFIG_PATH", startLine: 6, endLine: 7 },
        { type: "class", name: "Foo", startLine: 8, endLine: 15 },
        { type: "function", name: "method", startLine: 11, endLine: 17 },
        { type: "function", name: "top_level", startLine: 18, endLine: 22 },
      ],
    },
  ],
  parity: {
    sampleDir: "python",
    exact: {
      dependencyGraph: [
        {
          from: "relative-imports.py",
          to: { type: "file", path: "helpers.py" },
        },
        {
          from: "relative-imports.py",
          to: { type: "file", path: "utils.py" },
        },
        {
          from: "utils.py",
          to: { type: "file", path: "helpers.py" },
        },
        {
          from: "package_exports/__init__.py",
          to: { type: "file", path: "package_exports/values.py" },
        },
        {
          from: "package_consumer.py",
          to: { type: "file", path: "package_exports/__init__.py" },
        },
      ],
      references: [
        {
          name: "finds package __all__ alias references",
          file: "package_exports/values.py",
          line: 1,
          column: 5,
          references: [
            { file: "package_exports/values.py", line: 1 },
            { file: "package_consumer.py", line: 1 },
            { file: "package_consumer.py", line: 3 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves a match keyword-pattern bound variable from its usage site",
        file: "match_patterns.py",
        line: 10,
        column: 20,
        expectedDefinition: { file: "match_patterns.py", line: 9 },
      },
      {
        name: "go to definition resolves an __all__ package alias from a consumer",
        file: "package_consumer.py",
        line: 3,
        column: 10,
        expectedDefinition: { file: "package_exports/values.py", line: 1 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Python stub discovery", () => {
  it("discovers and indexes .pyi declarations", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "python");
    const stubFile = path.join(fixturePath, "stubs.pyi");
    const index = await buildProjectIndex(fixturePath, { cache: "off" });

    expectFileInIndex(index, stubFile);
    expect(findSymbolsByName(index, "StubType", stubFile)).toHaveLength(1);
    expect(findSymbolsByName(index, "stub_function", stubFile)).toHaveLength(1);
  });
});

describe("Python match bindings", () => {
  it("resolves tuple and as-pattern captures as local symbols", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "python");
    const file = path.join(fixturePath, "match_bindings.py");
    const index = await buildProjectIndex(fixturePath, { cache: "off" });

    expect(findSymbolsByName(index, "x", file)).toHaveLength(1);
    expect(findSymbolsByName(index, "y", file)).toHaveLength(1);
    expect(findSymbolsByName(index, "w", file)).toHaveLength(1);

    const tupleUsage = await goToDefinition(index, { file, line: 4, column: 20 });
    expect(tupleUsage.status).toBe("ok");
    if (tupleUsage.status === "ok") expect(tupleUsage.definition.range.start.line).toBe(3);

    const aliasUsage = await goToDefinition(index, { file, line: 6, column: 20 });
    expect(aliasUsage.status).toBe("ok");
    if (aliasUsage.status === "ok") expect(aliasUsage.definition.range.start.line).toBe(5);

    const tupleReferences = await findReferences(index, { file, line: 3, column: 15 });
    expect(tupleReferences.status).toBe("ok");
    if (tupleReferences.status === "ok") expect(tupleReferences.references).toHaveLength(2);

    const aliasReferences = await findReferences(index, { file, line: 5, column: 19 });
    expect(aliasReferences.status).toBe("ok");
    if (aliasReferences.status === "ok") expect(aliasReferences.references).toHaveLength(2);
  });
});

describe("Python local imports", () => {
  it("does not expose a function-local import to consumers", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-local-import-"));
    const packageDir = path.join(root, "sample");
    const sourceFile = path.join(packageDir, "source.py");
    const barrelFile = path.join(packageDir, "barrel.py");
    const consumerFile = path.join(root, "consumer.py");
    await fsp.mkdir(packageDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(packageDir, "__init__.py"), "", "utf8"),
      fsp.writeFile(sourceFile, "def hidden():\n    return 1\n", "utf8"),
      fsp.writeFile(barrelFile, "def use_hidden():\n    from .source import hidden\n    return hidden()\n", "utf8"),
      fsp.writeFile(consumerFile, "from sample.barrel import hidden\nhidden()\n", "utf8"),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const barrel = index.byFile.get(fileIdentityKey(barrelFile));
      const result = await goToDefinition(index, { file: consumerFile, line: 2, column: 1 });

      expect(barrel?.exports.some((entry) => entry.exportedAs === "hidden")).toBe(false);
      expect(result.status).not.toBe("ok");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python namespace reexports", () => {
  it("exposes a module-level package namespace import", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-namespace-reexport-"));
    const packageDir = path.join(root, "sample");
    const barrelFile = path.join(packageDir, "__init__.py");
    const valuesFile = path.join(packageDir, "values.py");
    await fsp.mkdir(packageDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(barrelFile, "import sample.values as values\n", "utf8"),
      fsp.writeFile(valuesFile, "value = 1\n", "utf8"),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const barrel = index.byFile.get(fileIdentityKey(barrelFile));

      expect(barrel?.exports).toContainEqual({
        type: "namespaceReexport",
        exportedAs: "values",
        fromModule: valuesFile.replace(/\\/g, "/"),
        moduleSpecifier: "sample.values",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python __all__ exports", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-all-"));
    const file = path.join(root, "test.py");
    await fsp.writeFile(file, source, "utf8");
    try {
      const parsed = await parseFile(file);
      return collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        tree: parsed.tree,
        nativeQueries: parsed.nativeQueries,
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  it("extracts exports from __all__ tuple assignment", async () => {
    const source = `
def foo(): pass
def bar(): pass

__all__ = (
    "foo",
    "bar",
)
`;
    const mod = await collectModule(source);

    const exportedNames = mod.exports.map((e) => e.exportedAs).sort();
    expect(exportedNames).toEqual(["bar", "foo"]);
  });

  it("avoids false positives from nearby strings in fallback", async () => {
    // The current fallback just scans 800 chars after __all__.
    // If we have a string that matches a local name, it will be exported.
    const source = `
def foo(): pass
def private_func(): pass

__all__ = ["foo"]

# "private_func" is mentioned in a string nearby, but not in __all__
description = "This module uses private_func internally"
`;
    const mod = await collectModule(source);

    const exportedNames = mod.exports.map((e) => e.exportedAs).sort();
    // It should NOT contain private_func
    expect(exportedNames).toEqual(["foo"]);
  });
});
