import { describe, expect, it } from "vitest";
import path from "node:path";
import { collectImportsForFile, parseFile } from "../src/indexer.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { buildProjectIndexFromFiles, goToDefinition } from "../src/index.js";
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
});
