import { describe, expect, it } from "vitest";
import {
  resolveFilePathFromRoot,
  assertFilePathWithinRoot,
  isAbsoluteFilePath,
  isFilePathWithinRoot,
  normalizePath,
  normalizeResolutionHints,
  toProjectDisplayPath,
  toProjectRelativePath,
} from "../src/util.js";
import { createImpactIncludeMatcher, normalizeImpactFilePath } from "../src/impact/path.js";

describe("cross-platform path normalization", () => {
  it("treats Windows-style paths as absolute regardless of host OS", () => {
    const windowsDrivePath = "C:/repo/src/main.ts";
    const windowsBackslashPath = String.raw`C:\repo\src\main.ts`;

    expect(isAbsoluteFilePath(windowsDrivePath)).toBe(true);
    expect(isAbsoluteFilePath(windowsBackslashPath)).toBe(true);
    expect(resolveFilePathFromRoot("/workspace/codegraph", windowsDrivePath)).toBe(windowsDrivePath);
    expect(resolveFilePathFromRoot("/workspace/codegraph", windowsBackslashPath)).toBe(windowsBackslashPath);
  });

  it("resolves relative paths against POSIX absolute roots on any host OS", () => {
    const root = "/mnt/e/git repos/codegraph";

    expect(resolveFilePathFromRoot(root, ".")).toBe(root);
    expect(resolveFilePathFromRoot(root, "./src")).toBe("/mnt/e/git repos/codegraph/src");
  });

  it("normalizes impact paths without re-rooting Windows-style absolute inputs", () => {
    expect(normalizeImpactFilePath("/workspace/codegraph", "C:/repo/src/main.ts")).toBe("C:/repo/src/main.ts");
    expect(normalizeImpactFilePath("/workspace/codegraph", String.raw`C:\repo\src\main.ts`)).toBe(
      "C:/repo/src/main.ts",
    );
  });

  it("matches impact include globs against absolute and relative project paths", () => {
    const matcher = createImpactIncludeMatcher("/workspace/codegraph", ["src/**/*.ts"]);

    expect(matcher("/workspace/codegraph/src/main.ts")).toBe(true);
    expect(matcher("src/main.ts")).toBe(true);
    expect(matcher("/workspace/codegraph/tests/main.test.ts")).toBe(false);
  });

  it("does not treat Windows-style absolute paths as inside a POSIX project root", () => {
    expect(isFilePathWithinRoot("/workspace/codegraph", "src/main.ts")).toBe(true);
    expect(toProjectRelativePath("/workspace/codegraph", "src/main.ts")).toBe("src/main.ts");
    expect(isFilePathWithinRoot("/workspace/codegraph", "C:/repo/src/main.ts")).toBe(false);
    expect(toProjectRelativePath("/workspace/codegraph", "C:/repo/src/main.ts")).toBeNull();
  });

  it("accepts Windows drive-letter case differences within the same root", () => {
    const root = "C:/Repo";
    const file = "c:/Repo/src/main.ts";

    expect(isFilePathWithinRoot(root, file)).toBe(true);
    expect(toProjectRelativePath(root, file)).toBe("src/main.ts");
  });

  it("resolves relative paths against Windows-style roots on any host OS", () => {
    const root = "C:/Repo";
    const file = "src/main.ts";

    expect(resolveFilePathFromRoot(root, file)).toBe("C:\\Repo\\src\\main.ts");
    expect(isFilePathWithinRoot(root, file)).toBe(true);
    expect(toProjectRelativePath(root, file)).toBe("src/main.ts");
  });

  it("normalizes backslashes without changing already-normalized paths", () => {
    expect(normalizePath(String.raw`src\feature\main.ts`)).toBe("src/feature/main.ts");
    expect(normalizePath("src/feature/main.ts")).toBe("src/feature/main.ts");
  });

  it("formats project display paths as relative slash-normalized paths when possible", () => {
    expect(toProjectDisplayPath("/workspace/codegraph", "/workspace/codegraph/src/main.ts")).toBe("src/main.ts");
    expect(toProjectDisplayPath("/workspace/codegraph", "C:/repo/src/main.ts")).toBe("C:/repo/src/main.ts");
    expect(toProjectDisplayPath(undefined, String.raw`src\main.ts`)).toBe("src/main.ts");
  });

  it("relativizes POSIX absolute paths with POSIX semantics on any host OS", () => {
    const root = "/mnt/e/git repos/codegraph";

    expect(isFilePathWithinRoot(root, "/mnt/e/git repos/codegraph/src/main.ts")).toBe(true);
    expect(toProjectRelativePath(root, "/mnt/e/git repos/codegraph/src/main.ts")).toBe("src/main.ts");
    expect(isFilePathWithinRoot(root, "/mnt/e/git repos/codegraph-tools/src/main.ts")).toBe(false);
    expect(toProjectRelativePath(root, "/mnt/e/git repos/codegraph-tools/src/main.ts")).toBeNull();
  });

  it("asserts project-root containment with label-specific errors", () => {
    const root = "C:/workspace/codegraph";

    expect(assertFilePathWithinRoot(root, "src/main.ts", "Input")).toBe("C:/workspace/codegraph/src/main.ts");
    expect(() => assertFilePathWithinRoot(root, "../outside.ts", "Input")).toThrow("Input is outside project root");
  });

  it("normalizes resolution hints by trimming, slash-normalizing, and deduping", () => {
    const hints = normalizeResolutionHints([
      "  src\\index.ts  ",
      "",
      "src/index.ts",
      "packages\\core",
      "packages/core",
      "  tests/main.test.ts",
    ]);

    expect(hints).toEqual(["src/index.ts", "packages/core", "tests/main.test.ts"]);
    expect(normalizeResolutionHints()).toEqual([]);
  });
});
