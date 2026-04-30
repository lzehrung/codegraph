import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { supportById } from "../src/languages.js";
import {
  getNativeQueryExecutionForState,
  getNativeSingleQueryExecution,
  getNativeTreeSitterLoadError,
  isNativeTreeSitterAvailable,
  isNativeTreeSitterDisabledByEnv,
} from "../src/native/treeSitterNative.js";

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
        supportedLanguageIds: () => [],
      },
      supportedLanguageIds: new Set(["python"]),
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
        supportedLanguageIds: () => ["ts"],
      },
      supportedLanguageIds: new Set(["ts"]),
    });
    expect(result.results).toBeNull();
    expect(result.fallbackReason).toBe("queryFailure");
    expect(result.error).toContain("bad native query");
  });

  it("normalizes ad hoc native queries through language compatibility hooks", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const result = getNativeSingleQueryExecution("class UtilityClass {}", support!, "(class_declaration name: (identifier) @name)");
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

  it("routes astGrep through unified single-query execution without a redundant direct native call", async () => {
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
      vi.doMock("../src/native/treeSitterNative.js", async () => {
        const actual = await vi.importActual<typeof import("../src/native/treeSitterNative.js")>("../src/native/treeSitterNative.js");
        return {
          ...actual,
          getUnifiedQueryExecution: unifiedSpy,
          getNativeSingleQueryExecution: singleSpy,
        };
      });

      const { astGrep } = await import("../src/index.js");
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
      vi.doUnmock("../src/native/treeSitterNative.js");
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
