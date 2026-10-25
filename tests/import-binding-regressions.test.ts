import { describe, expect, it } from "vitest";
import path from "node:path";
import { collectImportsForFile, parseFile } from "../src/indexer.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { buildProjectIndexFromFiles, findReferences, goToDefinition } from "../src/index.js";
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
  it("keeps unresolved C# aliases as bindings that shadow imported decoys", async () => {
    const cases = [
      { name: "generic alias", target: "N.Box<int>", box: "namespace N; public class Box<T> {}\n" },
      { name: "array alias", target: "N.Box[]", box: "namespace N; public class Box {}\n" },
      {
        name: "conflict-unresolved alias",
        target: "N.Box",
        box: "namespace N; public class Box {}\n",
        conflict: true,
      },
    ];
    const outcomes: { name: string; hasUnresolvedAlias: boolean; useStatus: string }[] = [];
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-shadow-"));
      const main = path.join(root, "Main.cs");
      const box = path.join(root, "Box.cs");
      const decoy = path.join(root, "Other.cs");
      const aliasLine = "using B = " + testCase.target + ";";
      const mainLines = testCase.conflict
        ? ["namespace Local {", "  " + aliasLine, "  using Other;", "  class Use { B value; }", "}"]
        : [aliasLine, "using Other;", "class Use { B value; }"];
      try {
        await writeFile(main, mainLines.join("\n") + "\n", "utf8");
        await writeFile(box, testCase.box, "utf8");
        await writeFile(decoy, "namespace Other; public class B {}\n", "utf8");
        const files = [main, box, decoy];
        if (testCase.conflict) {
          const localNamespace = path.join(root, "LocalNamespace.cs");
          await writeFile(localNamespace, "namespace Local.N; public class Marker {}\n", "utf8");
          files.push(localNamespace);
        }
        const index = await buildProjectIndexFromFiles(root, files);
        const importer = index.byFile.get(fileIdentityKey(main));
        const hasUnresolvedAlias =
          importer?.imports.some(
            (entry) =>
              entry.kind === "named" &&
              entry.local === "B" &&
              entry.from === testCase.target &&
              entry.explicitAlias &&
              typeof entry.resolved !== "string",
          ) ?? false;

        const useLine = mainLines.findIndex((line) => line.includes("B value")) + 1;
        const result = await goToDefinition(index, {
          file: main,
          line: useLine,
          column: mainLines[useLine - 1]!.indexOf("B value") + 1,
        });
        outcomes.push({ name: testCase.name, hasUnresolvedAlias, useStatus: result.status });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(outcomes).toEqual(
      cases.map((testCase) => ({ name: testCase.name, hasUnresolvedAlias: true, useStatus: "not_found" })),
    );
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

      expect(bindings.map((binding) => (binding.kind === "named" ? binding.local : "")).sort()).toEqual(
        [...wrappedAliases].sort(),
      );
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
  it("keeps every name in an unresolved generic C# alias target an ordinary reference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-generic-alias-argument-"));
    const model = path.join(root, "Model.cs");
    const box = path.join(root, "Box.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = ["using B = N.Box<Model>;", "using C = N.Box<Model>.Inner;", "class Use { B value; }"];
    try {
      await writeFile(model, "public class Model {}\n", "utf8");
      const boxSource = "namespace N; public class Box<T> { public class Inner {} }\n";
      await writeFile(box, boxSource, "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [model, box, main]);
      const aliases = index.byFile
        .get(fileIdentityKey(main))
        ?.imports.filter((binding) => binding.kind === "named" && (binding.local === "B" || binding.local === "C"));

      // `imported` names the target type, not a type argument, and neither alias resolves.
      expect(aliases).toMatchObject([
        { local: "B", imported: "Box", from: "N.Box<Model>", explicitAlias: true },
        { local: "C", imported: "Inner", from: "N.Box<Model>.Inner", explicitAlias: true },
      ]);
      expect(aliases?.map((binding) => typeof binding.resolved !== "string")).toEqual([true, true]);
      const alias = await goToDefinition(index, { file: main, line: 3, column: mainLines[2]!.indexOf("B value") + 1 });
      expect(alias.status).not.toBe("ok");

      const mainSites = async (file: string, column: number): Promise<string[]> => {
        const references = await findReferences(index, { file, line: 1, column });
        if (references.status !== "ok") throw new Error(`Expected references for ${path.basename(file)}`);
        return references.references
          .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))
          .map((reference) => `${reference.range.start.line}:${reference.range.start.column}`);
      };
      const column = (line: number, name: string): number => mainLines[line - 1]!.indexOf(name) + 1;
      expect(await mainSites(model, 14)).toEqual([`1:${column(1, "Model")}`, `2:${column(2, "Model")}`]);
      expect(await mainSites(box, boxSource.indexOf("Box") + 1)).toEqual([
        `1:${column(1, "Box")}`,
        `2:${column(2, "Box")}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
