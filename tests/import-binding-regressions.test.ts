import { describe, expect, it } from "vitest";
import path from "node:path";
import { collectImportsForFile, parseFile } from "../src/indexer.js";

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
      tree: parsed.tree,
      nativeQueries: parsed.nativeQueries,
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
      tree: parsed.tree,
      nativeQueries: parsed.nativeQueries,
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
      tree: parsed.tree,
      nativeQueries: parsed.nativeQueries,
    });

    const simplified = simplifyImports(imports);
    expect(simplified).toContainEqual({
      kind: "named",
      local: "SupportToolbox",
      imported: "Toolbox",
      from: "App\\Support\\Toolbox",
      resolved: toolboxTarget,
    });
    expect(simplified).toContainEqual({
      kind: "named",
      local: "support_helper",
      imported: "support_helper",
      from: "App\\Support\\support_helper",
      resolved: helperTarget,
    });
    expect(simplified).toContainEqual({
      kind: "named",
      local: "DEFAULT_NAME",
      imported: "DEFAULT_NAME",
      from: "App\\Support\\DEFAULT_NAME",
      resolved: constantTarget,
    });
  });
});
