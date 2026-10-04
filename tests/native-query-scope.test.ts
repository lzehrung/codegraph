import { afterEach, describe, expect, it, vi } from "vitest";
import { supportById } from "../src/languages.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import {
  getCompactImportsExecution,
  getNativeQueryExecutionForState,
  isNativeTreeSitterAvailable,
  type NativeQueryResults,
} from "../src/native/tree-sitter-native.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

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
    // Scope selection must reach native through runLanguageQueries. If it ever routes
    // through the combined call instead, this fails loudly rather than silently
    // recording no executed kinds.
    extractLanguage: (): never => {
      throw new Error("extractLanguage must not be used for scoped query execution");
    },
    supportedLanguageIds: () => ["ts", "tsx", "js", "python", "go", "rust"],
  };
  const state = {
    loaded: true as const,
    binding,
    supportedLanguageIds: new Set(["ts", "tsx", "js", "python", "go", "rust"]),
    origin: { mode: "workspace" as const, packageName: "@lzehrung/codegraph-native" },
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
    const specs = collectModuleSpecifiersFromSource(support, "const x = 1;\n", {
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
    const specs = collectModuleSpecifiersFromSource(support, "export const value = 42;\n", {
      nativeQueries: emptyNativeResults,
    });
    expect(specs).toEqual([]);
  });

  it("extracts triple-slash reference specifiers when native imports are empty", () => {
    const support = supportById("ts")!;
    const source = '/// <reference path="./globals.d.ts" />\nexport const x = 1;\n';
    const specs = collectModuleSpecifiersFromSource(support, source, {
      nativeQueries: { imports: [], exports: [], locals: [], importBindings: [] },
    });
    expect(specs).toContainEqual(expect.objectContaining({ spec: "./globals.d.ts", typeOnly: true }));
  });

  it("extracts a path= attribute regardless of its position among other reference attributes", () => {
    const support = supportById("ts")!;
    const source = '/// <reference no-default-lib="true" path="./globals.d.ts" />\nexport const x = 1;\n';
    const specs = collectModuleSpecifiersFromSource(support, source, {
      nativeQueries: { imports: [], exports: [], locals: [], importBindings: [] },
    });
    expect(specs).toContainEqual(expect.objectContaining({ spec: "./globals.d.ts", typeOnly: true }));
  });

  it("extracts triple-slash reference specifiers in fast mode", () => {
    const support = supportById("ts")!;
    const source = '/// <reference path="./globals.d.ts" />\nexport const x = 1;\n';
    const specs = collectModuleSpecifiersFromSource(support, source, { fast: true });
    expect(specs).toContainEqual(expect.objectContaining({ spec: "./globals.d.ts", typeOnly: true }));
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
    const fullSpecs = collectModuleSpecifiersFromSource(support, source, {
      nativeQueries: fullExecution.results,
    });

    // Compact path
    const compactExecution = getCompactImportsExecution(source, support);
    const compactSpecs = collectModuleSpecifiersFromSource(support, source, {
      compactNativeImports: compactExecution.results,
    });

    expect(compactSpecs).toEqual(fullSpecs);
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
    const specs = collectModuleSpecifiersFromSource(support, source, {
      compactNativeImports: execution.results,
    });

    expect(specs.map((entry) => entry.spec)).toEqual(["real-package", "required-package"]);
  });
});
