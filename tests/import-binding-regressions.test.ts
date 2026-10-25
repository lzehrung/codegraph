import { describe, expect, it } from "vitest";
import path from "node:path";
import { collectImportsForFile, parseFile } from "../src/indexer.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { buildProjectIndexFromFiles, findReferences, goToDefinition } from "../src/index.js";
import { CSHARP_SUPPORT } from "../src/languages.js";
import { collectCsharpImportDirectives, csharpUsingDirective, parseCsharpSyntaxTree } from "../src/util/csharp-tree.js";
import { fileIdentityKey } from "../src/util/paths.js";

function simplifyImports(imports: Awaited<ReturnType<typeof collectImportsForFile>>): unknown[] {
  return imports.map((entry) => ({
    kind: entry.kind,
    ...(entry.kind === "named"
      ? {
          local: entry.local,
          imported: entry.imported,
        }
      : {}),
    ...(entry.kind === "namespace"
      ? {
          localNS: entry.localNS,
        }
      : {}),
    from: entry.from,
    resolved: typeof entry.resolved === "string" ? entry.resolved.replace(/\\/g, "/") : entry.resolved,
  }));
}

describe("import binding regressions", () => {
  it("retains Kotlin alias imports in import binding extraction", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "kotlin");
    const file = path.join(root, "Aliases.kt");
    const target = path.join(root, "utils", "helperFunction.kt").replace(/\\/g, "/");
    const parsed = await parseFile(file);

    const imports = await collectImportsForFile(file, root, {
      source: parsed.source,
      sup: parsed.sup,
      ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
    });

    expect(simplifyImports(imports)).toContainEqual({
      kind: "named",
      local: "RenamedUtilityClass",
      imported: "UtilityClass",
      from: "utils.UtilityClass",
      resolved: target,
    });
  });

  it("treats Java static wildcard imports as star imports from the declaring type", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "java");
    const file = path.join(root, "StaticWildcardImports.java");
    const target = path.join(root, "utils", "Utils.java").replace(/\\/g, "/");
    const parsed = await parseFile(file);

    const imports = await collectImportsForFile(file, root, {
      source: parsed.source,
      sup: parsed.sup,
      ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
    });

    expect(simplifyImports(imports)).toContainEqual({
      kind: "star",
      from: "utils.Utils",
      resolved: target,
    });
  });

  it("retains PHP grouped use aliases, functions, and constants in import binding extraction", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "php");
    const file = path.join(root, "grouped-consumer.php");
    const toolboxTarget = path.join(root, "src", "Support", "Toolbox.php").replace(/\\/g, "/");
    const helperTarget = path.join(root, "src", "Support", "support_helper.php").replace(/\\/g, "/");
    const constantTarget = path.join(root, "src", "Support", "DEFAULT_NAME.php").replace(/\\/g, "/");
    const parsed = await parseFile(file);

    const imports = await collectImportsForFile(file, root, {
      source: parsed.source,
      sup: parsed.sup,
      ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
    });

    const simplified = simplifyImports(imports);
    expect(simplified).toContainEqual({
      kind: "named",
      local: "SupportToolbox",
      imported: "tOoLbOx",
      from: "aPp\\sUpPoRt\\tOoLbOx",
      resolved: toolboxTarget,
    });
    expect(simplified).toContainEqual({
      kind: "named",
      local: "SuPpOrT_hElPeR",
      imported: "SuPpOrT_hElPeR",
      from: "aPp\\sUpPoRt\\SuPpOrT_hElPeR",
      resolved: helperTarget,
    });
    expect(simplified).toContainEqual({
      kind: "named",
      local: "DEFAULT_NAME",
      imported: "DEFAULT_NAME",
      from: "aPp\\sUpPoRt\\DEFAULT_NAME",
      resolved: constantTarget,
    });
  });
  it("resolves a generic C# alias by arity for goto and findReferences within one file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-generic-alias-same-file-"));
    const types = path.join(root, "Types.cs");
    const main = path.join(root, "Main.cs");
    const typeSource = [
      "namespace N {",
      "  public class Box {",
      "    public class Nested {}",
      "  }",
      "  public class Box<T> {",
      "    public class Nested {}",
      "  }",
      "}",
    ].join("\n");
    const mainLines = ["using B = N.Box<int>;", "class Use {", "  B value;", "}"];
    try {
      await writeFile(types, typeSource + "\n", "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [types, main]);

      const goto = await goToDefinition(index, {
        file: main,
        line: 3,
        column: mainLines[2]!.indexOf("B") + 1,
      });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected alias B to resolve to Box<T>");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(types));
      expect(goto.definition.range.start.line).toBe(5);

      const references = await findReferences(index, {
        file: types,
        line: 5,
        column: typeSource.split("\n")[4]!.indexOf("Box") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected generic Box references");
      expect(
        references.references.some(
          (reference) => fileIdentityKey(reference.file) === fileIdentityKey(main) && reference.range.start.line === 3,
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not namespace-fallback for generic static C# usings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-static-generic-"));
    const typeFile = path.join(root, "Box.cs");
    const namespaceFile = path.join(root, "BoxNamespace.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(typeFile, "namespace N; public class Box<T> { public static void Run() {} }\n", "utf8");
      await writeFile(namespaceFile, "namespace N.Box; public class NamespaceDecoy {}\n", "utf8");
      await writeFile(main, "global using static N.Box<int>;\nusing static N.Box<int>;\nclass Use {}\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [typeFile, namespaceFile, main]);
      const importer = index.byFile.get(fileIdentityKey(main));

      expect(importer?.imports.some((binding) => binding.kind === "star" && typeof binding.resolved === "string")).toBe(
        false,
      );
      const fileTargets = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(main) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
      expect(fileTargets).not.toContain(fileIdentityKey(typeFile));
      expect(fileTargets).not.toContain(fileIdentityKey(namespaceFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps array, nullable, pointer, and ref C# alias targets unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-wrapped-alias-targets-"));
    const typeFile = path.join(root, "Box.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = [
      "using A = N.Box[];",
      "using Q = N.Box?;",
      "using P = N.Box*;",
      "using R = ref N.Box;",
      "class Use {",
      "  void M() { A.Nested.Run(); }",
      "}",
    ];
    try {
      await writeFile(
        typeFile,
        "namespace N; public class Box { public class Nested { public static void Run() {} } }\n",
        "utf8",
      );
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [typeFile, main]);
      const importer = index.byFile.get(fileIdentityKey(main));
      const wrappedAliases = new Set(["A", "Q", "P", "R"]);
      const bindings =
        importer?.imports.filter((binding) => binding.kind === "named" && wrappedAliases.has(binding.local)) ?? [];

      expect(bindings.every((binding) => typeof binding.resolved !== "string")).toBe(true);
      const fileTargets = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(main) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
      expect(fileTargets).not.toContain(fileIdentityKey(typeFile));

      const nested = await goToDefinition(index, {
        file: main,
        line: 6,
        column: mainLines[5]!.indexOf("Nested") + 1,
      });
      expect(nested.status).not.toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves generic C# aliases in their enclosing namespace before global decoys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-generic-alias-enclosing-namespace-"));
    const scopedType = path.join(root, "ScopedBox.cs");
    const globalDecoy = path.join(root, "GlobalBox.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = ["namespace A {", "  using B = N.Box<int>;", "  class Use {", "    B value;", "  }", "}"];
    try {
      await writeFile(scopedType, "namespace A.N; public class Box<T> {}\n", "utf8");
      await writeFile(globalDecoy, "namespace N; public class Box<T> {}\n", "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const csharpTree = parseCsharpSyntaxTree(mainLines.join("\n") + "\n", CSHARP_SUPPORT).tree;
      if (!csharpTree) throw new Error("Expected the C# alias fixture to parse");
      const aliasDirective = collectCsharpImportDirectives(csharpTree)
        .map(csharpUsingDirective)
        .find((directive) => directive?.alias?.text === "B");
      expect(aliasDirective?.enclosingNamespaces).toEqual(["A"]);
      const index = await buildProjectIndexFromFiles(root, [scopedType, globalDecoy, main]);
      const alias = index.byFile
        .get(fileIdentityKey(main))
        ?.imports.find((binding) => binding.kind === "named" && binding.local === "B");

      expect(typeof alias?.resolved).toBe("string");
      if (typeof alias?.resolved !== "string") throw new Error("Expected alias B to resolve to A.N.Box<T>");
      expect(fileIdentityKey(alias.resolved)).toBe(fileIdentityKey(scopedType));

      const goto = await goToDefinition(index, {
        file: main,
        line: 4,
        column: mainLines[3]!.indexOf("B") + 1,
      });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected alias B use to navigate to A.N.Box<T>");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(scopedType));

      const fileTargets = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(main) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
      expect(fileTargets).toEqual([fileIdentityKey(scopedType)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generic aliases to global-namespace C# types unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-global-generic-alias-"));
    const globalType = path.join(root, "GlobalBox.cs");
    const main = path.join(root, "Main.cs");
    try {
      await writeFile(globalType, "public class Box<T> {}\n", "utf8");
      await writeFile(
        main,
        [
          "using B = Box<int>;",
          "using G = global::Box<int>;",
          "class Use {",
          "  B value;",
          "  G globalValue;",
          "}",
        ].join("\n") + "\n",
        "utf8",
      );
      const index = await buildProjectIndexFromFiles(root, [globalType, main]);
      const aliases =
        index.byFile
          .get(fileIdentityKey(main))
          ?.imports.filter((binding) => binding.kind === "named" && ["B", "G"].includes(binding.local)) ?? [];

      expect(aliases.map((binding) => (binding.kind === "named" ? binding.local : "")).sort()).toEqual(["B", "G"]);
      expect(aliases.every((binding) => typeof binding.resolved !== "string")).toBe(true);
      const fileTargets = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(main) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : ""));
      expect(fileTargets).not.toContain(fileIdentityKey(globalType));
      const unqualifiedGoto = await goToDefinition(index, { file: main, line: 4, column: 3 });
      const globalQualifiedGoto = await goToDefinition(index, { file: main, line: 5, column: 3 });
      expect(unqualifiedGoto.status).not.toBe("ok");
      expect(globalQualifiedGoto.status).not.toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects generic C# partial declarations without non-generic same-name declarations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-generic-alias-"));
    const firstPart = path.join(root, "Box.First.cs");
    const secondPart = path.join(root, "Box.Second.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = ["using B = N.Box<int>;", "class Use {", "  B value;", "}"];
    try {
      await writeFile(firstPart, "namespace N { public class Box {} public partial class Box<T> {} }\n", "utf8");
      await writeFile(secondPart, "namespace N { public partial class Box<T> {} }\n", "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [firstPart, secondPart, main]);
      const goto = await goToDefinition(index, {
        file: main,
        line: 3,
        column: mainLines[2]!.indexOf("B") + 1,
      });

      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected generic alias B to select the partial Box<T>");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(firstPart));
      expect(goto.definition.range.start.line).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
