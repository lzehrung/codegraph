import { describe, expect, it } from "vitest";
import { pickPackageExportTarget } from "../src/util/packageExports.js";

describe("package export target selection", () => {
  it("picks string targets directly", () => {
    expect(pickPackageExportTarget("./dist/index.js")).toBe("./dist/index.js");
  });

  it("prefers import, default, require, then module conditions", () => {
    expect(
      pickPackageExportTarget({
        require: "./dist/index.cjs",
        default: "./dist/index.js",
        import: "./dist/index.mjs",
      }),
    ).toBe("./dist/index.mjs");

    expect(
      pickPackageExportTarget({
        require: "./dist/index.cjs",
        module: "./dist/index.module.js",
      }),
    ).toBe("./dist/index.cjs");
  });

  it("ignores unsupported export target shapes", () => {
    expect(pickPackageExportTarget(null)).toBeNull();
    expect(pickPackageExportTarget(false)).toBeNull();
    expect(pickPackageExportTarget(["./dist/index.js"])).toBeNull();
    expect(pickPackageExportTarget({ import: ["./dist/index.js"] })).toBeNull();
  });
});
