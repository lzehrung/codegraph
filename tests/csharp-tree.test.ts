import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
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
