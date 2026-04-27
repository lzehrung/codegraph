import { describe, expect, it } from "vitest";
import {
  resolveFilePathFromRoot,
  isAbsoluteFilePath,
  isFilePathWithinRoot,
  toProjectRelativePath,
} from "../src/util.js";
import { normalizeImpactFilePath } from "../src/impact/path.js";

describe("cross-platform path normalization", () => {
  it("treats Windows-style paths as absolute regardless of host OS", () => {
    const windowsDrivePath = "C:/repo/src/main.ts";
    const windowsBackslashPath = String.raw`C:\repo\src\main.ts`;

    expect(isAbsoluteFilePath(windowsDrivePath)).toBe(true);
    expect(isAbsoluteFilePath(windowsBackslashPath)).toBe(true);
    expect(resolveFilePathFromRoot("/workspace/codegraph", windowsDrivePath)).toBe(
      windowsDrivePath,
    );
    expect(
      resolveFilePathFromRoot("/workspace/codegraph", windowsBackslashPath),
    ).toBe(windowsBackslashPath);
  });

  it("normalizes impact paths without re-rooting Windows-style absolute inputs", () => {
    expect(
      normalizeImpactFilePath("/workspace/codegraph", "C:/repo/src/main.ts"),
    ).toBe("C:/repo/src/main.ts");
    expect(
      normalizeImpactFilePath(
        "/workspace/codegraph",
        String.raw`C:\repo\src\main.ts`,
      ),
    ).toBe("C:/repo/src/main.ts");
  });

  it("does not treat Windows-style absolute paths as inside a POSIX project root", () => {
    expect(
      isFilePathWithinRoot("/workspace/codegraph", "src/main.ts"),
    ).toBe(true);
    expect(
      toProjectRelativePath("/workspace/codegraph", "src/main.ts"),
    ).toBe("src/main.ts");
    expect(
      isFilePathWithinRoot("/workspace/codegraph", "C:/repo/src/main.ts"),
    ).toBe(false);
    expect(
      toProjectRelativePath("/workspace/codegraph", "C:/repo/src/main.ts"),
    ).toBeNull();
  });
});
