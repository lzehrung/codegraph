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
  collectJvmFileFacts,
  collectJvmImportDirectives,
  isJvmFileFacts,
  jvmPackageName,
} from "../src/util/jvm-tree.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
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

  it("names a Kotlin function by its own name, whatever its receiver or type parameters, and never by a receiver type", () => {
    const source = [
      "package p",
      "fun String.shout() {}",
      'fun String?.orEmpty2() = this ?: ""',
      "fun List<String>.firstOrNone() = firstOrNull()",
      "fun a.b.Qualified.bar() {}",
      "fun (() -> Unit).runTwice() {}",
      "fun ((Int) -> Int).twice(): Int = 0",
      "fun <T> Set<T>.second(): T = first()",
      "fun <T> gen(x: T) {}",
      "inline fun <reified T> typed() {}",
      "operator fun String.plus(x: Int) = this",
      "fun `back tick`() {}",
      "fun plain() {}",
      "",
    ].join("\n");

    const facts = collectJvmFileFacts(treeFor("kotlin", source), "kotlin");

    // Receiver types (`String`, `List`, `a`, `Set`, `Unit`, `Int`) and type parameters (`T`) are not declared here.
    expect(facts.symbols).toEqual([
      "shout",
      "orEmpty2",
      "firstOrNone",
      "bar",
      "runTwice",
      "twice",
      "second",
      "gen",
      "typed",
      "plus",
      "`back tick`",
      "plain",
    ]);
    // A Java import names classes, objects, and interfaces, never a function.
    expect(facts.javaTypes).toEqual([]);
  });

  it("accepts the facts it produces and rejects a malformed persisted row", () => {
    expect(isJvmFileFacts(collectJvmFileFacts(treeFor("kotlin", "package p\nclass A\n"), "kotlin"))).toBe(true);
    expect(isJvmFileFacts({ packageName: null, symbols: [] })).toBe(true);
    expect(isJvmFileFacts({ packageName: "p", symbols: ["A"], incomplete: true })).toBe(true);
    const malformed: unknown[] = [
      null,
      "p",
      {},
      { packageName: 1, symbols: [] },
      { packageName: null, symbols: [1] },
      { packageName: null, symbols: [], javaTypes: "A" },
      // The flag only ever says "unread declarations"; a persisted row cannot claim anything else.
      { packageName: null, symbols: [], incomplete: false },
      { packageName: null, symbols: [], incomplete: "yes" },
    ];
    for (const value of malformed) expect(isJvmFileFacts(value), JSON.stringify(value)).toBe(false);
  });
});

describe("JVM facts and Kotlin syntax errors", () => {
  /** Whether the tree has an ERROR node at its top, as the pinned Kotlin grammar gives a few forms it cannot read. */
  function hasTopLevelError(tree: SyntaxTreeLike): boolean {
    const root = tree.rootNode;
    return root.type === "ERROR" || root.namedChildren.some((node) => node.type === "ERROR");
  }

  it("declares every top-level name of a file with one-line class bodies, and no member of those bodies", () => {
    const source = [
      "package p",
      "class Outer { fun member() {} }",
      "class Second { fun other() {} }",
      "class Third { val x = 1 }",
      "class Many { val a = 1; val b = 2 }",
      "interface Base { fun p() }",
      "fun interface Handler { fun handle(x: Int): Int }",
      "class Impl : Handler { override fun handle(x: Int) = x }",
      "object Registry { fun all(): List<Handler> = listOf() }",
      "enum class Color { RED, GREEN }",
      "typealias Alias = Outer",
      "val topLevelProperty = 1",
      "fun top() {}",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar fails on one-line class bodies").toBe(false);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.symbols).toEqual([
      "Outer",
      "Second",
      "Third",
      "Many",
      "Base",
      "Handler",
      "Impl",
      "Registry",
      "Color",
      "Alias",
      "top",
    ]);
    expect(facts.javaTypes).toEqual([
      "Outer",
      "Second",
      "Third",
      "Many",
      "Base",
      "Handler",
      "Impl",
      "Registry",
      "Color",
    ]);
  });

  it("declares the name under an annotation, and no declaration inside a body", () => {
    const source = [
      "package p",
      "@Target(AnnotationTarget.CLASS)",
      "annotation class Marker",
      '@Deprecated("old")',
      "fun legacy() {}",
      '@Suppress("UNCHECKED_CAST") @JvmInline',
      "value class Wrapper(val raw: Int)",
      "@PublishedApi",
      "internal fun helper() {}",
      "@Component",
      "@Transactional",
      "class Service { fun find() = 1 }",
      '@Deprecated("x")',
      "typealias Alias = Service",
      "fun top() {",
      '  @Suppress("x") val local = 1',
      "  class Local",
      "}",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar fails on annotated declarations").toBe(false);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.symbols).toEqual(["Marker", "legacy", "Wrapper", "helper", "Service", "Alias", "top"]);
    expect(facts.javaTypes).toEqual(["Marker", "Wrapper", "Service"]);
  });

  it("declares no member of a class the grammar fails inside, and none of the text after the failure", () => {
    // The pinned grammar reads no identifier written with CJK ideographs, so a variable named with them ends the tree
    // in an ERROR. The answer is a miss: neither the class nor its members (`read`, `update`) nor `After` become
    // top-level names.
    const source = [
      "package p",
      "class Reader : Source {",
      "  fun read(): Long {",
      "    var \u540d\u524d = false",
      "    while (!\u540d\u524d) {",
      "      if (ready()) {",
      "        \u540d\u524d = true",
      "      }",
      "    }",
      "    return 0",
      "  }",
      "  private fun update() {}",
      "}",
      "class After",
      "",
    ].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.packageName).toBe("p");
    expect(facts.symbols).toEqual([]);
    expect(facts.javaTypes).toEqual([]);
  });

  it("counts a declaration an ERROR holds outside braces as top-level, and nothing the ERROR swallowed", () => {
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

    expect(facts.symbols).toEqual(["consume"]);
    expect(facts.javaTypes).toEqual([]);
  });

  it("keeps the declarations before a stray token and reads none after it", () => {
    const source = ["package p", "class Before", ")", "class After { fun m() {} }", "fun later() {}", ""].join("\n");
    const tree = treeFor("kotlin", source);
    expect(hasTopLevelError(tree), "the pinned grammar no longer fails on this source").toBe(true);

    const facts = collectJvmFileFacts(tree, "kotlin");

    expect(facts.symbols).toEqual(["Before"]);
    expect(facts.javaTypes).toEqual(["Before"]);
  });

  it("records that a syntax error at the top of a file left declarations unread, and only then", () => {
    // Declarations the error swallowed are not in `symbols`, so the facts must say the list may be short.
    const kotlin = treeFor("kotlin", "package p\nclass Before\n)\nfun select(x: String) = x\n");
    expect(hasTopLevelError(kotlin), "the pinned Kotlin grammar no longer fails on this source").toBe(true);
    expect(collectJvmFileFacts(kotlin, "kotlin")).toEqual({
      packageName: "p",
      symbols: ["Before"],
      javaTypes: ["Before"],
      incomplete: true,
    });

    // The Java grammar reads `After` here, but a stray token can as well swallow a class (`@@@ !!` leaves `After` as
    // a block), so a file with an error is unproven either way.
    const java = treeFor("java", "package p;\nclass Before {}\n@@@ !!\nclass After {}\n");
    expect(hasTopLevelError(java), "the pinned Java grammar no longer fails on this source").toBe(true);
    expect(collectJvmFileFacts(java, "java")).toEqual({ packageName: "p", symbols: ["Before"], incomplete: true });

    // A file the grammar reads in full is complete, and so is one whose error sits inside a body.
    const clean = collectJvmFileFacts(treeFor("kotlin", "package p\nclass A\nfun f() {}\n"), "kotlin");
    expect(clean.incomplete).toBeUndefined();
    const nested = treeFor("kotlin", "package p\nclass A { fun f() { val x = ) } }\nclass B\n");
    expect(hasTopLevelError(nested), "the error must stay inside the class body").toBe(false);
    expect(collectJvmFileFacts(nested, "kotlin")).toEqual({
      packageName: "p",
      symbols: ["A", "B"],
      javaTypes: ["A", "B"],
    });
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

describe("JVM importers while a package file has no readable syntax tree", () => {
  /** Fails native parsing and extraction for sources containing `marker`, so that file indexes without a tree. */
  function setNativeIndexingFailureFor(marker: string): void {
    const state = loadBinding();
    if (!state.loaded || !state.binding.parseSyntaxTree) throw new Error("Native addon required for JVM tree tests");
    const { parseSyntaxTree, extractLanguage } = state.binding;
    __setNativeTreeSitterBindingForTests({
      ...state,
      binding: {
        ...state.binding,
        parseSyntaxTree: (source, languageId) => {
          if (source.includes(marker)) throw new Error("forced JVM parse failure");
          return parseSyntaxTree(source, languageId);
        },
        extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
          if (source.includes(marker)) throw new Error("forced JVM extraction failure");
          return extractLanguage(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
        },
      },
    });
  }

  it("extracts an importer again once a package file whose tree failed reads again (memory cache)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-lookup-recovery-"));
    try {
      const marker = "// JVM_PACKAGE_FILE_UNREADABLE";
      // The marker is past the 64 KiB head that is parsed for the package clause, so Big.kt keeps its package while
      // its declarations are unknown.
      const sources: Record<string, string> = {
        "p/Small.kt": "package p\n\nfun select(x: Int) = x\n",
        "p/Big.kt": `package p\n\nclass Unrelated\n${"// padding\n".repeat(7000)}${marker}\n`,
        "app/Use.kt": "package app\n\nimport p.select\n\nclass Use\n",
      };
      for (const [name, contents] of Object.entries(sources)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), contents, "utf8");
      }
      const options = { cache: "memory" as const, threads: 1, useNativeWorkers: false };
      const useKey = fileIdentityKey(normalizePath(path.join(root, "app/Use.kt")));

      setNativeIndexingFailureFor(marker);
      const failed = await buildProjectIndex(root, options);
      const failedUse = failed.byFile.get(useKey);
      // Big.kt may overload `select`, so the import is unproven and the importer is marked.
      expect(failedUse).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      expect(failedUse?.imports[0]?.resolved).toEqual({ external: "p.select" });

      // Use.kt, Small.kt, and the cache are unchanged, but Big.kt reads now and declares no `select`.
      __resetNativeTreeSitterBindingForTests();
      const recovered = await buildProjectIndex(root, options);
      const recoveredUse = recovered.byFile.get(useKey);
      expect(recoveredUse?.parserDegraded).toBeUndefined();
      expect(recoveredUse?.importLookupIncomplete).toBeUndefined();
      expect(path.basename(String(recoveredUse?.imports[0]?.resolved))).toBe("Small.kt");
    } finally {
      clearMemoryCache();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JVM importers beside a package file with a syntax error", () => {
  // The error leaves `select(String)` unread, so Gap.kt may overload what Peer.kt declares. `Before` was read first.
  const sources: Record<string, string> = {
    "p/Gap.kt": "package com.acme.p\n\nclass Before\n)\nfun select(x: String) = x\n",
    "p/Peer.kt": "package com.acme.p\n\nfun select(x: Int) = x\n",
    "app/UseSelect.kt": "package com.acme.app\n\nimport com.acme.p.select\n",
    "app/UseBefore.kt": "package com.acme.app\n\nimport com.acme.p.Before\n",
  };
  const expected = { UseSelect: "external (incomplete)", UseBefore: "Gap.kt" };

  async function writeProject(root: string): Promise<void> {
    for (const [name, contents] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), contents, "utf8");
    }
  }

  /** What each importer binds, and whether its module is marked incomplete. */
  function outcomes(index: ProjectIndex, root: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of ["UseSelect", "UseBefore"]) {
      const module = index.byFile.get(fileIdentityKey(normalizePath(path.join(root, `app/${name}.kt`))));
      const resolved = module?.imports[0]?.resolved;
      const target = typeof resolved === "string" ? path.basename(resolved) : "external";
      result[name] = `${target}${module?.importLookupIncomplete ? " (incomplete)" : ""}`;
    }
    return result;
  }

  it("gives the same answer from a cold build, a warm disk build, and a build from the project snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-error-file-cache-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-error-file-cache-dir-"));
    try {
      await writeProject(root);
      const options = { cache: "disk" as const, cacheDir, threads: 1, useNativeWorkers: false };

      const cold = await buildProjectIndex(root, options);
      expect(cold.byFile.get(fileIdentityKey(normalizePath(path.join(root, "p/Gap.kt"))))?.jvmFacts).toEqual({
        packageName: "com.acme.p",
        symbols: ["Before"],
        javaTypes: ["Before"],
        incomplete: true,
      });
      expect(outcomes(cold, root)).toEqual(expected);

      // Every module comes from the disk cache; Gap.kt's facts, with their flag, are what the package scan reads.
      clearMemoryCache();
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndex(root, { ...options, report });
      expect(report.files?.cached ?? 0).toBeGreaterThan(0);
      expect(outcomes(warm, root)).toEqual(expected);

      clearMemoryCache();
      expect(outcomes(await buildProjectIndexIncremental(root, options), root)).toEqual(expected);
    } finally {
      clearMemoryCache();
      await rm(root, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("reads the file's own tree for the package scan when no module holds its facts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-jvm-error-file-fresh-"));
    try {
      await writeProject(root);
      // Discovery ignores Gap.kt, so no module covers it, but the package scan still parses it.
      const index = await buildProjectIndex(root, {
        cache: "memory",
        threads: 1,
        useNativeWorkers: false,
        discovery: { ignoreGlobs: ["p/Gap.kt"], globRoot: root },
      });
      expect(index.byFile.has(fileIdentityKey(normalizePath(path.join(root, "p/Gap.kt"))))).toBe(false);
      expect(outcomes(index, root).UseSelect).toBe(expected.UseSelect);
    } finally {
      clearMemoryCache();
      await rm(root, { recursive: true, force: true });
    }
  });
});
