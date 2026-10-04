import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { buildProjectIndex, type BuildReport } from "../src/index.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { supportById } from "../src/languages.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import { loadBinding } from "../src/native/runtime.js";

describe("required native runtime", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

  afterEach(() => {
    __resetNativeTreeSitterBindingForTests();
  });

  it("requires the native addon to build an index and points to codegraph doctor", async () => {
    __setNativeTreeSitterBindingForTests({ loaded: false, error: new Error("addon not installed") });

    await expect(buildProjectIndex(samplePath, { cache: "off" })).rejects.toThrow(
      /Required native addon @lzehrung\/codegraph-native is unavailable.*codegraph doctor/,
    );
  });

  it("reports a failed native import query without recovering imports from source text", () => {
    const state = loadBinding();
    if (!state.loaded) throw new Error("Native addon required for query failure test");
    __setNativeTreeSitterBindingForTests({
      ...state,
      binding: {
        ...state.binding,
        runImportsQueryCompact: () => {
          throw new Error("forced import query failure");
        },
      },
    });
    const report: BuildReport = { timings: {} };
    const support = supportById("ts")!;
    const imports = collectModuleSpecifiersFromSource(support, "import { foo } from './bar';\n", {
      file: "main.ts",
      report,
    });

    expect(imports).toEqual([]);
    expect(report.backend?.native.fallbackReasons.queryFailure).toBe(1);
    expect(report.backend?.native.errors).toEqual([
      expect.objectContaining({
        file: "main.ts",
        languageId: "ts",
        reason: "queryFailure",
        message: "forced import query failure",
      }),
    ]);
  });
});
