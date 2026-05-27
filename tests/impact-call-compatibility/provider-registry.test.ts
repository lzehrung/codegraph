import { describe, expect, it } from "vitest";
import {
  callCompatibilityProviders,
  getCallCompatibilityProvider,
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

  it("routes supported languages through registered providers", () => {
    expect(callCompatibilityProviders).toHaveLength(1);
    expect(getCallCompatibilityProvider("typescript")).toBe(callCompatibilityProviders[0]);
    expect(getCallCompatibilityProvider("python")).toBe(callCompatibilityProviders[0]);
    expect(getCallCompatibilityProvider("markdown")).toBeNull();
  });

  it("does not claim graph-only or SQL call compatibility support", () => {
    expect(isCallCompatibilityLanguageSupported("markdown")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("css")).toBeFalsy();
    expect(isCallCompatibilityLanguageSupported("sql")).toBeFalsy();
  });
});
