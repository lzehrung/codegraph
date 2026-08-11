import fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import {
  fileIdentityKey,
  initializeFileIdentityCaseSensitivity,
  isFileIdentityCaseInsensitive,
  resetFileIdentityCaseSensitivityForTests,
  setFileIdentityCaseInsensitive,
} from "../src/util/paths.js";
import { createAgentFileLookup, resolveAgentSnapshotFile } from "../src/agent/normalize.js";
import { getDependencies, getShortestPath } from "../src/graphs/traversal.js";
import { createGraphFileResolver, createImpactIncludeMatcher, normalizeImpactFilePath } from "../src/impact/path.js";
import type { Graph } from "../src/types.js";

const identityLookupMethods = /(?:\.byFile|\.parsed\??)\.(?:get|has|set|delete)\(/;
const identityGraphNodeMethods = /\.graph\.nodes\.(?:get|has|set|delete)\(/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function findPathIdentityGuardViolations(relativeFile: string, source: string): string[] {
  const identityVariables = new Set(
    Array.from(source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*fileIdentityKey\(/g), (match) => match[1]!),
  );
  return source.split(/\r?\n/).flatMap((line, index) => {
    const isIdentityLookup = identityLookupMethods.test(line);
    const isRawGraphLookup = identityGraphNodeMethods.test(line);
    const usesIdentityVariable = [...identityVariables].some((variable) => line.includes(`(${variable})`));
    if (!(isIdentityLookup || isRawGraphLookup) || line.includes("fileIdentityKey(") || usesIdentityVariable) return [];
    return [`${relativeFile}:${index + 1}: ${line.trim()}`];
  });
}

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
  it("uses filesystem case sensitivity for path identity while normalizing drive letters", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests();
      setFileIdentityCaseInsensitive(true);
      expect(fileIdentityKey("E:/x")).toBe(fileIdentityKey("e:/X"));
      expect(fileIdentityKey("E:/repo/Util.ts")).toBe(fileIdentityKey("e:/REPO/util.ts"));

      resetFileIdentityCaseSensitivityForTests();
      setFileIdentityCaseInsensitive(false);
      expect(fileIdentityKey("E:/x")).toBe(fileIdentityKey("e:/x"));
      expect(fileIdentityKey("E:/repo/Util.ts")).not.toBe(fileIdentityKey("E:/repo/util.ts"));
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });
  it("freezes identity case mode after the first key", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      const firstKey = fileIdentityKey("E:/Repo/Util.ts");

      setFileIdentityCaseInsensitive(false);

      expect(isFileIdentityCaseInsensitive()).toBe(true);
      expect(fileIdentityKey("e:/repo/util.ts")).toBe(firstKey);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });
  it("resolves case-variant graph files to their preserved graph paths", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      const resolveGraphFile = createGraphFileResolver(["C:/Repo/Src/Feature.ts"]);

      expect(resolveGraphFile("c:/repo/src/FEATURE.ts")).toBe("C:/Repo/Src/Feature.ts");
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("does not revisit a case-variant dependency traversal start", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      const start = "C:/Repo/Src/Main.ts";
      const dependency = "C:/Repo/Src/Dependency.ts";
      const graph: Graph = {
        nodes: new Set([start, dependency]),
        edges: [
          { from: start, to: { type: "file", path: dependency }, raw: "./Dependency" },
          { from: dependency, to: { type: "file", path: start }, raw: "./Main" },
        ],
      };

      expect(getDependencies(graph, "c:/repo/src/MAIN.ts")).toEqual([{ file: dependency, depth: 1 }]);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("finds case-variant shortest-path targets with normalized graph paths", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      const start = "C:/Repo/Src/Main.ts";
      const dependency = "C:/Repo/Src/Dependency.ts";
      const graph: Graph = {
        nodes: new Set([start, dependency]),
        edges: [{ from: start, to: { type: "file", path: dependency }, raw: "./Dependency" }],
      };

      expect(getShortestPath(graph, start, "c:/repo/src/DEPENDENCY.ts")).toEqual([start, dependency]);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("resolves agent snapshot files through case-variant requests", () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    try {
      resetFileIdentityCaseSensitivityForTests(true);
      setFileIdentityCaseInsensitive(true);
      const root = "C:/Repo";
      const file = "C:/Repo/Src/Feature.ts";
      const snapshot = { root, files: [file], fileLookup: createAgentFileLookup([file]) };

      expect(resolveAgentSnapshotFile(snapshot, "src/FEATURE.ts")).toBe(file);
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("warns when probes observe conflicting filesystem case modes", async () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    const statSpy = vi.spyOn(fsp, "stat");
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let statCallCount = 0;
    statSpy.mockImplementation(async (): Promise<Stats> => {
      statCallCount += 1;
      if (statCallCount !== 4) return { dev: 1, ino: 1 } as Stats;
      const error = new Error("missing path") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    });
    try {
      resetFileIdentityCaseSensitivityForTests();
      await initializeFileIdentityCaseSensitivity("C:/InsensitiveRoot");
      await initializeFileIdentityCaseSensitivity("C:/SensitiveRoot");

      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("InsensitiveRoot"),
        expect.objectContaining({ code: "CODEGRAPH_FILE_IDENTITY_CASE_MODE_CONFLICT" }),
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("SensitiveRoot"),
        expect.objectContaining({ code: "CODEGRAPH_FILE_IDENTITY_CASE_MODE_CONFLICT" }),
      );
    } finally {
      statSpy.mockRestore();
      warningSpy.mockRestore();
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
    }
  });

  it("guards identity-keyed source lookups mechanically", async () => {
    const root = path.resolve(process.cwd(), "src");
    const files = await sourceFiles(root);
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await fsp.readFile(file, "utf8");
          return findPathIdentityGuardViolations(path.relative(root, file).replace(/\\/g, "/"), source);
        }),
      )
    ).flat();

    expect(violations).toEqual([]);
    expect(findPathIdentityGuardViolations("src/example.ts", "index.byFile.get(file);")).toEqual([
      "src/example.ts:1: index.byFile.get(file);",
    ]);
  });
});
