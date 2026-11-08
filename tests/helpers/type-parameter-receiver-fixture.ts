import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";
import { clearMemoryCache } from "../../src/indexer/build-cache.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache/module-cache.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";
import type { MatrixCell } from "../call-form-matrix/types.js";

/** A call through a receiver typed by `T`: either the class `T` (a member is expected) or a type parameter `T` (none). */
export type TypeParameterReceiverSite = {
  /** 1-based line in the row's `use` file. */
  line: number;
  /** Member name; its column is located on `line`. */
  token: string;
  /** Enclosing callable, named in the detailed graph. */
  caller: string;
  /** True when the receiver is the class `T`, so the member declared on it must be the target. */
  resolves: boolean;
};

export type TypeParameterReceiverLanguage =
  | "kotlin"
  | "csharp"
  | "go"
  | "java"
  | "ts"
  | "tsx"
  | "rust"
  | "swift"
  | "python"
  | "cpp";

/**
 * A class `T` declaring a member, a same-named generic type parameter in the same compilation unit, and a bounded
 * interface decoy that declares the same member. A receiver typed by the type parameter never proves the class, while
 * a receiver built outside the generic scope still does.
 */
export type TypeParameterReceiverRow = {
  language: TypeParameterReceiverLanguage;
  /** Short description for the test title. */
  form: string;
  files: Readonly<Record<string, string>>;
  /** File holding the call sites. */
  use: string;
  /** Declaration of the member on the class `T`. */
  declaration: { file: string; line: number; token: string };
  sites: readonly TypeParameterReceiverSite[];
};

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const CSHARP_USE = [
  "class M {",
  "  void Constructed<T>() where T : I, new() { var t = new T(); t.Hello(); }",
  "  void Bounded<T>(T x) where T : I { x.Hello(); }",
  "  void Use() { var t = new T(); t.Hello(); }",
  "}",
];

const GO_USE = [
  "func Bounded[T I](x T) {",
  "\tvar t T",
  "\tt.Hello()",
  "\tx.Hello()",
  "}",
  "",
  "func Use() {",
  "\tvar t T",
  "\tt.Hello()",
  "}",
];

const CPP_STRUCT = "struct Widget { int hello() { return 1; } };";

/** C++ template forms beside a class of the same name; `use` builds the class outside every template. */
function cppRow(form: string, template: string, templateSite: boolean, classFirst = true): TypeParameterReceiverRow {
  const use = "void use() { Widget w; w.hello(); }";
  const rows = classFirst ? [CPP_STRUCT, template, use] : [template, CPP_STRUCT, use];
  const declarationLine = classFirst ? 1 : 2;
  const templateLine = classFirst ? 2 : 1;
  return {
    language: "cpp",
    form,
    files: { "a.cpp": lines(...rows) },
    use: "a.cpp",
    declaration: { file: "a.cpp", line: declarationLine, token: "hello" },
    sites: [
      ...(templateSite ? [{ line: templateLine, token: "hello", caller: "generic", resolves: false }] : []),
      { line: 3, token: "hello", caller: "use", resolves: true },
    ],
  };
}

export const TYPE_PARAMETER_RECEIVER_ROWS: readonly TypeParameterReceiverRow[] = [
  {
    language: "kotlin",
    form: "imported class",
    files: {
      "lib/T.kt": "package lib\nclass T { fun hello() = 1 }\ninterface I { fun hello(): Int }\n",
      "Main.kt": lines(
        "import lib.I",
        "import lib.T",
        "",
        "fun <T> unused(x: T) = x",
        "fun <T : I> bounded(x: T) { x.hello() }",
        "fun <T : I> declared(x: T) { val y: T = x; y.hello() }",
        "fun use() { val t = T(); t.hello() }",
      ),
    },
    use: "Main.kt",
    declaration: { file: "lib/T.kt", line: 2, token: "hello" },
    sites: [
      { line: 5, token: "hello", caller: "bounded", resolves: false },
      { line: 6, token: "hello", caller: "declared", resolves: false },
      { line: 7, token: "hello", caller: "use", resolves: true },
    ],
  },
  {
    language: "kotlin",
    form: "same file with class-level parameter",
    files: {
      "Main.kt": lines(
        "interface I { fun hello(): Int }",
        "class T { fun hello() = 1 }",
        "fun <T : I> bounded(x: T) { x.hello() }",
        "fun <T : I> declared(x: T) { val y: T = x; y.hello() }",
        "fun use() { val t = T(); t.hello() }",
        "class Box<T : I> { fun m(y: T) { y.hello() } }",
      ),
    },
    use: "Main.kt",
    declaration: { file: "Main.kt", line: 2, token: "hello" },
    sites: [
      { line: 3, token: "hello", caller: "bounded", resolves: false },
      { line: 4, token: "hello", caller: "declared", resolves: false },
      { line: 5, token: "hello", caller: "use", resolves: true },
      { line: 6, token: "hello", caller: "m", resolves: false },
    ],
  },
  {
    language: "csharp",
    form: "peer file",
    files: {
      "T.cs": "class T { public int Hello() => 1; }\n",
      "I.cs": "interface I { int Hello(); }\n",
      "Main.cs": lines(...CSHARP_USE),
    },
    use: "Main.cs",
    declaration: { file: "T.cs", line: 1, token: "Hello" },
    sites: [
      { line: 2, token: "Hello", caller: "Constructed", resolves: false },
      { line: 3, token: "Hello", caller: "Bounded", resolves: false },
      { line: 4, token: "Hello", caller: "Use", resolves: true },
    ],
  },
  {
    language: "csharp",
    form: "same file",
    files: {
      "Main.cs": lines("interface I { int Hello(); }", "class T { public int Hello() => 1; }", ...CSHARP_USE),
    },
    use: "Main.cs",
    declaration: { file: "Main.cs", line: 2, token: "Hello" },
    sites: [
      { line: 4, token: "Hello", caller: "Constructed", resolves: false },
      { line: 5, token: "Hello", caller: "Bounded", resolves: false },
      { line: 6, token: "Hello", caller: "Use", resolves: true },
    ],
  },
  {
    language: "go",
    form: "peer file",
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "t.go": lines(
        "package main",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        "type I interface{ Hello() int }",
      ),
      "main.go": lines("package main", "", ...GO_USE),
    },
    use: "main.go",
    declaration: { file: "t.go", line: 5, token: "Hello" },
    sites: [
      { line: 5, token: "Hello", caller: "Bounded", resolves: false },
      { line: 6, token: "Hello", caller: "Bounded", resolves: false },
      { line: 11, token: "Hello", caller: "Use", resolves: true },
    ],
  },
  {
    language: "go",
    form: "same file",
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "main.go": lines(
        "package main",
        "",
        "type I interface{ Hello() int }",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        ...GO_USE,
      ),
    },
    use: "main.go",
    declaration: { file: "main.go", line: 7, token: "Hello" },
    sites: [
      { line: 11, token: "Hello", caller: "Bounded", resolves: false },
      { line: 12, token: "Hello", caller: "Bounded", resolves: false },
      { line: 17, token: "Hello", caller: "Use", resolves: true },
    ],
  },
  {
    language: "go",
    form: "receiver type parameter and shared constraint",
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "main.go": lines(
        "package main",
        "",
        "type I interface{ Hello() int }",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        "type Box[T I] struct{}",
        "",
        "func (b Box[T]) Method(x T) {",
        "\tx.Hello()",
        "}",
        "",
        "func Shared[K, T I](k K, t T) {",
        "\tt.Hello()",
        "}",
        "",
        "func Use() {",
        "\tvar t T",
        "\tt.Hello()",
        "}",
      ),
    },
    use: "main.go",
    declaration: { file: "main.go", line: 7, token: "Hello" },
    sites: [
      { line: 12, token: "Hello", caller: "Method", resolves: false },
      { line: 16, token: "Hello", caller: "Shared", resolves: false },
      { line: 21, token: "Hello", caller: "Use", resolves: true },
    ],
  },
  {
    language: "java",
    form: "class and method parameters",
    files: {
      "p/I.java": "package p;\npublic interface I { int hello(); }\n",
      "p/T.java": "package p;\npublic class T { public int hello() { return 1; } }\n",
      "p/M.java": lines(
        "package p;",
        "class M<T extends I> {",
        "  void classLevel(T x) { x.hello(); }",
        "}",
        "class N {",
        "  <T extends I> void methodLevel(T x) { x.hello(); }",
        "  void use() { T t = new T(); t.hello(); }",
        "}",
      ),
    },
    use: "p/M.java",
    declaration: { file: "p/T.java", line: 2, token: "hello" },
    sites: [
      { line: 3, token: "hello", caller: "classLevel", resolves: false },
      { line: 6, token: "hello", caller: "methodLevel", resolves: false },
      { line: 7, token: "hello", caller: "use", resolves: true },
    ],
  },
  ...(["ts", "tsx"] as const).map(
    (language): TypeParameterReceiverRow => ({
      language,
      form: "function and class parameters",
      files: {
        [`i.${language}`]: "export interface I { hello(): number }\n",
        [`t.${language}`]: "export class T { hello() { return 1; } }\n",
        [`m.${language}`]: lines(
          `import { I } from "./i";`,
          `import { T } from "./t";`,
          "export function bounded<T extends I>(x: T) { x.hello(); }",
          "export class K<T extends I> { method(x: T) { x.hello(); } }",
          "export function use() { const t = new T(); t.hello(); }",
        ),
      },
      use: `m.${language}`,
      declaration: { file: `t.${language}`, line: 1, token: "hello" },
      sites: [
        { line: 3, token: "hello", caller: "bounded", resolves: false },
        { line: 4, token: "hello", caller: "method", resolves: false },
        { line: 5, token: "hello", caller: "use", resolves: true },
      ],
    }),
  ),
  {
    language: "rust",
    form: "function and impl parameters",
    files: {
      "lib.rs": lines(
        "trait I { fn hello(&self) -> i32; }",
        "struct T;",
        "impl T { fn hello(&self) -> i32 { 1 } }",
        "fn bounded<T: I>(x: T) { x.hello(); }",
        "struct B<T>(T);",
        "impl<T: I> B<T> { fn method(&self, x: T) { x.hello(); } }",
        "fn use_it() { let t = T; t.hello(); }",
      ),
    },
    use: "lib.rs",
    declaration: { file: "lib.rs", line: 3, token: "hello" },
    sites: [
      { line: 4, token: "hello", caller: "bounded", resolves: false },
      { line: 6, token: "hello", caller: "method", resolves: false },
      { line: 7, token: "hello", caller: "use_it", resolves: true },
    ],
  },
  {
    language: "swift",
    form: "function and class parameters",
    files: {
      "a.swift": lines(
        "protocol I { func hello() -> Int }",
        "class T { func hello() -> Int { 1 } }",
        "func bounded<T: I>(x: T) { x.hello() }",
        "class Box<T: I> { func method(x: T) { x.hello() } }",
        "func use() { let t = T(); t.hello() }",
      ),
    },
    use: "a.swift",
    declaration: { file: "a.swift", line: 2, token: "hello" },
    sites: [
      { line: 3, token: "hello", caller: "bounded", resolves: false },
      { line: 4, token: "hello", caller: "method", resolves: false },
      { line: 5, token: "hello", caller: "use", resolves: true },
    ],
  },
  {
    language: "python",
    form: "PEP 695 function and class parameters",
    files: {
      "i.py": "class I:\n    def hello(self): return 0\n",
      "t.py": "class T:\n    def hello(self): return 1\n",
      "m.py": lines(
        "from i import I",
        "from t import T",
        "",
        "def bounded[T: I](x: T):",
        "    x.hello()",
        "",
        "class Box[T: I]:",
        "    def method(self, x: T):",
        "        x.hello()",
        "",
        "def use():",
        "    t = T()",
        "    t.hello()",
      ),
    },
    use: "m.py",
    declaration: { file: "t.py", line: 2, token: "hello" },
    sites: [
      { line: 5, token: "hello", caller: "bounded", resolves: false },
      { line: 9, token: "hello", caller: "method", resolves: false },
      { line: 13, token: "hello", caller: "use", resolves: true },
    ],
  },
  cppRow("function template", "template <typename Widget> void generic(Widget& w) { w.hello(); }", true),
  cppRow(
    "function template declared before the class",
    "template <typename Widget> void generic(Widget& w) { w.hello(); }",
    true,
    false,
  ),
  cppRow("class template", "template <typename Widget> struct generic { void m(Widget& w) { w.hello(); } };", true),
  cppRow("alias template", "template <typename Widget> using generic = Widget*;", false),
  cppRow("variable template", "template <typename Widget> Widget generic = Widget();", false),
  cppRow("template template parameter", "template <template <typename> class Widget> struct generic {};", false),
  {
    language: "cpp",
    form: "Allocator and Container header",
    files: {
      "a.h": lines(
        "class Allocator { public: int alloc(int n) { return n; } };",
        "class Container { public: void push(int v) {} };",
        "template <typename Allocator> void rebind(Allocator& a) { a.alloc(1); }",
        "void use() { Container c; c.push(1); Allocator al; al.alloc(1); }",
      ),
    },
    use: "a.h",
    declaration: { file: "a.h", line: 1, token: "alloc" },
    sites: [
      { line: 3, token: "alloc", caller: "rebind", resolves: false },
      { line: 4, token: "alloc", caller: "use", resolves: true },
    ],
  },
];

/** Registers one language's rows under every cache state; each language suite calls this once. */
export function describeTypeParameterReceiverRows(language: TypeParameterReceiverLanguage, title: string): void {
  const rows = TYPE_PARAMETER_RECEIVER_ROWS.filter((row) => row.language === language);
  describe(title, () => {
    for (const mode of TYPE_PARAMETER_RECEIVER_CACHE_MODES) {
      it.each(rows.map((row) => ({ row, form: row.form })))(
        `never selects the class's members through a type-parameter receiver, and keeps the class (${mode}: $form)`,
        async ({ row }) => {
          await expectTypeParameterReceiverRow(row, mode);
        },
      );
    }
  });
}

/** Cache states a consumer must agree across: no cache, a cold disk build, a warm disk reload, and the memory cache. */
export const TYPE_PARAMETER_RECEIVER_CACHE_MODES = ["off", "disk-cold", "disk-warm", "memory"] as const;
export type TypeParameterReceiverCacheMode = (typeof TYPE_PARAMETER_RECEIVER_CACHE_MODES)[number];

async function expectRowConsumers(
  index: ProjectIndex,
  row: TypeParameterReceiverRow,
  paths: Readonly<Record<string, string>>,
  scope: string,
): Promise<void> {
  const useFile = paths[row.use]!;
  const useLines = row.files[row.use]!.split("\n");
  const declarationFile = paths[row.declaration.file]!;
  const declarationLines = row.files[row.declaration.file]!.split("\n");

  for (const site of row.sites) {
    const label = `${scope}: ${row.language} ${row.use}:${site.line}`;
    const result = await goToDefinition(index, {
      file: useFile,
      line: site.line,
      column: columnOf(useLines, site.line, site.token),
    });
    if (!site.resolves) {
      expect(result.status, label).toBe("not_found");
      continue;
    }
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") throw new Error(`${label}: expected the member of class T`);
    expect(normalizePath(result.definition.file), label).toBe(declarationFile);
    expect(result.definition.range.start.line, label).toBe(row.declaration.line);
  }

  const references = await findReferences(index, {
    file: declarationFile,
    line: row.declaration.line,
    column: columnOf(declarationLines, row.declaration.line, row.declaration.token),
  });
  expect(references.status, scope).toBe("ok");
  if (references.status !== "ok") throw new Error(`${scope}: expected references`);
  const referenceLines = new Set(
    references.references
      .filter((reference) => normalizePath(reference.file) === useFile)
      .map((reference) => reference.range.start.line),
  );
  for (const site of row.sites) {
    const label = `${scope}: ${row.language} references line ${site.line}`;
    if (site.resolves) expect(referenceLines.has(site.line), label).toBe(true);
    else expect(referenceLines.has(site.line), label).toBe(false);
  }

  const memberDef = index.byFile
    .get(fileIdentityKey(declarationFile))
    ?.locals.find(
      (local) => local.localName === row.declaration.token && local.range.start.line === row.declaration.line,
    );
  if (!memberDef) throw new Error(`${scope}: missing declaration ${row.declaration.token}`);
  const memberId = defNodeId(memberDef);
  const graph = await buildSymbolGraphDetailed(index);
  for (const site of row.sites) {
    const targets = graph.edges.flatMap((edge) => {
      const from = graph.nodes.get(edge.from);
      return edge.label === "calls" && from?.file === useFile && from.name === site.caller ? [edge.to] : [];
    });
    const label = `${scope}: ${row.language} ${site.caller}`;
    if (site.resolves) expect(targets, label).toContain(memberId);
    else expect(targets, label).not.toContain(memberId);
  }
}

/** Runs goto, references, and the detailed graph for one row under one cache state. */
export async function expectTypeParameterReceiverRow(
  row: TypeParameterReceiverRow,
  mode: TypeParameterReceiverCacheMode,
): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-type-parameter-${row.language}-`));
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-type-parameter-cache-"));
  try {
    const paths = await writeFixtureFiles(root, row.files);
    const options = { cache: "disk" as const, cacheDir, threads: 1 };
    if (mode === "off") {
      await expectRowConsumers(await buildProjectIndex(root, { cache: "off" }), row, paths, mode);
    } else if (mode === "memory") {
      clearMemoryCache();
      const memory = { cache: "memory" as const, threads: 1 };
      await buildProjectIndex(root, memory);
      await expectRowConsumers(await buildProjectIndex(root, memory), row, paths, mode);
    } else {
      clearMemoryCache();
      const cold = await buildProjectIndex(root, options);
      if (mode === "disk-cold") {
        await expectRowConsumers(cold, row, paths, mode);
      } else {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        await expectRowConsumers(await buildProjectIndexIncremental(root, options), row, paths, mode);
      }
    }
  } finally {
    closeDiskCacheDatabase(root, { cache: "disk", cacheDir });
    clearMemoryCache();
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  }
}

/**
 * One call-form matrix cell per language: a generic declaration that names its parameter `T` beside the class `T`, and
 * a receiver built outside it. Resolved cells require complete reference coverage, so the generic body makes no call;
 * the rows above cover calls through the type parameter.
 */
type TypeParameterMatrixSource = {
  files: Readonly<Record<string, string>>;
  use: { file: string; line: number; token: string };
  expected: { file: string; line: number; token: string };
  decoy: { file: string; line: number; token: string };
  caller: string;
};

const TYPE_PARAMETER_MATRIX_SOURCES: Readonly<
  Partial<Record<TypeParameterReceiverLanguage, TypeParameterMatrixSource>>
> = {
  kotlin: {
    files: {
      "lib/T.kt": "package lib\nclass T { fun hello() = 1 }\ninterface I { fun hello(): Int }\n",
      "Main.kt": lines("import lib.T", "", "fun <T> unused(x: T) = x", "fun use() { val t = T(); t.hello() }"),
    },
    use: { file: "Main.kt", line: 4, token: "hello" },
    expected: { file: "lib/T.kt", line: 2, token: "hello" },
    decoy: { file: "lib/T.kt", line: 3, token: "hello" },
    caller: "use",
  },
  csharp: {
    files: {
      "T.cs": "class T { public int Hello() => 1; }\n",
      "I.cs": "interface I { int Hello(); }\n",
      "Main.cs": lines("class M {", "  void Unused<T>(T x) { }", "  void Use() { var t = new T(); t.Hello(); }", "}"),
    },
    use: { file: "Main.cs", line: 3, token: "Hello" },
    expected: { file: "T.cs", line: 1, token: "Hello" },
    decoy: { file: "I.cs", line: 1, token: "Hello" },
    caller: "Use",
  },
  go: {
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "t.go": lines(
        "package main",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        "type Other struct{}",
        "",
        "func (Other) Hello() int { return 2 }",
      ),
      "main.go": lines(
        "package main",
        "",
        "func Unused[T any](x T) {}",
        "",
        "func Use() {",
        "\tvar t T",
        "\tt.Hello()",
        "}",
      ),
    },
    use: { file: "main.go", line: 7, token: "Hello" },
    expected: { file: "t.go", line: 5, token: "Hello" },
    decoy: { file: "t.go", line: 9, token: "Hello" },
    caller: "Use",
  },
  java: {
    files: {
      "p/I.java": "package p;\npublic interface I { int hello(); }\n",
      "p/T.java": "package p;\npublic class T { public int hello() { return 1; } }\n",
      "p/M.java": lines(
        "package p;",
        "class M {",
        "  <T> void unused(T x) { }",
        "  void use() { T t = new T(); t.hello(); }",
        "}",
      ),
    },
    use: { file: "p/M.java", line: 4, token: "hello" },
    expected: { file: "p/T.java", line: 2, token: "hello" },
    decoy: { file: "p/I.java", line: 2, token: "hello" },
    caller: "use",
  },
  ts: {
    files: {
      "i.ts": "export interface I { hello(): number }\n",
      "t.ts": "export class T { hello() { return 1; } }\n",
      "m.ts": lines(
        `import { T } from "./t";`,
        "export function unused<T>(x: T) { return x; }",
        "export function use() { const t = new T(); t.hello(); }",
      ),
    },
    use: { file: "m.ts", line: 3, token: "hello" },
    expected: { file: "t.ts", line: 1, token: "hello" },
    decoy: { file: "i.ts", line: 1, token: "hello" },
    caller: "use",
  },
  tsx: {
    files: {
      "i.tsx": "export interface I { hello(): number }\n",
      "t.tsx": "export class T { hello() { return 1; } }\n",
      "m.tsx": lines(
        `import { T } from "./t";`,
        "export function unused<T>(x: T) { return x; }",
        "export function use() { const t = new T(); t.hello(); }",
      ),
    },
    use: { file: "m.tsx", line: 3, token: "hello" },
    expected: { file: "t.tsx", line: 1, token: "hello" },
    decoy: { file: "i.tsx", line: 1, token: "hello" },
    caller: "use",
  },
  rust: {
    files: {
      "lib.rs": lines(
        "trait I { fn hello(&self) -> i32; }",
        "struct T;",
        "impl T { fn hello(&self) -> i32 { 1 } }",
        "fn unused<T>(x: T) {}",
        "fn use_it() { let t = T; t.hello(); }",
      ),
    },
    use: { file: "lib.rs", line: 5, token: "hello" },
    expected: { file: "lib.rs", line: 3, token: "hello" },
    decoy: { file: "lib.rs", line: 1, token: "hello" },
    caller: "use_it",
  },
  swift: {
    files: {
      "a.swift": lines(
        "protocol I { func hello() -> Int }",
        "class T { func hello() -> Int { 1 } }",
        "func unused<T>(x: T) {}",
        "func use() { let t = T(); t.hello() }",
      ),
    },
    use: { file: "a.swift", line: 4, token: "hello" },
    expected: { file: "a.swift", line: 2, token: "hello" },
    decoy: { file: "a.swift", line: 1, token: "hello" },
    caller: "use",
  },
  python: {
    files: {
      "i.py": "class I:\n    def hello(self): return 0\n",
      "t.py": "class T:\n    def hello(self): return 1\n",
      "m.py": lines(
        "from t import T",
        "",
        "def unused[T](x: T):",
        "    return x",
        "",
        "def use():",
        "    t = T()",
        "    t.hello()",
      ),
    },
    use: { file: "m.py", line: 8, token: "hello" },
    expected: { file: "t.py", line: 2, token: "hello" },
    decoy: { file: "i.py", line: 2, token: "hello" },
    caller: "use",
  },
  cpp: {
    files: {
      "a.cpp": lines(
        "struct Widget { int hello() { return 1; } };",
        "struct Gadget { int hello() { return 2; } };",
        "template <typename Widget> void generic(Widget& w) {}",
        "void use() { Widget w; w.hello(); }",
      ),
    },
    use: { file: "a.cpp", line: 4, token: "hello" },
    expected: { file: "a.cpp", line: 1, token: "hello" },
    decoy: { file: "a.cpp", line: 2, token: "hello" },
    caller: "use",
  },
};

/** The call-form matrix cell for one language: the receiver built outside the generic scope reaches the class. */
export function typeParameterReceiverCell(language: TypeParameterReceiverLanguage): MatrixCell {
  const source = TYPE_PARAMETER_MATRIX_SOURCES[language];
  if (!source) throw new Error(`No type-parameter matrix source for ${language}`);
  return {
    id: `${language}/typed-local-receiver-beside-type-parameter`,
    language,
    callForm: "typed-local-receiver",
    files: source.files,
    use: source.use,
    expected: source.expected,
    decoy: source.decoy,
    decoyKind: "callable",
    edge: { label: "calls", fromFile: source.use.file, fromName: source.caller },
  };
}
