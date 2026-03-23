import { describe, expect, it } from "vitest";
import { supportById } from "../src/languages.js";
import {
  getNativeQueryExecutionForState,
  isNativeTreeSitterDisabledByEnv,
} from "../src/native/treeSitterNative.js";

describe("native fallback reporting", () => {
  it("detects when native tree-sitter is disabled by environment", () => {
    expect(isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "1" })).toBe(
      true,
    );
    expect(
      isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "true" }),
    ).toBe(true);
    expect(
      isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "yes" }),
    ).toBe(true);
    expect(
      isNativeTreeSitterDisabledByEnv({ CODEGRAPH_DISABLE_NATIVE: "0" }),
    ).toBe(false);
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
});
