import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { buildProjectIndex, collectLocalsAndExportsFromSource, parseFile, SymbolKind } from "../../src/indexer.js";
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
});

describe("Python native import bindings", () => {
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

  it("keeps simple-suite imports out of module exports while retaining same-line top-level imports", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-simple-suite-"));
    const consumer = path.join(root, "consumer.py");
    await Promise.all(
      ["feature", "hidden", "first", "second"].map((name) =>
        fsp.writeFile(path.join(root, `${name}.py`), "value = 1\n"),
      ),
    );
    await fsp.writeFile(
      consumer,
      ["if enabled: import feature", "def load(): import hidden", "import first; import second"].join("\n"),
    );
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(consumer));
      expect(module?.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "feature", moduleLevel: false }),
          expect.objectContaining({ from: "hidden", moduleLevel: false }),
          expect.objectContaining({ from: "second", moduleLevel: true }),
        ]),
      );
      const exported = module?.exports.flatMap((entry) => (entry.type === "exportStar" ? [] : [entry.exportedAs]));
      expect(exported).not.toContain("feature");
      expect(exported).not.toContain("hidden");
      expect(exported).toContain("second");
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
