import { afterEach, describe, expect, it, vi } from "vitest";
import { isJsFallbackAvailable } from "../src/jsFallback.js";
import { supportById } from "../src/languages.js";
import { collectModuleSpecifiersFromSource, type FallbackImportExtractionEvent } from "../src/graphs.js";
import {
  getCompactImportsExecution,
  getNativeQueryExecutionForState,
  isNativeTreeSitterAvailable,
  type NativeQueryResults,
  type NativeQueryScope,
} from "../src/native/treeSitterNative.js";
import * as jsFallback from "../src/jsFallback.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;
const jsFallbackDescribe = isJsFallbackAvailable() ? describe : describe.skip;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Creates a mock binding that records which queries were non-empty.
 */
function createScopeSpy() {
  const executedKinds: string[] = [];
  const binding = {
    runLanguageQueries: (
      _source: string,
      _languageId: string,
      importsQuery: string,
      exportsQuery: string,
      localsQuery: string,
      importBindingsQuery: string,
    ): NativeQueryResults => {
      if (importsQuery.trim()) executedKinds.push("imports");
      if (exportsQuery.trim()) executedKinds.push("exports");
      if (localsQuery.trim()) executedKinds.push("locals");
      if (importBindingsQuery.trim()) executedKinds.push("importBindings");
      return {
        imports: [],
        exports: [],
        locals: [],
        importBindings: [],
      };
    },
    supportedLanguageIds: () => ["ts", "tsx", "js", "python", "go", "rust"],
  };
  const state = {
    loaded: true as const,
    binding,
    supportedLanguageIds: new Set(["ts", "tsx", "js", "python", "go", "rust"]),
  };
  return { executedKinds, state };
}

describe("native query scope", () => {
  it('scope "imports" only sends the imports query to native', () => {
    const support = supportById("ts")!;
    expect(support).toBeDefined();
    const { executedKinds, state } = createScopeSpy();

    const result = getNativeQueryExecutionForState("import { foo } from './bar';", support, state, "imports");

    expect(result.results).not.toBeNull();
    expect(executedKinds).toEqual(["imports"]);
  });

  it('scope "full" sends all query kinds to native', () => {
    const support = supportById("ts")!;
    expect(support).toBeDefined();
    const { executedKinds, state } = createScopeSpy();

    const result = getNativeQueryExecutionForState(
      "import { foo } from './bar'; export const x = 1;",
      support,
      state,
      "full",
    );

    expect(result.results).not.toBeNull();
    expect(executedKinds).toContain("imports");
    expect(executedKinds).toContain("exports");
    expect(executedKinds).toContain("locals");
    expect(executedKinds).toContain("importBindings");
  });

  it("defaults to full scope when no scope is specified", () => {
    const support = supportById("ts")!;
    expect(support).toBeDefined();
    const { executedKinds, state } = createScopeSpy();

    getNativeQueryExecutionForState("export const value = 1;", support, state);

    expect(executedKinds).toContain("imports");
    expect(executedKinds).toContain("exports");
    expect(executedKinds).toContain("locals");
    expect(executedKinds).toContain("importBindings");
  });

  it('scope "imports" works for Python', () => {
    const support = supportById("python")!;
    expect(support).toBeDefined();
    const { executedKinds, state } = createScopeSpy();

    getNativeQueryExecutionForState("import os\n", support, state, "imports");

    expect(executedKinds).toEqual(["imports"]);
  });

  it('scope "imports" works for Go', () => {
    const support = supportById("go")!;
    expect(support).toBeDefined();
    const { executedKinds, state } = createScopeSpy();

    getNativeQueryExecutionForState('package main\nimport "fmt"\n', support, state, "imports");

    expect(executedKinds).toEqual(["imports"]);
  });
});

nativeDescribe("native query scope with real binding", () => {
  it('scope "imports" produces correct import results from real native', () => {
    const support = supportById("ts")!;
    const result = getNativeQueryExecutionForState(
      "import { foo } from './bar';\nexport const x = 1;\nfunction helper() {}",
      support,
      undefined,
      "imports",
    );

    expect(result.results).not.toBeNull();
    expect(result.results!.imports.length).toBeGreaterThan(0);
    // exports, locals, importBindings should be empty since we only requested imports
    expect(result.results!.exports).toEqual([]);
    expect(result.results!.locals).toEqual([]);
    expect(result.results!.importBindings).toEqual([]);
  });

  it('scope "full" produces results for all query kinds from real native', () => {
    const support = supportById("ts")!;
    const result = getNativeQueryExecutionForState(
      "import { foo } from './bar';\nexport const x = 1;\nfunction helper() {}",
      support,
      undefined,
      "full",
    );

    expect(result.results).not.toBeNull();
    expect(result.results!.imports.length).toBeGreaterThan(0);
  });
});

describe("authoritative empty native results", () => {
  it("treats empty native imports as authoritative for non-normalized languages", () => {
    const support = supportById("ts")!;
    // File with no imports -- native returns 0 matches; should not fall through to text recovery
    const emptyNativeResults: NativeQueryResults = {
      imports: [],
      exports: [],
      locals: [],
      importBindings: [],
    };
    const specs = collectModuleSpecifiersFromSource(support, undefined, "const x = 1;\n", {
      nativeQueries: emptyNativeResults,
    });
    expect(specs).toEqual([]);
  });

  it("treats empty native imports as authoritative for TypeScript with no import keyword", () => {
    const support = supportById("ts")!;
    const emptyNativeResults: NativeQueryResults = {
      imports: [],
      exports: [],
      locals: [],
      importBindings: [],
    };
    // Source that has no import keyword at all
    const specs = collectModuleSpecifiersFromSource(support, undefined, "export const value = 42;\n", {
      nativeQueries: emptyNativeResults,
    });
    expect(specs).toEqual([]);
  });

  it("uses regex recovery when native queries are absent", () => {
    const support = supportById("ts")!;
    const specs = collectModuleSpecifiersFromSource(support, undefined, "import { foo } from './bar';\n");
    // Without nativeQueries, text recovery should find the import
    expect(specs.length).toBeGreaterThan(0);
    expect(specs[0]!.spec).toBe("./bar");
  });

  it("uses regex recovery for TypeScript without JS fallback", () => {
    const support = supportById("ts")!;
    const executeSpy = vi.spyOn(jsFallback, "executeJsQueryAsNativeMatches").mockImplementation(() => {
      throw new Error("JS fallback should not be used for TypeScript import recovery");
    });
    const fallbackEvents: FallbackImportExtractionEvent[] = [];

    const specs = collectModuleSpecifiersFromSource(
      support,
      undefined,
      "import { foo } from './bar';\nexport { baz } from './qux';\n",
      {
        file: "main.ts",
        native: "off",
        onFallbackImportExtraction: (event) => fallbackEvents.push(event),
      },
    );

    expect(specs).toEqual([{ spec: "./bar" }, { spec: "./qux" }]);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(fallbackEvents).toEqual([
      expect.objectContaining({
        language: "ts",
        reason: "reduced-mode",
        file: "main.ts",
      }),
    ]);
  });

  it("recovers HTML specifiers without warning in reduced mode", () => {
    const support = supportById("html")!;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const specs = collectModuleSpecifiersFromSource(
        support,
        undefined,
        '<script src="./app.js"></script><a href="./about.html">About</a>',
        {
          file: "index.html",
          native: "off",
        },
      );

      expect(specs).toEqual([
        { spec: "./app.js", resolutionKind: "document" },
        { spec: "./about.html", resolutionKind: "document" },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

nativeDescribe("compact imports execution", () => {
  it("returns compact results with name and text only", () => {
    const support = supportById("ts")!;
    const execution = getCompactImportsExecution("import { foo } from './bar';\nexport const x = 1;", support);
    expect(execution.results).not.toBeNull();
    expect(execution.results!.imports.length).toBeGreaterThan(0);
    const firstCapture = execution.results!.imports[0]!.captures[0]!;
    // Compact captures have only name and text, no nodeType/start/end
    expect(firstCapture).toHaveProperty("name");
    expect(firstCapture).toHaveProperty("text");
    expect(firstCapture).not.toHaveProperty("nodeType");
    expect(firstCapture).not.toHaveProperty("start");
    expect(firstCapture).not.toHaveProperty("end");
  });

  it("produces the same specifiers as the full native path", () => {
    const support = supportById("ts")!;
    const source = "import { foo } from './bar';\nimport { baz } from './qux';\n";

    // Full native path
    const fullExecution = getNativeQueryExecutionForState(source, support, undefined, "imports");
    const fullSpecs = collectModuleSpecifiersFromSource(support, undefined, source, {
      nativeQueries: fullExecution.results,
    });

    // Compact path
    const compactExecution = getCompactImportsExecution(source, support);
    const compactSpecs = collectModuleSpecifiersFromSource(support, undefined, source, {
      compactNativeImports: compactExecution.results,
    });

    expect(compactSpecs).toEqual(fullSpecs);
  });

  it("returns null results when native is unavailable", () => {
    const support = supportById("ts")!;
    const execution = getCompactImportsExecution("import { foo } from './bar';", support, "off");
    expect(execution.results).toBeNull();
    expect(execution.fallbackReason).toBe("unavailable");
  });

  it("does not treat arbitrary JavaScript string arguments as imports", () => {
    const support = supportById("js")!;
    const source = [
      'const element = requireElement("graph-container");',
      'const result = spawnSync("npm", ["run", "build"]);',
      'import realImport from "real-package";',
      'const required = require("required-package");',
    ].join("\n");

    const execution = getCompactImportsExecution(source, support);
    const specs = collectModuleSpecifiersFromSource(support, undefined, source, {
      compactNativeImports: execution.results,
    });

    expect(specs.map((entry) => entry.spec)).toEqual(["real-package", "required-package"]);
  });

  it("falls back to regex extraction for Python when compact native imports are empty", () => {
    const support = supportById("python")!;
    const specs = collectModuleSpecifiersFromSource(support, undefined, "import os\nfrom pkg import value\n", {
      compactNativeImports: { imports: [] },
    });

    expect(specs).toEqual([{ spec: "os" }, { spec: "pkg" }]);
  });
});

jsFallbackDescribe("native import fallback contract by language", () => {
  it("treats empty native imports as authoritative for TypeScript and Java", () => {
    const cases = [
      {
        supportId: "ts",
        fileName: "main.ts",
        source: "import { foo } from './bar';\n",
      },
      {
        supportId: "java",
        fileName: "Main.java",
        source: "package demo;\nimport demo.util.Helper;\nclass Main {}\n",
      },
    ] as const;

    for (const testCase of cases) {
      const support = supportById(testCase.supportId)!;
      const specs = collectModuleSpecifiersFromSource(support, support.language(testCase.fileName), testCase.source, {
        nativeQueries: {
          imports: [],
          exports: [],
          locals: [],
          importBindings: [],
        },
        file: testCase.fileName,
      });

      expect(specs).toEqual([]);
    }
  });

  it("treats empty native imports as authoritative for Kotlin once native normalization is authoritative", () => {
    const support = supportById("kotlin")!;
    const specs = collectModuleSpecifiersFromSource(
      support,
      support.language("Main.kt"),
      "package demo\nimport demo.util.Helper\nclass Main\n",
      {
        nativeQueries: {
          imports: [],
          exports: [],
          locals: [],
          importBindings: [],
        },
        file: "Main.kt",
      },
    );

    expect(specs).toEqual([]);
  });

  it("uses parser fallback for Java and Kotlin when native imports are unavailable", () => {
    const cases = [
      {
        supportId: "java",
        fileName: "Main.java",
        source: "package demo;\nimport demo.util.Helper;\nclass Main {}\n",
        expected: [{ spec: "demo.util.Helper" }],
      },
      {
        supportId: "kotlin",
        fileName: "Main.kt",
        source: "package demo\nimport demo.util.Helper\nclass Main\n",
        expected: [{ spec: "demo.util.Helper" }],
      },
    ] as const;

    for (const testCase of cases) {
      const support = supportById(testCase.supportId)!;
      const specs = collectModuleSpecifiersFromSource(support, support.language(testCase.fileName), testCase.source, {
        file: testCase.fileName,
      });

      expect(specs).toEqual(testCase.expected);
    }
  });
});
