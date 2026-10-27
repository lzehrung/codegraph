import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../src/index.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import type { BuildReport, ProjectIndex } from "../src/indexer/types.js";
import { supportById } from "../src/languages.js";
import type { SyntaxTreeLike } from "../src/languages/types.js";
import { loadBinding } from "../src/native/runtime.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import {
  MAX_UNREAD_CHARS,
  MAX_UNREAD_PARSES,
  collectJvmFileFacts,
  collectJvmImportDirectives,
  isJvmFileFacts,
  jvmPackageName,
} from "../src/util/jvm-tree.js";
import { parseSyntaxTree, type JvmLanguageId } from "../src/util/syntax-tree.js";

function treeFor(languageId: JvmLanguageId, source: string): SyntaxTreeLike {
  const tree = parseSyntaxTree(source, supportById(languageId)!).tree;
  if (!tree) throw new Error(`Expected a ${languageId} syntax tree`);
  return tree;
}

/** Records every source the addon parses into a standalone tree, so a test can tell which files were parsed again. */
function recordStandaloneTreeParses(): string[] {
  const state = loadBinding();
  if (!state.loaded || !state.binding.parseSyntaxTree) throw new Error("Native addon required for JVM tree tests");
  const parseSyntaxTree = state.binding.parseSyntaxTree;
  const sources: string[] = [];
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: (source, languageId) => {
        sources.push(source);
        return parseSyntaxTree(source, languageId);
      },
    },
  });
  return sources;
}

afterEach(() => {
  __resetNativeTreeSitterBindingForTests();
});

describe("JVM package clause", () => {
  it("reads a Java clause as written and ignores package text that is not a clause", () => {
    const cases: Array<[string, string | null]> = [
      ["package a.b;\nclass A {}\n", "a.b"],
      ["package a . b ;\nclass A {}\n", "a.b"],
      ["// package fake;\n/* package fake2; */\npackage real.pkg;\n", "real.pkg"],
      ["@Deprecated\npackage annotated;\n", "annotated"],
      ["class A {}\n", null],
      ['class A { String s = "package decoy;"; }\n', null],
      ['class A { String t = """\n  package decoy;\n  """; }\n', null],
    ];
    for (const [source, expected] of cases) {
      expect(jvmPackageName(treeFor("java", source), "java"), source).toBe(expected);
    }
  });

  it("reads a Kotlin clause as written and ignores package text that is not a clause", () => {
    const cases: Array<[string, string | null]> = [
      ["package a.b\nclass A\n", "a.b"],
      ["package a . b\nclass A\n", "a.b"],
      ['@file:Suppress("unused")\npackage a.b;\nclass A\n', "a.b"],
      ["// package fake\n/* package fake2 */\npackage real.pkg\n", "real.pkg"],
      ["class A\n", null],
      ['val s = "package decoy"\n', null],
      ['val raw = """\npackage decoy\n"""\n', null],
    ];
    for (const [source, expected] of cases) {
      expect(jvmPackageName(treeFor("kotlin", source), "kotlin"), source).toBe(expected);
    }
  });
});

describe("JVM top-level declarations", () => {
  it("lists the top-level types a Java file declares, not nested, commented, or quoted ones", () => {
    const source = [
      "package p;",
      "// class InLine {}",
      "/* interface InBlock {} */",
      "public class Top {",
      "  class Nested {}",
      '  String text = "class InString {}";',
      "  int method() { return 1; }",
      "}",
      "interface Iface {}",
      "enum En { A, B }",
      "record Rec(int x) {}",
      "@interface Ann {}",
      "",
    ].join("\n");

    expect(collectJvmFileFacts(treeFor("java", source), "java")).toEqual({
      packageName: "p",
      symbols: ["Top", "Iface", "En", "Rec", "Ann"],
    });
  });

  it("lists the top-level names a Kotlin file declares and the ones Java can import", () => {
    const source = [
      "package p",
      "// class InLine",
      "class Top {",
      "  class Nested {}",
      "  fun member() = 1",
      "}",
      "object Obj",
      "interface Iface",
      "enum class En { A }",
      "typealias Alias = Top",
      "fun topFun() {",
      "  class Local {}",
      "}",
      'val text = "class InString"',
      "val property = 1",
      "",
    ].join("\n");

    const facts = collectJvmFileFacts(treeFor("kotlin", source), "kotlin");

    expect(facts.packageName).toBe("p");
    expect(facts.symbols).toEqual(["Top", "Obj", "Iface", "En", "Alias", "topFun"]);
    // A Java import can name a Kotlin class, object, or interface, but not an alias or a function.
    expect(facts.javaTypes).toEqual(["Top", "Obj", "Iface", "En"]);
  });

  it("names a Kotlin extension function after its receiver type, but not a function type or type parameters", () => {
    const source = [
      "package p",
      "fun String.shout() {}",
      'fun String?.orEmpty2() = this ?: ""',
      "fun List<String>.firstOrNone() = firstOrNull()",
      "fun a.b.Qualified.bar() {}",
      "fun (() -> Unit).runTwice() {}",
      "fun ((Int) -> Int).twice(): Int = 0",
      "fun <T> Set<T>.second(): T = first()",
      "fun plain() {}",
      "",
    ].join("\n");

    // The receiver type names the function, as it always has; a parenthesized receiver and a function with type
    // parameters name nothing, so `Unit`, `Int`, `Set`, and `T` stay undeclared.
    expect(collectJvmFileFacts(treeFor("kotlin", source), "kotlin").symbols).toEqual(["String", "List", "a", "plain"]);
  });

  it("accepts the facts it produces and rejects a malformed persisted row", () => {
    expect(isJvmFileFacts(collectJvmFileFacts(treeFor("kotlin", "package p\nclass A\n"), "kotlin"))).toBe(true);
    expect(isJvmFileFacts({ packageName: null, symbols: [] })).toBe(true);
    const malformed: unknown[] = [
      null,
      "p",
      {},
      { packageName: 1, symbols: [] },
      { packageName: null, symbols: [1] },
      { packageName: null, symbols: [], javaTypes: "A" },
    ];
    for (const value of malformed) expect(isJvmFileFacts(value), JSON.stringify(value)).toBe(false);
  });
});

describe("JVM facts after a syntax error", () => {
  /** Whether the tree has an ERROR node at its top, as the pinned Kotlin grammar gives two one-line class bodies. */
  function hasTopLevelError(tree: SyntaxTreeLike): boolean {
    const root = tree.rootNode;
    return root.type === "ERROR" || root.namedChildren.some((node) => node.type === "ERROR");
  }

  it("reads the declarations an ERROR left out of the tree, and none of the members of their bodies", () => {
    const source = [
      "package com.acme.handlers",
      "",
      "class Early",
      "",
      "fun interface Handler { fun handle(x: Int): Int }",
      "",
      "class DefaultHandler : Handler { override fun handle(x: Int) = x }",
      "object Registry { fun all(): List<Handler> = listOf() }",
      "fun createHandler(): Handler = Handler { it }",
      "typealias HandlerAlias = Handler",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    const facts = collectJvmFileFacts(tree, "kotlin");

    // `handle` and `all` are members of the swallowed bodies.
    expect(facts.symbols).toEqual(["Early", "Handler", "DefaultHandler", "Registry", "createHandler", "HandlerAlias"]);
    expect(facts.javaTypes).toEqual(["Early", "Handler", "DefaultHandler", "Registry"]);
  });

  it("counts a declaration an ERROR holds outside braces as top-level, and the text after it", () => {
    const source = [
      "package p",
      "fun consume(): Int {",
      "  return }x()",
      "}",
      "class After { fun member() {} }",
      "object Obj",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.symbols).toEqual(["consume", "After", "Obj"]);
    expect(facts.javaTypes).toEqual(["After", "Obj"]);
  });

  it("reads the declarations after a stray token, without the members of their bodies", () => {
    const source = ["package p", "class Before", ")", "class After { fun m() {} }", "fun later() {}", ""].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.symbols).toEqual(["Before", "After", "later"]);
    expect(facts.javaTypes).toEqual(["Before", "After"]);
  });

  it("never declares the members of one-line bodies, whichever follow the first one", () => {
    const source = [
      "package p",
      "class Outer { fun member() {} }",
      "class Second { fun other() {} }",
      "class Third { val x = 1 }",
      "val topLevelProperty = 1",
      "fun top() {}",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    expect(collectJvmFileFacts(tree, "kotlin").symbols).toEqual(["Outer", "Second", "Third", "top"]);
  });

  it("reads nothing from text that begins inside a brace the ERROR leaves open", () => {
    // The grammar fails at the second member of the first body, so the text after the ERROR is still inside that
    // body. Its members stay undeclared, and so do the declarations after it: a miss, never a member as top-level.
    const source = [
      "package p",
      "class Outer { fun member() {} val prop = 1 }",
      "class Impl : Base { override fun member() {} fun created() {} }",
      "typealias Alias = Outer",
      "fun top() {}",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    expect(collectJvmFileFacts(tree, "kotlin").symbols).toEqual([]);
  });

  it("stops after the parse limit and keeps the names read so far, in source order", () => {
    const names = Array.from({ length: MAX_UNREAD_PARSES }, (_, index) => `C${index}`);
    // Each stray `)` ends the tree again, so every declaration costs two parses.
    const source = ["package p", ...names.flatMap((name) => [`class ${name}`, ")"]), ""].join("\n");
    const tree = treeFor("kotlin", source);
    const parsed = recordStandaloneTreeParses();

    const { symbols } = collectJvmFileFacts(tree, "kotlin");

    expect(parsed).toHaveLength(MAX_UNREAD_PARSES);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.length).toBeLessThan(names.length);
    expect(symbols).toEqual(names.slice(0, symbols.length));
  });

  it("does not read again a part longer than the character limit", () => {
    const source = ["package p", "class Before", ")", "class After", "", "\n".repeat(MAX_UNREAD_CHARS)].join("\n");
    const tree = treeFor("kotlin", source);
    const parsed = recordStandaloneTreeParses();

    expect(collectJvmFileFacts(tree, "kotlin").symbols).toEqual(["Before"]);
    expect(parsed.every((text) => text.length <= MAX_UNREAD_CHARS)).toBe(true);
  });

  it("parses nothing again for a tree without an ERROR", () => {
    const tree = treeFor("kotlin", "package p\nclass A { fun a() {} }\nfun b() {}\n");
    const parsed = recordStandaloneTreeParses();

    expect(collectJvmFileFacts(tree, "kotlin").symbols).toEqual(["A", "b"]);
    expect(parsed).toEqual([]);
  });
});

describe("JVM import directives", () => {
  it("reads Java imports with their static and wildcard forms, skipping imports that are not statements", () => {
    const source = [
      "package p;",
      "// import fake.One;",
      "import a.b.C;",
      "import static a.b.C.d;",
      "import static a.b.C.*;",
      "import a.b.*;",
      "import a . /* c */ b.D;",
      "import X;",
      'class A { String s = "import fake.Two;"; }',
      "",
    ].join("\n");

    const directives = collectJvmImportDirectives(treeFor("java", source), "java").map((directive) => ({
      name: directive.name,
      leaf: directive.leaf.text,
      isStatic: directive.isStatic,
      wildcard: directive.wildcard,
    }));

    expect(directives).toEqual([
      { name: "a.b.C", leaf: "C", isStatic: false, wildcard: false },
      { name: "a.b.C.d", leaf: "d", isStatic: true, wildcard: false },
      { name: "a.b.C", leaf: "C", isStatic: true, wildcard: true },
      { name: "a.b", leaf: "b", isStatic: false, wildcard: true },
      { name: "a.b.D", leaf: "D", isStatic: false, wildcard: false },
      { name: "X", leaf: "X", isStatic: false, wildcard: false },
    ]);
  });

  it("reads Kotlin imports with their alias and wildcard forms, skipping imports that are not statements", () => {
    const source = [
      "package p",
      "// import fake.One",
      "import a.b.C",
      "import a.b.C as D",
      "import a.b.*",
      "import a . b . /* c */ E",
      'val raw = """',
      "import fake.Two",
      '"""',
      "",
    ].join("\n");

    const directives = collectJvmImportDirectives(treeFor("kotlin", source), "kotlin").map((directive) => ({
      name: directive.name,
      leaf: directive.leaf.text,
      alias: directive.alias?.text,
      wildcard: directive.wildcard,
    }));

    expect(directives).toEqual([
      { name: "a.b.C", leaf: "C", alias: undefined, wildcard: false },
      { name: "a.b.C", leaf: "C", alias: "D", wildcard: false },
      { name: "a.b", leaf: "b", alias: undefined, wildcard: true },
      { name: "a.b.E", leaf: "E", alias: undefined, wildcard: false },
    ]);
  });
});

describe("JVM package scan after a touched-file build", () => {
  type Build = (root: string, files: string[], options: object) => Promise<ProjectIndex>;
  // `reads` is how often an unchanged file may be parsed. Without a manifest (`files`), a reused file's edges are
  // collected from its source once; the package scan must never parse it as well.
  const builds: Array<{ mode: string; build: Build; reads: number }> = [
    { mode: "files", build: (root, files, options) => buildProjectIndexFromFiles(root, files, options), reads: 1 },
    { mode: "full", build: (root, _files, options) => buildProjectIndex(root, options), reads: 0 },
    { mode: "incremental", build: (root, _files, options) => buildProjectIndexIncremental(root, options), reads: 0 },
  ];
  for (const { mode, build, reads } of builds) {
    it(`parses no unchanged file for the package scan (${mode} build)`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-touched-scan-"));
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-touched-scan-cache-"));
      try {
        const sources: Record<string, string> = {
          "q/Edited.java": "package q;\npublic class Edited {}\n",
          "q/Stable.java": "package q;\npublic class Stable {}\n",
          "k/Stable.kt": "package k\nclass StableKt\n",
          // Each imports whole packages, so a changed JVM file makes the build scan the packages of the project.
          "app/UseJava.java": "package app;\nimport q.*;\nimport k.*;\nclass UseJava {}\n",
          "app/UseKotlin.kt": "package app\nimport q.*\nimport k.*\nclass UseKotlin\n",
        };
        const files: string[] = [];
        for (const [name, contents] of Object.entries(sources)) {
          const file = path.join(root, name);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, contents, "utf8");
          files.push(file);
        }
        const options = { cache: "disk" as const, cacheDir, threads: 1, useNativeWorkers: false };
        await build(root, files, options);
        clearMemoryCache();

        await writeFile(path.join(root, "q/Edited.java"), "package q;\npublic class EditedRenamed {}\n", "utf8");
        const parsed = recordStandaloneTreeParses();
        const report: BuildReport = { timings: {} };
        const index = await build(root, files, { ...options, report });

        // Only the touched file is parsed for the package scan: every other file's package comes from the module the
        // cache holds.
        const parsesOf = new Map<string, number>();
        for (const source of parsed) parsesOf.set(source, (parsesOf.get(source) ?? 0) + 1);
        for (const [source, count] of parsesOf) {
          if (source.includes("class EditedRenamed")) continue;
          expect(count, source).toBeLessThanOrEqual(reads);
        }
        expect(report.files?.cached ?? 0).toBeGreaterThan(0);
        // The touched file's stored facts describe its new source, not the cached one.
        const edited = [...index.byFile.values()].find((module) => module.file.endsWith("q/Edited.java"));
        expect(edited?.jvmFacts).toEqual({ packageName: "q", symbols: ["EditedRenamed"] });
      } finally {
        clearMemoryCache();
        await rm(root, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
      }
    });
  }
});
