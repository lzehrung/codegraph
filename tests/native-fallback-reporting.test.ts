import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { supportById } from "../src/languages.js";
import { collectModuleSpecifiersFromSource, type FallbackImportExtractionEvent } from "../src/graphs/specifiers.js";
import { maybeWriteNativeBackendStatus, runWithCliRuntime } from "../src/cli/context.js";
import { buildDoctorReport, formatDoctorSummary } from "../src/cli/doctor.js";
import { GRAPH_ONLY_LANGUAGE_IDS } from "../src/document-links.js";
import type { BuildReport, NativeBackendLanguageReport } from "../src/indexer/types.js";
import {
  getNativeQueryExecutionForState,
  getNativeSingleQueryExecution,
  getNativeTreeSitterLoadError,
  isNativeTreeSitterAvailable,
  isNativeTreeSitterDisabledByEnv,
} from "../src/native/tree-sitter-native.js";

const slowNativeIntegrationTimeoutMs = 30000;
const nativeIt = isNativeTreeSitterAvailable() ? it : it.skip;

describe("native fallback reporting", () => {
  it("detects when native tree-sitter is disabled by environment", () => {
    expect(isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "1" })).toBe(true);
    expect(isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "true" })).toBe(true);
    expect(isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "yes" })).toBe(true);
    expect(isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "0" })).toBe(false);
  });

  it("reports unavailable when the native binding is not loaded", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const result = getNativeQueryExecutionForState("export const value = 1;", support!, {
      loaded: false,
      error: new Error("native addon missing"),
    });
    expect(result.results).toBeNull();
    expect(result.fallbackReason).toBe("unavailable");
    expect(result.error).toContain("native addon missing");
  });

  it("treats explicit off mode as unavailable without consulting the env var", () => {
    expect(isNativeTreeSitterAvailable("off")).toBe(false);
    const loadError = getNativeTreeSitterLoadError("off");
    expect(loadError).toBeInstanceOf(Error);
    expect(String(loadError)).toContain("explicit option");
  });

  it("lets explicit on mode bypass the environment default", () => {
    const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
    try {
      const loadError = getNativeTreeSitterLoadError("on");
      expect(String(loadError ?? "")).not.toContain("CODEGRAPH_DISABLE_NATIVE");
    } finally {
      if (previous === undefined) {
        delete process.env.CODEGRAPH_DISABLE_NATIVE;
      } else {
        process.env.CODEGRAPH_DISABLE_NATIVE = previous;
      }
    }
  });

  it("reports unsupportedLanguage when the binding does not support the language", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const result = getNativeQueryExecutionForState("export const value = 1;", support!, {
      loaded: true,
      binding: {
        runLanguageQueries: () => {
          throw new Error("should not execute");
        },
        extractLanguage: (): never => {
          throw new Error("extractLanguage must not be used on this path");
        },
        supportedLanguageIds: () => [],
      },
      supportedLanguageIds: new Set(["python"]),
      origin: { mode: "workspace" as const, packageName: "@lzehrung/codegraph-native" },
    });
    expect(result.results).toBeNull();
    expect(result.fallbackReason).toBe("unsupportedLanguage");
  });

  it("reports queryFailure when native query execution throws", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const result = getNativeQueryExecutionForState("export const value = 1;", support!, {
      loaded: true,
      binding: {
        runLanguageQueries: () => {
          throw new Error("bad native query");
        },
        extractLanguage: (): never => {
          throw new Error("extractLanguage must not be used on this path");
        },
        supportedLanguageIds: () => ["ts"],
      },
      supportedLanguageIds: new Set(["ts"]),
      origin: { mode: "workspace" as const, packageName: "@lzehrung/codegraph-native" },
    });
    expect(result.results).toBeNull();
    expect(result.fallbackReason).toBe("queryFailure");
    expect(result.error).toContain("bad native query");
  });

  nativeIt("normalizes ad hoc native queries through language compatibility hooks", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const result = getNativeSingleQueryExecution(
      "class UtilityClass {}",
      support!,
      "(class_declaration name: (identifier) @name)",
    );
    expect(result.matches).not.toBeNull();
    expect(result.matches).toEqual([
      expect.objectContaining({
        captures: expect.arrayContaining([
          expect.objectContaining({
            name: "name",
            text: "UtilityClass",
          }),
        ]),
      }),
    ]);
  });

  it(
    "routes astGrep through unified single-query execution without a redundant direct native call",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-astgrep-unified-"));
      const file = path.join(root, "entry.ts");
      await fsp.writeFile(file, "import { helper } from './dep';\n", "utf8");

      try {
        const unifiedSpy = vi.fn(() => ({
          matches: [
            {
              patternIndex: 0,
              captures: [
                {
                  name: "mod",
                  text: "'./dep'",
                  nodeType: "string",
                  start: { row: 0, column: 23, index: 23 },
                  end: { row: 0, column: 30, index: 30 },
                },
              ],
            },
          ],
          backend: "native" as const,
        }));
        const singleSpy = vi.fn(() => ({
          matches: null,
          fallbackReason: "queryFailure" as const,
          error: "legacy single-query path should not run",
        }));

        vi.resetModules();
        vi.doMock("../src/native/tree-sitter-native.js", async () => {
          const actual = await vi.importActual<typeof import("../src/native/tree-sitter-native.js")>(
            "../src/native/tree-sitter-native.js",
          );
          return {
            ...actual,
            getUnifiedQueryExecution: unifiedSpy,
            getNativeSingleQueryExecution: singleSpy,
          };
        });

        const { astGrep } = await import("../src/graphs/grep.js");
        const hits = await astGrep(root, "(import_statement source: (string) @mod)", ["**/*.ts"]);

        expect(unifiedSpy).toHaveBeenCalledTimes(1);
        expect(singleSpy).not.toHaveBeenCalled();
        expect(hits).toEqual([
          expect.objectContaining({
            file: "entry.ts",
            capture: "mod",
            snippet: "'./dep'",
          }),
        ]);
      } finally {
        vi.doUnmock("../src/native/tree-sitter-native.js");
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
    slowNativeIntegrationTimeoutMs,
  );
});

function emptyLanguageReport(filesFellBack: number): NativeBackendLanguageReport {
  return {
    filesSeen: filesFellBack,
    filesUsed: 0,
    filesFellBack,
    fallbackReasons: { unavailable: filesFellBack, unsupportedLanguage: 0, queryFailure: 0 },
  };
}

describe("fallback import extraction honesty", () => {
  it("reports unavailable when python has a grammar but the binding did not run", () => {
    const support = supportById("python");
    expect(support).toBeDefined();
    const events: FallbackImportExtractionEvent[] = [];
    const specs = collectModuleSpecifiersFromSource(support!, "import os\n", {
      file: "main.py",
      native: "off",
      onFallbackImportExtraction: (event) => events.push(event),
    });
    expect(specs).toEqual(expect.arrayContaining([expect.objectContaining({ spec: "os" })]));
    expect(events).toEqual([expect.objectContaining({ language: "python", reason: "unavailable", file: "main.py" })]);
  });

  it("reports unsupportedLanguage for graph-only markdown instead of query-empty", () => {
    const support = supportById("markdown");
    expect(support).toBeDefined();
    const events: FallbackImportExtractionEvent[] = [];
    const specs = collectModuleSpecifiersFromSource(support!, "[Guide](./guide.md)\n", {
      file: "page.md",
      native: "off",
      onFallbackImportExtraction: (event) => events.push(event),
    });
    expect(specs).toEqual(expect.arrayContaining([expect.objectContaining({ spec: "./guide.md" })]));
    expect(events).toEqual([
      expect.objectContaining({ language: "markdown", reason: "unsupportedLanguage", file: "page.md" }),
    ]);
  });

  it("reports unavailable for scss when the binding did not run", () => {
    const support = supportById("scss");
    expect(support).toBeDefined();
    const events: FallbackImportExtractionEvent[] = [];
    const specs = collectModuleSpecifiersFromSource(support!, '@use "variables";\n', {
      file: "main.scss",
      native: "off",
      onFallbackImportExtraction: (event) => events.push(event),
    });
    expect(specs).toEqual(expect.arrayContaining([expect.objectContaining({ spec: "variables" })]));
    expect(events).toEqual([expect.objectContaining({ language: "scss", reason: "unavailable", file: "main.scss" })]);
  });

  it("reports query-empty only when a native import query ran and matched nothing", () => {
    const support = supportById("python");
    expect(support).toBeDefined();
    const events: FallbackImportExtractionEvent[] = [];
    const specs = collectModuleSpecifiersFromSource(support!, "import os\n", {
      file: "main.py",
      compactNativeImports: { imports: [] },
      onFallbackImportExtraction: (event) => events.push(event),
    });
    expect(specs).toEqual(expect.arrayContaining([expect.objectContaining({ spec: "os" })]));
    expect(events).toEqual([expect.objectContaining({ language: "python", reason: "query-empty", file: "main.py" })]);
  });
});

describe("degraded native backend language names", () => {
  it("names affected languages in the default degraded backend line", async () => {
    const report: BuildReport = {
      timings: {},
      backend: {
        native: {
          available: false,
          enabled: false,
          supportedLanguageIds: [],
          filesUsed: 0,
          filesFellBack: 5,
          fallbackReasons: { unavailable: 5, unsupportedLanguage: 0, queryFailure: 0 },
          byLanguage: {
            js: emptyLanguageReport(1),
            python: emptyLanguageReport(2),
            rust: emptyLanguageReport(1),
            ts: emptyLanguageReport(1),
          },
          errors: [],
          loadError: "native tree-sitter disabled by CODEGRAPH_DISABLE_NATIVE",
        },
      },
    };
    const chunks: string[] = [];
    await runWithCliRuntime({ stderr: (chunk) => chunks.push(chunk) }, async () => {
      maybeWriteNativeBackendStatus(report, false);
    });
    const stderr = chunks.join("");
    expect(stderr).toContain("Backend: reduced graph/regex mode");
    expect(stderr).toContain("native addon unavailable");
    expect(stderr).toContain("native tree-sitter disabled by CODEGRAPH_DISABLE_NATIVE");
    expect(stderr).toContain("affected languages: js, python, rust, ts");
  });
});

describe("doctor language support honesty", () => {
  it("separates native grammar ids from registered graph-only ids when the binding is disabled", () => {
    const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
    try {
      const report = buildDoctorReport();
      expect(report.native.supportedLanguageIds).toEqual([]);
      expect(report.native.graphOnlyLanguageIds).toEqual(
        [...GRAPH_ONLY_LANGUAGE_IDS].sort((left, right) => left.localeCompare(right)),
      );
      expect(report.native.graphOnlyLanguageIds).toEqual(["adoc", "astro", "hbs", "markdown", "mdx", "rst"]);
      const summary = formatDoctorSummary(report);
      expect(summary).toContain("Native grammar language ids");
      expect(summary).toContain("Graph-only language ids");
      expect(summary).toContain("markdown");
      expect(summary).not.toContain("Supported language ids");
    } finally {
      if (previous === undefined) {
        delete process.env.CODEGRAPH_DISABLE_NATIVE;
      } else {
        process.env.CODEGRAPH_DISABLE_NATIVE = previous;
      }
    }
  });
});
