import fsp from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  goToDefinition,
  findReferences,
  type ProjectIndex,
} from "../../src/index.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import {
  expectGoto,
  expectReferences,
  placeOf,
  type Batch3Fixture,
  type Place,
  type Sources,
} from "./csharp-java-batch3-fixture.js";

// Bindings checked against Roslyn. External deliberately has no definition.
export const CSHARP_BATCH5_SOURCES: Sources = {
  "Fixture.cs": [
    "using System;",
    "using System.Linq;",
    "class Fixture {",
    "  int b = 2;",
    "  int x = 5;",
    "  int y = 6;",
    "  int item = 7;",
    "  int[] xs = { 1, 2 };",
    "  int Multiply(int a) { int m = Id(a * b); x = a * b; return m + b; }",
    "  static int Id(int n) => n;",
    "  unsafe int Pointer(int* p) { int* q = p; return *q; }",
    "  int Query() {",
    "    var q = from item in xs where item > 0 let y = item + 1 join x in xs on x equals x into grouped select y + item + x + grouped.Count();",
    "    return item + y + x + q.Count();",
    "  }",
    "  int Typed() { var q = from int x in xs join int y in xs on x equals y select y; return q.Count(); }",
    "  unsafe bool Try(out int* pointer) { pointer = null; return true; }",
    "  unsafe bool Test() => Try(out int* p);",
    "  int Continuation() { var q = from x in xs select x into y select y + x; return x + y + q.Count(); }",
    "  int ShadowSource() { var q = from xs in xs select xs; return xs.Length + q.Count(); }",
    "}",
    "",
  ].join("\n"),
  "Selectors.cs": [
    "class Selectors {",
    "  int Method(int value, string name) => value + name.Length;",
    "  int Other(External thing, External h) => thing.value + h.value + thing.name.Length;",
    "  int Tuple() { var tuple = (value: 1, other: 2); return tuple.value; }",
    "  int Anonymous() { var anon = new { value = 1 }; return anon.value; }",
    "  int Pascal(External thing) => thing.Value + thing.Name.Length;",
    "}",
    "",
  ].join("\n"),
};

// Bindings checked against javac 21; an unknown subject deliberately has no definition.
export const JAVA_BATCH5_SOURCES: Sources = {
  "Fixture.java": [
    "import java.util.function.*;",
    "enum Size { SMALL, BIG }",
    "class Fixture {",
    "  int SMALL = 9;",
    "  int x = 8;",
    "  int a = 7;",
    "  int b = 6;",
    '  String s = "field";',
    "  int run(Size size, int SMALL) { return switch (size) { case SMALL -> 1; case BIG -> SMALL; }; }",
    "  int lambda() { IntUnaryOperator f = x -> x + 1; IntBinaryOperator g = (a, b) -> a + b; return x + a + b + f.applyAsInt(1) + g.applyAsInt(1, 2); }",
    "  int ternary(Object o) { return !(o instanceof String s) ? s.length() : s.length(); }",
    "  int numeric(int n) { final int X = 1; return switch (n) { case X -> X; default -> 0; }; }",
    "  int unknown(Missing value, int SMALL) { return switch (value) { case SMALL -> SMALL; default -> 0; }; }",
    "}",
    "enum Other { SMALL, BIG }",
    "class StringSwitch {",
    '  static final String KEY = "x";',
    "  int select(String value) { return switch (value) { case KEY -> 1; default -> 0; }; }",
    "  int select2(java.lang.String value) { return switch (value) { case KEY -> 1; default -> 0; }; }",
    "}",
    "class UnknownSwitch {",
    "  static final int TOKEN = 1;",
    "  Size choice;",
    "  int peek() { return 1; }",
    "  int field() { return switch (peek()) { case TOKEN -> 1; default -> 0; }; }",
    "  int local() { final int LOCAL = 1; return switch (peek()) { case LOCAL -> LOCAL; default -> 0; }; }",
    "  int nonfinal() { int VAR = 1; return switch (peek()) { case VAR -> 1; default -> 0; }; }",
    "  int parameter(int BAD) { return switch (peek()) { case BAD -> 1; default -> 0; }; }",
    "  int enumField(int SMALL) { return switch (choice) { case SMALL -> SMALL; default -> 0; }; }",
    "  static final int BAD = 1;",
    "  int catchCase() { try { return 0; } catch (RuntimeException BAD) { return switch (peek()) { case BAD -> 1; default -> 0; }; } }",
    "  int lambdaCase() { IntUnaryOperator f = BAD -> switch (peek()) { case BAD -> 1; default -> 0; }; return f.applyAsInt(2); }",
    "  int patternCase(Object o) { if (o instanceof Integer BAD) { return switch (peek()) { case BAD -> 1; default -> 0; }; } return 0; }",
    "  int loopCase(int[] xs) { for (int BAD : xs) { switch (peek()) { case BAD -> { return 1; } default -> {} } } return 0; }",
    "}",
    "",
  ].join("\n"),
};

/** The graph omits local-value reads; it must not attach them to a same-named member instead. */
async function expectNoIncorrectEdges(
  fixture: Batch3Fixture,
  index: ProjectIndex,
  uses: readonly Place[],
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  for (const use of uses) {
    const position = placeOf(fixture.sources, use);
    const result = await goToDefinition(index, { file: fixture.files[use.file]!, ...position });
    const edges = graph.edges.filter(
      (edge) =>
        edge.site?.file === fixture.files[use.file] &&
        edge.site.range.start.line === position.line &&
        edge.site.range.start.column === position.column,
    );
    if (result.status === "ok") expect(edges.every((edge) => edge.to === defNodeId(result.definition))).toBe(true);
    else expect(edges).toEqual([]);
  }
}

export async function expectCsharpBatch5(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Fixture.cs", line, token, nth });
  for (const nth of [1, 2, 3]) await expectGoto(fixture, index, at(9, "b", nth), at(4, "b"));
  await expectGoto(fixture, index, at(9, "a", 2), at(9, "a"));
  await expectReferences(fixture, index, at(4, "b"), [at(4, "b"), ...[1, 2, 3].map((n) => at(9, "b", n))], "complete");
  await expectGoto(fixture, index, at(11, "q", 2), at(11, "q"));
  await expectReferences(fixture, index, at(11, "q"), [at(11, "q"), at(11, "q", 2)], "complete");
  for (const nth of [2, 3, 4]) await expectGoto(fixture, index, at(13, "item", nth), at(13, "item"));
  await expectGoto(fixture, index, at(13, "y", 2), at(13, "y"));
  await expectGoto(fixture, index, at(13, "x", 2), at(5, "x"));
  await expectGoto(fixture, index, at(13, "x", 3), at(13, "x"));
  await expectGoto(fixture, index, at(13, "x", 4), at(5, "x"));
  await expectGoto(fixture, index, at(13, "grouped", 2), at(13, "grouped"));
  await expectGoto(fixture, index, at(14, "item"), at(7, "item"));
  await expectReferences(
    fixture,
    index,
    at(13, "item"),
    [1, 2, 3, 4].map((n) => at(13, "item", n)),
    "complete",
  );
  await expectReferences(fixture, index, at(13, "x"), [at(13, "x"), at(13, "x", 3)], "complete");
  await expectReferences(fixture, index, at(13, "grouped"), [at(13, "grouped"), at(13, "grouped", 2)], "complete");
  await expectGoto(fixture, index, at(16, "y", 2), at(16, "y"));
  await expectGoto(fixture, index, at(16, "y", 3), at(16, "y"));
  await expectGoto(fixture, index, at(19, "x", 2), at(19, "x"));
  await expectGoto(fixture, index, at(19, "x", 3), at(5, "x"));
  await expectGoto(fixture, index, at(19, "y", 2), at(19, "y"));
  await expectGoto(fixture, index, at(20, "xs", 2), at(8, "xs"));
  await expectGoto(fixture, index, at(20, "xs", 3), at(20, "xs"));
  await expectGoto(fixture, index, at(20, "xs", 4), at(8, "xs"));
  const selector = (line: number, token: string, nth = 1): Place => ({ file: "Selectors.cs", line, token, nth });
  for (const name of ["value", "name"]) {
    await expectGoto(fixture, index, selector(3, name), "not_found");
    await expectReferences(fixture, index, selector(2, name), [selector(2, name), selector(2, name, 2)], "complete");
  }
  await expectGoto(fixture, index, selector(3, "value", 2), "not_found");
  await expectNoIncorrectEdges(fixture, index, [at(9, "b"), at(13, "item", 2), at(13, "x", 3), selector(3, "value")]);
  const graph = await buildSymbolGraphDetailed(index);
  expect(
    graph.edges.some(
      (edge) =>
        edge.label === "calls" &&
        graph.nodes.get(edge.from)?.name === "Multiply" &&
        graph.nodes.get(edge.to)?.name === "Id",
    ),
  ).toBe(true);
}

export async function expectJavaBatch5(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Fixture.java", line, token, nth });
  await expectGoto(fixture, index, at(9, "SMALL", 2), at(2, "SMALL"));
  await expectGoto(fixture, index, at(9, "SMALL", 3), at(9, "SMALL"));
  await expectReferences(
    fixture,
    index,
    at(2, "SMALL"),
    [at(2, "SMALL"), at(9, "SMALL", 2), at(29, "SMALL", 2)],
    "partial",
  );
  await expectGoto(fixture, index, at(9, "BIG"), at(2, "BIG"));
  await expectReferences(fixture, index, at(2, "BIG"), [at(2, "BIG"), at(9, "BIG")], "complete");
  await expectReferences(fixture, index, at(9, "SMALL"), [at(9, "SMALL"), at(9, "SMALL", 3)], "complete");
  for (const name of ["x", "a", "b"]) {
    await expectGoto(fixture, index, at(10, name, 2), at(10, name));
    await expectReferences(fixture, index, at(10, name), [at(10, name), at(10, name, 2)], "complete");
  }
  const stringCase = (line: number): Place => ({ file: "Fixture.java", line, token: "KEY" });
  await expectGoto(fixture, index, stringCase(18), stringCase(17));
  await expectGoto(fixture, index, stringCase(19), stringCase(17));
  await expectReferences(fixture, index, stringCase(17), [stringCase(17), stringCase(18), stringCase(19)], "complete");
  await expectGoto(fixture, index, at(10, "x", 3), at(5, "x"));
  await expectGoto(fixture, index, at(11, "s", 2), at(8, "s"));
  await expectGoto(fixture, index, at(11, "s", 3), "not_found");
  await expectReferences(fixture, index, at(8, "s"), [at(8, "s"), at(11, "s", 2)], "partial");
  await expectGoto(fixture, index, at(12, "X", 2), at(12, "X"));
  await expectReferences(fixture, index, at(12, "X"), [at(12, "X"), at(12, "X", 2), at(12, "X", 3)], "complete");
  await expectGoto(fixture, index, at(13, "SMALL", 2), "not_found");
  await expectGoto(fixture, index, at(13, "SMALL", 3), at(13, "SMALL"));
  await expectGoto(fixture, index, at(25, "TOKEN"), at(22, "TOKEN"));
  await expectReferences(fixture, index, at(22, "TOKEN"), [at(22, "TOKEN"), at(25, "TOKEN")], "complete");
  await expectGoto(fixture, index, at(26, "LOCAL", 2), at(26, "LOCAL"));
  await expectReferences(
    fixture,
    index,
    at(26, "LOCAL"),
    [1, 2, 3].map((n) => at(26, "LOCAL", n)),
    "complete",
  );
  await expectGoto(fixture, index, at(27, "VAR", 2), "not_found");
  await expectGoto(fixture, index, at(28, "BAD", 2), "not_found");
  for (const line of [31, 32, 33, 34]) await expectGoto(fixture, index, at(line, "BAD", 2), "not_found");
  await expectGoto(fixture, index, at(29, "SMALL", 2), at(2, "SMALL"));
  await expectReferences(fixture, index, at(13, "SMALL"), [at(13, "SMALL"), at(13, "SMALL", 3)], "complete");
  await expectNoIncorrectEdges(fixture, index, [at(9, "SMALL", 2), at(9, "SMALL", 3), at(10, "x", 2), at(11, "s", 2)]);
}

/** Cold, incremental, and reopened indexes agree through edits, renames, deletion, and restoration. */
export async function expectBatch5CacheTransitions(fixture: Batch3Fixture, language: "csharp" | "java"): Promise<void> {
  const originalName = language === "csharp" ? "Fixture.cs" : "Fixture.java";
  const original = fixture.files[originalName]!;
  const renamed = path.join(fixture.root, `Renamed${path.extname(original)}`);
  const source = fixture.sources[originalName]!;
  let file = original;
  let deleted = false;
  const sites =
    language === "csharp"
      ? [
          { file: originalName, line: 9, token: "b" },
          { file: originalName, line: 13, token: "item", nth: 2 },
          { file: originalName, line: 13, token: "x", nth: 3 },
          { file: originalName, line: 20, token: "xs", nth: 2 },
        ]
      : [
          { file: originalName, line: 9, token: "SMALL", nth: 2 },
          { file: originalName, line: 10, token: "x", nth: 2 },
          { file: originalName, line: 11, token: "s", nth: 2 },
          { file: originalName, line: 12, token: "X", nth: 2 },
        ];
  const describe = async (index: ProjectIndex): Promise<unknown> => {
    if (deleted) {
      expect(index.byFile.has(fileIdentityKey(file))).toBe(false);
      return { deleted: true };
    }
    const answers = [];
    for (const site of sites) {
      const result = await goToDefinition(index, { file, ...placeOf(fixture.sources, site) });
      if (result.status !== "ok") {
        answers.push({ status: result.status });
        continue;
      }
      const refs = await findReferences(index, { def: result.definition });
      answers.push({
        status: result.status,
        declaration: [result.definition.range.start.line, result.definition.range.start.column],
        coverage: refs.status === "ok" ? refs.referenceCoverage.state : refs.status,
        references:
          refs.status === "ok" ? refs.references.map((ref) => [ref.range.start.line, ref.range.start.column]) : [],
      });
    }
    const graph = await buildSymbolGraphDetailed(index);
    const edges = graph.edges
      .map((edge) => [
        edge.label,
        graph.nodes.get(edge.from)?.name,
        graph.nodes.get(edge.to)?.name,
        edge.site?.range.start.line,
        edge.site?.range.start.column,
      ])
      .sort();
    return { answers, edges };
  };
  const check = async (): Promise<void> => {
    const cold = await buildProjectIndex(fixture.root, { cache: "off", threads: 1 });
    const incremental = await buildProjectIndexIncremental(fixture.root, { cache: "disk", threads: 1 });
    clearMemoryCache();
    closeDiskCacheDatabase(fixture.root);
    const reopened = await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 });
    const expected = await describe(cold);
    expect(await describe(incremental)).toEqual(expected);
    expect(await describe(reopened)).toEqual(expected);
  };
  try {
    await check();
    await fsp.writeFile(file, `${source}// edited\n`);
    await check();
    await fsp.rename(original, renamed);
    file = renamed;
    await check();
    await fsp.rename(renamed, original);
    file = original;
    await check();
    await fsp.rm(file);
    deleted = true;
    await check();
    await fsp.writeFile(file, source);
    deleted = false;
    await check();
  } finally {
    clearMemoryCache();
    closeDiskCacheDatabase(fixture.root);
  }
}

/** Compiler-checked initializer, record selector, and query-source scope regressions. */
export const CSHARP_BATCH5_REVIEW_SOURCES: Sources = {
  "Initializers.cs": [
    "using System.Collections.Generic;",
    "using System.Linq;",
    "class Bucket {",
    "  public int item = 1;",
    "  public int i = 2;",
    "  public IEnumerable<int> Values = from item in new[] { 1 } select item;",
    "  public IEnumerable<int> Query => from i in new[] { 1 } select i;",
    "  public int Read(Bucket other) => other.item + this.item + other.i + this.i;",
    "}",
    "class MissingDerived : MissingBase { public IEnumerable<int> Values = from missing in new[] { 1 } select missing; }",
    "class Reader { int Read(MissingDerived d) => d.missing; }",
    "",
  ].join("\n"),
  "Queries.cs": [
    "using System.Linq;",
    "using System.Collections.Generic;",
    "class Queries {",
    "  int n = 10, j = 20, m = 30, item = 40, v = 50, w = 60, zz = 70;",
    "  static int[] Make(out int x) { x = 3; return new[] { x }; }",
    "  int First() { var q = from a in Make(out var n) select a + n; return n + q.Count(); }",
    "  int Join() { var q = from a in new[] { 1 } join b in Make(out var j) on a equals b select a + b + j; return j + q.Count(); }",
    "  int Second() { var q = from a in new[] { 1 } from b in Make(out var m) select a + b + m; return m + q.Count(); }",
    "  IEnumerable<int> Field = from a in Make(out var item) select a + item;",
    "  int Outside() => item;",
    "  int Let() { var q = from a in new[] { 1 } let b = Make(out var v).Length select v; return v + q.Count(); }",
    "  int Where() { var q = from a in new[] { 1 } where Make(out var w).Length > 0 select w; return w + q.Count(); }",
    "  int Nested() { var q = from a in new[] { 1 } from b in (from z in Make(out var zz) select z + zz) select zz; return zz + q.Count(); }",
    "}",
    "",
  ].join("\n"),
  "Patterns.cs": [
    "using System.Linq;",
    "class QueryPattern {",
    "  int[] p = new[] { 1 };",
    "  int Use(object input) { var q = from a in (input is int[] p ? p : new[] { 1 }) select a + p.Length; return p.Length + q.Count(); }",
    "}",
    "",
  ].join("\n"),
  "Records.cs": [
    "public record Person(string Name);",
    "public record struct Point(string Label);",
    "public readonly record struct ReadonlyPoint(string Tag);",
    "public record class Named(string Title);",
    "",
  ].join("\n"),
  "UseRecords.cs": [
    "class UseRecords {",
    '  Person MakePerson() => new Person("a");',
    '  Point MakePoint() => new Point("a");',
    '  ReadonlyPoint MakeReadonlyPoint() => new ReadonlyPoint("a");',
    '  Named MakeNamed() => new Named("a");',
    "  string Read() { var p = MakePerson(); var q = MakePoint(); var r = MakeReadonlyPoint(); var s = MakeNamed(); return p.Name + p?.Name + q.Label + r.Tag + s.Title; }",
    "}",
    "",
  ].join("\n"),
};

export const JAVA_BATCH5_REVIEW_SOURCES: Sources = {
  "ji/Cache.java": [
    "package ji;",
    "import java.util.function.Function;",
    "class Cache {",
    "  int value = 4;",
    "  Function<Integer, Integer> mapper = value -> value + 1;",
    "  int read(Cache other) { return other.value + this.value + value; }",
    "}",
    "class Derived extends MissingBase { Function<Integer, Integer> f = timeout -> timeout; }",
    "class Unknown { int get(Derived d) { return d.timeout; } }",
    "enum E { ONE(right -> right); E(Function<Integer, Integer> f) {} }",
    "class EnumUser { int get(E e) { return e.right; } }",
    "class Varargs {",
    "  int a = 1;",
    "  Function<String[], Integer> f = (String... a) -> a.length;",
    "}",
    "",
  ].join("\n"),
  "ji/User.java": ["package ji;", "class User { int get(Cache c) { return c.value; } }", ""].join("\n"),
};

export async function expectCsharpBatch5Review(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (file: string, line: number, token: string, nth = 1): Place => ({ file, line, token, nth });
  const initial = (line: number, token: string, nth = 1): Place => at("Initializers.cs", line, token, nth);
  for (const [name, fieldLine, queryLine] of [
    ["item", 4, 6],
    ["i", 5, 7],
  ] as const) {
    await expectGoto(fixture, index, initial(queryLine, name, 2), initial(queryLine, name));
    await expectGoto(fixture, index, initial(8, name), initial(fieldLine, name));
    await expectGoto(fixture, index, initial(8, name, 2), initial(fieldLine, name));
    await expectReferences(
      fixture,
      index,
      initial(fieldLine, name),
      [initial(fieldLine, name), initial(8, name), initial(8, name, 2)],
      "complete",
    );
    await expectReferences(
      fixture,
      index,
      initial(queryLine, name),
      [initial(queryLine, name), initial(queryLine, name, 2)],
      "complete",
    );
  }
  await expectGoto(fixture, index, initial(11, "missing"), "not_found");
  const query = (line: number, token: string, nth = 1): Place => at("Queries.cs", line, token, nth);
  for (const [line, name] of [
    [6, "n"],
    [7, "j"],
  ] as const) {
    await expectGoto(fixture, index, query(line, name, 2), query(line, name));
    await expectGoto(fixture, index, query(line, name, 3), query(line, name));
    await expectReferences(
      fixture,
      index,
      query(line, name),
      [1, 2, 3].map((n) => query(line, name, n)),
      "complete",
    );
  }
  await expectGoto(fixture, index, query(8, "m", 2), query(4, "m"));
  await expectGoto(fixture, index, query(8, "m", 3), query(4, "m"));
  await expectGoto(fixture, index, query(9, "item", 2), query(9, "item"));
  await expectGoto(fixture, index, query(10, "item"), query(4, "item"));
  for (const [line, name] of [
    [11, "v"],
    [12, "w"],
  ] as const) {
    await expectGoto(fixture, index, query(line, name, 2), query(4, name));
    await expectGoto(fixture, index, query(line, name, 3), query(4, name));
    await expectReferences(
      fixture,
      index,
      query(4, name),
      [query(4, name), query(line, name, 2), query(line, name, 3)],
      "complete",
    );
  }
  await expectGoto(fixture, index, query(13, "zz", 2), query(13, "zz"));
  for (const nth of [3, 4]) await expectGoto(fixture, index, query(13, "zz", nth), query(4, "zz"));
  await expectReferences(fixture, index, query(13, "zz"), [query(13, "zz"), query(13, "zz", 2)], "complete");
  await expectReferences(
    fixture,
    index,
    query(4, "zz"),
    [query(4, "zz"), query(13, "zz", 3), query(13, "zz", 4)],
    "complete",
  );
  const pattern = (nth: number): Place => at("Patterns.cs", 4, "p", nth);
  for (const nth of [2, 3, 4]) await expectGoto(fixture, index, pattern(nth), pattern(1));
  await expectReferences(fixture, index, pattern(1), [1, 2, 3, 4].map(pattern), "complete");
  for (const [line, name] of [
    [1, "Name"],
    [2, "Label"],
    [3, "Tag"],
    [4, "Title"],
  ] as const) {
    const declaration = at("Records.cs", line, name);
    await expectGoto(fixture, index, at("UseRecords.cs", 6, name), "not_found");
    if (name === "Name") await expectGoto(fixture, index, at("UseRecords.cs", 6, name, 2), "not_found");
    await expectReferences(fixture, index, declaration, [declaration], "partial");
  }
  await expectNoIncorrectEdges(fixture, index, [
    initial(8, "item"),
    initial(8, "i"),
    query(6, "n", 3),
    query(8, "m", 2),
  ]);
}

export async function expectJavaBatch5Review(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "ji/Cache.java", line, token, nth });
  const user: Place = { file: "ji/User.java", line: 2, token: "value" };
  for (const nth of [1, 2, 3]) await expectGoto(fixture, index, at(6, "value", nth), at(4, "value"));
  await expectGoto(fixture, index, user, at(4, "value"));
  await expectGoto(fixture, index, at(5, "value", 2), at(5, "value"));
  await expectReferences(
    fixture,
    index,
    at(4, "value"),
    [at(4, "value"), ...[1, 2, 3].map((n) => at(6, "value", n)), user],
    "complete",
  );
  await expectReferences(fixture, index, at(5, "value"), [at(5, "value"), at(5, "value", 2)], "complete");
  await expectGoto(fixture, index, at(9, "timeout"), "not_found");
  await expectGoto(fixture, index, at(11, "right"), "not_found");
  await expectGoto(fixture, index, at(14, "a", 2), at(14, "a"));
  await expectReferences(fixture, index, at(14, "a"), [at(14, "a"), at(14, "a", 2)], "complete");
  await expectReferences(fixture, index, at(13, "a"), [at(13, "a")], "complete");
  await expectNoIncorrectEdges(fixture, index, [
    at(6, "value"),
    user,
    at(9, "timeout"),
    at(11, "right"),
    at(14, "a", 2),
  ]);
}
