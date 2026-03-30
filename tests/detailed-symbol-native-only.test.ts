import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/indexer.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

describe("detailed symbol graph in native-only installs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/jsFallback.js");
    vi.doUnmock("../src/native/treeSitterNative.js");
  });

  it("skips files cleanly when syntax-tree fallback is unavailable", async () => {
    const root = await mkTmpDir("cg-detailed-native-only-");
    await fsp.writeFile(
      path.join(root, "legacy.js"),
      "export function render(value) { return value; }\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "template.html"),
      "<div><script>export const value = 1;</script></div>\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    index.parsed = new Map();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parseSpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for grammar loading. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });

    vi.resetModules();
    vi.doMock("../src/jsFallback.js", async () => {
      const actual = await vi.importActual<typeof import("../src/jsFallback.js")>(
        "../src/jsFallback.js",
      );
      return {
        ...actual,
        isJsFallbackAvailable: () => false,
        parseWithJsLanguage: parseSpy,
      };
    });
    vi.doMock("../src/native/treeSitterNative.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/native/treeSitterNative.js")
      >("../src/native/treeSitterNative.js");
      return {
        ...actual,
        getNativeSyntaxTreeExecution: vi.fn(() => ({
          tree: null,
          fallbackReason: "unavailable",
        })),
      };
    });

    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const detailed = await buildSymbolGraphDetailed(index);
    const warnings = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));

    expect(parseSpy).not.toHaveBeenCalled();
    expect(
      warnings.some((warning) =>
        warning.includes("Failed to build detailed symbol edges for"),
      ),
    ).toBe(false);
    expect(warnings).toContain(
      "Warning: Skipped detailed symbol edges for 2 file(s) because the JS Tree-sitter fallback is unavailable.",
    );
    expect(detailed.edges).toEqual([]);
  });

  it("builds the project index without per-file warnings when both tree paths are unavailable", async () => {
    const root = await mkTmpDir("cg-index-native-only-");
    await fsp.writeFile(
      path.join(root, "legacy.js"),
      "angular.module('admin').controller('UserCtrl', function UserCtrl($scope) { return $scope; });\n",
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parseSpy = vi.fn(() => {
      throw new Error(
        "JS Tree-sitter fallback is unavailable for grammar loading. Install @lzehrung/codegraph-js-fallback to enable it",
      );
    });

    vi.resetModules();
    vi.doMock("../src/jsFallback.js", async () => {
      const actual = await vi.importActual<typeof import("../src/jsFallback.js")>(
        "../src/jsFallback.js",
      );
      return {
        ...actual,
        parseWithJsLanguage: parseSpy,
      };
    });
    vi.doMock("../src/native/treeSitterNative.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/native/treeSitterNative.js")
      >("../src/native/treeSitterNative.js");
      return {
        ...actual,
        getNativeQueryExecution: vi.fn(() => ({
          results: null,
          fallbackReason: "unavailable",
        })),
        getNativeSyntaxTreeExecution: vi.fn(() => ({
          tree: null,
          fallbackReason: "unavailable",
        })),
      };
    });

    const { buildProjectIndex } = await import("../src/indexer.js");
    const index = await buildProjectIndex(root);
    const warnings = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));
    expect(index.byFile.size).toBe(1);
    expect(index.byFile.get(normalizePath(path.join(root, "legacy.js")))).toBeDefined();
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    expect(
      warnings.some((warning) =>
        warning.includes("Warning: Failed to process file"),
      ),
    ).toBe(false);
  });
});
