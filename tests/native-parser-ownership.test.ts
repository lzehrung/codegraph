import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;

const sampleRoot = path.resolve(process.cwd(), "tests", "samples");

type NativeSemanticCase = {
  root: string;
  files: string[];
  symbolFile?: string;
  symbolNames?: string[];
  goto: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
  references: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
};

function normalizeFile(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function sampleCase(
  rootDir: string,
  files: string[],
  goto: NativeSemanticCase["goto"],
  references: NativeSemanticCase["references"],
  symbolFile?: string,
  symbolNames?: string[],
): NativeSemanticCase {
  const root = path.join(sampleRoot, rootDir);
  return {
    root,
    files: files.map((file) => path.join(root, file)),
    ...(symbolFile ? { symbolFile: path.join(root, symbolFile) } : {}),
    ...(symbolNames ? { symbolNames } : {}),
    goto: {
      ...goto,
      file: path.join(root, goto.file),
    },
    references: {
      ...references,
      file: path.join(root, references.file),
    },
  };
}

nativeDescribe("native parser ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/jsFallback.js");
  });

  it("keeps representative source-language navigation on the native runtime when the JS fallback package is unavailable", async () => {
    const parseSpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for grammar loading. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });
    const querySpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for JS query execution. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });

    vi.resetModules();
    vi.doMock("../src/jsFallback.js", async () => {
      const actual = await vi.importActual<typeof import("../src/jsFallback.js")>("../src/jsFallback.js");
      return {
        ...actual,
        isJsFallbackAvailable: () => false,
        parseWithJsLanguage: parseSpy,
        executeJsQueryAsNativeMatches: querySpy,
      };
    });

    const { buildProjectIndexFromFiles, findReferences, goToDefinition, listSymbols } = await import("../src/index.js");

    const cases: NativeSemanticCase[] = [
      sampleCase(
        "typescript",
        ["main.ts", "utils.ts", "helpers.ts"],
        { file: "main.ts", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.ts", line: 1, column: 16, expectedStatus: "ok" },
        "utils.ts",
        ["helperFunction", "UtilityClass"],
      ),
      sampleCase(
        "javascript",
        ["main.js", "utils.js", "helpers.js"],
        { file: "main.js", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.js", line: 1, column: 16, expectedStatus: "ok" },
        "utils.js",
        ["helperFunction", "UtilityClass"],
      ),
      sampleCase(
        "tsx",
        ["App.tsx", "components/Button.tsx", "utils.ts"],
        { file: "App.tsx", line: 6, column: 20, expectedStatus: "ok" },
        { file: "utils.ts", line: 3, column: 17, expectedStatus: "ok" },
        "components/Button.tsx",
        ["Button"],
      ),
      sampleCase(
        "python",
        ["main.py", "utils.py", "helpers.py"],
        { file: "main.py", line: 11, column: 18, expectedStatus: "ok" },
        { file: "utils.py", line: 1, column: 16, expectedStatus: "ok" },
        "utils.py",
        ["helper_function", "UtilityClass"],
      ),
      sampleCase(
        "php",
        [
          "main.php",
          "utils.php",
          "helpers.php",
          "grouped-consumer.php",
          "composer-consumer.php",
          "partials/shared.php",
          "src/Domain/Service.php",
          "src/Support/Toolbox.php",
          "src/Support/support_helper.php",
          "src/Support/DEFAULT_NAME.php",
        ],
        { file: "grouped-consumer.php", line: 8, column: 10, expectedStatus: "ok" },
        { file: "src/Support/Toolbox.php", line: 5, column: 7, expectedStatus: "ok" },
        "src/Support/Toolbox.php",
        ["Toolbox"],
      ),
      sampleCase(
        "go",
        ["aliased-types.go", "dot-imports.go", "interfaces.go", "utils.go", "helpers.go"],
        { file: "aliased-types.go", line: 8, column: 22, expectedStatus: "ok" },
        { file: "utils.go", line: 9, column: 6, expectedStatus: "ok" },
        "utils.go",
        ["UtilityClass", "NewUtilityClass"],
      ),
      sampleCase(
        "java",
        ["WildcardImports.java", "pkg/PackageTypes.java"],
        { file: "WildcardImports.java", line: 6, column: 16, expectedStatus: "ok" },
        { file: "pkg/PackageTypes.java", line: 7, column: 11, expectedStatus: "ok" },
        "pkg/PackageTypes.java",
        ["PackageTypes", "NestedValue", "ServiceContract"],
      ),
      sampleCase(
        "csharp",
        ["NamespaceAlias.cs"],
        { file: "NamespaceAlias.cs", line: 3, column: 20, expectedStatus: "ok" },
        { file: "NamespaceAlias.cs", line: 3, column: 20, expectedStatus: "ok" },
      ),
      sampleCase(
        "rust",
        ["nested.rs", "nested_service.rs", "reexports.rs", "utils.rs", "helpers.rs"],
        { file: "nested.rs", line: 6, column: 18, expectedStatus: "ok" },
        { file: "nested_service.rs", line: 1, column: 12, expectedStatus: "ok" },
        "nested_service.rs",
        ["NestedRunner"],
      ),
      sampleCase(
        "kotlin",
        ["Aliases.kt", "TypeConsumers.kt", "utils/MoreTypes.kt", "utils/helperFunction.kt"],
        { file: "TypeConsumers.kt", line: 3, column: 21, expectedStatus: "ok" },
        { file: "utils/MoreTypes.kt", line: 3, column: 11, expectedStatus: "ok" },
        "utils/MoreTypes.kt",
        ["UtilityAlias", "UtilityFactory", "CompanionCarrier"],
      ),
      sampleCase(
        "swift",
        ["AdvancedUsage.swift", "StaticMembers.swift", "Utils.swift"],
        { file: "AdvancedUsage.swift", line: 4, column: 10, expectedStatus: "ok" },
        { file: "StaticMembers.swift", line: 6, column: 8, expectedStatus: "ok" },
        "StaticMembers.swift",
        ["UtilityFactory", "build"],
      ),
      sampleCase(
        "c",
        ["advanced-use.c", "function-pointers.h", "function-pointers.c"],
        { file: "advanced-use.c", line: 4, column: 3, expectedStatus: "ok" },
        { file: "function-pointers.h", line: 3, column: 15, expectedStatus: "ok" },
        "function-pointers.h",
        ["Comparator", "AdvancedState", "compare_values"],
      ),
      sampleCase(
        "cpp",
        ["namespace-usage.cpp", "namespaces.hpp"],
        { file: "namespace-usage.cpp", line: 4, column: 12, expectedStatus: "ok" },
        { file: "namespaces.hpp", line: 4, column: 7, expectedStatus: "ok" },
        "namespaces.hpp",
        ["toolkit", "Widget", "buildWidget"],
      ),
      sampleCase(
        "ruby",
        ["consumer.rb", "namespaced.rb"],
        { file: "consumer.rb", line: 3, column: 22, expectedStatus: "ok" },
        { file: "namespaced.rb", line: 5, column: 11, expectedStatus: "ok" },
        "namespaced.rb",
        ["Outer", "Inner", "Tool"],
      ),
      sampleCase(
        "sql/graph",
        ["001_create_users.sql", "report.sql"],
        { file: "report.sql", line: 1, column: 25, expectedStatus: "ok" },
        { file: "001_create_users.sql", line: 1, column: 16, expectedStatus: "ok" },
        "001_create_users.sql",
        ["users"],
      ),
    ];

    for (const testCase of cases) {
      const files = testCase.files.map(normalizeFile);
      const index = await buildProjectIndexFromFiles(testCase.root, files, {
        native: "on",
      });

      if (testCase.symbolFile && testCase.symbolNames) {
        const seen = new Set(
          listSymbols(index, { file: normalizeFile(testCase.symbolFile) }).map((symbol) => symbol.name),
        );
        for (const name of testCase.symbolNames) {
          expect(seen.has(name)).toBe(true);
        }
      }

      const gotoResult = await goToDefinition(index, {
        file: normalizeFile(testCase.goto.file),
        line: testCase.goto.line,
        column: testCase.goto.column,
      });
      expect(gotoResult.status).toBe(testCase.goto.expectedStatus);

      const referencesResult = await findReferences(index, {
        file: normalizeFile(testCase.references.file),
        line: testCase.references.line,
        column: testCase.references.column,
      });
      expect(referencesResult.status).toBe(testCase.references.expectedStatus);
    }

    expect(parseSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
  }, 45_000);

  it("builds detailed TypeScript symbol edges without loading the JS fallback package", async () => {
    const parseSpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for grammar loading. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });
    const querySpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for JS query execution. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });

    vi.resetModules();
    vi.doMock("../src/jsFallback.js", async () => {
      const actual = await vi.importActual<typeof import("../src/jsFallback.js")>("../src/jsFallback.js");
      return {
        ...actual,
        isJsFallbackAvailable: () => false,
        parseWithJsLanguage: parseSpy,
        executeJsQueryAsNativeMatches: querySpy,
      };
    });

    const { buildProjectIndexFromFiles } = await import("../src/index.js");
    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const root = path.join(sampleRoot, "typescript");
    const files = ["main.ts", "utils.ts", "helpers.ts"].map((file) => path.join(root, file));

    const index = await buildProjectIndexFromFiles(root, files, {
      native: "on",
    });
    const detailed = await buildSymbolGraphDetailed(index);

    expect(detailed.nodes.size).toBeGreaterThan(0);
    expect(detailed.edges.length).toBeGreaterThan(0);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
  });
});
