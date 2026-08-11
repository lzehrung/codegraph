import { describe, expect, it } from "vitest";
import { resolvePackageExportTargets } from "../src/util/packageExports.js";

describe("package export target selection", () => {
  it("picks string targets directly", () => {
    expect(resolvePackageExportTargets("./dist/index.js", ".")).toEqual(["./dist/index.js"]);
  });

  // Restored from pre-c1680788: asserts Node author-key order, not the buggy
  // "prefers import" priority list that replaced this assertion.
  it("uses Node's declared condition order", () => {
    expect(
      resolvePackageExportTargets(
        {
          import: "./dist/index.mjs",
          require: "./dist/index.cjs",
          default: "./dist/index.js",
        },
        ".",
      ),
    ).toEqual(["./dist/index.mjs"]);

    expect(
      resolvePackageExportTargets(
        {
          node: "./dist/index.node.js",
          import: "./dist/index.mjs",
        },
        ".",
      ),
    ).toEqual(["./dist/index.node.js"]);

    expect(
      resolvePackageExportTargets(
        {
          import: "./dist/index.mjs",
          node: "./dist/index.node.js",
        },
        ".",
      ),
    ).toEqual(["./dist/index.mjs"]);

    expect(
      resolvePackageExportTargets(
        {
          require: "./dist/index.cjs",
          module: "./dist/index.module.js",
        },
        ".",
        "require",
      ),
    ).toEqual(["./dist/index.cjs"]);
  });

  it("selects mutually exclusive import vs require by consumer mode", () => {
    const dual = {
      require: "./cjs.cjs",
      import: "./esm.mjs",
      default: "./default.js",
    };
    expect(resolvePackageExportTargets(dual, ".", "require")).toEqual(["./cjs.cjs"]);
    expect(resolvePackageExportTargets(dual, ".", "import")).toEqual(["./esm.mjs"]);

    const importFirst = {
      import: "./esm.mjs",
      require: "./cjs.cjs",
    };
    expect(resolvePackageExportTargets(importFirst, ".", "require")).toEqual(["./cjs.cjs"]);
    expect(resolvePackageExportTargets(importFirst, ".", "import")).toEqual(["./esm.mjs"]);

    // Reviewer's probe shape: default before import terminates for import mode.
    const probe = {
      require: "./cjs.cjs",
      default: "./default.js",
      import: "./esm.mjs",
    };
    expect(resolvePackageExportTargets(probe, ".", "require")).toEqual(["./cjs.cjs"]);
    expect(resolvePackageExportTargets(probe, ".", "import")).toEqual(["./default.js"]);
  });

  it("terminates on default and recurses nested conditions", () => {
    expect(
      resolvePackageExportTargets(
        {
          default: "./default.js",
          import: "./never.mjs",
        },
        ".",
      ),
    ).toEqual(["./default.js"]);

    expect(
      resolvePackageExportTargets(
        {
          node: {
            require: "./feature-node.cjs",
            import: "./feature-node.mjs",
          },
          default: "./feature.mjs",
        },
        ".",
        "require",
      ),
    ).toEqual(["./feature-node.cjs"]);

    expect(
      resolvePackageExportTargets(
        {
          node: {
            require: "./feature-node.cjs",
            import: "./feature-node.mjs",
          },
          default: "./feature.mjs",
        },
        ".",
        "import",
      ),
    ).toEqual(["./feature-node.mjs"]);
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
    expect(resolvePackageExportTargets(null, ".")).toEqual([]);
    expect(resolvePackageExportTargets(false, ".")).toEqual([]);
  });
});
