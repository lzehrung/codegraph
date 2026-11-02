import { afterEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { mkTmpDir } from "./helpers/filesystem.js";
import { buildProjectIndex, type BuildReport } from "../src/index.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { supportById } from "../src/languages.js";
import * as bindingLoader from "../src/native/binding-loader.js";
import type { NativeBindingOrigin } from "../src/native/contracts.js";
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

  it("treats an addon that predates registered query sets as unavailable and says to reinstall it", async () => {
    const origin: NativeBindingOrigin = { mode: "workspace", packageName: "@lzehrung/codegraph-native" };
    // An addon from before query sets exports the extraction calls but not `registerQuerySet`.
    const legacyBinding = {
      supportedLanguageIds: () => ["ts"],
      runLanguageQueries: () => ({ imports: [], exports: [], locals: [], importBindings: [] }),
    };
    const load = vi.spyOn(bindingLoader, "loadNativeBinding").mockReturnValue({ binding: legacyBinding, origin });
    __resetNativeTreeSitterBindingForTests();
    try {
      const state = loadBinding();

      expect(state.loaded).toBe(false);
      if (state.loaded) throw new Error("An addon without registerQuerySet must not load.");
      expect(String(state.error)).toMatch(/registerQuerySet.*Reinstall the native package/);
      expect(state.origin).toEqual(origin);
      await expect(buildProjectIndex(samplePath, { cache: "off" })).rejects.toThrow(
        /Required native addon @lzehrung\/codegraph-native is unavailable.*codegraph doctor.*registerQuerySet/,
      );
    } finally {
      load.mockRestore();
      __resetNativeTreeSitterBindingForTests();
    }
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

  it("counts a failed native extraction once per file, including single-file component blocks", async () => {
    const root = await mkTmpDir("cg-native-failure-count-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await fsp.writeFile(
      path.join(root, "Comp.vue"),
      '<script lang="ts">\nimport { a } from "./a";\n</script>\n<script setup lang="ts">\nimport { a as b } from "./a";\n</script>\n',
    );
    const state = loadBinding();
    if (!state.loaded) throw new Error("Native addon required for extraction failure test");
    __setNativeTreeSitterBindingForTests({
      ...state,
      binding: {
        ...state.binding,
        extractLanguage: () => {
          throw new Error("forced extraction failure");
        },
      },
    });
    const report: BuildReport = { timings: {} };
    await buildProjectIndex(root, { cache: "off", report });

    expect(report.backend?.native.filesFellBack).toBe(2);
    expect(report.backend?.native.fallbackReasons.queryFailure).toBe(2);
    expect(report.backend?.native.errors.map((error) => path.basename(error.file)).sort()).toEqual([
      "Comp.vue",
      "a.ts",
    ]);
  });
});
