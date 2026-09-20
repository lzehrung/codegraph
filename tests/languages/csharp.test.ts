import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQuery } from "@lzehrung/codegraph-native";
import { CSHARP_SUPPORT } from "../../src/languages.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { getUnresolvedImports } from "../../src/graphs/unresolved.js";
import { buildProjectIndexFromFiles, goToDefinition, type ProjectIndex } from "../../src/index.js";
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
