import { describe, expect, it } from "vitest";
import { pickPackageExportTarget, resolvePackageExportTargets } from "../src/util/packageExports.js";

describe("package export target selection", () => {
  it("picks string targets directly", () => {
    expect(pickPackageExportTarget("./dist/index.js")).toBe("./dist/index.js");
  });

  it("prefers import conditions while retaining node and require fallbacks", () => {
    expect(
      pickPackageExportTarget({
        require: "./dist/index.cjs",
        default: "./dist/index.js",
        import: "./dist/index.mjs",
      }),
    ).toBe("./dist/index.mjs");

    expect(pickPackageExportTarget({ node: "./dist/index.node.js" })).toBe("./dist/index.node.js");

    expect(
      pickPackageExportTarget({
        require: "./dist/index.cjs",
        module: "./dist/index.module.js",
      }),
    ).toBe("./dist/index.cjs");
  });

  it("matches subpath patterns and preserves conditional-array fallback targets", () => {
    const exportsField = {
      "./*": {
        import: ["./dist/esm/*.mjs", "./dist/fallback/*.js"],
      },
    };

    expect(resolvePackageExportTargets(exportsField, "./feature")).toEqual([
      "./dist/esm/feature.mjs",
      "./dist/fallback/feature.js",
    ]);
    expect(resolvePackageExportTargets(exportsField, "./private")).toEqual([
      "./dist/esm/private.mjs",
      "./dist/fallback/private.js",
    ]);
  });

  it("refuses unlisted subpaths and invalid target shapes", () => {
    expect(resolvePackageExportTargets({ "./public": "./dist/public.js" }, "./private")).toEqual([]);
    expect(pickPackageExportTarget(null)).toBeNull();
    expect(pickPackageExportTarget(false)).toBeNull();
  });
});
