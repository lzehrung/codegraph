import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
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

/**
 * A class `T` declaring a member, a same-named generic type parameter in the same compilation unit, and a bounded
 * interface decoy that declares the same member. A receiver typed by the type parameter never proves the class.
 */
export type TypeParameterReceiverRow = {
  language: "kotlin" | "csharp" | "go";
  files: Readonly<Record<string, string>>;
  /** File holding the call sites. */
  use: string;
  /** Declaration of the member on the class `T`. */
  declaration: { file: string; line: number; token: string };
  sites: readonly TypeParameterReceiverSite[];
};

const KOTLIN_FUNCTIONS = [
  "interface I { fun hello(): Int }",
  "class T { fun hello() = 1 }",
  "fun <T : I> bounded(x: T) { x.hello() }",
  "fun <T : I> declared(x: T) { val y: T = x; y.hello() }",
  "fun use() { val t = T(); t.hello() }",
];

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

export const TYPE_PARAMETER_RECEIVER_ROWS: readonly TypeParameterReceiverRow[] = [
  {
    language: "kotlin",
    files: {
      "lib/T.kt": "package lib\nclass T { fun hello() = 1 }\ninterface I { fun hello(): Int }\n",
      "Main.kt": [
        "import lib.I",
        "import lib.T",
        "",
        "fun <T> unused(x: T) = x",
        "fun <T : I> bounded(x: T) { x.hello() }",
        "fun <T : I> declared(x: T) { val y: T = x; y.hello() }",
        "fun use() { val t = T(); t.hello() }",
        "",
      ].join("\n"),
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
    files: { "Main.kt": `${KOTLIN_FUNCTIONS.join("\n")}\n` },
    use: "Main.kt",
    declaration: { file: "Main.kt", line: 2, token: "hello" },
    sites: [
      { line: 3, token: "hello", caller: "bounded", resolves: false },
      { line: 4, token: "hello", caller: "declared", resolves: false },
      { line: 5, token: "hello", caller: "use", resolves: true },
    ],
  },
  {
    language: "csharp",
    files: {
      "T.cs": "class T { public int Hello() => 1; }\n",
      "I.cs": "interface I { int Hello(); }\n",
      "Main.cs": `${CSHARP_USE.join("\n")}\n`,
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
    files: {
      "Main.cs": ["interface I { int Hello(); }", "class T { public int Hello() => 1; }", ...CSHARP_USE, ""].join("\n"),
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
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "t.go": [
        "package main",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        "type I interface{ Hello() int }",
        "",
      ].join("\n"),
      "main.go": ["package main", "", ...GO_USE, ""].join("\n"),
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
    files: {
      "go.mod": "module example.com/m\n\ngo 1.21\n",
      "main.go": [
        "package main",
        "",
        "type I interface{ Hello() int }",
        "",
        "type T struct{}",
        "",
        "func (T) Hello() int { return 1 }",
        "",
        ...GO_USE,
        "",
      ].join("\n"),
    },
    use: "main.go",
    declaration: { file: "main.go", line: 7, token: "Hello" },
    sites: [
      { line: 11, token: "Hello", caller: "Bounded", resolves: false },
      { line: 12, token: "Hello", caller: "Bounded", resolves: false },
      { line: 17, token: "Hello", caller: "Use", resolves: true },
    ],
  },
];

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
