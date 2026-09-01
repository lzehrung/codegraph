import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { buildProjectIndex, collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { expectFileInIndex, findSymbolsByName } from "../test-utils.js";
import { collectGraph, findReferences, goToDefinition } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { exportedNameOf } from "../helpers/narrow.js";

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

      expect(barrel?.exports.some((entry) => exportedNameOf(entry) === "hidden")).toBe(false);
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
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
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

    const exportedNames = mod.exports.map((e) => exportedNameOf(e)).sort();
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

    const exportedNames = mod.exports.map((e) => exportedNameOf(e)).sort();
    // It should NOT contain private_func
    expect(exportedNames).toEqual(["foo"]);
  });
});

describe("Python dynamic imports", () => {
  it("maps supported static forms, preserves precise edges, and rejects unsafe guesses", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-dynamic-import-"));
    const packageDir = path.join(root, "pkg");
    const sourceFile = path.join(packageDir, "loader.py");
    const dynamicTargetNames = [
      "direct.py",
      "alias.py",
      "function.py",
      "builtin.py",
      "canonical.py",
      "relative.py",
      "triple.py",
      "créer.py",
    ];
    const ignoredNames = ["string_only.py", "comment_only.py", "computed.py", "2invalid.py", "builtin_relative.py"];
    await fsp.mkdir(packageDir, { recursive: true });
    const source = [
      "import importlib, importlib as module_loader",
      "import pkg.precise",
      "from importlib import (",
      "    import_module,",
      "    import_module as load_module,",
      ")",
      "",
      'module_loader.import_module("pkg.direct")',
      'load_module(name="pkg.alias")',
      'import_module("pkg.function")',
      '__import__(r"pkg.builtin")',
      'importlib.import_module(f"pkg.canonical")',
      'importlib.import_module(".relative", package="pkg")',
      'importlib.import_module("""pkg.triple""")',
      'importlib.import_module("pkg.créer")',
      'importlib.import_module("pkg.precise")',
      '__import__(".builtin_relative")',
      'description = """module_loader.import_module("pkg.string_only")"""',
      '# __import__("pkg.comment_only")',
      'module_name = "pkg.computed"',
      "module_loader.import_module(module_name)",
      'module_loader.import_module("pkg.2invalid")',
      '__import__("optional_plugin")',
      "",
    ].join("\n");
    const files = [
      path.join(packageDir, "__init__.py"),
      sourceFile,
      path.join(packageDir, "precise.py"),
      ...[...dynamicTargetNames, ...ignoredNames].map((name) => path.join(packageDir, name)),
    ];
    await Promise.all(files.map((file) => fsp.writeFile(file, file === sourceFile ? source : "", "utf8")));

    try {
      const normalizedSource = sourceFile.replace(/\\/g, "/");
      const disabled = await collectGraph(root, files);
      const disabledLocalNames = disabled.edges
        .filter((edge) => edge.from === normalizedSource && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : ""));
      expect(disabledLocalNames).toEqual(["precise.py"]);

      const enabled = await collectGraph(root, files, { dynamicImportHeuristics: true });
      const localEdges = enabled.edges.filter((edge) => edge.from === normalizedSource && edge.to.type === "file");
      const heuristicLocalNames = localEdges
        .filter((edge) => edge.resolved === "heuristic" && edge.confidence === 0.7)
        .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : ""))
        .sort();
      expect(heuristicLocalNames).toEqual([...dynamicTargetNames].sort());

      const preciseEdge = localEdges.find(
        (edge) => edge.to.type === "file" && path.basename(edge.to.path) === "precise.py",
      );
      expect(preciseEdge).toMatchObject({ raw: "pkg.precise" });
      expect(preciseEdge?.resolved).toBeUndefined();
      expect(preciseEdge?.confidence).toBeUndefined();

      expect(enabled.edges).toContainEqual({
        from: normalizedSource,
        to: { type: "external", name: "optional_plugin" },
        raw: "optional_plugin",
        resolved: "heuristic",
        confidence: 0.7,
      });
      const localNames = new Set(
        localEdges.map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : "")),
      );
      for (const ignoredName of ignoredNames) {
        expect(localNames.has(ignoredName)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
