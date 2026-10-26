import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { collectEdgesForFile } from "../src/graph-edge-collector.js";
import { collectImportsForFile } from "../src/indexer/imports.js";
import { clearCsharpResolutionCaches, resolveCsharpNamespaceTypePath } from "../src/util/resolution/csharp.js";
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
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import { makeTestProjectIndex } from "./helpers/narrow.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import {
  collectCsharpDeclaredNames,
  collectCsharpImportDirectives,
  collectCsharpNamespaceFacts,
  csharpImportDirectiveAt,
  parseCsharpSyntaxTree,
} from "../src/util/csharp-tree.js";
import * as csharpTree from "../src/util/csharp-tree.js";

type CsharpTreeOutcome = { tree: SyntaxTreeLike | null; fallbackReason?: string; error?: string };

function parseCsharpOutcome(source: string): CsharpTreeOutcome {
  const parsed = parseCsharpSyntaxTree(source, CSHARP_SUPPORT) as unknown as CsharpTreeOutcome | SyntaxTreeLike | null;
  if (!parsed) return { tree: null };
  if ("rootNode" in parsed) return { tree: parsed };
  return parsed;
}

function setNativeTreeParseFailure(message: string): () => number {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  let attempts = 0;
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: () => {
        attempts += 1;
        throw new Error(message);
      },
    },
  });
  return () => attempts;
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

/** Fails parsing and extraction for sources containing `marker`, so that file indexes without a tree. */
function setNativeIndexingFailureFor(marker: string, message: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  const { parseSyntaxTree, extractLanguage } = state.binding;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: (source, languageId) => {
        if (source.includes(marker)) throw new Error(message);
        return parseSyntaxTree(source, languageId);
      },
      extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        if (source.includes(marker)) throw new Error(message);
        return extractLanguage(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
      },
    },
  });
}

function countNativeTreeParses(): () => number {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for C# tree tests");
  const { parseSyntaxTree, extractLanguage, runLanguageQueries, runImportsQueryCompact } = state.binding;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  let count = 0;
  // Every native entry point that reads source parses it, including the query-only passes.
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
      runLanguageQueries: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        count += 1;
        return runLanguageQueries(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
      },
      ...(runImportsQueryCompact
        ? {
            runImportsQueryCompact: (source: string, languageId: string, importsQuery: string) => {
              count += 1;
              return runImportsQueryCompact(source, languageId, importsQuery);
            },
          }
        : {}),
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
describe("C# partial type selection", () => {
  it("selects among partial parts from retained trees without parsing them again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-partial-retained-"));
    const partA = path.join(root, "PartA.cs");
    const partB = path.join(root, "PartB.cs");
    const sources = new Map([
      [partA, "namespace N { public partial class Point { public int Sum() => 1; } }\n"],
      [partB, "namespace N { public partial class Point { public int Extra() => 2; } }\n"],
    ]);
    try {
      const parsedFiles = new Map<string, ParsedFileContext>();
      for (const [file, source] of sources) {
        await writeFile(file, source, "utf8");
        parsedFiles.set(fileIdentityKey(file), {
          source,
          tree: treeForSource(source),
          sup: CSHARP_SUPPORT,
          nativeQueries: null,
        });
      }
      clearCsharpResolutionCaches();
      const parseCount = countNativeTreeParses();

      const resolution = await resolveCsharpNamespaceTypePath(
        root,
        "N",
        "Point",
        partA,
        undefined,
        undefined,
        parsedFiles,
      );

      // Both parts are one partial type, so the first file stands for it; nothing is read from disk again.
      expect(resolution.status === "found" && fileIdentityKey(resolution.file)).toBe(fileIdentityKey(partA));
      expect(parseCount()).toBe(0);
    } finally {
      clearCsharpResolutionCaches();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# project-build import tree reuse", () => {
  it("reuses the C# tree for using directives and compilation-unit namespace lookup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-import-tree-build-"));
    const file = path.join(root, "Main.cs");
    try {
      const usingDirectives = Array.from({ length: 12 }, (_, index) => `using Missing.Namespace${index};`);
      await writeFile(file, ["namespace A;", ...usingDirectives, "class Main {}", ""].join("\n"), "utf8");
      const parseCount = countNativeTreeParses();
      const index = await buildProjectIndexFromFiles(root, [file], { useNativeWorkers: false, keepParsed: true });
      expect(parseCount()).toBe(1);
      const { getCompilationUnitPeers } = await import("../src/indexer/compilation-units.js");
      expect(getCompilationUnitPeers(index, file).files).toContain(file);
      expect(parseCount()).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("C# import tree reuse", () => {
  it("does not reparse a caller-supplied tree", async () => {
    const root = process.cwd();
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

  it("parses a C# file once when edges are collected without a parsed context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-edge-tree-once-"));
    const plain = path.join(root, "Plain.cs");
    const second = path.join(root, "Second.cs");
    const importer = path.join(root, "Importer.cs");
    try {
      await writeFile(plain, "class Plain {}\n", "utf8");
      await writeFile(second, "class Second {}\n", "utf8");
      await writeFile(importer, "using System.Text;\nclass Importer {}\n", "utf8");
      const parseCount = countNativeTreeParses();

      // Neither file has a directive to resolve, so the only native read is the one that finds none.
      expect(await collectEdgesForFile(plain, root, undefined, {})).toEqual([]);
      expect(parseCount()).toBe(1);
      expect(await collectEdgesForFile(second, root, undefined, {})).toEqual([]);
      expect(parseCount()).toBe(2);

      // The single tree still yields the file's directives.
      const edges = await collectEdgesForFile(importer, root, undefined, {});
      expect(edges.map((edge) => edge.raw)).toEqual(["System.Text"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accounts a C# file's native parse when edges are collected without a parsed context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-edge-native-report-"));
    const importer = path.join(root, "Importer.cs");
    const source = "using System.Text;\nclass Importer {}\n";
    try {
      await writeFile(importer, source, "utf8");

      const report: BuildReport = { timings: {} };
      await collectEdgesForFile(importer, root, undefined, { report });
      expect(report.backend?.native).toMatchObject({
        enabled: true,
        filesUsed: 1,
        filesFellBack: 0,
        byLanguage: { csharp: { filesSeen: 1, filesUsed: 1, filesFellBack: 0 } },
      });

      // A supplied context was accounted when it was built, so collecting its edges counts nothing more.
      const supplied: BuildReport = { timings: {} };
      await collectEdgesForFile(importer, root, undefined, {
        parsed: { source, sup: CSHARP_SUPPORT },
        report: supplied,
      });
      expect(supplied.backend?.native.filesUsed ?? 0).toBe(0);
      expect(supplied.backend?.native.byLanguage.csharp?.filesSeen ?? 0).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts a C# file whose tree is unavailable as one native fallback and one parser degradation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-edge-native-fallback-"));
    const importer = path.join(root, "Importer.cs");
    try {
      await writeFile(importer, "using System.Text;\nclass Importer {}\n", "utf8");
      const parseAttempts = setNativeTreeParseFailure("forced C# edge tree failure");

      const report: BuildReport = { timings: {} };
      expect(await collectEdgesForFile(importer, root, undefined, { report })).toEqual([]);
      expect(report.backend?.native).toMatchObject({
        enabled: false,
        filesUsed: 0,
        filesFellBack: 1,
        fallbackReasons: { queryFailure: 1 },
        byLanguage: { csharp: { filesSeen: 1, filesUsed: 0, filesFellBack: 1 } },
        errors: [
          {
            file: importer.replace(/\\/g, "/"),
            languageId: "csharp",
            reason: "queryFailure",
            message: "forced C# edge tree failure",
          },
        ],
      });
      expect(report.backend?.parser).toMatchObject({
        total: 1,
        byLanguage: { csharp: 1 },
        files: [
          {
            file: importer.replace(/\\/g, "/"),
            languageId: "csharp",
            nativeFallbackReason: "queryFailure",
            nativeError: "forced C# edge tree failure",
          },
        ],
      });
      // The failed tree is the file's one parse attempt: reading its directives must not parse it again.
      expect(parseAttempts()).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C# namespace resolution cache mappings", () => {
  it("recollects namespace facts when sequential import collection uses a different mapping", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-mapped-namespace-cache-"));
    const main = path.join(root, "Main.csx");
    const namespaceFile = path.join(root, "Namespace.cs");
    const source = "using N;\nclass Main {}\n";
    try {
      await writeFile(main, source, "utf8");
      await writeFile(namespaceFile, "namespace N; public class Target {}\n", "utf8");
      clearCsharpResolutionCaches();

      await collectImportsForFile(main, root, {
        source,
        sup: CSHARP_SUPPORT,
        languageExtensions: { ".cs": "python" },
      });
      const imports = await collectImportsForFile(main, root, {
        source,
        sup: CSHARP_SUPPORT,
        languageExtensions: { ".cs": "csharp" },
      });
      const namespaceImport = imports.find((binding) => binding.kind === "star" && binding.from === "N");

      expect(namespaceImport?.resolved).toBe(namespaceFile.replace(/\\/g, "/"));
    } finally {
      clearCsharpResolutionCaches();
      await rm(root, { recursive: true, force: true });
    }
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
/** Main.cs for the alias-scan projects: `A` aliases namespace `N`, and each use names `N.Box` through it. */
const aliasScanMainLines = [
  "using A = N;",
  "class Holder { public int Count; }",
  "class Use {",
  "  A::Box aliased;",
  "  A.Box dotted;",
  "  object Make() { return new A::Box(); }",
  "  void Run() { A::Box.Go(); }",
  "  void Dotted() { A.Box.Go(); }",
  "  int Value(Holder A) => A.Count;",
  "  void Qualified(Holder A) { A::Box.Go(); }",
  "}",
];

/**
 * Writes the alias-scan project. `N.Box` is declared once, and Unparsed.cs, whose declarations are unknown while
 * native indexing fails for its marker, could declare another one.
 */
async function writeAliasScanProject(root: string): Promise<void> {
  await writeFixtureFiles(root, {
    "Box.cs": "namespace N; public class Box { public static void Go() {} }\n",
    "Unparsed.cs": "// CSHARP_ALIAS_SCAN_FAILURE\nnamespace Elsewhere; public class Hidden {}\n",
    "Main.cs": aliasScanMainLines.join("\n") + "\n",
  });
}

/** What each consumer reports for the alias uses in the alias-scan project's Main.cs. */
async function aliasScanConsumers(index: ProjectIndex, root: string) {
  const main = path.join(root, "Main.cs");
  const goto: string[] = [];
  for (const [line, token] of [
    [4, "Box"],
    [5, "Box"],
    [6, "Box"],
    [7, "Box"],
    [7, "Go"],
    [8, "Box"],
    [8, "Go"],
    [9, "Count"],
    [10, "Go"],
  ] as const) {
    const result = await goToDefinition(index, { file: main, line, column: columnOf(aliasScanMainLines, line, token) });
    goto.push(result.status === "ok" ? path.basename(result.definition.file) : result.status);
  }
  const references = await findReferences(index, { file: path.join(root, "Box.cs"), line: 1, column: 27 });
  const graph = await buildSymbolGraphDetailed(index);
  return {
    goto,
    references:
      references.status === "ok"
        ? references.references
            .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))
            .map((reference) => reference.range.start.line)
        : references.status,
    graphEdges: graph.edges
      .flatMap((edge) => {
        const from = graph.nodes.get(edge.from);
        const to = graph.nodes.get(edge.to);
        const leavesMain = from && to && fileIdentityKey(from.file) === fileIdentityKey(main);
        return leavesMain && fileIdentityKey(to.file) !== fileIdentityKey(main) && from.kind !== "namespaceImport"
          ? [`${from.name} ${edge.label} ${path.basename(to.file)}`]
          : [];
      })
      .sort(),
    dependencies: index.graph.edges
      .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(main) && edge.to.type === "file")
      .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : ""))
      .sort(),
  };
}

/** While Unparsed.cs's declarations are unknown, the dependency edge stays and no consumer names a type through `A`. */
const aliasScanUnproven = {
  // A parameter named `A` still makes `A.Count` a member of that value; `A::` reaches aliases only.
  goto: [...Array.from({ length: 7 }, () => "not_found"), "Main.cs", "not_found"],
  references: [],
  graphEdges: [],
  dependencies: ["Box.cs"],
};

/** Once every file's declarations are known, the one declaring file is proven and every consumer follows the alias. */
const aliasScanProven = {
  goto: [...Array.from({ length: 7 }, () => "Box.cs"), "Main.cs", "Box.cs"],
  references: [4, 5, 6, 7, 8, 10],
  graphEdges: [
    "Dotted calls Box.cs",
    "Dotted uses Box.cs",
    "Dotted uses Box.cs",
    "Make instantiates Box.cs",
    "Make uses Box.cs",
    "Qualified calls Box.cs",
    "Run calls Box.cs",
    "Run uses Box.cs",
    "Run uses Box.cs",
  ],
  dependencies: ["Box.cs"],
};

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

  it("leaves a dotted alias use unresolved while an indexed C# file's declarations are unknown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-unknown-declarations-"));
    const real = path.join(root, "Real.cs");
    const unparsed = path.join(root, "Unparsed.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = ["using X = Real;", "namespace Local {", "  class Use { X.Target value; }", "}"];
    try {
      await writeFile(real, "namespace Real; public class Target {}\n", "utf8");
      await writeFile(unparsed, "// CSHARP_UNKNOWN_DECLARATIONS\nnamespace Elsewhere; class Hidden {}\n", "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const gotoTarget = async (index: ProjectIndex): Promise<string> => {
        const result = await goToDefinition(index, {
          file: main,
          line: 3,
          column: mainLines[2]!.indexOf("Target") + 1,
        });
        return result.status === "ok" ? path.basename(result.definition.file) : result.status;
      };
      const files = [real, unparsed, main];

      // Without a tree, Unparsed.cs could declare `Local.X`; an unreadable file is not an empty one.
      setNativeIndexingFailureFor("CSHARP_UNKNOWN_DECLARATIONS", "forced C# declarations indexing failure");
      expect(await gotoTarget(await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false }))).toBe(
        "not_found",
      );

      __resetNativeTreeSitterBindingForTests();
      expect(await gotoTarget(await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false }))).toBe(
        "Real.cs",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a namespace alias's dependency edge but names no type through it after an incomplete scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-incomplete-scan-"));
    try {
      await writeAliasScanProject(root);
      const files = ["Box.cs", "Unparsed.cs", "Main.cs"].map((name) => path.join(root, name));

      setNativeIndexingFailureFor("CSHARP_ALIAS_SCAN_FAILURE", "forced C# alias scan indexing failure");
      const failed = await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false });
      expect(await aliasScanConsumers(failed, root)).toEqual(aliasScanUnproven);

      __resetNativeTreeSitterBindingForTests();
      const recovered = await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false });
      expect(await aliasScanConsumers(recovered, root)).toEqual(aliasScanProven);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A failed file recovers when the failure clears or when it is edited. An incremental build keeps an unchanged
  // file's module from its snapshot, so there only an edit recovers it.
  it.each([
    ["clears", "memory"],
    ["clears", "disk"],
    ["is fixed", "memory"],
    ["is fixed", "disk"],
    ["is fixed", "incremental"],
  ] as const)("answers the same warm and cold after a failed candidate file %s (%s cache)", async (recovery, mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-recovery-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-recovery-cache-"));
    try {
      await writeAliasScanProject(root);
      const warmBuild = mode === "incremental" ? buildProjectIndexIncremental : buildProjectIndex;
      const options = {
        cache: mode === "memory" ? ("memory" as const) : ("disk" as const),
        cacheDir,
        threads: 1,
        useNativeWorkers: false,
      };
      const outcomes = async () => ({
        warm: await aliasScanConsumers(await warmBuild(root, options), root),
        cold: await aliasScanConsumers(await buildProjectIndex(root, { cache: "off", useNativeWorkers: false }), root),
      });

      setNativeIndexingFailureFor("CSHARP_ALIAS_SCAN_FAILURE", "forced C# alias scan indexing failure");
      const failed = await outcomes();
      expect(failed.cold, "while Unparsed.cs fails").toEqual(aliasScanUnproven);
      expect(failed.warm, "while Unparsed.cs fails").toEqual(failed.cold);

      // Main.cs is unchanged, so it keeps the module it cached while Unparsed.cs failed.
      if (recovery === "clears") {
        __resetNativeTreeSitterBindingForTests();
      } else {
        await writeFile(path.join(root, "Unparsed.cs"), "namespace Elsewhere; public class Hidden {}\n", "utf8");
      }
      const recovered = await outcomes();
      expect(recovered.cold, "after Unparsed.cs recovers").toEqual(aliasScanProven);
      expect(recovered.warm, "after Unparsed.cs recovers").toEqual(recovered.cold);
    } finally {
      clearMemoryCache();
      await rm(root, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("C# alias project boundary", () => {
  const manifest = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';
  const real = "namespace Real; public class Target {}\n";
  const localX = "namespace Local.X; public class Target {}\n";
  const useLines = [
    "using X = Real;",
    "class Top { X::Target aliased; }",
    "namespace Local {",
    "  class Use { X.Target dotted; void Make() { var made = new X.Target(); } }",
    "}",
  ];
  const unparsed = "// CSHARP_PROJECT_BOUNDARY_FAILURE\nnamespace Elsewhere; public class Hidden {}\n";

  /** One project: its manifest, a `Real` namespace, and a Use.cs that reaches `Real.Target` through the alias `X`. */
  const project = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({
    [`${name}/${name.toUpperCase()}.csproj`]: manifest,
    [`${name}/Real.cs`]: real,
    [`${name}/Use.cs`]: useLines.join("\n") + "\n",
    ...extra,
  });

  /** What each consumer reports for the `Target` uses in `<name>/Use.cs`, with files named relative to `root`. */
  async function useOutcome(index: ProjectIndex, root: string, name: string) {
    const relative = (file: string): string => path.relative(root, file).replace(/\\/g, "/");
    const useFile = path.join(root, name, "Use.cs");
    const goto: string[] = [];
    for (const line of [2, 4]) {
      for (const match of useLines[line - 1]!.matchAll(/Target/gu)) {
        const result = await goToDefinition(index, { file: useFile, line, column: match.index + 1 });
        goto.push(result.status === "ok" ? relative(result.definition.file) : result.status);
      }
    }
    const references = await findReferences(index, {
      file: path.join(root, name, "Real.cs"),
      line: 1,
      column: real.indexOf("Target") + 1,
    });
    const graph = await buildSymbolGraphDetailed(index);
    return {
      goto,
      references:
        references.status === "ok"
          ? references.references
              .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(useFile))
              .map((reference) => reference.range.start.line)
          : references.status,
      edges: graph.edges
        .flatMap((edge) => {
          const from = graph.nodes.get(edge.from);
          const to = graph.nodes.get(edge.to);
          const leavesUse = from && to && fileIdentityKey(from.file) === fileIdentityKey(useFile);
          return leavesUse && fileIdentityKey(to.file) !== fileIdentityKey(useFile) && from.kind !== "namespaceImport"
            ? [`${from.name} ${edge.label} ${relative(to.file)}`]
            : [];
        })
        .sort(),
    };
  }

  /** Project a has no declaration or unknown file of its own that could stand between its alias and `Real`. */
  const provenInA = {
    goto: ["a/Real.cs", "a/Real.cs", "a/Real.cs"],
    references: [2, 4, 4],
    edges: ["Make instantiates a/Real.cs", "Make uses a/Real.cs"],
  };

  it("lets only a namespace in the importer's own project shadow its alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-project-shadow-"));
    try {
      await writeFixtureFiles(root, {
        ...project("a"),
        // Project b declares `Local.X` but is not project a.
        "b/B.csproj": manifest,
        "b/LocalX.cs": localX,
        ...project("c", { "c/LocalX.cs": localX }),
      });
      const index = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false });

      expect(await useOutcome(index, root, "a")).toEqual(provenInA);
      // Project c declares `Local.X` itself: the dotted uses inside `Local` are shadowed, while `X::Target` is not.
      expect(await useOutcome(index, root, "c")).toEqual({
        goto: ["c/Real.cs", "not_found", "not_found"],
        references: [2],
        edges: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an unreadable file's declarations as unknown only within its own project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-project-unknown-"));
    try {
      setNativeIndexingFailureFor("CSHARP_PROJECT_BOUNDARY_FAILURE", "forced C# project boundary indexing failure");
      await writeFixtureFiles(root, { ...project("a"), "b/B.csproj": manifest, "b/Unparsed.cs": unparsed });
      const beside = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false });
      expect(await useOutcome(beside, root, "a")).toEqual(provenInA);

      await writeFixtureFiles(root, { "a/Unparsed.cs": unparsed });
      const within = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false });
      expect(await useOutcome(within, root, "a")).toEqual({
        goto: ["not_found", "not_found", "not_found"],
        references: [],
        edges: [],
      });
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
describe("C# alias shadowing facts", () => {
  it("collects a tree's namespace facts once and still decides from the current index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-alias-facts-"));
    const real = path.join(root, "Real.cs");
    const main = path.join(root, "Main.cs");
    const mainLines = [
      "using X = Real;",
      "namespace Local {",
      "  class Use { X.Target a; X.Target b; X.Target c; }",
      "}",
    ];
    const options = { useNativeWorkers: false, keepParsed: true };
    const collectFacts = vi.spyOn(csharpTree, "collectCsharpNamespaceFacts");
    const targets = async (index: ProjectIndex): Promise<string[]> => {
      const found: string[] = [];
      for (const match of mainLines[2]!.matchAll(/Target/gu)) {
        const result = await goToDefinition(index, { file: main, line: 3, column: match.index + 1 });
        found.push(result.status === "ok" ? path.basename(result.definition.file) : result.status);
      }
      return found;
    };
    try {
      await writeFile(real, "namespace Real; public class Target {}\n", "utf8");
      await writeFile(main, mainLines.join("\n") + "\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [real, main], options);
      expect(await targets(index)).toEqual(["Real.cs", "Real.cs", "Real.cs"]);

      // The index's own caches are warm, so only the per-use shadowing check could collect facts again.
      collectFacts.mockClear();
      expect(await targets(index)).toEqual(["Real.cs", "Real.cs", "Real.cs"]);
      expect(collectFacts.mock.calls.length).toBe(0);

      // The facts depend on the tree alone: an index that declares `Local.X` shares the tree and still sees it.
      const shadow = path.join(root, "Shadow.cs");
      await writeFile(shadow, "namespace Local.X; public class Other {}\n", "utf8");
      const shadowed = await buildProjectIndexFromFiles(root, [real, main, shadow], options);
      shadowed.parsed = index.parsed;
      expect(await targets(shadowed)).toEqual(["not_found", "not_found", "not_found"]);
      expect(await targets(index)).toEqual(["Real.cs", "Real.cs", "Real.cs"]);
    } finally {
      collectFacts.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declares a type for other files' lookups only when a bare name can bind it", () => {
    const source = [
      "namespace Local {",
      "  class Plain {}",
      "  class Both {}",
      "  class Both<T> {}",
      "  class OnlyGeneric<T> {}",
      "  struct Pair<A, B> {}",
      "  interface IBox<out T> {}",
      "  record Wrapper<T>(T Value);",
      "  delegate void Handler<T>(T value);",
      "  file class Hidden<T> {}",
      "  enum Mode { A }",
      "}",
      "class GlobalGeneric<T> {}",
      "",
    ].join("\n");
    const tree = treeForSource(source);
    const facts = collectCsharpNamespaceFacts(tree, source.length);

    // `X` never binds `X<T>`, so only a namespace or a type without type parameters can shadow a bare name.
    expect([...collectCsharpDeclaredNames(tree)].sort()).toEqual(["Local", "Local.Both", "Local.Mode", "Local.Plain"]);
    expect(facts.symbolsByNamespace.get("Local")).toEqual(new Set(["Plain", "Both", "Mode"]));
    expect(facts.fileLocalTypes.size).toBe(0);
    // A generic type outside every namespace still makes its file a global-namespace peer.
    expect(facts.hasGlobalType).toBe(true);
  });
});
