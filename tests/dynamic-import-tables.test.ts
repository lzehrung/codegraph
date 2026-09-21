import path from "node:path";
import { describe, expect, it } from "vitest";
import "../src/languages/all.js";
import { createDynamicImportEntries, type DynamicImportFoldHelpers } from "../src/util/dynamic-import-tables.js";
import { extractDynamicImportSpecifiers } from "../src/util/specifiers.js";
import { getLanguageById } from "../src/languages/registry.js";

const NOOP_FOLDS: DynamicImportFoldHelpers = {
  foldCapturedPath: () => () => null,
  foldNewUrlArgument: () => null,
  resolveFoldedPathAgainstBase: () => null,
  resolveFoldedPathAgainstFileDir: () => null,
  resolveFoldedPathByConcatenation: () => null,
  foldPythonDynamicModuleArgument: () => null,
  collectPythonDynamicImportAliases: () => ({
    importlibAliases: new Set<string>(),
    importModuleAliases: new Set<string>(),
  }),
};

const DYNAMIC_IMPORT_LANGUAGE_IDS = ["js", "php", "python", "ruby", "ts"];

describe("dynamic import tables", () => {
  it("registers exactly the supported dynamic-import languages", () => {
    const entries = createDynamicImportEntries(NOOP_FOLDS);
    expect(Object.keys(entries).sort()).toEqual(DYNAMIC_IMPORT_LANGUAGE_IDS);
    for (const languageId of Object.keys(entries)) {
      expect(getLanguageById(languageId), `${languageId} is not a registered language`).toBeDefined();
    }
  });

  it.each([
    {
      languageId: "js",
      source: "require(path.join(__dirname, 'dep'))",
      expectedSpec: "./dep",
    },
    {
      languageId: "ts",
      source: "import(path.join(__dirname, 'dep'))",
      expectedSpec: "./dep",
    },
    {
      languageId: "python",
      source: 'import importlib\nimportlib.import_module("pkg.dep")',
      expectedSpec: "pkg.dep",
    },
    {
      languageId: "ruby",
      source: 'require File.join(__dir__, "dep")',
      expectedSpec: "./dep",
    },
    {
      languageId: "php",
      source: "require __DIR__ . '/dep.php';",
      expectedSpec: "./dep.php",
    },
  ])("routes $languageId through its registered adapter", ({ languageId, source, expectedSpec }) => {
    const projectRoot = path.join(process.cwd(), "dynamic-import-table-fixture");
    const fromFile = path.join(projectRoot, "src", "main.txt");

    expect(extractDynamicImportSpecifiers(languageId, source, fromFile, projectRoot)).toEqual([
      { spec: expectedSpec, resolved: "heuristic", confidence: 0.7 },
    ]);
  });
});
