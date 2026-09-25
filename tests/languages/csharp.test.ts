import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { CSHARP_SUPPORT } from "../../src/languages.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { getUnresolvedImports } from "../../src/graphs/unresolved.js";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  listSymbols,
  type ProjectIndex,
} from "../../src/index.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

const definition: LanguageTestDefinition = {
  id: "csharp",
  samples: [
    {
      name: "chunks C# structures",
      sourceFile: "csharp.sample.cs",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 3 },
        { type: "namespace", name: "MyNamespace", startLine: 4, endLine: 19 },
        { type: "class", name: "MyClass", startLine: 5, endLine: 9 },
        { type: "method", name: "MyMethod", startLine: 6, endLine: 8 },
        { type: "interface", name: "IMyInterface", startLine: 11, endLine: 13 },
        { type: "method", name: "InterfaceMethod", startLine: 12, endLine: 12 },
        { type: "enum", name: "MyEnum", startLine: 15, endLine: 18 },
        { type: "misc", startLine: 19, endLine: 20 },
      ],
    },
  ],
  parity: {
    sampleDir: "csharp",
    exact: {
      dependencyGraph: [
        {
          from: "Main.cs",
          to: { type: "file", path: "Utils.cs" },
        },
        {
          from: "Main.cs",
          to: { type: "file", path: "Helpers.cs" },
        },
        {
          from: "AliasOnly.cs",
          to: { type: "file", path: "Utils.cs" },
        },
        {
          from: "NamespaceAlias.cs",
          to: { type: "external", name: "System.Collections.Generic" },
        },
        {
          from: "GlobalUsings.cs",
          to: { type: "external", name: "System.Text" },
        },
        {
          from: "GlobalUsings.cs",
          to: { type: "file", path: "Shared.cs" },
        },
      ],
      symbols: [
        {
          file: "AdvancedTypes.cs",
          symbols: [
            { name: "IRunnable", kind: "interface" },
            { name: "Run", kind: "function" },
            { name: "Toolbox", kind: "class" },
            { name: "NestedTool", kind: "class" },
            { name: "Execute", kind: "function" },
            { name: "Mode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
          ],
        },
        {
          file: "RecordTypes.cs",
          symbols: [
            { name: "ISized", kind: "interface" },
            { name: "Size", kind: "variable" },
            { name: "Point", kind: "class" },
            { name: "X", kind: "variable" },
            { name: "Y", kind: "variable" },
            { name: "NamedShape", kind: "class" },
            { name: "Size", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for an is-pattern bound variable includes its usage site",
          file: "PatternMatching.cs",
          line: 7,
          column: 29,
          references: [
            { file: "PatternMatching.cs", line: 7 },
            { file: "PatternMatching.cs", line: 9 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves an is-pattern bound variable from its usage site",
        file: "PatternMatching.cs",
        line: 9,
        column: 42,
        expectedDefinition: { file: "PatternMatching.cs", line: 7 },
      },
      {
        name: "go to definition resolves a type through a global using namespace",
        file: "GlobalUsings.cs",
        line: 10,
        column: 9,
        expectedDefinition: { file: "Shared.cs", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("C# Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a method name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "Widget.cs",
      source: "// café ☕ prüfung\n/* über */ public class Widget {\n\tpublic int Créer() {\n\t\treturn 1;\n\t}\n}\n",
      symbolName: "Créer",
    });
  });
});

describe("C# global using directives", () => {
  it("keeps global, alias, and static forms as resolved import bindings", async () => {
    const sampleDir = path.resolve(process.cwd(), "tests", "samples", "csharp");
    const globalUsingFile = path.join(sampleDir, "GlobalUsings.cs");
    const sharedFile = path.join(sampleDir, "Shared.cs");
    const index = await createTestIndexFromFiles(sampleDir, [globalUsingFile, sharedFile]);
    const moduleEntry = [...index.byFile.values()].find(
      (entry) => fileIdentityKey(entry.file) === fileIdentityKey(globalUsingFile),
    );

    expect(moduleEntry).toBeDefined();
    if (!moduleEntry) return;

    const systemTextBinding = moduleEntry.imports.find(
      (binding) => binding.kind === "star" && binding.from === "System.Text",
    );
    expect(systemTextBinding).toBeDefined();
    expect(systemTextBinding?.resolved).toEqual({ external: "System.Text" });

    const sharedBindings = [
      moduleEntry.imports.find((binding) => binding.kind === "star" && binding.from === "Shared"),
      moduleEntry.imports.find(
        (binding) => binding.kind === "named" && binding.local === "TextBuilder" && binding.from === "Shared",
      ),
      moduleEntry.imports.find((binding) => binding.kind === "star" && binding.from === "Shared.TextUtilities"),
    ];
    for (const binding of sharedBindings) {
      expect(typeof binding?.resolved).toBe("string");
      if (typeof binding?.resolved !== "string") continue;
      expect(fileIdentityKey(binding.resolved)).toBe(fileIdentityKey(sharedFile));
    }
  });
});

describe("C# native declaration queries", () => {
  it("captures member constructs that use non-uniform grammar shapes", () => {
    const source = `
      namespace Demo;
      struct Point {
        int X;
        int Value { get; set; }
        Point(int x) { X = x; }
        public static Point operator +(Point a, Point b) => a;
        public event System.Action Changed;
        public int this[int i] { get => i; }
      }
      delegate void Notify();
      class Holder { ~Holder() {} void M() { void Local() {} } }
    `;
    const exports = runQuery(source, "csharp", CSHARP_SUPPORT.queries.exports);
    const names = exports.matches.flatMap((match) =>
      match.captures.filter((capture) => capture.name === "name").map((capture) => capture.text),
    );

    // Structs, delegates, fields, properties, and events have a plain identifier name and were
    // previously missing entirely. Local functions are intentionally local, not module exports.
    expect(names).toEqual(expect.arrayContaining(["Point", "X", "Value", "Changed", "Notify", "Holder", "M"]));
    expect(names).not.toContain("Local");
    // Constructors and destructors repeat the type name, and operators, conversion operators and
    // indexers have no identifier at all. Publishing them would make `Point`/`Holder` ambiguous and
    // create symbols literally named `operator`/`this`, so they stay out of the symbol set.
    expect(names.filter((name) => name === "Point")).toHaveLength(1);
    expect(names.filter((name) => name === "Holder")).toHaveLength(1);
    expect(names).not.toContain("operator");
    expect(names).not.toContain("this");
  });
});

describe("C# module declarations", () => {
  it("keeps local functions local and classifies delegates as declared types", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-module-declarations-"));
    const file = path.join(root, "Declarations.cs");
    const source = "delegate void Notify(); class Holder { void M() { void Local() {} } }";
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const notify = module?.locals.find((symbol) => symbol.localName === "Notify");

      expect(module?.exports).toContainEqual(expect.objectContaining({ type: "local", exportedAs: "Notify" }));
      expect(module?.exports).not.toContainEqual(expect.objectContaining({ type: "local", exportedAs: "Local" }));
      expect(module?.locals).toContainEqual(expect.objectContaining({ localName: "Local" }));
      expect(notify?.kind).toBe("type");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# .csx script files", () => {
  it("classifies a System.* import as resolved stdlib, not unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-csx-stdlib-"));
    const file = path.join(root, "script.csx");
    try {
      await writeFile(file, 'using System;\nConsole.WriteLine("hi");\n', "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root });
      expect(unresolved.map((entry) => entry.name)).not.toContain("System");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reports a genuinely unknown package import in a .csx file as unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-csx-unresolved-"));
    const file = path.join(root, "script.csx");
    try {
      await writeFile(file, "using Some.Unknown.Package;\n", "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root });
      expect(unresolved.map((entry) => entry.name)).toContain("Some.Unknown.Package");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function edgesFrom(index: ProjectIndex, file: string): ProjectIndex["graph"]["edges"] {
  return index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
}

function edgeColumns(source: string, line: number, needle: string): number {
  return (source.split("\n")[line - 1] ?? "").indexOf(needle) + 1;
}

describe("C# namespace aliases", () => {
  it("resolves a block-scoped namespace alias to its declaring file and navigates its members", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-alias-"));
    const declaration = path.join(root, "Decl.cs");
    const main = path.join(root, "Main.cs");
    const mainSource = "using A = Project.Model;\nclass Program { void M() { A.Widget.Do(); } }\n";
    try {
      await writeFile(
        declaration,
        "namespace Project.Model {\n  public class Widget { public static void Do() {} }\n}\n",
        "utf8",
      );
      await writeFile(main, mainSource, "utf8");
      const index = await createTestIndexFromFiles(root, [declaration, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "A");

      // The local alias stays `A` and points at the file that declares the namespace, whose
      // file name does not mirror the namespace's last segment.
      expect(alias).toMatchObject({ kind: "namespace", localNS: "A", from: "Project.Model" });
      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") return;
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(declaration));

      const edges = edgesFrom(index, main);
      expect(edges).toHaveLength(1);
      expect(edges[0]?.to).toEqual({ type: "file", path: declaration.replace(/\\/g, "/") });

      // Member navigation through the alias resolves because the alias is a namespace import
      // that points at the declaring file: `A.Widget.Do()` resolves the member and the
      // namespace-qualified type.
      const member = await goToDefinition(index, {
        file: main,
        line: 2,
        column: edgeColumns(mainSource, 2, "Do();"),
      });
      expect(member.status).toBe("ok");
      if (member.status === "ok") {
        expect(fileIdentityKey(member.definition.file)).toBe(fileIdentityKey(declaration));
        expect(member.definition.localName).toBe("Do");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a file-scoped namespace alias to its declaring file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-alias-filescoped-"));
    const declaration = path.join(root, "Scoped.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        declaration,
        "namespace Scoped.Model;\npublic class Widget { public static void Build() {} }\n",
        "utf8",
      );
      await writeFile(main, "using S = Scoped.Model;\nclass Program { void M() { S.Widget.Build(); } }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [declaration, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "S");

      expect(alias).toMatchObject({ kind: "namespace", localNS: "S", from: "Scoped.Model" });
      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") return;
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(declaration));

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "file", path: declaration.replace(/\\/g, "/") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("targets every file that declares a namespace and leaves the alias unresolved when split", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-split-"));
    const alpha = path.join(root, "Alpha.cs");
    const beta = path.join(root, "Beta.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        alpha,
        "namespace Shared.Scoped;\npublic class Widget { public static void Build() {} }\n",
        "utf8",
      );
      await writeFile(
        beta,
        "namespace Shared.Scoped;\npublic class Gadget { public static void Build() {} }\n",
        "utf8",
      );
      await writeFile(main, "using S = Shared.Scoped;\nclass Program { void M() { S.Widget.Build(); } }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [alpha, beta, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "S");

      // A namespace split over files has no single target, so the binding stays an unresolved
      // namespace rather than claiming one declaring file.
      expect(alias).toMatchObject({ kind: "namespace", localNS: "S", from: "Shared.Scoped" });
      expect(alias?.resolved).toBeUndefined();

      const targets = edgesFrom(index, main).map((edge) => edge.to);
      expect(targets).toHaveLength(2);
      expect(targets).toEqual(
        expect.arrayContaining([
          { type: "file", path: alpha.replace(/\\/g, "/") },
          { type: "file", path: beta.replace(/\\/g, "/") },
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an external namespace alias external", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-external-"));
    const main = path.join(root, "NamespaceAlias.cs");
    try {
      await writeFile(main, "using Col = System.Collections.Generic;\nclass NamespaceAliasProgram {}\n", "utf8");
      const index = await createTestIndexFromFiles(root, [main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "named" && binding.local === "Col");

      expect(alias).toMatchObject({
        kind: "named",
        local: "Col",
        imported: "Generic",
        from: "System.Collections.Generic",
        resolved: { external: "System.Collections.Generic" },
      });

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "external", name: "System.Collections.Generic" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("follows the new namespace mapping when the same root is rebuilt after the declaring file moves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-rebuild-"));
    const first = path.join(root, "First.cs");
    const second = path.join(root, "Second.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(first, "namespace Project.Model;\npublic class Widget {}\n", "utf8");
      await writeFile(main, "using A = Project.Model;\nclass Program { void M() { A.Widget.Do(); } }\n", "utf8");
      const initial = await buildProjectIndexFromFiles(root, [first, main]);
      expect(edgesFrom(initial, main).map((edge) => edge.to)).toEqual([
        { type: "file", path: first.replace(/\\/g, "/") },
      ]);

      // Rebuilding the same root must not reuse the cached namespace-to-file mapping.
      await rm(first);
      await writeFile(second, "namespace Project.Model;\npublic class Widget { public static void Do() {} }\n", "utf8");
      const rebuilt = await buildProjectIndexFromFiles(root, [second, main]);
      expect(edgesFrom(rebuilt, main).map((edge) => edge.to)).toEqual([
        { type: "file", path: second.replace(/\\/g, "/") },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a first-party type alias resolving to its declaring file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-type-alias-"));
    const utils = path.join(root, "Utils.cs");
    const main = path.join(root, "AliasOnly.cs");
    const mainSource =
      "using UUtils = Utils.UtilsClass;\nclass AliasOnlyProgram {\n  static void Main() {\n    UUtils.HelperFunction();\n  }\n}\n";
    try {
      await writeFile(
        utils,
        "namespace Utils {\n  public static class UtilsClass { public static void HelperFunction() {} }\n}\n",
        "utf8",
      );
      await writeFile(main, mainSource, "utf8");
      const index = await createTestIndexFromFiles(root, [utils, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "named" && binding.local === "UUtils");

      expect(alias).toMatchObject({ kind: "named", local: "UUtils", imported: "UtilsClass", from: "Utils.UtilsClass" });
      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") return;
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(utils));

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "file", path: utils.replace(/\\/g, "/") }]);

      const member = await goToDefinition(index, {
        file: main,
        line: 4,
        column: edgeColumns(mainSource, 4, "HelperFunction"),
      });
      expect(member.status).toBe("ok");
      if (member.status === "ok") {
        expect(fileIdentityKey(member.definition.file)).toBe(fileIdentityKey(utils));
        expect(member.definition.localName).toBe("HelperFunction");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an alias to a later block-scoped namespace in a file that declares several", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-multiple-"));
    const declaration = path.join(root, "Declarations.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        declaration,
        "namespace Project.First {\n  public class Alpha {}\n}\nnamespace Project.Second {\n  public class Widget { public static void Do() {} }\n}\n",
        "utf8",
      );
      await writeFile(main, "using A = Project.Second;\nclass Program { void M() { A.Widget.Do(); } }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [declaration, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "A");

      // The second namespace in the file must be indexed, not just the first.
      expect(alias).toMatchObject({ kind: "namespace", localNS: "A", from: "Project.Second" });
      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") return;
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(declaration));

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "file", path: declaration.replace(/\\/g, "/") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a file-scoped namespace declared after a using directive and a comment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-late-filescoped-"));
    const declaration = path.join(root, "Scoped.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        declaration,
        "// Leading comment before the namespace.\nusing System;\n\nnamespace Tail.Model;\npublic class Widget { public static void Static() {} }\n",
        "utf8",
      );
      await writeFile(main, "using T = Tail.Model;\nclass Program { void M() { T.Widget.Static(); } }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [declaration, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const alias = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "T");

      expect(alias).toMatchObject({ kind: "namespace", localNS: "T", from: "Tail.Model" });
      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") return;
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(declaration));

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "file", path: declaration.replace(/\\/g, "/") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores namespace text inside block comments and string literals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-trivia-"));
    const decoy = path.join(root, "Decoy.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        decoy,
        [
          "namespace Real.Model;",
          "",
          "/*",
          "namespace Fake.Block { }",
          "*/",
          "",
          "public class Decoy {",
          '  public string Text = @"',
          "namespace Fake.Text;",
          '";',
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        main,
        "using R = Real.Model;\nusing F = Fake.Block;\nusing G = Fake.Text;\nclass Program {}\n",
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [decoy, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const real = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "R");
      const commented = module?.imports.find((binding) => binding.kind === "named" && binding.local === "F");
      const inString = module?.imports.find((binding) => binding.kind === "named" && binding.local === "G");

      // Only the real namespace maps to the file; the comment and the verbatim string do not.
      expect(typeof real?.resolved).toBe("string");
      if (typeof real?.resolved !== "string") return;
      expect(fileIdentityKey(real.resolved)).toBe(fileIdentityKey(decoy));
      expect(commented?.resolved).toEqual({ external: "Fake.Block" });
      expect(inString?.resolved).toEqual({ external: "Fake.Text" });

      const edges = edgesFrom(index, main).map((edge) => edge.to);
      expect(edges).toEqual(
        expect.arrayContaining([
          { type: "file", path: decoy.replace(/\\/g, "/") },
          { type: "external", name: "Fake.Block" },
          { type: "external", name: "Fake.Text" },
        ]),
      );
      expect(edges).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a nested namespace's qualified name and its enclosing namespace to the declaring file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-nested-"));
    const declaration = path.join(root, "Nested.cs");
    const main = path.join(root, "Main.cs");
    try {
      // One line, so the scan cannot rely on a declaration starting a line.
      await writeFile(
        declaration,
        "namespace Outer { namespace Inner { public class Widget { public static void Do() {} } } }\n",
        "utf8",
      );
      await writeFile(
        main,
        "using A = Outer.Inner;\nusing B = Outer;\nclass Program { void M() { A.Widget.Do(); } }\n",
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [declaration, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const nested = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "A");
      const enclosing = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "B");

      // The nested block contributes the composed name, and the enclosing block is also declared.
      expect(nested).toMatchObject({ kind: "namespace", localNS: "A", from: "Outer.Inner" });
      expect(enclosing).toMatchObject({ kind: "namespace", localNS: "B", from: "Outer" });
      expect(typeof nested?.resolved).toBe("string");
      expect(typeof enclosing?.resolved).toBe("string");
      if (typeof nested?.resolved !== "string") return;
      if (typeof enclosing?.resolved !== "string") return;
      expect(fileIdentityKey(nested.resolved)).toBe(fileIdentityKey(declaration));
      expect(fileIdentityKey(enclosing.resolved)).toBe(fileIdentityKey(declaration));

      const edges = edgesFrom(index, main);
      expect(edges.map((edge) => edge.to)).toEqual([{ type: "file", path: declaration.replace(/\\/g, "/") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not compose namespace names out of block comments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-nested-comment-"));
    const decoy = path.join(root, "Commented.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(
        decoy,
        [
          "namespace Real.Model;",
          "",
          "/*",
          "namespace Outer {",
          "  namespace Inner { }",
          "}",
          "*/",
          "",
          "public class Decoy {}",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        main,
        "using R = Real.Model;\nusing N = Outer.Inner;\nusing O = Outer;\nclass Program {}\n",
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [decoy, main]);
      const module = index.byFile.get(fileIdentityKey(main));
      const real = module?.imports.find((binding) => binding.kind === "namespace" && binding.localNS === "R");
      const nested = module?.imports.find((binding) => binding.kind === "named" && binding.local === "N");
      const enclosing = module?.imports.find((binding) => binding.kind === "named" && binding.local === "O");

      expect(typeof real?.resolved).toBe("string");
      if (typeof real?.resolved !== "string") return;
      expect(fileIdentityKey(real.resolved)).toBe(fileIdentityKey(decoy));
      expect(nested?.resolved).toEqual({ external: "Outer.Inner" });
      expect(enclosing?.resolved).toEqual({ external: "Outer" });

      const edges = edgesFrom(index, main).map((edge) => edge.to);
      expect(edges).toEqual(
        expect.arrayContaining([
          { type: "file", path: decoy.replace(/\\/g, "/") },
          { type: "external", name: "Outer.Inner" },
          { type: "external", name: "Outer" },
        ]),
      );
      expect(edges).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# record components", () => {
  it("indexes positional record parameters as variable locals and leaves a body property alone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-record-components-"));
    const file = path.join(root, "Records.cs");
    const source = [
      "public record Plain(int Size);",
      "public record class Headed(int Size, string Name);",
      "public record struct Valued(int Width) {",
      "  public int Extra { get; set; }",
      "}",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const locals = module?.locals ?? [];
      const kindsByName = (name: string) =>
        locals.filter((local) => local.localName === name).map((local) => local.kind);

      // Positional parameters of plain, `record class`, and `record struct` declarations are
      // variable locals, and the two `Size` parameters stay distinct declarations.
      expect(kindsByName("Size")).toEqual(["variable", "variable"]);
      expect(kindsByName("Name")).toEqual(["variable"]);
      expect(kindsByName("Width")).toEqual(["variable"]);
      // A non-positional property in the record body is unaffected and stays a variable local.
      expect(kindsByName("Extra")).toEqual(["variable"]);

      // Components are locals only: they never become exports.
      const exported = (module?.exports ?? []).flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));
      expect(exported).toContain("Extra");
      expect(exported).not.toContain("Size");
      expect(exported).not.toContain("Name");
      expect(exported).not.toContain("Width");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# extern alias", () => {
  it("recognizes the alias binding without inventing a dependency edge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-extern-alias-"));
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(main, "extern alias Foo;\nclass Program { static void Main() {} }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [main]);
      const module = index.byFile.get(fileIdentityKey(main));

      // `extern alias` names a compiler alias for an assembly's extern alias, so it has no
      // resolvable target but is still recognized as a local namespace alias.
      expect(module?.imports).toEqual([{ kind: "namespace", localNS: "Foo", from: "Foo" }]);

      // It is not an import specifier: no file or external dependency edge, and no unresolved
      // import finding for `Foo`.
      expect(edgesFrom(index, main)).toEqual([]);
      expect(getUnresolvedImports(index.graph, { projectRoot: root }).map((entry) => entry.name)).not.toContain("Foo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# method parameters as locals", () => {
  it("lists a method parameter as a local and resolves it through goto", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-method-params-"));
    const file = path.join(root, "Params.cs");
    const source = [
      "public class Greeter {",
      "  public void Greet(string name, int times) {",
      "    System.Console.WriteLine(name);",
      "  }",
      "}",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);

      const symbols = listSymbols(index, { file });
      const nameParam = symbols.filter((symbol) => symbol.name === "name");
      expect(nameParam.length).toBeGreaterThan(0);

      // `name` is used inside the method body; goto resolves it to the parameter declaration.
      const useLine = 3;
      const useColumn = source.split("\n")[useLine - 1].indexOf("name") + 1;
      const goto = await goToDefinition(index, { file, line: useLine, column: useColumn });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.localName).toBe("name");
        expect(goto.definition.range.start.line).toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# same-namespace sibling visibility", () => {
  // #378: a type declared in the same namespace is visible without a using directive, so the
  // sibling type must resolve and be referenced, while a same-named type in another namespace
  // must stay out of both results.
  const targetLines = ["namespace P;", "public class Target {}"];
  const useLines = ["namespace P;", "public class Use {", "  Target Make() => new Target();", "}"];
  const decoyTargetLines = ["namespace Q;", "public class Target {}"];
  const decoyUseLines = ["namespace Q;", "public class UseDecoy {", "  Target Make() => new Target();", "}"];

  it("resolves sibling return types and constructors and excludes the other namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-peer-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Target.cs": `${targetLines.join("\n")}\n`,
        "Use.cs": `${useLines.join("\n")}\n`,
        "Q/DecoyTarget.cs": `${decoyTargetLines.join("\n")}\n`,
        "Q/DecoyUse.cs": `${decoyUseLines.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Target.cs"]!,
        paths["Use.cs"]!,
        paths["Q/DecoyTarget.cs"]!,
        paths["Q/DecoyUse.cs"]!,
      ]);
      const targetPath = paths["Target.cs"]!;
      const usePath = paths["Use.cs"]!;

      for (const token of ["Target", "Target()"]) {
        const goto = await goToDefinition(index, {
          file: usePath,
          line: 3,
          column: columnOf(useLines, 3, token),
        });
        expect(goto.status, `Use.cs:3 ${token} must resolve`).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected the same-namespace class declaration");
        expect(normalizePath(goto.definition.file)).toBe(targetPath);
        expect(goto.definition.range.start.line).toBe(2);
      }

      const references = await findReferences(index, {
        file: targetPath,
        line: 2,
        column: columnOf(targetLines, 2, "Target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected same-namespace class references");
      expect(
        references.references.map((reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`),
      ).toContain(`${usePath}:3`);
      expect(references.references.some((reference) => normalizePath(reference.file) === paths["Q/DecoyUse.cs"])).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the other namespace out of a sibling reference scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-decoy-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Target.cs": `${targetLines.join("\n")}\n`,
        "Use.cs": `${useLines.join("\n")}\n`,
        "Q/DecoyTarget.cs": `${decoyTargetLines.join("\n")}\n`,
        "Q/DecoyUse.cs": `${decoyUseLines.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Target.cs"]!,
        paths["Use.cs"]!,
        paths["Q/DecoyTarget.cs"]!,
        paths["Q/DecoyUse.cs"]!,
      ]);
      const references = await findReferences(index, {
        file: paths["Target.cs"]!,
        line: 2,
        column: columnOf(targetLines, 2, "Target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected same-namespace class references");
      expect(references.references.some((reference) => normalizePath(reference.file) === paths["Q/DecoyUse.cs"])).toBe(
        false,
      );
      const decoyReferences = await findReferences(index, {
        file: paths["Q/DecoyTarget.cs"]!,
        line: 2,
        column: columnOf(decoyTargetLines, 2, "Target"),
      });
      expect(decoyReferences.status).toBe("ok");
      if (decoyReferences.status !== "ok") throw new Error("Expected decoy namespace references");
      expect(decoyReferences.references.some((reference) => normalizePath(reference.file) === paths["Use.cs"])).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# same-file namespace boundaries", () => {
  const lines = [
    "namespace Q { public class Target {} class Direct { Target DirectMake() => new Target(); } }",
    "namespace P { class Rejected { Target RejectedMake() => new Target(); } }",
    "namespace Q { class Allowed { Target AllowedMake() => new Target(); } }",
    "class GlobalRejected { Target GlobalMake() => new Target(); }",
    "namespace Q.Child { class Nested { Target NestedMake() => new Target(); } }",
    "namespace P { class Shadow { int Local() { int Target = 1; return Target; } } }",
    "namespace Q { internal class Hidden {} }",
    "namespace Q { class HiddenUse { Hidden InternalMake() => new Hidden(); } }",
    "namespace P { class Qualified { Q.Target QualifiedMake() => new Q.Target(); } }",
    "namespace P { class RootQualified { global::Q.Target RootMake() => new global::Q.Target(); } }",
    "namespace Q { class Unknown { Missing.Target UnknownMake() => new Missing.Target(); } }",
  ];

  it("resolves only visible declarations and finds uses in reopened namespaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-local-namespace-"));
    try {
      const paths = await writeFixtureFiles(root, { "Use.cs": lines.join("\n") });
      const file = paths["Use.cs"]!;
      const index = await buildProjectIndexFromFiles(root, [file]);
      for (const line of [1, 2, 3, 4, 5]) {
        const result = await goToDefinition(index, {
          file,
          line,
          column: columnOf(lines, line, "new Target") + 4,
        });
        const visible = line === 1 || line === 3 || line === 5;
        expect(result.status, `constructor on line ${line}`).toBe(visible ? "ok" : "not_found");
        if (result.status === "ok") {
          expect(result.definition.range.start).toMatchObject({ line: 1, column: columnOf(lines, 1, "Target") });
        }
      }
      for (const [line, token, visible] of [
        [9, "new Q.", true],
        [10, "new global::Q.", true],
        [11, "new Missing.", false],
      ] as const) {
        const qualified = await goToDefinition(index, {
          file,
          line,
          column: columnOf(lines, line, token) + token.length,
        });
        expect(qualified.status, `qualified constructor on line ${line}`).toBe(visible ? "ok" : "not_found");
        if (qualified.status === "ok") expect(qualified.definition.range.start.line).toBe(1);
      }
      const shadow = await goToDefinition(index, {
        file,
        line: 6,
        column: columnOf(lines, 6, "return Target") + 7,
      });
      expect(shadow.status).toBe("ok");
      if (shadow.status !== "ok") throw new Error("Expected the local variable");
      expect(shadow.definition.range.start).toMatchObject({ line: 6, column: columnOf(lines, 6, "Target") });

      const hidden = await goToDefinition(index, {
        file,
        line: 8,
        column: columnOf(lines, 8, "new Hidden") + 4,
      });
      expect(hidden.status).toBe("ok");
      if (hidden.status !== "ok") throw new Error("Expected the same-file internal class");
      expect(hidden.definition.range.start.line).toBe(7);
      const hiddenReferences = await findReferences(index, { file, line: 7, column: columnOf(lines, 7, "Hidden") });
      expect(hiddenReferences.status).toBe("ok");
      if (hiddenReferences.status !== "ok") throw new Error("Expected same-file internal class references");
      expect(hiddenReferences.references.map((reference) => reference.range.start.line).sort()).toEqual([7, 8, 8]);
      const references = await findReferences(index, { file, line: 1, column: columnOf(lines, 1, "Target") });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected namespace type references");
      expect(references.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([
        1, 1, 1, 3, 3, 5, 5, 9, 9, 10, 10,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create constructor edges across unrelated namespace regions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-local-namespace-graph-"));
    try {
      const paths = await writeFixtureFiles(root, { "Use.cs": lines.join("\n") });
      const index = await buildProjectIndexFromFiles(root, [paths["Use.cs"]!]);
      const graph = await buildSymbolGraphDetailed(index);
      const constructors = graph.edges
        .filter((edge) => edge.label === "instantiates" && graph.nodes.get(edge.to)?.name === "Target")
        .map((edge) => graph.nodes.get(edge.from)?.name)
        .sort();
      expect(constructors).toEqual(["AllowedMake", "DirectMake", "NestedMake", "QualifiedMake", "RootMake"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# partial class members across files", () => {
  // #378: members declared in one part file are the same owner as the call site in the other part
  // file, so navigation, references, and the detailed graph must all connect them. A third
  // same-namespace file must resolve the shared partial type without treating the parts as
  // competing exports.
  const partALines = [
    "namespace P;",
    "public partial class Box {",
    "  public void Helper() {}",
    "  public static void Left() {}",
    "}",
  ];
  const partBLines = [
    "namespace P;",
    "public partial class Box {",
    "  void Use() {",
    "    this.Helper();",
    "  }",
    "  public void Other() {}",
    "  public static void Right() {}",
    "}",
  ];
  const callerLines = [
    "namespace P;",
    "class Caller {",
    "  Box Make() => new Box();",
    "  void Run() {",
    "    var box = new Box();",
    "    box.Helper();",
    "    box.Other();",
    "    Box.Left();",
    "    Box.Right();",
    "  }",
    "}",
  ];
  const decoyLines = [
    "namespace Q;",
    "public partial class Box {",
    "  public void Helper() {}",
    "  void DecoyUse() {",
    "    this.Helper();",
    "  }",
    "}",
  ];
  const namespaceDecoyLines = ["namespace Q;", "public partial class Box {", "  public void Helper() {}", "}"];
  const nestedDecoyLines = [
    "namespace P;",
    "public partial class Outer {",
    "  public partial class Box {",
    "    public void Helper() {}",
    "  }",
    "}",
  ];
  const nonPartialDecoyLines = ["namespace R;", "public class Box {", "  public void Helper() {}", "}"];

  function expectedBoxRepresentative(partAPath: string, partBPath: string): string {
    return fileIdentityKey(partAPath) < fileIdentityKey(partBPath) ? partAPath : partBPath;
  }

  function happyPathFiles(): Record<string, string> {
    return {
      "Box.A.cs": `${partALines.join("\n")}\n`,
      "Box.B.cs": `${partBLines.join("\n")}\n`,
      "Caller.cs": `${callerLines.join("\n")}\n`,
      "Q/Box.Decoy.cs": `${decoyLines.join("\n")}\n`,
      "Decoy.Namespace.cs": `${namespaceDecoyLines.join("\n")}\n`,
      "Decoy.Nested.cs": `${nestedDecoyLines.join("\n")}\n`,
      "Decoy.NonPartial.cs": `${nonPartialDecoyLines.join("\n")}\n`,
    };
  }

  async function assertSharedPartialConsumers(index: ProjectIndex, paths: Record<string, string>): Promise<string> {
    const partAPath = paths["Box.A.cs"]!;
    const partBPath = paths["Box.B.cs"]!;
    const callerPath = paths["Caller.cs"]!;
    const decoyPath = paths["Q/Box.Decoy.cs"]!;
    const namespaceDecoyPath = paths["Decoy.Namespace.cs"]!;
    const nestedPath = paths["Decoy.Nested.cs"]!;
    const nonPartialPath = paths["Decoy.NonPartial.cs"]!;
    const representative = expectedBoxRepresentative(partAPath, partBPath);
    const decoyFiles = new Set([decoyPath, namespaceDecoyPath, nestedPath, nonPartialPath]);

    const goto = await goToDefinition(index, {
      file: partBPath,
      line: 4,
      column: columnOf(partBLines, 4, "Helper"),
    });
    expect(goto.status).toBe("ok");
    if (goto.status !== "ok") throw new Error("Expected the partial-class member declaration");
    expect(normalizePath(goto.definition.file)).toBe(partAPath);
    expect(goto.definition.range.start.line).toBe(3);

    const gotoBox = await goToDefinition(index, {
      file: callerPath,
      line: 3,
      column: columnOf(callerLines, 3, "Box Make"),
    });
    expect(gotoBox.status).toBe("ok");
    if (gotoBox.status !== "ok") throw new Error("Expected the shared partial type");
    expect(normalizePath(gotoBox.definition.file)).toBe(representative);

    const gotoNewBox = await goToDefinition(index, {
      file: callerPath,
      line: 5,
      column: columnOf(callerLines, 5, "new Box") + 4,
    });
    expect(gotoNewBox.status).toBe("ok");
    if (gotoNewBox.status !== "ok") throw new Error("Expected the constructed partial type");
    expect(normalizePath(gotoNewBox.definition.file)).toBe(representative);

    const gotoHelper = await goToDefinition(index, {
      file: callerPath,
      line: 6,
      column: columnOf(callerLines, 6, "Helper"),
    });
    expect(gotoHelper.status).toBe("ok");
    if (gotoHelper.status !== "ok") throw new Error("Expected Helper through the resolved Box");
    expect(normalizePath(gotoHelper.definition.file)).toBe(partAPath);
    expect(gotoHelper.definition.range.start.line).toBe(3);

    const gotoOther = await goToDefinition(index, {
      file: callerPath,
      line: 7,
      column: columnOf(callerLines, 7, "Other"),
    });
    expect(gotoOther.status).toBe("ok");
    if (gotoOther.status !== "ok") throw new Error("Expected Other through the resolved Box");
    expect(normalizePath(gotoOther.definition.file)).toBe(partBPath);
    expect(gotoOther.definition.range.start.line).toBe(6);

    const gotoLeft = await goToDefinition(index, {
      file: callerPath,
      line: 8,
      column: columnOf(callerLines, 8, "Left"),
    });
    expect(gotoLeft.status).toBe("ok");
    if (gotoLeft.status !== "ok") throw new Error("Expected Left through the resolved Box");
    expect(normalizePath(gotoLeft.definition.file)).toBe(partAPath);
    expect(gotoLeft.definition.range.start.line).toBe(4);

    const gotoRight = await goToDefinition(index, {
      file: callerPath,
      line: 9,
      column: columnOf(callerLines, 9, "Right"),
    });
    expect(gotoRight.status).toBe("ok");
    if (gotoRight.status !== "ok") throw new Error("Expected Right through the resolved Box");
    expect(normalizePath(gotoRight.definition.file)).toBe(partBPath);
    expect(gotoRight.definition.range.start.line).toBe(7);

    const helperReferences = await findReferences(index, {
      file: partAPath,
      line: 3,
      column: columnOf(partALines, 3, "Helper"),
    });
    expect(helperReferences.status).toBe("ok");
    if (helperReferences.status !== "ok") throw new Error("Expected partial-class member references");
    const helperSites = helperReferences.references.map(
      (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
    );
    expect(helperSites).toContain(`${partBPath}:4`);
    expect(helperSites).toContain(`${callerPath}:6`);
    expect(helperReferences.references.some((reference) => decoyFiles.has(normalizePath(reference.file)))).toBe(false);

    const leftReferences = await findReferences(index, {
      file: partAPath,
      line: 4,
      column: columnOf(partALines, 4, "Left"),
    });
    expect(leftReferences.status).toBe("ok");
    if (leftReferences.status !== "ok") throw new Error("Expected static Left references");
    const leftSites = leftReferences.references.map(
      (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
    );
    expect(leftSites).toContain(`${callerPath}:8`);
    expect(leftReferences.references.some((reference) => decoyFiles.has(normalizePath(reference.file)))).toBe(false);

    const rightReferences = await findReferences(index, {
      file: partBPath,
      line: 7,
      column: columnOf(partBLines, 7, "Right"),
    });
    expect(rightReferences.status).toBe("ok");
    if (rightReferences.status !== "ok") throw new Error("Expected static Right references");
    const rightSites = rightReferences.references.map(
      (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
    );
    expect(rightSites).toContain(`${callerPath}:9`);
    expect(rightReferences.references.some((reference) => decoyFiles.has(normalizePath(reference.file)))).toBe(false);

    const otherPart = representative === partAPath ? partBPath : partAPath;
    const otherPartLines = representative === partAPath ? partBLines : partALines;
    for (const [file, lines] of [
      [representative, representative === partAPath ? partALines : partBLines],
      [otherPart, otherPartLines],
    ] as const) {
      const boxReferences = await findReferences(index, {
        file,
        line: 2,
        column: columnOf(lines, 2, "Box"),
      });
      expect(boxReferences.status).toBe("ok");
      if (boxReferences.status !== "ok") throw new Error("Expected shared partial type references");
      const boxSites = boxReferences.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(boxSites).toContain(`${partAPath}:2`);
      expect(boxSites).toContain(`${partBPath}:2`);
      expect(boxSites).toContain(`${callerPath}:3`);
      expect(boxSites).toContain(`${callerPath}:5`);
      expect(boxSites).toContain(`${callerPath}:8`);
      expect(boxSites).toContain(`${callerPath}:9`);
      expect(
        boxReferences.references.some(
          (reference) =>
            normalizePath(reference.file) === decoyPath || normalizePath(reference.file) === namespaceDecoyPath,
        ),
      ).toBe(false);
    }

    const graph = await buildSymbolGraphDetailed(index);
    const useNode = [...graph.nodes.values()].find(
      (node) => node.name === "Use" && normalizePath(node.file) === partBPath,
    );
    expect(useNode).toBeDefined();
    const runNode = [...graph.nodes.values()].find(
      (node) => node.name === "Run" && normalizePath(node.file) === callerPath,
    );
    expect(runNode).toBeDefined();

    const callTargetsFrom = (fromId: string): string[] => {
      const callTargets: string[] = [];
      for (const edge of graph.edges) {
        if (edge.label !== "calls" || edge.from !== fromId) continue;
        const node = graph.nodes.get(edge.to);
        if (node) callTargets.push(`${normalizePath(node.file)}::${node.name}`);
      }
      return callTargets;
    };
    const useTargets = callTargetsFrom(useNode!.id);
    expect(useTargets).toContain(`${partAPath}::Helper`);
    expect(useTargets.some((target) => [...decoyFiles].some((file) => target.startsWith(`${file}::`)))).toBe(false);

    const runTargets = callTargetsFrom(runNode!.id);
    expect(runTargets).toContain(`${partAPath}::Helper`);
    expect(runTargets).toContain(`${partBPath}::Other`);
    expect(runTargets).toContain(`${partAPath}::Left`);
    expect(runTargets).toContain(`${partBPath}::Right`);
    expect(runTargets.some((target) => [...decoyFiles].some((file) => target.startsWith(`${file}::`)))).toBe(false);

    const instantiated = graph.edges
      .filter((edge) => edge.label === "instantiates" && edge.from === runNode!.id)
      .map((edge) => graph.nodes.get(edge.to))
      .filter((node): node is NonNullable<typeof node> => !!node);
    expect(instantiated.some((node) => node.name === "Box" && normalizePath(node.file) === representative)).toBe(true);
    expect(instantiated.some((node) => decoyFiles.has(normalizePath(node.file)))).toBe(false);

    return representative;
  }

  it("connects navigation, references, and calls to the declaring part", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-owner-"));
    try {
      const paths = await writeFixtureFiles(root, happyPathFiles());
      const index = await buildProjectIndexFromFiles(root, [
        paths["Box.A.cs"]!,
        paths["Box.B.cs"]!,
        paths["Caller.cs"]!,
        paths["Q/Box.Decoy.cs"]!,
        paths["Decoy.Namespace.cs"]!,
        paths["Decoy.Nested.cs"]!,
        paths["Decoy.NonPartial.cs"]!,
      ]);
      await assertSharedPartialConsumers(index, paths);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("picks the same partial representative across candidate order and disk reload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-reload-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-cache-"));
    try {
      const paths = await writeFixtureFiles(root, happyPathFiles());
      const listed = [
        paths["Caller.cs"]!,
        paths["Decoy.NonPartial.cs"]!,
        paths["Box.B.cs"]!,
        paths["Decoy.Namespace.cs"]!,
        paths["Q/Box.Decoy.cs"]!,
        paths["Decoy.Nested.cs"]!,
        paths["Box.A.cs"]!,
      ];
      const off = await buildProjectIndexFromFiles(root, listed);
      const offTarget = await assertSharedPartialConsumers(off, paths);

      const buildOptions = { cache: "disk" as const, cacheDir, threads: 1 };
      const cold = await buildProjectIndex(root, buildOptions);
      const coldTarget = await assertSharedPartialConsumers(cold, paths);
      expect(coldTarget).toBe(offTarget);

      const warm = await buildProjectIndexIncremental(root, buildOptions);
      const warmTarget = await assertSharedPartialConsumers(warm, paths);
      expect(warmTarget).toBe(offTarget);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not coalesce ordinary same-name classes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-nonpartial-duplicate-"));
    try {
      const first = ["namespace P;", "public class Box {}"];
      const second = ["namespace P;", "public class Box {}"];
      const caller = ["namespace P;", "class Caller {", "  Box Make() => new Box();", "}"];
      const paths = await writeFixtureFiles(root, {
        "Box.A.cs": `${first.join("\n")}\n`,
        "Box.B.cs": `${second.join("\n")}\n`,
        "Caller.cs": `${caller.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Box.A.cs"]!,
        paths["Box.B.cs"]!,
        paths["Caller.cs"]!,
      ]);
      const result = await goToDefinition(index, {
        file: paths["Caller.cs"]!,
        line: 3,
        column: columnOf(caller, 3, "new Box") + 4,
      });
      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not coalesce partials with different generic arities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-arity-"));
    try {
      const plain = ["namespace P;", "public partial class Box {", "  public void Helper() {}", "}"];
      const generic = ["namespace P;", "public partial class Box<T> {", "  public void Helper() {}", "}"];
      const caller = ["namespace P;", "class Caller {", "  Box Make() => new Box();", "}"];
      const paths = await writeFixtureFiles(root, {
        "Box.A.cs": `${plain.join("\n")}\n`,
        "Box.Generic.cs": `${generic.join("\n")}\n`,
        "Caller.cs": `${caller.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Box.A.cs"]!,
        paths["Box.Generic.cs"]!,
        paths["Caller.cs"]!,
      ]);
      const result = await goToDefinition(index, {
        file: paths["Caller.cs"]!,
        line: 3,
        column: columnOf(caller, 3, "new Box") + 4,
      });
      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not coalesce partials with different kinds or enclosing owners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-kind-owner-"));
    try {
      const classPart = ["namespace P;", "public partial class Box {}"];
      const structPart = ["namespace P;", "public partial struct Box {}"];
      const classCaller = ["namespace P;", "class KindCaller {", "  Box Make() => new Box();", "}"];
      const outerUse = [
        "namespace P;",
        "public partial class Outer {",
        "  public partial class Item {",
        "    void Use() { this.Helper(); }",
        "  }",
        "}",
      ];
      const otherHelper = [
        "namespace P;",
        "public partial class Other {",
        "  public partial class Item {",
        "    public void Helper() {}",
        "  }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "Box.Class.cs": `${classPart.join("\n")}\n`,
        "Box.Struct.cs": `${structPart.join("\n")}\n`,
        "KindCaller.cs": `${classCaller.join("\n")}\n`,
        "Outer.cs": `${outerUse.join("\n")}\n`,
        "Other.cs": `${otherHelper.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Box.Class.cs"]!,
        paths["Box.Struct.cs"]!,
        paths["KindCaller.cs"]!,
        paths["Outer.cs"]!,
        paths["Other.cs"]!,
      ]);
      const kind = await goToDefinition(index, {
        file: paths["KindCaller.cs"]!,
        line: 3,
        column: columnOf(classCaller, 3, "new Box") + 4,
      });
      expect(kind.status).toBe("not_found");

      const nested = await goToDefinition(index, {
        file: paths["Outer.cs"]!,
        line: 4,
        column: columnOf(outerUse, 4, "Helper"),
      });
      expect(nested.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // r4100398996: each enclosing type's generic arity belongs to the shared owner
  // identity, so `Outer.Inner` and `Outer<T>.Inner` never share partial members
  // while matching nested partials across files still connect.
  it("does not share nested partial members across distinct generic enclosing owners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-nested-arity-"));
    try {
      const plainPart = [
        "namespace P;",
        "public partial class Outer {",
        "  public partial class Inner {",
        "    public void PlainOnly() {}",
        "  }",
        "}",
      ];
      const genericPart = [
        "namespace P;",
        "public partial class Outer<T> {",
        "  public partial class Inner {",
        "    public void GenericOnly() {}",
        "  }",
        "}",
      ];
      const plainUse = [
        "namespace P;",
        "public partial class Outer {",
        "  public partial class Inner {",
        "    void UsePlain() {",
        "      this.PlainOnly();",
        "      this.GenericOnly();",
        "    }",
        "  }",
        "}",
      ];
      const genericUse = [
        "namespace P;",
        "public partial class Outer<T> {",
        "  public partial class Inner {",
        "    void UseGeneric() {",
        "      this.GenericOnly();",
        "      this.PlainOnly();",
        "    }",
        "  }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "Nested.A.cs": `${plainPart.join("\n")}\n`,
        "Nested.B.cs": `${genericPart.join("\n")}\n`,
        "Nested.Use.cs": `${plainUse.join("\n")}\n`,
        "Nested.GenericUse.cs": `${genericUse.join("\n")}\n`,
      });
      const index = await buildProjectIndexFromFiles(root, [
        paths["Nested.A.cs"]!,
        paths["Nested.B.cs"]!,
        paths["Nested.Use.cs"]!,
        paths["Nested.GenericUse.cs"]!,
      ]);

      // Matching nested partials under the same enclosing owner still cross files.
      const plain = await goToDefinition(index, {
        file: paths["Nested.Use.cs"]!,
        line: 5,
        column: columnOf(plainUse, 5, "PlainOnly"),
      });
      expect(plain.status).toBe("ok");
      if (plain.status !== "ok") throw new Error("Expected PlainOnly through the plain enclosing owner");
      expect(normalizePath(plain.definition.file)).toBe(paths["Nested.A.cs"]!);
      expect(plain.definition.range.start.line).toBe(4);

      const generic = await goToDefinition(index, {
        file: paths["Nested.GenericUse.cs"]!,
        line: 5,
        column: columnOf(genericUse, 5, "GenericOnly"),
      });
      expect(generic.status).toBe("ok");
      if (generic.status !== "ok") throw new Error("Expected GenericOnly through the generic enclosing owner");
      expect(normalizePath(generic.definition.file)).toBe(paths["Nested.B.cs"]!);
      expect(generic.definition.range.start.line).toBe(4);

      // Outer.Inner and Outer<T>.Inner do not share members in either direction.
      const leaked = await goToDefinition(index, {
        file: paths["Nested.Use.cs"]!,
        line: 6,
        column: columnOf(plainUse, 6, "GenericOnly"),
      });
      expect(leaked.status).toBe("not_found");

      const reverseLeak = await goToDefinition(index, {
        file: paths["Nested.GenericUse.cs"]!,
        line: 6,
        column: columnOf(genericUse, 6, "PlainOnly"),
      });
      expect(reverseLeak.status).toBe("not_found");

      const genericRefs = await findReferences(index, {
        file: paths["Nested.B.cs"]!,
        line: 4,
        column: columnOf(genericPart, 4, "GenericOnly"),
      });
      expect(genericRefs.status).toBe("ok");
      if (genericRefs.status !== "ok") throw new Error("Expected GenericOnly references");
      const genericSites = genericRefs.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(genericSites).toContain(`${paths["Nested.GenericUse.cs"]}:5`);
      expect(genericSites).not.toContain(`${paths["Nested.Use.cs"]}:6`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
