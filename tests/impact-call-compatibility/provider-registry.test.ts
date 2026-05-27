import { describe, expect, it } from "vitest";
import {
  getCallCompatibilitySupportedLanguages,
  isCallCompatibilityLanguageSupported,
} from "../../src/impact/call-compatibility/providers/index.js";

describe("call compatibility provider registry", () => {
  it("covers every source language with function-call compatibility support", () => {
    expect(getCallCompatibilitySupportedLanguages()).toEqual([
      "c",
      "cpp",
      "csharp",
      "go",
      "java",
      "javascript",
      "js",
      "jsx",
      "kotlin",
      "php",
      "python",
      "ruby",
      "rust",
      "swift",
      "ts",
      "tsx",
      "typescript",
      "zig",
    ]);
  });

  it("does not claim graph-only or SQL call compatibility support", () => {
    expect(isCallCompatibilityLanguageSupported("markdown")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("css")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("sql")).toBeFalsy();
  });
});
