import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { buildProjectIndexFromFiles } from "../src/index.js";
import { collectEdgesForFile } from "../src/graph-edge-collector.js";
import { collectImportsForFile } from "../src/indexer/imports.js";
import { resolveCsharpNamespaceTypePath } from "../src/util/resolution/csharp.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs/specifiers.js";
import { CSHARP_SUPPORT } from "../src/languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../src/languages/types.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import { loadBinding } from "../src/native/runtime.js";
import { getCsharpNamespaceRegions } from "../src/indexer/compilation-units.js";
import type { BuildReport, ModuleIndex, ProjectIndex } from "../src/indexer/types.js";
import type { ParsedFileContext } from "../src/indexer/parse-context.js";
import { makeTestProjectIndex } from "./helpers/narrow.js";
import { fileIdentityKey } from "../src/util/paths.js";
import {
  collectCsharpImportDirectives,
  collectCsharpNamespaceFacts,
  csharpImportDirectiveAt,
  parseCsharpSyntaxTree,
} from "../src/util/csharp-tree.js";

type CsharpTreeOutcome = { tree: SyntaxTreeLike | null; fallbackReason?: string; error?: string };

function parseCsharpOutcome(source: string): CsharpTreeOutcome {
  const parsed = parseCsharpSyntaxTree(source, CSHARP_SUPPORT) as unknown as CsharpTreeOutcome | SyntaxTreeLike | null;
  if (!parsed) return { tree: null };
  if ("rootNode" in parsed) return { tree: parsed };
  return parsed;
}

function setNativeTreeParseFailure(message: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: () => {
        throw new Error(message);
      },
    },
  });
}

function setNativeTreeParseFailureFor(marker: string, message: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  const parseSyntaxTree = state.binding.parseSyntaxTree;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: (source, languageId) => {
        if (source.includes(marker)) throw new Error(message);
        return parseSyntaxTree(source, languageId);
      },
    },
  });
}

function countNativeTreeParses(): () => number {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  const parseSyntaxTree = state.binding.parseSyntaxTree;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  const extractLanguage = state.binding.extractLanguage;
  let count = 0;
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: (source, languageId) => {
        count += 1;
        return parseSyntaxTree(source, languageId);
      },
      extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        count += 1;
        return extractLanguage(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
      },
    },
  });
  return () => count;
}
function projectIndexWithSource(file: string, source: string): ProjectIndex {
  const key = fileIdentityKey(file);
  const module: ModuleIndex = { file, exports: [], imports: [], locals: [] };
  return makeTestProjectIndex({
    byFile: new Map([[key, module]]),
    parsed: new Map([[key, { source } as ParsedFileContext]]),
    buildReport: { timings: {} } as BuildReport,
  });
}

function treeForSource(source: string): SyntaxTreeLike {
  const tree = parseCsharpOutcome(source).tree;
  if (!tree) throw new Error("Expected a C# syntax tree");
  return tree;
}

afterEach(() => {
  __resetNativeTreeSitterBindingForTests();
});

describe("C# syntax-tree outcomes", () => {
  it("distinguishes parsed-empty syntax from an unavailable native tree", () => {
    const empty = parseCsharpOutcome("");
    expect(empty.tree).not.toBeNull();
    expect(empty.fallbackReason).toBeUndefined();
    expect(collectCsharpNamespaceFacts(empty.tree!, 0).regions).toEqual([]);

    setNativeTreeParseFailure("forced C# tree parse failure");
    expect(parseCsharpOutcome("namespace N; class T {}\n")).toEqual({
      tree: null,
      fallbackReason: "queryFailure",
      error: "forced C# tree parse failure",
    });
  });

  it("reports an unavailable C# tree as parser degradation while collecting specifiers", () => {
    setNativeTreeParseFailure("forced C# specifier parse failure");
    const report: BuildReport = { timings: {} };

    expect(
      collectModuleSpecifiersFromSource(CSHARP_SUPPORT, "using Missing;\n", {
        file: "src/Main.cs",
        report,
      }),
    ).toEqual([]);
    expect(report.backend?.parser).toMatchObject({
      total: 1,
      byLanguage: { csharp: 1 },
      files: [
        {
          file: "src/Main.cs",
          languageId: "csharp",
          nativeFallbackReason: "queryFailure",
          nativeError: "forced C# specifier parse failure",
        },
      ],
    });
  });

  it("does not cache unavailable namespace facts as an empty namespace", () => {
    const file = path.resolve("CsharpTreeUnavailable.cs").replace(/\\/g, "/");
    const index = projectIndexWithSource(file, "namespace N; class T {}\n");
    setNativeTreeParseFailure("forced C# namespace parse failure");

    expect(getCsharpNamespaceRegions(index, file)).toBeNull();
    expect(index.buildReport?.backend?.parser).toMatchObject({
      total: 1,
      byLanguage: { csharp: 1 },
      files: [
        {
          file,
          languageId: "csharp",
          nativeFallbackReason: "queryFailure",
          nativeError: "forced C# namespace parse failure",
        },
      ],
    });
  });
});

describe("C# namespace declarations in conditional directives", () => {
  it("keeps a conditional namespace in its enclosing scope only", () => {
    const source = [
      "namespace Outer {",
      "#if FEATURE",
      "namespace Nested { public class ConditionalType {} }",
      "#elif OTHER",
      "namespace Alternate { public class AlternateType {} }",
      "#else",
      "namespace Fallback { public class FallbackType {} }",
      "#endif",
      "}",
      "namespace Unrelated { public class OtherType {} }",
      "",
    ].join("\n");
    const tree = treeForSource(source);
    const facts = collectCsharpNamespaceFacts(tree, source.length);

    expect(facts.namespaces).toEqual(["Outer", "Outer.Nested", "Outer.Alternate", "Outer.Fallback", "Unrelated"]);
    expect(facts.symbolsByNamespace.get("Outer.Nested")).toEqual(new Set(["ConditionalType"]));
    expect(facts.symbolsByNamespace.get("Outer.Alternate")).toEqual(new Set(["AlternateType"]));
    expect(facts.symbolsByNamespace.get("Outer.Fallback")).toEqual(new Set(["FallbackType"]));
    expect(facts.symbolsByNamespace.get("Unrelated")).toEqual(new Set(["OtherType"]));
    expect(facts.symbolsByNamespace.has("Unrelated.Nested")).toBe(false);
    expect(facts.hasGlobalType).toBe(false);
  });
});
describe("C# namespace type-index completeness", () => {
  it("returns partial when a project C# file cannot be parsed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-partial-"));
    const typeFile = path.join(root, "Box.cs");
    const unparsedFile = path.join(root, "Unparsed.cs");
    try {
      await writeFile(typeFile, "namespace N; public class Box {}\n", "utf8");
      await writeFile(unparsedFile, "// CSHARP_PARSE_FAILURE\nnamespace Other; class Hidden {}\n", "utf8");
      setNativeTreeParseFailureFor("CSHARP_PARSE_FAILURE", "forced C# namespace candidate parse failure");

      const resolution = await resolveCsharpNamespaceTypePath(root, "N", "Box", typeFile);
      expect(resolution).toEqual({ status: "partial" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# project-build import tree reuse", () => {
  it("uses one native tree parse for a C# module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-import-tree-build-"));
    const file = path.join(root, "Main.cs");
    try {
      await writeFile(file, "class Main {}\n", "utf8");
      const parseCount = countNativeTreeParses();
      await buildProjectIndexFromFiles(root, [file], { useNativeWorkers: false });
      expect(parseCount()).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("C# import tree reuse", () => {
  it("does not reparse a caller-supplied tree", async () => {
    const root = "E:/git repos/codegraph-wt-csharp-using";
    const file = path.join(root, "src", "CsharpTreeReuse.cs");
    const source = "class Main {}\n";
    const tree = treeForSource(source);
    const parseCount = countNativeTreeParses();
    const optionsWithTree = { source, sup: CSHARP_SUPPORT, nativeQueries: null, tree };

    await collectImportsForFile(file, root, optionsWithTree);
    expect(parseCount()).toBe(0);

    await collectImportsForFile(file, root, { source, sup: CSHARP_SUPPORT, nativeQueries: null });
    expect(parseCount()).toBe(1);
  });
});

describe("C# alias namespace parse reporting", () => {
  it("reports failed namespace candidates while handling a namespace alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-parse-report-"));
    const main = path.join(root, "Main.cs");
    const namespaceFile = path.join(root, "Namespace.cs");
    const unparsedFile = path.join(root, "Unparsed.cs");
    const source = "using A = N;\nclass Main {}\n";
    const report: BuildReport = { timings: {} };
    try {
      await writeFile(main, source, "utf8");
      await writeFile(namespaceFile, "namespace N; public class Box {}\n", "utf8");
      await writeFile(unparsedFile, "// CSHARP_PARSE_FAILURE\nnamespace Other; class Hidden {}\n", "utf8");
      setNativeTreeParseFailureFor("CSHARP_PARSE_FAILURE", "forced C# alias namespace parse failure");

      const bindings = await collectImportsForFile(main, root, { source, sup: CSHARP_SUPPORT, report });
      expect(bindings).toContainEqual(expect.objectContaining({ kind: "namespace", localNS: "A", from: "N" }));
      expect(report.backend?.parser).toMatchObject({
        total: 1,
        byLanguage: { csharp: 1 },
        files: [
          {
            file: unparsedFile.replace(/\\/g, "/"),
            languageId: "csharp",
            nativeFallbackReason: "queryFailure",
            nativeError: "forced C# alias namespace parse failure",
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps a type alias unresolved when a candidate parse fails despite one namespace target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-type-alias-partial-"));
    const main = path.join(root, "Main.cs");
    const namespaceFile = path.join(root, "Namespace.cs");
    const failedCandidate = path.join(root, "Box.cs");
    const source = "using A = N.Box;\nclass Main {}\n";
    const report: BuildReport = { timings: {} };
    try {
      await writeFile(main, source, "utf8");
      await writeFile(namespaceFile, "namespace N; public class Other {}\n", "utf8");
      await writeFile(failedCandidate, "// CSHARP_PARSE_FAILURE\nnamespace N; public class Box {}\n", "utf8");
      setNativeTreeParseFailureFor("CSHARP_PARSE_FAILURE", "forced C# type candidate parse failure");

      const bindings = await collectImportsForFile(main, root, { source, sup: CSHARP_SUPPORT, report });
      const alias = bindings.find((binding) => binding.kind === "named" && binding.local === "A");

      expect(alias).toMatchObject({
        kind: "named",
        local: "A",
        imported: "Box",
        from: "N.Box",
        resolved: { external: "N.Box" },
      });
      expect(typeof alias?.resolved).not.toBe("string");
      expect(report.backend?.parser?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: failedCandidate.replace(/\\/g, "/"),
            languageId: "csharp",
            nativeFallbackReason: "queryFailure",
            nativeError: "forced C# type candidate parse failure",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("C# namespace resolution failures and parser reporting", () => {
  it("returns partial when a C# namespace candidate file cannot be read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-namespace-read-failure-"));
    const typeFile = path.join(root, "Box.cs");
    const unreadableFile = path.join(root, "Other.cs");
    try {
      await writeFile(typeFile, "namespace N; public class Box {}\n", "utf8");
      await writeFile(unreadableFile, "namespace Other; public class Hidden {}\n", "utf8");
      const originalReadFile = fsp.readFile.bind(fsp);
      const readFileSpy = vi.spyOn(fsp, "readFile").mockImplementation((...args) => {
        if (fileIdentityKey(String(args[0])) === fileIdentityKey(unreadableFile)) {
          return Promise.reject(new Error("forced C# candidate read failure"));
        }
        return originalReadFile(...args);
      });
      try {
        const resolution = await resolveCsharpNamespaceTypePath(root, "N", "Box", typeFile);
        expect(resolution).toEqual({ status: "partial" });
      } finally {
        readFileSpy.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records C# candidate parse failures while collecting dependency edges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-edge-parse-report-"));
    const main = path.join(root, "Main.cs");
    const typeFile = path.join(root, "Box.cs");
    const failedCandidate = path.join(root, "Unparsed.cs");
    const source = "using B = N.Box;\nclass Main { B value; }\n";
    const report: BuildReport = { timings: {} };
    try {
      await writeFile(main, source, "utf8");
      await writeFile(typeFile, "namespace N; public class Box {}\n", "utf8");
      await writeFile(failedCandidate, "// CSHARP_EDGE_PARSE_FAILURE\nnamespace Other; class Hidden {}\n", "utf8");
      setNativeTreeParseFailureFor("CSHARP_EDGE_PARSE_FAILURE", "forced C# edge candidate parse failure");

      const edges = await collectEdgesForFile(main, root, undefined, {
        parsed: { source, sup: CSHARP_SUPPORT },
        report,
      });

      expect(edges).toEqual(
        expect.arrayContaining([expect.objectContaining({ to: { type: "external", name: "N.Box" } })]),
      );
      expect(report.backend?.parser).toMatchObject({
        total: 1,
        byLanguage: { csharp: 1 },
        files: [
          expect.objectContaining({
            file: failedCandidate.replace(/\\/g, "/"),
            languageId: "csharp",
            nativeFallbackReason: "queryFailure",
            nativeError: "forced C# edge candidate parse failure",
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts repeated C# alias candidate failures once per file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-parse-report-dedup-"));
    const main = path.join(root, "Main.cs");
    const typeFile = path.join(root, "Box.cs");
    const failedCandidate = path.join(root, "Unparsed.cs");
    const source = "using A = N.Box;\nusing B = N.Box;\nclass Main {}\n";
    const report: BuildReport = { timings: {} };
    try {
      await writeFile(main, source, "utf8");
      await writeFile(typeFile, "namespace N; public class Box {}\n", "utf8");
      await writeFile(failedCandidate, "// CSHARP_ALIAS_DEDUP_FAILURE\nnamespace Other; class Hidden {}\n", "utf8");
      setNativeTreeParseFailureFor("CSHARP_ALIAS_DEDUP_FAILURE", "forced C# alias dedup parse failure");

      const bindings = await collectImportsForFile(main, root, { source, sup: CSHARP_SUPPORT, report });

      expect(bindings.filter((binding) => binding.kind === "named" && ["A", "B"].includes(binding.local))).toHaveLength(
        2,
      );
      expect(report.backend?.parser).toMatchObject({
        total: 1,
        byLanguage: { csharp: 1 },
        files: [expect.objectContaining({ file: failedCandidate.replace(/\\/g, "/"), languageId: "csharp" })],
      });
      expect(report.backend?.parser?.files).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("C# using-directive syntax lookup", () => {
  it("selects the second of adjacent directives without reusing the first", () => {
    const source = "using A;using B;";
    const tree = treeForSource(source);
    const secondStart = source.indexOf("using", 1);

    expect(csharpImportDirectiveAt(tree, source.indexOf("using"))?.text).toBe("using A;");
    expect(csharpImportDirectiveAt(tree, secondStart)?.text).toBe("using B;");
  });

  it("finds a directive after a leading comment", () => {
    const source = "/*x*/using A;";
    const tree = treeForSource(source);

    expect(csharpImportDirectiveAt(tree, source.indexOf("using"))?.text).toBe("using A;");
  });

  it("reads each visited node's named-child list once", () => {
    const children = Array.from({ length: 64 }, () => ({ type: "using_directive" }) as unknown as SyntaxNodeLike);
    let namedChildrenReads = 0;
    const rootNode = {
      type: "compilation_unit",
      get namedChildren() {
        namedChildrenReads += 1;
        return children;
      },
    } as unknown as SyntaxNodeLike;
    const tree = { rootNode } as unknown as SyntaxTreeLike;

    expect(collectCsharpImportDirectives(tree)).toHaveLength(children.length);
    expect(namedChildrenReads).toBe(1);
  });
});
