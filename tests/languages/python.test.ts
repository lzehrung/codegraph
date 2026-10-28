import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import {
  buildProjectIndex,
  collectImportsForFile,
  collectLocalsAndExportsFromSource,
  parseFile,
  findReferencesById,
  symbolId,
  SymbolKind,
} from "../../src/indexer.js";
import { expectFileInIndex, findSymbolsByName } from "../test-utils.js";
import { collectGraph, findReferences, goToDefinition } from "../../src/index.js";
import { PY_SUPPORT } from "../../src/languages.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { getUnresolvedImports } from "../../src/graphs/unresolved.js";
import { collectModuleSpecifiersFromSource } from "../../src/graphs/specifiers.js";
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
            { file: "package_exports/__init__.py", line: 1 },
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

describe("Python package __all__ alias import tokens", () => {
  it("returns imported and local declaration tokens for the re-exported alias", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "python");
    const valuesFile = path.join(root, "package_exports", "values.py").replace(/\\/g, "/");
    const initFile = path.join(root, "package_exports", "__init__.py").replace(/\\/g, "/");
    const consumerFile = path.join(root, "package_consumer.py").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });
    const result = await findReferences(index, { file: valuesFile, line: 1, column: 5 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const initSource = await fsp.readFile(initFile, "utf8");
    const consumerSource = await fsp.readFile(consumerFile, "utf8");
    const sameFile = (left: string, right: string) => fileIdentityKey(left) === fileIdentityKey(right);
    const tokenAt = (source: string, token: string, occurrence = 0) => {
      let from = 0;
      for (let index = 0; index <= occurrence; index += 1) {
        const found = source.indexOf(token, from);
        if (found < 0) throw new Error(`token not found: ${token}`);
        if (index === occurrence) {
          return {
            column: found - (source.lastIndexOf("\n", found - 1) + 1) + 1,
            index: found,
            text: token,
          };
        }
        from = found + 1;
      }
      throw new Error(`token not found: ${token}`);
    };

    const importedInit = result.references.find(
      (reference) => sameFile(reference.file, initFile) && reference.via?.importBinding === "imported",
    );
    const localInit = result.references.find(
      (reference) => sameFile(reference.file, initFile) && reference.via?.importBinding === "local",
    );
    const importedConsumer = result.references.find(
      (reference) => sameFile(reference.file, consumerFile) && reference.via?.importBinding === "imported",
    );
    const localConsumer = result.references.find(
      (reference) => sameFile(reference.file, consumerFile) && reference.via?.importBinding === "local",
    );
    const usage = result.references.find(
      (reference) =>
        sameFile(reference.file, consumerFile) &&
        reference.range.start.line === 3 &&
        reference.via?.importBinding === undefined,
    );
    const definition = result.references.find(
      (reference) =>
        sameFile(reference.file, valuesFile) &&
        reference.range.start.line === 1 &&
        reference.via?.importBinding === undefined,
    );

    const expectedImportedInit = tokenAt(initSource, "source_value");
    const expectedLocalInit = tokenAt(initSource, "public_value");
    const expectedImportedConsumer = tokenAt(consumerSource, "public_value");
    const expectedLocalConsumer = tokenAt(consumerSource, "selected_value");
    const expectedUsage = tokenAt(consumerSource, "selected_value", 1);

    expect(importedInit?.range.start.column).toBe(expectedImportedInit.column);
    expect(initSource.slice(importedInit!.range.start.index!, importedInit!.range.end.index!)).toBe("source_value");
    expect(localInit?.range.start.column).toBe(expectedLocalInit.column);
    expect(initSource.slice(localInit!.range.start.index!, localInit!.range.end.index!)).toBe("public_value");
    expect(importedConsumer?.range.start.column).toBe(expectedImportedConsumer.column);
    expect(consumerSource.slice(importedConsumer!.range.start.index!, importedConsumer!.range.end.index!)).toBe(
      "public_value",
    );
    expect(localConsumer?.range.start.column).toBe(expectedLocalConsumer.column);
    expect(consumerSource.slice(localConsumer!.range.start.index!, localConsumer!.range.end.index!)).toBe(
      "selected_value",
    );
    expect(usage?.range.start.column).toBe(expectedUsage.column);
    expect(definition).toBeDefined();
    expect(localInit?.range.start.column).not.toBe(importedInit?.range.start.column);
    expect(localConsumer?.range.start.column).not.toBe(importedConsumer?.range.start.column);

    const uniqueSites = new Set(
      result.references.map(
        (reference) =>
          `${fileIdentityKey(reference.file)}:${reference.range.start.line}:${reference.range.start.column}:${reference.range.end.column}`,
      ),
    );
    expect(uniqueSites.size).toBe(result.references.length);
  });
});

describe("Python stub discovery", () => {
  it("discovers and indexes .pyi declarations", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "python");
    const stubFile = path.join(fixturePath, "stubs.pyi");
    const index = await buildProjectIndex(fixturePath, { cache: "off" });

    expectFileInIndex(index, stubFile);
    expect(findSymbolsByName(index, "StubType", stubFile)).toHaveLength(1);
    expect(findSymbolsByName(index, "stub_function", stubFile)).toHaveLength(1);
  });

  it("classifies a standard-library import in a .pyi stub as resolved, and an unknown one as unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-stub-stdlib-"));
    try {
      const stub = path.join(root, "typings.pyi");
      await fsp.writeFile(stub, "import os\nimport definitely_not_a_package\n", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root }).map((entry) => entry.name);

      expect(unresolved).not.toContain("os");
      expect(unresolved).toContain("definitely_not_a_package");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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

describe("Python case pattern qualified values", () => {
  it("does not create locals for a qualified case pattern value like module.CONST", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-case-qualified-"));
    try {
      const moduleFile = path.join(root, "module.py").replace(/\\/g, "/");
      const mainFile = path.join(root, "main.py").replace(/\\/g, "/");
      await fsp.writeFile(moduleFile, "CONST = 1\n", "utf8");
      await fsp.writeFile(
        mainFile,
        [
          "import module",
          "",
          "class Point:",
          "    def __init__(self, x, y):",
          "        self.x = x",
          "        self.y = y",
          "",
          "def handle(value):",
          "    match value:",
          "        case module.CONST:",
          "            return 1",
          "        case Point(x=module.CONST):",
          "            return 2",
          "        case bare_name:",
          "            return bare_name",
          "        case Point(x=px, y=py):",
          "            return px + py",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await buildProjectIndex(root, { cache: "off" });

      // A qualified value pattern must not create phantom locals for either segment.
      expect(findSymbolsByName(index, "module", mainFile)).toHaveLength(0);
      expect(findSymbolsByName(index, "CONST", mainFile)).toHaveLength(0);
      // The unaffected bare-name and keyword-pattern bindings keep working.
      expect(findSymbolsByName(index, "bare_name", mainFile)).toHaveLength(1);
      expect(findSymbolsByName(index, "px", mainFile)).toHaveLength(1);
      expect(findSymbolsByName(index, "py", mainFile)).toHaveLength(1);

      // "module" in `case module.CONST:` (line 10, col 14) still resolves to the import.
      const gotoModule = await goToDefinition(index, { file: mainFile, line: 10, column: 14 });
      expect(gotoModule.status).toBe("ok");
      if (gotoModule.status === "ok") expect(gotoModule.definition.file).toBe(moduleFile);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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

  it("ignores strings outside the explicit export list", async () => {
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

  it("keeps module-level __all__ concatenation, extend, append, and augmented assignment", async () => {
    const mod = await collectModule(`
def foo(): pass
def bar(): pass
def extra(): pass
def appended(): pass
def leftover(): pass

__all__ = ["foo"] + ["bar"]
__all__ += ["extra"]
__all__.extend(["appended"])
__all__.append("leftover")
`);
    expect(mod.exports.map((entry) => exportedNameOf(entry)).sort()).toEqual([
      "appended",
      "bar",
      "extra",
      "foo",
      "leftover",
    ]);
  });

  it("retains every static list item without reading comment strings", async () => {
    const mod = await collectModule(
      'def a(): pass\ndef b(): pass\ndef hidden(): pass\n__all__ = ["a", # "hidden"\n "b"]\n',
    );
    expect(mod.exports.map((entry) => exportedNameOf(entry)).sort()).toEqual(["a", "b"]);
  });

  it("keeps an empty explicit export list empty", async () => {
    const mod = await collectModule("def hidden(): pass\n__all__ = []\n");
    expect(mod.exports).toEqual([]);
  });

  it("does not let function-local __all__ assignment, extend, append, or += filter module exports", async () => {
    const mod = await collectModule(`
VISIBLE = 1

def public_fn():
    return VISIBLE

def mutate():
    __all__ = ["HIDDEN"]
    __all__ += ["nope"]
    __all__.extend(["also"])
    __all__.append("no")
`);
    expect(mod.exports.map((entry) => exportedNameOf(entry)).sort()).toEqual(["VISIBLE", "mutate", "public_fn"]);
  });

  it("resolves a public module export through a consumer when a function-local __all__ is present", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-local-all-"));
    const packageDir = path.join(root, "sample");
    const sourceFile = path.join(packageDir, "mod.py");
    const consumerFile = path.join(root, "consumer.py");
    await fsp.mkdir(packageDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(packageDir, "__init__.py"), "", "utf8"),
      fsp.writeFile(
        sourceFile,
        [
          "VISIBLE = 1",
          "",
          "def public_fn():",
          "    return VISIBLE",
          "",
          "def mutate():",
          '    __all__ = ["HIDDEN"]',
          '    __all__ += ["nope"]',
          '    __all__.extend(["also"])',
          '    __all__.append("no")',
          "",
        ].join("\n"),
        "utf8",
      ),
      fsp.writeFile(consumerFile, "from sample.mod import public_fn\n\npublic_fn()\n", "utf8"),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const source = index.byFile.get(fileIdentityKey(sourceFile));
      const result = await goToDefinition(index, { file: consumerFile, line: 3, column: 1 });

      expect(source?.exports.map((entry) => exportedNameOf(entry)).sort()).toEqual(["VISIBLE", "mutate", "public_fn"]);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(sourceFile));
        expect(result.definition.range.start.line).toBe(3);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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
      "escaped.py",
      "joined.py",
      "relative.py",
      "triple.py",
      "créer.py",
    ];
    const ignoredNames = [
      "string_only.py",
      "comment_only.py",
      "computed.py",
      "computed_expression.py",
      "2invalid.py",
      "builtin_relative.py",
    ];
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
      'importlib.import_module("pkg.\\u0065scaped")',
      'importlib.import_module("pkg." "joined")',
      'importlib.import_module(".relative", package="pkg")',
      'importlib.import_module("""pkg.triple""")',
      'importlib.import_module("pkg.créer")',
      'importlib.import_module("pkg.precise")',
      '__import__(".builtin_relative")',
      'description = """module_loader.import_module("pkg.string_only")"""',
      '# __import__("pkg.comment_only")',
      'module_name = "pkg.computed"',
      "module_loader.import_module(module_name)",
      'suffix = ""',
      'module_loader.import_module("pkg.computed_expression" + suffix)',
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

describe("Python query-driven declarations", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-decls-"));
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

  it("binds except/with as-pattern aliases, not the exception class", async () => {
    const mod = await collectModule(`
def uses_bindings():
    with open(__file__) as handle:
        try:
            1 / 0
        except ValueError as err:
            return handle, err
`);
    const localNames = mod.locals.map((entry) => entry.localName);
    expect(localNames).toEqual(expect.arrayContaining(["handle", "err"]));
    expect(localNames).not.toContain("ValueError");
  });

  it("indexes walrus, unpacking, and PEP 695 type-alias locals", async () => {
    const mod = await collectModule(`
a, b = (1, 2)
(c, d) = (3, 4)
type Pair = tuple[int, int]
type PairGeneric[T] = tuple[T, T]

def uses_walrus(value):
    if (walrus := value):
        return walrus
    return None
`);
    const byName = new Map(mod.locals.map((entry) => [entry.localName, entry]));
    for (const name of ["a", "b", "c", "d", "walrus", "Pair", "PairGeneric"]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get("Pair")?.kind).toBe(SymbolKind.TypeAlias);
    expect(byName.get("PairGeneric")?.kind).toBe(SymbolKind.TypeAlias);
  });

  it("indexes keyword-pattern binding names, not the matched attributes", async () => {
    const mod = await collectModule(`
def describe(p):
    match p:
        case Point(x=px, y=py):
            return px + py
`);
    const localNames = mod.locals.map((entry) => entry.localName);
    expect(localNames).toEqual(expect.arrayContaining(["px", "py"]));
    expect(localNames.filter((name) => name === "x" || name === "y")).toEqual([]);
  });

  it("does not export function-body locals while keeping module and class members", async () => {
    const mod = await collectModule(`
MODULE_CONST = 1

class Holder:
    CLASS_ATTR = 8
    def method(self):
        method_local = 11
        def nested():
            return method_local
        return nested()

def outer(arg):
    secret_tmp = arg + 1
    def nested():
        inner_var = secret_tmp
        return inner_var
    return nested()
`);
    const exportedNames = mod.exports.map((entry) => exportedNameOf(entry)).sort();
    const localNames = mod.locals.map((entry) => entry.localName);
    expect(exportedNames).toEqual(["CLASS_ATTR", "Holder", "MODULE_CONST", "method", "outer"]);
    expect(localNames).toEqual(expect.arrayContaining(["secret_tmp", "nested", "inner_var", "method_local"]));
  });

  it("does not export members of a function-local class", async () => {
    const mod = await collectModule(`
def outer():
    class Hidden:
        def member(self): pass

def keep(): pass
`);
    const exportedNames = mod.exports.map((entry) => exportedNameOf(entry));
    const localNames = mod.locals.map((entry) => entry.localName);
    expect(localNames).toEqual(expect.arrayContaining(["outer", "Hidden", "member", "keep"]));
    expect(exportedNames).toEqual(expect.arrayContaining(["outer", "keep"]));
    expect(exportedNames).not.toContain("member");
    expect(exportedNames).not.toContain("Hidden");
  });
});

describe("Python declaration-name field identity", () => {
  it("finds a reference to an imported symbol used as a bare assignment initializer", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-decl-init-"));
    const aFile = path.join(root, "a.py");
    const bFile = path.join(root, "b.py");
    await fsp.writeFile(aFile, "def helper():\n    return 1\n", "utf8");
    await fsp.writeFile(bFile, "from a import helper as helper_alias\n\nresult = helper_alias\n", "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const references = await findReferences(index, { file: bFile, line: 1, column: 25 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((entry) => entry.range.start.line)).toContain(3);
      }
      // Regression: the assignment target itself must still be a legitimate declaration.
      const module = index.byFile.get(fileIdentityKey(bFile));
      expect(module?.locals.map((entry) => entry.localName)).toContain("result");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python native import bindings", () => {
  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
  ])("marks only imports inside TYPE_CHECKING suites as type-only (%s)", async (_label, newline) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-type-checking-"));
    const consumer = path.join(root, "consumer.py");
    const source = [
      "from typing import TYPE_CHECKING",
      "import typing",
      "if TYPE_CHECKING:",
      "    from .models import User",
      "    if condition:",
      "        import nested_type",
      "else:",
      "    import runtime_else",
      "if typing.TYPE_CHECKING:",
      "    import qualified_type",
      "if not TYPE_CHECKING:",
      "    import runtime_negated",
      "if OTHER:",
      "    import runtime_other",
      "if TYPE_CHECKING: import inline_type; import inline_second",
      "if TYPE_CHECKING:",
      "    value = call(",
      ")",
      "    import after_continuation",
      "import runtime_plain; import runtime_second",
      "if TYPE_CHECKING: import list_first, list_second as second",
      // tree-sitter-python drops a nested one-line suite in a lone-CR file.
      ...(newline === "\n"
        ? [
            "if TYPE_CHECKING:",
            "    if enabled: import inline_nested",
            "    match mode:",
            "        case 1: import case_guarded",
            "if enabled: import runtime_inline",
          ]
        : []),
      "import runtime_list_a, runtime_list_b",
      "",
    ].join(newline);
    const typeSpecs = [
      ".models",
      "nested_type",
      "qualified_type",
      "inline_type",
      "inline_second",
      "after_continuation",
      "list_first",
      "list_second",
      ...(newline === "\n" ? ["inline_nested", "case_guarded"] : []),
    ];
    const runtimeSpecs = [
      "typing",
      "runtime_else",
      "runtime_negated",
      "runtime_other",
      "runtime_plain",
      "runtime_second",
      "runtime_list_a",
      "runtime_list_b",
      ...(newline === "\n" ? ["runtime_inline"] : []),
    ];
    await Promise.all([
      fsp.writeFile(consumer, source),
      ...["models", ...typeSpecs.slice(1), ...runtimeSpecs.slice(1)].map((name) =>
        fsp.writeFile(path.join(root, `${name}.py`), "value = 1\n"),
      ),
    ]);
    try {
      const imports = await collectImportsForFile(consumer, root, { source });
      const specs = collectModuleSpecifiersFromSource(PY_SUPPORT, source);
      for (const spec of typeSpecs) {
        expect(imports.find((binding) => binding.from === spec)?.typeOnly).toBe(true);
        expect(specs.find((entry) => entry.spec === spec)?.typeOnly).toBe(true);
      }
      for (const spec of runtimeSpecs) {
        expect(imports.find((binding) => binding.from === spec)).toBeDefined();
        expect(imports.find((binding) => binding.from === spec)?.typeOnly).not.toBe(true);
        expect(specs.find((entry) => entry.spec === spec)).toBeDefined();
        expect(specs.find((entry) => entry.spec === spec)?.typeOnly).not.toBe(true);
      }
      const index = await buildProjectIndex(root, { cache: "off" });
      const fromConsumer = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(consumer));
      for (const spec of typeSpecs) {
        expect(fromConsumer.find((edge) => edge.raw === spec)?.typeOnly).toBe(true);
      }
      for (const spec of runtimeSpecs) {
        const edge = fromConsumer.find((candidate) => candidate.raw === spec);
        expect(edge).toBeDefined();
        expect(edge?.typeOnly).not.toBe(true);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("binds multiline, comma-separated, continued, relative, star, and future imports", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-native-imports-"));
    const packageDir = path.join(root, "pkg");
    const consumerFile = path.join(packageDir, "consumer.py").replace(/\\/g, "/");
    const alphaFile = path.join(packageDir, "alpha.py").replace(/\\/g, "/");
    await fsp.mkdir(packageDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(packageDir, "__init__.py"), "", "utf8"),
      fsp.writeFile(alphaFile, "one = 1\ntwo = 2\n", "utf8"),
      fsp.writeFile(path.join(packageDir, "beta.py"), "three = 3\nfour = 4\n", "utf8"),
      fsp.writeFile(path.join(packageDir, "local.py"), "value = 5\n", "utf8"),
      fsp.writeFile(
        consumerFile,
        [
          "from .alpha import (",
          "    one,",
          "    two,",
          ")",
          "import os, sys",
          "from .beta import three, \\",
          "    four as renamed",
          "from .local import *",
          "from __future__ import annotations",
          "if True:",
          "    from .local import value as nested",
          "one",
          "",
        ].join("\n"),
        "utf8",
      ),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(consumerFile))?.imports ?? [];
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "named",
            from: ".alpha",
            imported: "one",
            local: "one",
            mechanism: "python",
          }),
          expect.objectContaining({
            kind: "named",
            from: ".alpha",
            imported: "two",
            local: "two",
            mechanism: "python",
          }),
          expect.objectContaining({ kind: "namespace", from: "os", localNS: "os", mechanism: "python" }),
          expect.objectContaining({ kind: "namespace", from: "sys", localNS: "sys", mechanism: "python" }),
          expect.objectContaining({
            kind: "named",
            from: ".beta",
            imported: "four",
            local: "renamed",
            mechanism: "python",
          }),
          expect.objectContaining({ kind: "star", from: ".local", mechanism: "python" }),
          expect.objectContaining({ kind: "named", from: "__future__", imported: "annotations", mechanism: "python" }),
          expect.objectContaining({
            kind: "named",
            from: ".local",
            imported: "value",
            local: "nested",
            moduleLevel: false,
          }),
        ]),
      );
      const references = await findReferences(index, { file: alphaFile, line: 1, column: 1 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references.some(
            (reference) => reference.file === consumerFile && reference.range.start.line === 12,
          ),
        ).toBe(true);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps multiline import bindings after comments", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-commented-import-"));
    const dependency = path.join(root, "dependency.py").replace(/\\/g, "/");
    const consumer = path.join(root, "consumer.py").replace(/\\/g, "/");
    const source = [
      "from dependency import (",
      "    first,",
      "    # the next binding must remain visible",
      "    second as second,",
      ")",
      "second",
      "",
    ].join("\n");
    await Promise.all([
      fsp.writeFile(dependency, "first = 1\nsecond = 2\n", "utf8"),
      fsp.writeFile(consumer, source, "utf8"),
    ]);
    try {
      const imports = await collectImportsForFile(consumer, root, { source });
      const binding = imports.find(
        (entry) => entry.kind === "named" && entry.imported === "second" && entry.local === "second",
      );
      expect(binding).toEqual(
        expect.objectContaining({
          kind: "named",
          explicitAlias: true,
          importedRange: expect.objectContaining({
            start: expect.objectContaining({ line: 4, column: 5 }),
          }),
          localRange: expect.objectContaining({
            start: expect.objectContaining({ line: 4, column: 15 }),
          }),
        }),
      );
      const index = await buildProjectIndex(root, { cache: "off" });
      const references = await findReferences(index, { file: dependency, line: 2, column: 1 });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected references to resolve");
      expect(
        references.references.map((reference) => [
          path.basename(reference.file),
          reference.range.start.line,
          reference.range.start.column,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["consumer.py", 4, 5],
          ["consumer.py", 4, 15],
          ["consumer.py", 6, 1],
        ]),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps simple-suite imports out of module exports while retaining same-line top-level imports", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-simple-suite-"));
    const consumer = path.join(root, "consumer.py");
    await Promise.all(
      ["feature", "hidden", "first", "second", "assigned", "called", "annotated"].map((name) =>
        fsp.writeFile(path.join(root, `${name}.py`), "value = 1\n"),
      ),
    );
    await fsp.writeFile(
      consumer,
      [
        "if enabled: import feature",
        "def load(): import hidden",
        "import first; import second",
        "x = 1; import assigned",
        "print('if ignored: ; )'); import called",
        "match: dict[str, int] = {'key': 1}; import annotated",
      ].join("\n"),
    );
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(consumer));
      expect(module?.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "feature", moduleLevel: false }),
          expect.objectContaining({ from: "hidden", moduleLevel: false }),
          expect.objectContaining({ from: "second", moduleLevel: true }),
          expect.objectContaining({ from: "assigned", moduleLevel: true }),
          expect.objectContaining({ from: "called", moduleLevel: true }),
          expect.objectContaining({ from: "annotated", moduleLevel: true }),
        ]),
      );
      const exported = module?.exports.flatMap((entry) => (entry.type === "exportStar" ? [] : [entry.exportedAs]));
      expect(exported).not.toContain("feature");
      expect(exported).not.toContain("hidden");
      expect(exported).toContain("second");
      expect(exported).toEqual(expect.arrayContaining(["assigned", "called", "annotated"]));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a multi-line conditional import out of module exports", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-multiline-cond-"));
    const consumer = path.join(root, "consumer.py");
    await Promise.all([
      fsp.writeFile(path.join(root, "feature.py"), "value = 1\n"),
      fsp.writeFile(path.join(root, "kept.py"), "value = 2\n"),
      fsp.writeFile(consumer, ["if (", "    enabled", "): import feature", "import kept"].join("\n")),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(consumer));
      expect(module?.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "feature", moduleLevel: false }),
          expect.objectContaining({ from: "kept", moduleLevel: true }),
        ]),
      );
      const exported = module?.exports.flatMap((entry) => (entry.type === "exportStar" ? [] : [entry.exportedAs]));
      expect(exported).not.toContain("feature");
      expect(exported).toContain("kept");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a top-level import after a multi-line parenthesized simple statement module-level", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-multiline-simple-"));
    const consumer = path.join(root, "consumer.py");
    await Promise.all([
      fsp.writeFile(path.join(root, "pkg.py"), "value = 1\n"),
      fsp.writeFile(consumer, "value = (\n    1\n); import pkg\n"),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(consumer));
      expect(module?.imports).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: "pkg", moduleLevel: true })]),
      );
      const exported = module?.exports.flatMap((entry) => (entry.type === "exportStar" ? [] : [entry.exportedAs]));
      expect(exported).toContain("pkg");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps module-level and conditional imports distinct in compound suites", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-mode-agreement-"));
    const consumer = path.join(root, "consumer.py");
    const source = [
      "value = (",
      "    1",
      "); import pkg",
      "if enabled: import feature",
      "if enabled: from models import User",
      "match value:",
      "    case 1: import case_first; import case_second",
      "import kept",
    ].join("\n");
    await Promise.all([
      fsp.writeFile(path.join(root, "pkg.py"), "value = 1\n"),
      fsp.writeFile(path.join(root, "feature.py"), "value = 1\n"),
      fsp.writeFile(path.join(root, "kept.py"), "value = 1\n"),
      fsp.writeFile(path.join(root, "models.py"), "class User: pass\n"),
      fsp.writeFile(path.join(root, "case_first.py"), "value = 1\n"),
      fsp.writeFile(path.join(root, "case_second.py"), "value = 1\n"),
      fsp.writeFile(consumer, source),
    ]);
    try {
      const imports = await collectImportsForFile(consumer, root, { source });
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "pkg", moduleLevel: true }),
          expect.objectContaining({ from: "kept", moduleLevel: true }),
          expect.objectContaining({ from: "feature", moduleLevel: false }),
          expect.objectContaining({ kind: "named", from: "models", imported: "User", moduleLevel: false }),
          expect.objectContaining({ from: "case_first", moduleLevel: false }),
          expect.objectContaining({ from: "case_second", moduleLevel: false }),
        ]),
      );
      const mod = collectLocalsAndExportsFromSource(consumer, source, PY_SUPPORT, imports);
      const importExports = mod.exports
        .filter((entry) => entry.type === "reexport" || entry.type === "namespaceReexport")
        .map((entry) => entry.exportedAs);
      expect(importExports).toEqual(expect.arrayContaining(["pkg", "kept"]));
      expect(importExports).not.toContain("feature");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps names after inline comments in native Python import statements", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-native-import-comments-"));
    const packageDir = path.join(root, "pkg");
    const consumerFile = path.join(packageDir, "consumer.py").replace(/\\/g, "/");
    await fsp.mkdir(packageDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(packageDir, "__init__.py"), "", "utf8"),
      fsp.writeFile(path.join(packageDir, "alpha.py"), "one = 1\ntwo = 2\n", "utf8"),
      fsp.writeFile(path.join(packageDir, "local.py"), "value = 5\n", "utf8"),
      fsp.writeFile(
        consumerFile,
        [
          "from .alpha import (",
          "    one,  # kept",
          "    two,",
          ")",
          "import os, sys  # stdlib",
          "from .local import *  # noqa",
          "from .local import value  # trailing",
          "",
        ].join("\n"),
        "utf8",
      ),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(consumerFile))?.imports ?? [];
      expect(imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "named", from: ".alpha", imported: "one", local: "one" }),
          expect.objectContaining({ kind: "named", from: ".alpha", imported: "two", local: "two" }),
          expect.objectContaining({ kind: "namespace", from: "os", localNS: "os" }),
          expect.objectContaining({ kind: "namespace", from: "sys", localNS: "sys" }),
          expect.objectContaining({ kind: "star", from: ".local" }),
          expect.objectContaining({ kind: "named", from: ".local", imported: "value", local: "value" }),
        ]),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python receiver member declarations", () => {
  async function collectModule(source: string) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-receiver-decls-"));
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

  it("indexes self and cls attributes assigned in methods as class members, not exports", async () => {
    const mod = await collectModule(`
class Holder:
    def __init__(self, value):
        self.value = value
        hidden = 1

    @classmethod
    def mark(cls):
        cls.tagged = True
`);
    const members = mod.locals.filter((entry) => entry.isMember);
    const memberNames = members.map((entry) => entry.localName).sort();
    expect(memberNames).toEqual(expect.arrayContaining(["__init__", "mark", "value", "tagged"]));
    expect(members.some((entry) => entry.localName === "value")).toBe(true);
    expect(members.some((entry) => entry.localName === "tagged")).toBe(true);
    expect(mod.locals.some((entry) => entry.localName === "hidden" && entry.isMember)).toBe(false);
    const exportedNames = mod.exports.map((entry) => exportedNameOf(entry));
    expect(exportedNames).toContain("Holder");
    expect(exportedNames).not.toContain("value");
    expect(exportedNames).not.toContain("tagged");
    expect(exportedNames).not.toContain("hidden");
  });
});

describe("Python receiver member navigation", () => {
  it("resolves self, cls, inherited, and constructor-assigned members, and keeps unproven receivers unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-receiver-lang-"));
    const file = path.join(root, "models.py").replace(/\\/g, "/");
    const source = [
      "class Base:",
      "    def base_method(self):",
      "        return 1",
      "",
      "class Service(Base):",
      '    kind = "svc"',
      "    def __init__(self, name):",
      "        self.name = name",
      "    def run(self):",
      "        return self.name",
      "    def call_self(self):",
      "        run = 0",
      "        return self.run()",
      "    def use_inherited(self):",
      "        return self.base_method()",
      "    @classmethod",
      "    def from_kind(cls):",
      "        return cls.kind",
      "",
      "class Other:",
      "    def run(self):",
      "        return 2",
      "",
      "def run():",
      "    return 0",
      "",
      "def make_service():",
      '    return Service("x")',
      "",
      "def via_constructor():",
      "    svc = Service()",
      "    return svc.run()",
      "",
      "def via_annotated():",
      "    svc: Service = Service()",
      "    return svc.run()",
      "",
      "def via_factory():",
      "    svc = make_service()",
      "    return svc.run()",
      "",
      "def via_param(svc):",
      "    return svc.run()",
      "",
      "def via_other():",
      "    other = Other()",
      "    return other.run()",
      "",
    ].join("\n");
    await fsp.writeFile(file, source, "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = source.split("\n");
      const columnOf = (line: number, token: string): number => {
        const indexOf = lines[line - 1]!.indexOf(token);
        if (indexOf < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
        return indexOf + 1;
      };

      const selfRun = await goToDefinition(index, { file, line: 13, column: columnOf(13, "run") });
      expect(selfRun.status).toBe("ok");
      if (selfRun.status === "ok") expect(selfRun.definition.range.start.line).toBe(9);

      const selfName = await goToDefinition(index, { file, line: 10, column: columnOf(10, "name") });
      expect(selfName.status).toBe("ok");
      if (selfName.status === "ok") expect(selfName.definition.range.start.line).toBe(8);

      const clsKind = await goToDefinition(index, { file, line: 18, column: columnOf(18, "kind") });
      expect(clsKind.status).toBe("ok");
      if (clsKind.status === "ok") expect(clsKind.definition.range.start.line).toBe(6);

      const inherited = await goToDefinition(index, { file, line: 15, column: columnOf(15, "base_method") });
      expect(inherited.status).toBe("ok");
      if (inherited.status === "ok") expect(inherited.definition.range.start.line).toBe(2);

      const constructed = await goToDefinition(index, { file, line: 32, column: columnOf(32, "run") });
      expect(constructed.status).toBe("ok");
      if (constructed.status === "ok") expect(constructed.definition.range.start.line).toBe(9);

      const annotated = await goToDefinition(index, { file, line: 36, column: columnOf(36, "run") });
      expect(annotated.status).toBe("ok");
      if (annotated.status === "ok") expect(annotated.definition.range.start.line).toBe(9);

      const factory = await goToDefinition(index, { file, line: 40, column: columnOf(40, "run") });
      expect(factory.status).toBe("not_found");

      const param = await goToDefinition(index, { file, line: 43, column: columnOf(43, "run") });
      expect(param.status).toBe("not_found");

      const unrelated = await goToDefinition(index, { file, line: 47, column: columnOf(47, "run") });
      expect(unrelated.status).toBe("ok");
      if (unrelated.status === "ok") expect(unrelated.definition.range.start.line).toBe(21);

      const methodRefs = await findReferences(index, { file, line: 9, column: columnOf(9, "run") });
      expect(methodRefs.status).toBe("ok");
      if (methodRefs.status === "ok") {
        const linesHit = methodRefs.references.map((reference) => reference.range.start.line);
        expect(linesHit).toEqual(expect.arrayContaining([9, 13, 32, 36]));
        expect(linesHit).not.toContain(25);
        expect(linesHit).not.toContain(40);
        expect(linesHit).not.toContain(43);
        expect(linesHit).not.toContain(21);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("resolves instance attributes ahead of class attributes and keeps references separate", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-shadowed-attribute-"));
    const file = path.join(root, "models.py").replace(/\\/g, "/");
    const source = [
      "class Counter:",
      "    count = 0",
      "    def assign_before_init(self):",
      "        self.count = -1",
      "    def __init__(self):",
      "        self.count = 0",
      "    def add(self, amount):",
      "        Counter.count += amount",
      "        self.count += amount",
      "        return self.count",
      "",
      "class ClassOnly:",
      "    count = 0",
      "    def read(self):",
      "        return self.count",
      "",
      "class FirstWrite:",
      "    count = 0",
      "    def set_first(self):",
      "        self.count = 1",
      "    def set_later(self):",
      "        self.count = 2",
      "    def read(self):",
      "        return self.count",
      "",
      "class AnnotatedOnly:",
      "    count = 7",
      "    def __init__(self):",
      "        self.count: int",
      "    def read(self):",
      "        return self.count",
      "",
      "def read_counter():",
      "    counter = Counter()",
      "    return counter.count",
      "",
      "class DecoratedProperty:",
      "    @property",
      "    def count(self):",
      "        return self._count",
      "    @count.setter",
      "    def count(self, value):",
      "        self._count = value",
      "    def write(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
      "",
      "class AssignedProperty:",
      "    def get_count(self):",
      "        return self._count",
      "    def set_count(self, value):",
      "        self._count = value",
      "    count = property(get_count, set_count)",
      "    def write(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");
    await fsp.writeFile(file, source, "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = source.split("\n");
      const columnOf = (line: number, token: string): number => {
        const indexOf = lines[line - 1]!.indexOf(token);
        if (indexOf < 0) throw new Error("Expected token " + token + " on fixture line " + line);
        return indexOf + 1;
      };

      for (const line of [9, 10]) {
        const result = await goToDefinition(index, { file, line, column: columnOf(line, "count") });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(6);
      }

      const classAttribute = await goToDefinition(index, { file, line: 8, column: columnOf(8, "count") });
      expect(classAttribute.status).toBe("ok");
      if (classAttribute.status === "ok") expect(classAttribute.definition.range.start.line).toBe(2);

      const classOnly = await goToDefinition(index, { file, line: 15, column: columnOf(15, "count") });
      expect(classOnly.status).toBe("ok");
      if (classOnly.status === "ok") expect(classOnly.definition.range.start.line).toBe(13);

      const firstWrite = await goToDefinition(index, { file, line: 24, column: columnOf(24, "count") });
      expect(firstWrite.status).toBe("ok");
      if (firstWrite.status === "ok") expect(firstWrite.definition.range.start.line).toBe(20);

      const constructed = await goToDefinition(index, { file, line: 35, column: lines[34]!.lastIndexOf("count") + 1 });
      expect(constructed.status).toBe("ok");
      if (constructed.status === "ok") expect(constructed.definition.range.start.line).toBe(6);

      const instanceReferences = await findReferences(index, { file, line: 6, column: columnOf(6, "count") });
      expect(instanceReferences.status).toBe("ok");
      if (instanceReferences.status === "ok") {
        const hits = instanceReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([4, 6, 9, 10, 35]));
        expect(hits).not.toContain(2);
        expect(hits).not.toContain(8);
      }

      const classReferences = await findReferences(index, { file, line: 2, column: columnOf(2, "count") });
      expect(classReferences.status).toBe("ok");
      if (classReferences.status === "ok") {
        const hits = classReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([2, 8]));
        expect(hits).not.toContain(4);
        expect(hits).not.toContain(6);
        expect(hits).not.toContain(9);
        expect(hits).not.toContain(10);
        expect(hits).not.toContain(35);
      }

      const classOnlyReferences = await findReferences(index, { file, line: 13, column: columnOf(13, "count") });
      expect(classOnlyReferences.status).toBe("ok");
      if (classOnlyReferences.status === "ok") {
        const hits = classOnlyReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([13, 15]));
      }

      const firstWriteReferences = await findReferences(index, { file, line: 20, column: columnOf(20, "count") });
      expect(firstWriteReferences.status).toBe("ok");
      if (firstWriteReferences.status === "ok") {
        const hits = firstWriteReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([20, 22, 24]));
        expect(hits).not.toContain(18);
      }

      const laterWriteReferences = await findReferences(index, { file, line: 22, column: columnOf(22, "count") });
      expect(laterWriteReferences).toEqual(firstWriteReferences);

      const laterWriteDefinition = index.byFile
        .get(fileIdentityKey(file))
        ?.locals.find((local) => local.range.start.line === 22);
      expect(laterWriteDefinition).toBeDefined();
      if (!laterWriteDefinition) throw new Error("Expected an indexed later instance write");
      const definitionReferences = await findReferences(index, { def: laterWriteDefinition });
      const handleReferences = await findReferencesById(index, symbolId(laterWriteDefinition));
      expect.soft(definitionReferences).toEqual(firstWriteReferences);
      expect.soft(handleReferences).toEqual(firstWriteReferences);

      const mappedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-shadowed-attribute-mapped-"));
      try {
        const mappedFile = path.join(mappedRoot, "models.pyt").replace(/\\/g, "/");
        await fsp.writeFile(mappedFile, source, "utf8");
        const mappedIndex = await buildProjectIndex(mappedRoot, {
          cache: "off",
          languageExtensions: { ".pyt": "python" },
        });
        const mappedReferences = await findReferences(mappedIndex, {
          file: mappedFile,
          line: 22,
          column: columnOf(22, "count"),
        });
        expect(mappedReferences.status).toBe("ok");
        if (mappedReferences.status === "ok") {
          const hits = mappedReferences.references.map((reference) => reference.range.start.line);
          expect(hits).toEqual(expect.arrayContaining([20, 22, 24]));
          expect(hits).not.toContain(18);
        }
      } finally {
        await fsp.rm(mappedRoot, { recursive: true, force: true });
      }

      const annotatedOnly = await goToDefinition(index, { file, line: 31, column: columnOf(31, "count") });
      expect(annotatedOnly.status).toBe("ok");
      if (annotatedOnly.status === "ok") expect(annotatedOnly.definition.range.start.line).toBe(27);

      const annotatedReferences = await findReferences(index, { file, line: 27, column: columnOf(27, "count") });
      expect(annotatedReferences.status).toBe("ok");
      if (annotatedReferences.status === "ok") {
        const hits = annotatedReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([27, 29, 31]));
      }
      const annotationStartedReferences = await findReferences(index, {
        file,
        line: 29,
        column: columnOf(29, "count"),
      });
      expect(annotationStartedReferences.status).toBe("ok");
      if (annotationStartedReferences.status === "ok") {
        expect(annotationStartedReferences.definition.range.start.line).toBe(27);
        const hits = annotationStartedReferences.references.map((reference) => reference.range.start.line);
        expect(hits).toEqual(expect.arrayContaining([27, 31]));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    {
      name: "a @property setter",
      source: [
        "class Counter:",
        "    @property",
        "    def count(self):",
        "        return self._count",
        "    @count.setter",
        "    def count(self, value):",
        "        self._count = value",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ].join("\n"),
      propertyLine: 3,
      writeLine: 9,
      readLine: 11,
    },
    {
      name: "a property() assignment",
      source: [
        "class Counter:",
        "    def get_count(self):",
        "        return self._count",
        "    def set_count(self, value):",
        "        self._count = value",
        "    count = property(get_count, set_count)",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ].join("\n"),
      propertyLine: 6,
      writeLine: 8,
      readLine: 10,
    },
    {
      name: "a one-argument property() assignment",
      source: [
        "class Counter:",
        "    def get_count(self):",
        "        return self._count",
        "    count = property(get_count)",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ].join("\n"),
      propertyLine: 4,
      writeLine: 6,
      readLine: 8,
    },
  ])("keeps instance writes behind $name descriptors", async ({ source, propertyLine, writeLine, readLine }) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-property-descriptor-"));
    try {
      const file = path.join(root, "models.py").replace(/\\/g, "/");
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = source.split("\n");
      const columnOf = (line: number, token: string): number => {
        const indexOf = lines[line - 1]!.indexOf(token);
        if (indexOf < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
        return indexOf + 1;
      };
      const navigation = await goToDefinition(index, {
        file,
        line: readLine,
        column: columnOf(readLine, "count"),
      });
      const writeNavigation = await goToDefinition(index, {
        file,
        line: writeLine,
        column: columnOf(writeLine, "count"),
      });
      const propertyDefinition = index.byFile
        .get(fileIdentityKey(file))
        ?.locals.find((local) => local.localName === "count" && local.range.start.line === propertyLine);
      expect(propertyDefinition).toBeDefined();
      if (!propertyDefinition) throw new Error("Expected the class property definition");
      const writeReferences = await findReferences(index, {
        file,
        line: writeLine,
        column: columnOf(writeLine, "count"),
      });
      const propertyReferences = await findReferences(index, { def: propertyDefinition });
      expect(navigation.status).toBe("ok");
      if (navigation.status === "ok") expect(navigation.definition.range.start.line).toBe(propertyLine);
      expect(writeNavigation.status).toBe("ok");
      if (writeNavigation.status === "ok") expect(writeNavigation.definition.range.start.line).toBe(propertyLine);
      expect(writeReferences.status).toBe("ok");
      expect(propertyReferences.status).toBe("ok");
      if (writeReferences.status === "ok" && propertyReferences.status === "ok") {
        expect(writeReferences.references).toEqual(propertyReferences.references);
        expect(writeReferences.references.map((reference) => reference.range.start.line)).toEqual(
          expect.arrayContaining([propertyLine, writeLine, readLine]),
        );
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python failed relative imports", () => {
  it("keeps the original relative specifier when a Python import fails to resolve", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-relative-external-"));
    try {
      const packageDir = path.join(root, "pkg");
      await fsp.mkdir(packageDir, { recursive: true });
      const file = path.join(packageDir, "app.py");
      await fsp.writeFile(path.join(packageDir, "__init__.py"), "");
      await fsp.writeFile(file, "from .missing import x\n");
      const index = await buildProjectIndex(root, { cache: "off" });
      const binding = index.byFile.get(fileIdentityKey(file))?.imports.find((entry) => entry.from === ".missing");
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root }).map((entry) => entry.name);
      const edgeNames = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file) && edge.to.type === "external")
        .map((edge) => (edge.to.type === "external" ? edge.to.name : ""));

      expect(binding?.resolved).toEqual({ external: ".missing" });
      expect(unresolved).toContain(".missing");
      expect(unresolved).not.toContain("..missing");
      expect(edgeNames).toContain(".missing");
      expect(edgeNames).not.toContain("..missing");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python formatted property accessor navigation regressions", () => {
  it("resolves formatted property reads to the getter instead of __init__ writes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-formatted-property-goto-"));
    try {
      const file = path.join(root, "models.py").replace(/\\/g, "/");
      const source = [
        "class Counter:",
        "    @ property",
        "    def count(self):",
        "        return self._count",
        "    @count . setter",
        "    def count(self, value):",
        "        self._count = value",
        "    def __init__(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ].join("\n");
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const navigation = await goToDefinition(index, { file, line: 11, column: 21 });
      expect(navigation.status).toBe("ok");
      if (navigation.status === "ok") expect(navigation.definition.range.start.line).toBe(3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat owner-qualified setters as Child instance attributes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-qualified-property-goto-"));
    try {
      const file = path.join(root, "models.py").replace(/\\/g, "/");
      const source = [
        "class Base:",
        "    @property",
        "    def count(self):",
        "        return self._count",
        "class Child(Base):",
        "    @Base.count.setter",
        "    def count(self, value):",
        "        self._count = value",
        "    def __init__(self):",
        "        self.count = 3",
      ].join("\n");
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const navigation = await goToDefinition(index, { file, line: 10, column: 14 });
      expect(navigation.status).toBe("ok");
      if (navigation.status === "ok") expect(navigation.definition.range.start.line).not.toBe(10);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Python inherited and replaced property navigation", () => {
  /** Goto targets for the `count` token on `gotoLines`, and the references and coverage of the `count` on `defLine`. */
  async function navigateCount(
    source: string,
    gotoLines: readonly number[],
    defLine: number,
  ): Promise<{ targets: Array<number | string>; referenceLines: number[]; coverage: string | undefined }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-inherited-property-"));
    try {
      const file = path.join(root, "models.py").replace(/\\/g, "/");
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const lines = source.split("\n");
      const column = (line: number): number => lines[line - 1]!.indexOf("count") + 1;
      const targets: Array<number | string> = [];
      for (const line of gotoLines) {
        const result = await goToDefinition(index, { file, line, column: column(line) });
        targets.push(result.status === "ok" ? result.definition.range.start.line : result.status);
      }
      const references = await findReferences(index, { file, line: defLine, column: column(defLine) });
      if (references.status !== "ok") throw new Error("Expected references for the count definition");
      return {
        targets,
        referenceLines: references.references.map((reference) => reference.range.start.line),
        coverage: references.referenceCoverage?.state,
      };
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  const base = [
    "class Base:",
    "    def __init__(self):",
    "        self._count = 0",
    "    @property",
    "    def count(self):",
    "        return self._count",
    "    @count.setter",
    "    def count(self, value):",
    "        self._count = value",
  ];

  it("resolves self.count in a subclass to an inherited property, not to its __init__ write", async () => {
    const source = [
      ...base,
      "class Child(Base):",
      "    def __init__(self):",
      "        super().__init__()",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
      "class GrandChild(Child):",
      "    def read_again(self):",
      "        return self.count",
    ].join("\n");
    const outcome = await navigateCount(source, [13, 15, 18], 5);

    // The inherited property takes the write and both reads; the write declares no instance attribute.
    expect(outcome.targets).toEqual([5, 5, 5]);
    expect(outcome.referenceLines).toEqual(expect.arrayContaining([5, 13, 15, 18]));
    expect(outcome.coverage).toBe("partial");
  });

  it.each([
    { name: "a class attribute that is not a property", override: "    count = 5" },
    { name: "a plain base attribute", override: "", baseOverride: true },
  ])("keeps the instance attribute ahead of $name in a nearer class", async ({ override, baseOverride }) => {
    const parent = baseOverride ? ["class Parent:", "    count = 1"] : base;
    const source = [
      ...parent,
      baseOverride ? "class Written(Parent):" : "class Written(Base):",
      ...(override ? [override] : []),
      "    def __init__(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");
    const lines = source.split("\n");
    const writeLine = lines.findIndex((line) => line.includes("self.count = 3")) + 1;
    const readLine = lines.findIndex((line) => line.includes("return self.count")) + 1;
    const outcome = await navigateCount(source, [readLine], writeLine);

    // Only a property in the first class that declares `count` takes precedence over the instance dictionary.
    expect(outcome.targets).toEqual([writeLine]);
  });

  it("resolves self.count to the replacing getter and keeps its references partial", async () => {
    const source = [
      "class Base:",
      "    @property",
      "    def count(self):",
      "        return 1",
      "    @count.getter",
      "    def count(self):",
      "        return 2",
      "    def use(self):",
      "        return self.count",
      "class Sub(Base):",
      "    @Base.count.getter",
      "    def count(self):",
      "        return 3",
      "    def again(self):",
      "        return self.count",
    ].join("\n");
    const base = await navigateCount(source, [9], 6);
    const sub = await navigateCount(source, [15], 12);

    expect(base).toMatchObject({ targets: [6], coverage: "partial" });
    expect(base.referenceLines).toEqual(expect.arrayContaining([6, 9]));
    expect(sub).toMatchObject({ targets: [12], coverage: "partial" });
    expect(sub.referenceLines).toEqual(expect.arrayContaining([12, 15]));
  });

  /** `Root.count` is a plain attribute and `Right.count` a property; `Child` derives from both through `bases`. */
  const mixinSource = (bases: string, rightExtendsRoot: boolean): string =>
    [
      "class Root:",
      "    count = 0",
      "class Left(Root):",
      "    pass",
      rightExtendsRoot ? "class Right(Root):" : "class Right:",
      "    @property",
      "    def count(self):",
      "        return 1",
      `class Child(${bases}):`,
      "    def __init__(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");

  it.each(["Left, Right", "Right, Left"])(
    "leaves self.count unresolved when Child(%s) reaches a plain attribute and a property that the bases do not order",
    async (bases) => {
      const outcome = await navigateCount(mixinSource(bases, false), [11, 13], 7);

      // Only the method resolution order says whether Root.count or Right.count comes first, so neither may be chosen.
      expect(outcome.targets).toEqual(["not_found", "not_found"]);
      expect(outcome.referenceLines).toEqual([7]);
      expect(outcome.coverage).toBe("partial");
    },
  );

  it.each(["Left, Right", "Right, Left"])(
    "resolves self.count to the property when Right extends the class with the plain attribute: Child(%s)",
    async (bases) => {
      const outcome = await navigateCount(mixinSource(bases, true), [11, 13], 7);

      // A subclass comes before its bases in every order, so Right.count is first whichever base is listed first.
      expect(outcome.targets).toEqual([7, 7]);
      expect(outcome.referenceLines).toEqual(expect.arrayContaining([7, 11, 13]));
    },
  );

  it("resolves self.count to a property that a diamond reaches through both bases", async () => {
    const source = [
      ...base,
      "class Left(Base):",
      "    pass",
      "class Right(Base):",
      "    pass",
      "class Child(Left, Right):",
      "    def __init__(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");
    const outcome = await navigateCount(source, [16, 18], 5);

    expect(outcome.targets).toEqual([5, 5]);
    expect(outcome.referenceLines).toEqual(expect.arrayContaining([5, 16, 18]));
  });

  it("keeps the instance attribute when a plain class attribute replaces the property later in the class", async () => {
    const source = [
      "class Counter:",
      "    @property",
      "    def count(self):",
      "        return 1",
      "    count = 0",
      "    def write(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");
    const outcome = await navigateCount(source, [7, 9], 5);

    // The class-level binding that runs last is `count = 0`, which is no descriptor, so the write declares an attribute.
    expect(outcome.targets).toEqual([7, 7]);
  });

  it.each([
    {
      name: "a plain class attribute before the property",
      lines: [
        "class Counter:",
        "    count = 0",
        "    @property",
        "    def count(self):",
        "        return 1",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
      probes: [7, 9],
      property: 4,
    },
    {
      name: "a deleter after the setter",
      lines: [
        "class Counter:",
        "    @property",
        "    def count(self):",
        "        return 1",
        "    @count.setter",
        "    def count(self, value):",
        "        pass",
        "    @count.deleter",
        "    def count(self):",
        "        pass",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
      probes: [12, 14],
      property: 3,
    },
    {
      name: "an annotation without a value after the property",
      lines: [
        "class Counter:",
        "    @property",
        "    def count(self):",
        "        return 1",
        "    count: int",
        "    def write(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
      probes: [7, 9],
      property: 3,
    },
  ])("keeps the property as the class-level binding with $name", async ({ lines, probes, property }) => {
    const outcome = await navigateCount(lines.join("\n"), probes, property);

    expect(outcome.targets).toEqual([property, property]);
    expect(outcome.coverage).toBe("partial");
  });

  /** A `Counter` class whose `count` property comes from `form` (lines 4 and on), then an instance write and read. */
  const counterWith = (form: string[]): string[] => [
    "class Counter:",
    "    def get_count(self):",
    "        return 1",
    ...form,
    "    def write(self):",
    "        self.count = 3",
    "    def read(self):",
    "        return self.count",
  ];

  it.each([
    {
      name: "a getter that replaces a property() assignment",
      form: ["    count = property(get_count)", "    @count.getter", "    def count(self):", "        return 2"],
      target: 6,
    },
    {
      name: "a property that replaces a property() assignment",
      form: ["    count = property(get_count)", "    @property", "    def count(self):", "        return 2"],
      target: 6,
    },
    {
      name: "a property() assignment that replaces a property",
      form: ["    @property", "    def count(self):", "        return 2", "    count = property(get_count)"],
      target: 7,
    },
    {
      name: "a setter that updates a property() assignment",
      form: ["    count = property(get_count)", "    @count.setter", "    def count(self, value):", "        pass"],
      target: 4,
    },
    {
      name: "a deleter that updates a property() assignment",
      form: ["    count = property(get_count)", "    @count.deleter", "    def count(self):", "        pass"],
      target: 4,
    },
  ])("resolves self.count to the last binding that makes the property: $name", async ({ form, target }) => {
    const lines = counterWith(form);
    const write = lines.findIndex((text) => text.includes("self.count = 3")) + 1;
    const outcome = await navigateCount(lines.join("\n"), [write, write + 2], target);

    // A getter or constructor replaces the property, so its definition is the target; a setter or deleter updates
    // the property and leaves the getter or constructor that made it as the target.
    expect(outcome.targets).toEqual([target, target]);
    expect(outcome.referenceLines).toEqual(expect.arrayContaining([target, write, write + 2]));
  });

  it.each([
    {
      name: "an annotation without a value in the subclass",
      lines: [
        ...base,
        "class Child(Base):",
        "    count: int",
        "    def __init__(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
    },
    {
      name: "an annotation in a class between the subclass and the property",
      lines: [
        ...base,
        "class Mid(Base):",
        "    count: int",
        "class Child(Mid):",
        "    def __init__(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
    },
    {
      name: "an annotation in a base that comes before the property's class",
      lines: [
        ...base,
        "class Left:",
        "    count: int",
        "class Child(Left, Base):",
        "    def __init__(self):",
        "        self.count = 3",
        "    def read(self):",
        "        return self.count",
      ],
    },
  ])("resolves self.count past $name to the inherited property", async ({ lines }) => {
    const write = lines.findIndex((text) => text.includes("self.count = 3")) + 1;
    const annotation = lines.findIndex((text) => text.trim() === "count: int") + 1;
    const outcome = await navigateCount(lines.join("\n"), [write, write + 2], 5);
    const annotated = await navigateCount(lines.join("\n"), [], annotation);

    // `count: int` declares a type and binds nothing, so the property of `Base` still decides the name.
    expect(outcome.targets).toEqual([5, 5]);
    expect(outcome.referenceLines).toEqual(expect.arrayContaining([5, write, write + 2]));
    expect(annotated.referenceLines).toEqual([annotation]);
  });

  it("keeps the instance attribute when the subclass gives the annotated name a value", async () => {
    const source = [
      ...base,
      "class Child(Base):",
      "    count: int = 5",
      "    def __init__(self):",
      "        self.count = 3",
      "    def read(self):",
      "        return self.count",
    ].join("\n");
    const outcome = await navigateCount(source, [13, 15], 11);

    // `count: int = 5` is a class-level binding that is no descriptor, so the write declares an instance attribute.
    expect(outcome.targets).toEqual([13, 13]);
  });

  it("resolves self.count to an annotation without a value when no class of the hierarchy has a property", async () => {
    const source = ["class Child:", "    count: int", "    def read(self):", "        return self.count"].join("\n");
    const outcome = await navigateCount(source, [4], 2);

    expect(outcome.targets).toEqual([2]);
    expect(outcome.referenceLines).toEqual(expect.arrayContaining([2, 4]));
  });
});
