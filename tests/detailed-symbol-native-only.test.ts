import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/indexer.js";
import { createUnavailableParserBackendSpies, expectParserBackendUnusedForNativeOwnership } from "./helpers/native.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

describe("detailed symbol graph in native-only installs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/parserBackend.js");
    vi.doUnmock("../src/native/treeSitterNative.js");
  });

  it("skips files cleanly when syntax-tree fallback is unavailable", async () => {
    const root = await mkTmpDir("cg-detailed-native-only-");
    await fsp.writeFile(path.join(root, "legacy.js"), "export function render(value) { return value; }\n", "utf8");
    await fsp.writeFile(
      path.join(root, "template.html"),
      "<div><script>export const value = 1;</script></div>\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    index.parsed = new Map();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallbackSpies = createUnavailableParserBackendSpies("grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: fallbackSpies.parseSpy,
      };
    });
    vi.doMock("../src/native/treeSitterNative.js", async () => {
      const actual = await vi.importActual<typeof import("../src/native/treeSitterNative.js")>(
        "../src/native/treeSitterNative.js",
      );
      return {
        ...actual,
        getNativeSyntaxTreeExecution: vi.fn(() => ({
          tree: null,
          fallbackReason: "unavailable",
        })),
      };
    });

    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const detailed = await buildSymbolGraphDetailed(index);
    const warnings = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));

    expectParserBackendUnusedForNativeOwnership({ parseSpy: fallbackSpies.parseSpy });
    expect(warnings.some((warning) => warning.includes("Failed to build detailed symbol edges for"))).toBe(false);
    expect(warnings).toContain(
      "Warning: Skipped detailed symbol edges for 1 file(s) because no syntax-tree backend was available.",
    );
    expect(detailed.edges).toEqual([]);
  });

  it("builds the project index without per-file warnings when both tree paths are unavailable", async () => {
    const root = await mkTmpDir("cg-index-native-only-");
    await fsp.writeFile(
      path.join(root, "legacy.js"),
      "angular.module('admin').controller('UserCtrl', function UserCtrl($scope) { return $scope; });\n",
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallbackSpies = createUnavailableParserBackendSpies("grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        parseWithLanguage: fallbackSpies.parseSpy,
      };
    });
    vi.doMock("../src/native/treeSitterNative.js", async () => {
      const actual = await vi.importActual<typeof import("../src/native/treeSitterNative.js")>(
        "../src/native/treeSitterNative.js",
      );
      return {
        ...actual,
        getNativeQueryExecution: vi.fn(() => ({
          results: null,
          fallbackReason: "unavailable",
        })),
        getNativeSyntaxTreeExecution: vi.fn(() => ({
          tree: null,
          fallbackReason: "unavailable",
        })),
      };
    });

    const { buildProjectIndex } = await import("../src/indexer.js");
    const report = { timings: {} };
    const index = await buildProjectIndex(root, { report });
    const warnings = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));
    expect(index.byFile.size).toBe(1);
    expect(index.byFile.get(normalizePath(path.join(root, "legacy.js")))).toBeDefined();
    expectParserBackendUnusedForNativeOwnership({ parseSpy: fallbackSpies.parseSpy });
    expect(report.backend?.parser?.total).toBe(1);
    expect(report.backend?.parser?.byLanguage.js).toBe(1);
    expect(report.backend?.parser?.files).toContainEqual(
      expect.objectContaining({
        file: normalizePath(path.join(root, "legacy.js")),
        languageId: "js",
        nativeFallbackReason: "unavailable",
      }),
    );
    expect(warnings.some((warning) => warning.includes("Warning: Failed to process file"))).toBe(false);
  });

  it("recovers TypeScript imports without loading a non-native parser", async () => {
    const root = await mkTmpDir("cg-ts-imports-native-only-");
    const entryFile = path.join(root, "entry.ts");
    const depFile = path.join(root, "dep.ts");
    await fsp.writeFile(
      entryFile,
      ["import value, { helper as alias } from './dep';", "export { helper } from './dep';", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(depFile, ["export default 1;", "export const helper = 2;", ""].join("\n"), "utf8");

    const fallbackSpies = createUnavailableParserBackendSpies("TypeScript grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: fallbackSpies.parseSpy,
        executeQueryAsNativeMatches: fallbackSpies.querySpy,
      };
    });

    const { collectImportsForFile } = await import("../src/indexer.js");
    const { supportForFile } = await import("../src/languages.js");
    const support = supportForFile(entryFile);
    expect(support).toBeDefined();

    const imports = await collectImportsForFile(entryFile, root, {
      source: await fsp.readFile(entryFile, "utf8"),
      sup: support!,
      lang: support!.language(entryFile),
    });

    expect(imports).toEqual([
      {
        kind: "default",
        local: "value",
        from: "./dep",
        resolved: normalizePath(depFile),
        typeOnly: false,
      },
      {
        kind: "named",
        local: "alias",
        imported: "helper",
        from: "./dep",
        resolved: normalizePath(depFile),
        typeOnly: false,
      },
      {
        kind: "named",
        local: "helper",
        imported: "helper",
        from: "./dep",
        resolved: normalizePath(depFile),
        typeOnly: false,
      },
    ]);
    expectParserBackendUnusedForNativeOwnership(fallbackSpies);
  });

  it("recovers Kotlin alias imports without loading a non-native parser", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "kotlin");
    const entryFile = path.join(root, "Aliases.kt");
    const depFile = path.join(root, "utils", "helperFunction.kt");

    const fallbackSpies = createUnavailableParserBackendSpies("Kotlin grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: fallbackSpies.parseSpy,
        executeQueryAsNativeMatches: fallbackSpies.querySpy,
      };
    });

    const { collectImportsForFile, parseFile } = await import("../src/indexer.js");
    const parsed = await parseFile(entryFile);
    const imports = await collectImportsForFile(entryFile, root, {
      source: parsed.source,
      sup: parsed.sup,
      lang: parsed.lang,
      nativeQueries: parsed.nativeQueries,
    });

    expect(imports).toEqual([
      {
        kind: "named",
        local: "RenamedUtilityClass",
        imported: "UtilityClass",
        from: "utils.UtilityClass",
        resolved: normalizePath(depFile),
        typeOnly: false,
      },
    ]);
    expectParserBackendUnusedForNativeOwnership(fallbackSpies);
  });

  it("indexes TypeScript locals and exports without loading a non-native parser", async () => {
    const root = await mkTmpDir("cg-ts-index-native-only-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(
      entryFile,
      [
        "export class Service {",
        "  run() {",
        "    return 1;",
        "  }",
        "}",
        "export const helper = () => new Service();",
        "",
      ].join("\n"),
      "utf8",
    );

    const fallbackSpies = createUnavailableParserBackendSpies("TypeScript grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: fallbackSpies.parseSpy,
        executeQueryAsNativeMatches: fallbackSpies.querySpy,
      };
    });

    const { buildProjectIndex } = await import("../src/indexer.js");
    const index = await buildProjectIndex(root);
    const moduleIndex = index.byFile.get(normalizePath(entryFile));

    const method = moduleIndex?.locals.find((entry) => entry.localName === "run");
    expect(moduleIndex?.locals.map((entry) => entry.localName)).toEqual(
      expect.arrayContaining(["Service", "run", "helper"]),
    );
    expect(method?.kind).toBe("function");
    expect(method?.range.start.line).toBe(2);
    expect(moduleIndex?.exports.filter((entry) => entry.type === "local").map((entry) => entry.exportedAs)).toEqual(
      expect.arrayContaining(["Service", "helper"]),
    );
    expectParserBackendUnusedForNativeOwnership(fallbackSpies);
  });

  it("runs TypeScript AST grep without loading a non-native parser", async () => {
    const root = await mkTmpDir("cg-ts-grep-native-only-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(
      entryFile,
      ["import { helper } from './dep';", "export const value = helper();", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "dep.ts"), "export function helper() { return 1; }\n", "utf8");

    const fallbackSpies = createUnavailableParserBackendSpies("TypeScript grammar");

    vi.resetModules();
    vi.doMock("../src/parserBackend.js", async () => {
      const actual = await vi.importActual<typeof import("../src/parserBackend.js")>("../src/parserBackend.js");
      return {
        ...actual,
        isNonNativeParserAvailable: () => false,
        parseWithLanguage: fallbackSpies.parseSpy,
        executeQueryAsNativeMatches: fallbackSpies.querySpy,
      };
    });

    const { astGrep } = await import("../src/index.js");
    const hits = await astGrep(root, "(import_statement (string) @mod)", ["**/*.ts"]);

    expect(hits).toEqual([
      expect.objectContaining({
        file: "entry.ts",
        capture: "mod",
        snippet: "'./dep'",
      }),
    ]);
    expectParserBackendUnusedForNativeOwnership(fallbackSpies);
  });
});
