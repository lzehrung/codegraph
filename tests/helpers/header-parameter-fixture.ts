import fsp from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import {
  CSHARP_ATTRIBUTE_SOURCES,
  CSHARP_RECORD_SOURCES,
  CSHARP_STATIC_RECEIVER_SOURCES,
  JAVA_RECORD_SOURCES,
  expectCsharpAttributeNames,
  expectCsharpRecordComponents,
  expectGoto,
  expectJavaRecordComponents,
  expectStaticReceiverEdges,
  expectReferences,
  placeOf,
  type Batch3Fixture,
  type Place,
  type Sources,
} from "./csharp-java-batch3-fixture.js";
import {
  CSHARP_BATCH5_REVIEW_SOURCES,
  CSHARP_BATCH5_SOURCES,
  JAVA_BATCH5_REVIEW_SOURCES,
  JAVA_BATCH5_SOURCES,
  expectCsharpBatch5,
  expectCsharpBatch5Review,
  expectJavaBatch5,
  expectJavaBatch5Review,
} from "./csharp-java-batch5-fixture.js";

/**
 * One record per binder form: a nearer binder of `X`, or a binder the scope index does not model, beside the header
 * parameter `X`. Every expectation below was checked against Roslyn (C#) and javac (Java).
 */
type BinderForm = {
  id: string;
  /** Members of `record R<id>(int X, int Y)`; the header parameter is the first `X` of its line. */
  body: string;
  /** The `X` (or `value`) occurrences read, each with the occurrence it names, or `not_found` when unproven. */
  uses: ReadonlyArray<readonly [use: number, target: number | "not_found"]>;
  /** The header parameter's references: the occurrences that name it, and whether coverage stays complete. */
  references?: { names: readonly number[]; coverage: "complete" | "partial" };
};

const CSHARP_BINDER_FORMS: readonly BinderForm[] = [
  {
    id: "ForeachVar",
    body: "int A(int[] xs) { foreach (var X in xs) { return X; } return X; }",
    uses: [
      [3, 2],
      [4, 1],
    ],
    references: { names: [1, 4], coverage: "complete" },
  },
  {
    id: "Deconstruction",
    body: "int A() { var (X, Z) = (1, 2); return X; }",
    uses: [
      [2, "not_found"],
      [3, "not_found"],
    ],
    references: { names: [1], coverage: "partial" },
  },
  {
    id: "DeconstructionBlock",
    body: "int A() { { var (X, Z) = (1, 2); } return X; }",
    uses: [[3, 1]],
  },
  {
    id: "QueryFrom",
    body: "int A(int[] xs) => (from X in xs select X).Count() + X;",
    uses: [
      [2, 2],
      [3, 2],
      [4, 1],
    ],
    references: { names: [1, 4], coverage: "complete" },
  },
  {
    id: "QueryLet",
    body: "int A(int[] xs) => (from v in xs let X = v select X).Count();",
    uses: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: "QueryJoin",
    body: "int A(int[] xs, int[] ys) => (from a in xs join X in ys on a equals X select X).Count();",
    uses: [
      [2, 2],
      [3, 2],
      [4, 2],
    ],
  },
  {
    id: "QueryInto",
    body: "int A(int[] xs) => (from a in xs group a by a into X select X.Key).Count();",
    uses: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: "AnonymousMethodParameter",
    body: "System.Func<int, int> F = delegate (int X) { return X; };",
    uses: [
      [2, "not_found"],
      [3, "not_found"],
    ],
  },
  {
    id: "AnonymousMethodCall",
    body: "int A(int[] xs) => xs.Sum(delegate (int X) { return X; }) + X;",
    uses: [
      [2, "not_found"],
      [3, "not_found"],
      [4, 1],
    ],
  },
  {
    id: "AnonymousMethodNoParameter",
    body: "System.Func<int> F = delegate { return X; };",
    uses: [[2, 1]],
  },
  {
    id: "InitializerLambda",
    body: "System.Func<int, int> F = X => X + 1;",
    uses: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: "InitializerStaticLambda",
    body: "System.Func<int, int> F = static X => X;",
    uses: [[3, 2]],
  },
  {
    id: "InitializerCallLambda",
    body: "int[] F = new[] { 1 }.Select(X => X + 1).ToArray();",
    uses: [[3, 2]],
  },
  {
    id: "InitializerPattern",
    body: "bool F = 1 is int X && X > 0;",
    uses: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: "InitializerOutVariable",
    body: 'int F = int.TryParse("1", out var X) ? X : 0;',
    uses: [[3, 2]],
  },
  {
    id: "LocalFunction",
    body: "int A() { int Local(int X) => X; return Local(1) + X; }",
    uses: [
      [3, 2],
      [4, 1],
    ],
  },
];

/** One file per form: unproven names of one form must not make another form's references partial. */
export const CSHARP_BINDER_SOURCES: Sources = Object.fromEntries(
  CSHARP_BINDER_FORMS.map((form) => [
    `R${form.id}.cs`,
    ["using System.Linq;", "namespace Binders;", `public record R${form.id}(int X, int Y) { ${form.body} }`, ""].join(
      "\n",
    ),
  ]),
);

/** The header parameter, and what each use in every form names, through goto and the header parameter's references. */
export async function expectCsharpBinderForms(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const form of CSHARP_BINDER_FORMS) {
    const occurrence = (nth: number): Place => ({ file: `R${form.id}.cs`, line: 3, token: "X", nth });
    for (const [use, target] of form.uses) {
      await expectGoto(fixture, index, occurrence(use), target === "not_found" ? target : occurrence(target));
    }
    if (form.references) {
      await expectReferences(
        fixture,
        index,
        occurrence(1),
        form.references.names.map(occurrence),
        form.references.coverage,
      );
    }
  }
}

const JAVA_BINDER_FORMS: readonly BinderForm[] = [
  {
    id: "LambdaName",
    body: "int f(java.util.List<Integer> xs) { xs.forEach(value -> value.hashCode()); return value; }",
    uses: [
      [2, 2],
      [3, 2],
      [4, 1],
    ],
    references: { names: [1, 4], coverage: "complete" },
  },
  {
    id: "LambdaTyped",
    body: "int f(java.util.List<Integer> xs) { xs.forEach((Integer value) -> value.hashCode()); return value; }",
    uses: [
      [2, 2],
      [3, 2],
      [4, 1],
    ],
  },
  {
    id: "LambdaInferred",
    body: "int f(java.util.List<Integer> xs) { xs.forEach((value) -> value.hashCode()); return value; }",
    uses: [
      [2, 2],
      [3, 2],
      [4, 1],
    ],
  },
  {
    id: "EnhancedFor",
    body: "int f(java.util.List<Integer> xs) { for (Integer value : xs) { value.hashCode(); } return value; }",
    uses: [
      [2, "not_found"],
      [3, "not_found"],
      [4, 1],
    ],
  },
  {
    id: "Catch",
    body: "int f() { try { hashCode(); } catch (RuntimeException value) { value.hashCode(); } return value; }",
    uses: [
      [2, "not_found"],
      [3, "not_found"],
      [4, 1],
    ],
  },
  {
    id: "TryWithResources",
    body: 'int f() { try (java.io.StringReader value = new java.io.StringReader("")) { value.read(); } catch (Exception e) { int q = value; } return value; }',
    uses: [
      [2, "not_found"],
      [3, "not_found"],
      [4, 1],
      [5, 1],
    ],
  },
  {
    id: "NestedLambda",
    body: "int f(java.util.List<Integer> xs) { xs.forEach(a -> { xs.forEach(value -> value.hashCode()); a.hashCode(); }); return value; }",
    uses: [
      [2, 2],
      [3, 2],
      [4, 1],
    ],
  },
  {
    id: "PatternVariable",
    body: "int f(Object o) { if (o instanceof Integer value) { return value; } return 0; }",
    uses: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: "MethodParameter",
    body: "int f(int value) { return value; }",
    uses: [[3, 2]],
  },
  {
    id: "LocalVariable",
    body: "int f() { int value = 2; return value; }",
    uses: [[3, 2]],
  },
];

export const JAVA_BINDER_SOURCES: Sources = Object.fromEntries(
  JAVA_BINDER_FORMS.map((form) => [
    `R${form.id}.java`,
    `record R${form.id}(int value, String label) { ${form.body} }\n`,
  ]),
);

/** The component, and what each use in every form names. A variable the scope does not bind stops the lookup. */
export async function expectJavaBinderForms(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const form of JAVA_BINDER_FORMS) {
    const occurrence = (nth: number): Place => ({ file: `R${form.id}.java`, line: 1, token: "value", nth });
    for (const [use, target] of form.uses) {
      await expectGoto(fixture, index, occurrence(use), target === "not_found" ? target : occurrence(target));
    }
    if (form.references) {
      await expectReferences(
        fixture,
        index,
        occurrence(1),
        form.references.names.map(occurrence),
        form.references.coverage,
      );
    }
  }
}

/** Base-constructor arguments are expressions: they read the parameter, and no type or parameter becomes a base. */
export const CSHARP_HERITAGE_SOURCES: Sources = {
  "Heritage.cs": [
    "namespace Heritage;",
    "public record Base1(int Id);",
    "public record Derived1(int Id, string Tag) : Base1(Id) { public int Twice() => Id * 2; }",
    "public class Id { }",
    "public class BaseC(int v) { }",
    "public class DerivedC(int x) : BaseC(x) { }",
    "public class x { }",
    "",
  ].join("\n"),
};

export async function expectCsharpHeritageArguments(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const file = "Heritage.cs";
  const at = (line: number, token: string, nth = 1): Place => ({ file, line, token, nth });
  // The argument reads the derived record's own parameter; the body reads the inherited property.
  await expectGoto(fixture, index, at(3, "Id", 2), at(3, "Id", 1));
  await expectGoto(fixture, index, at(3, "Id", 3), at(2, "Id"));
  await expectGoto(fixture, index, at(6, "x", 2), at(6, "x", 1));
  const graph = await buildSymbolGraphDetailed(index);
  const heritageTargets = (name: string): string[] =>
    graph.edges
      .filter((edge) => edge.label === "extends" || edge.label === "implements")
      .filter((edge) => graph.nodes.get(edge.from)?.name === name)
      .map((edge) => graph.nodes.get(edge.to)?.name ?? "?");
  expect(heritageTargets("Derived1")).toEqual(["Base1"]);
  expect(heritageTargets("DerivedC")).toEqual(["BaseC"]);
  // The decoys named like the arguments are never a base.
  const decoyIds = new Set(
    [...graph.nodes].filter(([, node]) => node.name === "Id" || node.name === "x").map(([id]) => id),
  );
  for (const edge of graph.edges.filter((candidate) => candidate.label === "implements")) {
    expect(decoyIds.has(edge.to)).toBe(false);
  }
}

/** A header parameter named like its own type (Color Color): `T.Static`, `T.Nested`, and enum members read the type. */
export const CSHARP_COLOR_COLOR_SOURCES: Sources = {
  "Types.cs": [
    "namespace T;",
    "public class Outer { public static int SM() => 1; public int Inst() => 2; public class Inner { public static int Make() => 3; } public enum Kind { A, B } public const int Limit = 5; }",
    "public enum Status { Active, Idle }",
    "",
  ].join("\n"),
  "Decoy.cs": [
    "namespace Decoy;",
    "public class Outer { public static int SM() => -1; public int Inst() => -2; public class Inner { public static int Make() => -3; } public enum Kind { A, B } }",
    "public enum Status { Active, Idle }",
    "",
  ].join("\n"),
  "Use.cs": [
    "using T;",
    "namespace App;",
    "public record R(Outer Outer, Status Status) {",
    "  public int F1() => Outer.SM();",
    "  public int F2() => Outer.Inner.Make();",
    "  public int F3() => (int)Outer.Kind.A;",
    "  public bool F4() => Status == Status.Active;",
    "  public int F5() => Outer.Inst();",
    "  public int F6() => Outer.Limit;",
    "}",
    "public class Cl(Outer Outer) {",
    "  public int G1() => Outer.SM();",
    "  public int G2() => Outer.Inst();",
    "  public int G3() => Outer.Inner.Make();",
    "}",
    "",
  ].join("\n"),
};

export async function expectCsharpColorColorHeaders(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const use = (line: number, token: string, nth = 1): Place => ({ file: "Use.cs", line, token, nth });
  const type = (token: string, line: number): Place => ({ file: "Types.cs", line, token });
  const inner = (line: number): Place => ({ file: "Types.cs", line, token: "Make" });
  for (const line of [4, 12]) await expectGoto(fixture, index, use(line, "SM"), type("SM", 2));
  for (const line of [5, 14]) await expectGoto(fixture, index, use(line, "Make"), inner(2));
  await expectGoto(fixture, index, use(6, "A"), type("A", 2));
  await expectGoto(fixture, index, use(7, "Active"), type("Active", 3));
  for (const line of [8, 13]) await expectGoto(fixture, index, use(line, "Inst"), type("Inst", 2));
  await expectGoto(fixture, index, use(9, "Limit"), type("Limit", 2));
  const graph = await buildSymbolGraphDetailed(index);
  const reached = new Set(
    graph.edges
      .filter((edge) => edge.label === "calls")
      .map((edge) => graph.nodes.get(edge.to)?.file)
      .filter((file): file is string => !!file),
  );
  expect(reached.has(fixture.files["Types.cs"]!)).toBe(true);
  expect(reached.has(fixture.files["Decoy.cs"]!)).toBe(false);
  await expectReferences(fixture, index, inner(2), [inner(2), use(5, "Make"), use(14, "Make")], "complete");
}

/** A member of another `partial` part, or of a base class, outranks a header parameter of the same name in a body. */
export const CSHARP_PARTIAL_SOURCES: Sources = {
  "Part1.cs": [
    "namespace Part;",
    "public partial class PC(int y) { public int A() => y; }",
    "public class BaseK { protected int z; }",
    "public class DK(int z) : BaseK { public int A() => z; }",
    "public partial class PE(int w) { }",
    "",
  ].join("\n"),
  "Part2.cs": [
    "namespace Part;",
    "public partial class PC { int y; }",
    "public partial class PE { public int B() => w; }",
    "",
  ].join("\n"),
};

export async function expectCsharpPartialAndInheritedMembers(
  fixture: Batch3Fixture,
  index: ProjectIndex,
): Promise<void> {
  const part1 = (line: number, token: string, nth = 1): Place => ({ file: "Part1.cs", line, token, nth });
  const part2 = (line: number, token: string, nth = 1): Place => ({ file: "Part2.cs", line, token, nth });
  // Goto reads the other part's field and the inherited field; so do the references of those fields, and the header
  // parameters' references leave the use out.
  await expectGoto(fixture, index, part1(2, "y", 2), part2(2, "y"));
  await expectGoto(fixture, index, part1(4, "z", 2), part1(3, "z"));
  await expectReferences(fixture, index, part1(2, "y"), [part1(2, "y")], "complete");
  await expectReferences(fixture, index, part2(2, "y"), [part2(2, "y"), part1(2, "y", 2)], "complete");
  await expectReferences(fixture, index, part1(4, "z"), [part1(4, "z")], "complete");
  await expectReferences(fixture, index, part1(3, "z"), [part1(3, "z"), part1(4, "z", 2)], "complete");
  // Roslyn also binds the parameter in a part that declares no header; that use stays unresolved here (a documented limit).
  await expectGoto(fixture, index, part2(3, "w"), "not_found");
}

/** Names written before `=` or `:` designate members of another type; the value after them reads the parameter. */
export const CSHARP_DESIGNATOR_SOURCES: Sources = {
  "Desig.cs": [
    "namespace Desig;",
    "public class Dto { public int X; public int Y; public Dto(int X = 0, int Y = 0) { } }",
    "public record Pat(int X, int Y) {",
    "  public bool P1(object o) => o is Dto { X: 1 };",
    "  public Dto N1() => new Dto(X: X);",
    "  public object A1() => new { X = X };",
    "  public (int, int) T1() => (X: X, Y: 2);",
    "  public Dto I1() => new Dto { X = X, Y = Y };",
    "  public Pat W1() => this with { X = X };",
    "  public Other W2() { var plan = new Other(0); return plan with { X = X }; }",
    "}",
    "public record Other(int X);",
    "",
  ].join("\n"),
};

export async function expectCsharpDesignators(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Desig.cs", line, token, nth });
  const header = (token: string): Place => at(3, token);
  await expectGoto(fixture, index, at(4, "X"), at(2, "X"));
  await expectGoto(fixture, index, at(5, "X", 1), at(2, "X", 2));
  await expectGoto(fixture, index, at(5, "X", 2), header("X"));
  await expectGoto(fixture, index, at(6, "X", 1), "not_found");
  await expectGoto(fixture, index, at(6, "X", 2), header("X"));
  await expectGoto(fixture, index, at(7, "X", 1), "not_found");
  await expectGoto(fixture, index, at(7, "X", 2), header("X"));
  await expectGoto(fixture, index, at(7, "Y"), "not_found");
  await expectGoto(fixture, index, at(8, "X", 1), at(2, "X"));
  await expectGoto(fixture, index, at(8, "X", 2), header("X"));
  await expectGoto(fixture, index, at(8, "Y", 1), at(2, "Y"));
  await expectGoto(fixture, index, at(8, "Y", 2), header("Y"));
  await expectGoto(fixture, index, at(9, "X", 1), header("X"));
  await expectGoto(fixture, index, at(9, "X", 2), header("X"));
  await expectGoto(fixture, index, at(10, "X", 1), at(12, "X"));
  await expectGoto(fixture, index, at(10, "X", 2), header("X"));
  await expectReferences(
    fixture,
    index,
    header("X"),
    [
      header("X"),
      at(5, "X", 2),
      at(6, "X", 2),
      at(7, "X", 2),
      at(8, "X", 2),
      at(9, "X", 1),
      at(9, "X", 2),
      at(10, "X", 2),
    ],
    "complete",
  );
  await expectReferences(fixture, index, at(12, "X"), [at(12, "X"), at(10, "X", 1)], "complete");
}

/** Two records declared under `#if`/`#else`, beside a file whose syntax tree is unavailable. */
export const CSHARP_TWIN_SOURCES: Sources = {
  "Twin.cs": [
    "namespace Twin;",
    "#if NEVER",
    'public readonly record struct Row(int Year) : System.IFormattable { public int G() => Year; public string ToString(string f, System.IFormatProvider p) => ""; }',
    "#else",
    'public readonly record struct Row(int Year) : System.IFormattable { public int G() => Year; public string ToString(string f, System.IFormatProvider p) => ""; }',
    "#endif",
    "public partial record Part(int Month) { public int H() => Month; }",
    "",
  ].join("\n"),
  "Peer.cs": ["namespace Twin;", "// CG_NO_TREE", "public class Peer { }", ""].join("\n"),
};

export const CSHARP_TWIN_NO_TREE_MARKER = "CG_NO_TREE";

export async function expectCsharpTwinRecordStructs(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Twin.cs", line, token, nth });
  // Neither twin is `partial` and a struct has no base class: no peer, readable or not, can hide the parameter.
  await expectGoto(fixture, index, at(3, "Year", 2), at(3, "Year"));
  await expectGoto(fixture, index, at(5, "Year", 2), at(5, "Year"));
  // A `partial` record may have a part in the unreadable peer: the parameter is not proven.
  await expectGoto(fixture, index, at(7, "Month", 2), "not_found");
}

type Mutation = {
  label: string;
  apply: (root: string) => Promise<void>;
  /** What each site answers after the mutation: `ok:<file>:<line>` or `not_found`. */
  expected: readonly string[];
};

/**
 * After each mutation a disk-cached build, which reuses what the earlier builds stored, answers every site like a cold
 * build that reads the files again, and like the expected answer.
 */
async function expectWarmMatchesCold(
  fixture: Batch3Fixture,
  sites: readonly Place[],
  mutations: readonly Mutation[],
): Promise<void> {
  const answers = (index: ProjectIndex): Promise<string[]> =>
    Promise.all(
      sites.map(async (place) => {
        const result = await goToDefinition(index, {
          file: fixture.files[place.file]!,
          ...placeOf(fixture.sources, place),
        });
        if (result.status !== "ok") return "not_found";
        return `ok:${path.basename(result.definition.file)}:${result.definition.range.start.line}`;
      }),
    );
  for (const { label, apply, expected } of mutations) {
    await apply(fixture.root);
    const cold = await answers(await buildProjectIndex(fixture.root, { cache: "off" }));
    const warm = await answers(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
    expect(cold, label).toEqual(expected);
    expect(warm, label).toEqual(cold);
  }
}

/** A member of another part hides the header parameter; editing, deleting, renaming, and restoring that part changes it. */
export async function expectPartialPartThroughEdits(fixture: Batch3Fixture): Promise<void> {
  const part2 = path.join(fixture.root, "Part2.cs");
  const renamed = path.join(fixture.root, "Part2Renamed.cs");
  const original = CSHARP_PARTIAL_SOURCES["Part2.cs"]!;
  const sites: Place[] = [
    { file: "Part1.cs", line: 2, token: "y", nth: 2 },
    { file: "Part1.cs", line: 4, token: "z", nth: 2 },
  ];
  await expectWarmMatchesCold(fixture, sites, [
    { label: "initial", apply: async () => {}, expected: ["ok:Part2.cs:2", "ok:Part1.cs:3"] },
    {
      label: "edit",
      apply: () => fsp.writeFile(part2, original.replace("int y;", "int other;")),
      expected: ["ok:Part1.cs:2", "ok:Part1.cs:3"],
    },
    { label: "delete", apply: () => fsp.rm(part2), expected: ["ok:Part1.cs:2", "ok:Part1.cs:3"] },
    { label: "restore", apply: () => fsp.writeFile(part2, original), expected: ["ok:Part2.cs:2", "ok:Part1.cs:3"] },
    { label: "rename", apply: () => fsp.rename(part2, renamed), expected: ["ok:Part2Renamed.cs:2", "ok:Part1.cs:3"] },
    { label: "rename back", apply: () => fsp.rename(renamed, part2), expected: ["ok:Part2.cs:2", "ok:Part1.cs:3"] },
  ]);
}

/** An attribute class and a twin without the suffix are ambiguous; editing, deleting, and restoring the twin changes it. */
export async function expectAttributeTwinThroughEdits(fixture: Batch3Fixture): Promise<void> {
  const lib = path.join(fixture.root, "Lib.cs");
  const renamed = path.join(fixture.root, "LibRenamed.cs");
  const original = CSHARP_ATTRIBUTE_SOURCES["Lib.cs"]!;
  const withoutTwin = original.replace("public class Dual : System.Attribute { }\n", "");
  const sites: Place[] = [
    { file: "Use.cs", line: 3, token: "Marker" },
    { file: "Use.cs", line: 6, token: "Dual" },
  ];
  await expectWarmMatchesCold(fixture, sites, [
    { label: "initial", apply: async () => {}, expected: ["ok:Lib.cs:2", "not_found"] },
    { label: "delete twin", apply: () => fsp.writeFile(lib, withoutTwin), expected: ["ok:Lib.cs:2", "ok:Lib.cs:3"] },
    { label: "restore twin", apply: () => fsp.writeFile(lib, original), expected: ["ok:Lib.cs:2", "not_found"] },
    { label: "rename", apply: () => fsp.rename(lib, renamed), expected: ["ok:LibRenamed.cs:2", "not_found"] },
    { label: "rename back", apply: () => fsp.rename(renamed, lib), expected: ["ok:Lib.cs:2", "not_found"] },
    { label: "delete", apply: () => fsp.rm(lib), expected: ["not_found", "not_found"] },
  ]);
}

/** Selectors and initializer-local variables next to same-named parameters and fields. */
export const CSHARP_SELECTOR_SCOPE_SOURCES: Sources = {
  "Selectors.cs": [
    "class Box { public int Value; }",
    "class Test {",
    "  int Value;",
    "  int M(Box Value) => Value.Value + this.Value + (Value?.Value ?? 0);",
    "}",
    "class Initializers {",
    "  static int x = 9;",
    '  static int A = int.TryParse("1", out var x) ? x : 0;',
    "  static int B = x;",
    "  static int C = 1 is int x ? x : 0;",
    "  static int D = x;",
    '  static int P { get; } = int.TryParse("2", out var y) ? y : 0;',
    "  static int y = 7;",
    "  static int Q = y;",
    "}",
    "class Segment {",
    '  public string Text => "text";',
    "  static Segment Truncate() => new Segment();",
    "  string Render() { var truncated = Truncate(); return truncated?.Text; }",
    "}",
    "static class Extensions {",
    "  static string Normalize(this string text) => text;",
    "  static string Split(string text) => text?.Normalize();",
    "}",
    "",
  ].join("\n"),
};

export async function expectCsharpSelectorAndInitializerScopes(
  fixture: Batch3Fixture,
  index: ProjectIndex,
): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Selectors.cs", line, token, nth });
  await expectGoto(fixture, index, at(4, "Value", 2), at(4, "Value", 1));
  await expectGoto(fixture, index, at(4, "Value", 3), at(1, "Value"));
  await expectGoto(fixture, index, at(4, "Value", 4), at(3, "Value"));
  await expectGoto(fixture, index, at(4, "Value", 5), at(4, "Value", 1));
  await expectReferences(
    fixture,
    index,
    at(4, "Value", 1),
    [at(4, "Value", 1), at(4, "Value", 2), at(4, "Value", 5)],
    "complete",
  );
  await expectGoto(fixture, index, at(8, "x", 2), at(8, "x", 1));
  await expectGoto(fixture, index, at(9, "x"), at(7, "x"));
  await expectGoto(fixture, index, at(10, "x", 2), at(10, "x", 1));
  await expectGoto(fixture, index, at(11, "x"), at(7, "x"));
  await expectGoto(fixture, index, at(12, "y", 2), at(12, "y", 1));
  await expectGoto(fixture, index, at(14, "y"), at(13, "y"));
  await expectGoto(fixture, index, at(19, "Text"), at(17, "Text"));
  await expectGoto(fixture, index, at(23, "Normalize"), at(22, "Normalize"));
  await expectReferences(fixture, index, at(17, "Text"), [at(17, "Text"), at(19, "Text")], "complete");
  await expectReferences(fixture, index, at(22, "Normalize"), [at(22, "Normalize"), at(23, "Normalize")], "complete");
  await expectReferences(fixture, index, at(8, "x", 1), [at(8, "x", 1), at(8, "x", 2)], "complete");
  await expectReferences(fixture, index, at(10, "x", 1), [at(10, "x", 1), at(10, "x", 2)], "complete");
}

/** Attribute arguments can name a callable's parameters before their declarations. */
export const CSHARP_ATTRIBUTE_PARAMETER_SOURCES: Sources = {
  "Attributes.cs": [
    "using System.Diagnostics.CodeAnalysis;",
    "class AttributeParameters {",
    '  string word = "";',
    '  string input = "";',
    "  [return: NotNullIfNotNull(nameof(word))]",
    "  string Echo(string word) => word;",
    "  string Parameter([NotNullIfNotNull(nameof(input))] string input) => input;",
    "  int first, second, local;",
    "  [Name(nameof(first))] public AttributeParameters([Name(nameof(second))] int first, int second) {}",
    "  void LocalOwner() { [Name(nameof(local))] void Local(int local) {} Local(local: 1); }",
    "}",
    "[System.AttributeUsage(System.AttributeTargets.All)] sealed class NameAttribute : System.Attribute { public NameAttribute(string value) {} }",
    "",
  ].join("\n"),
};

export async function expectCsharpAttributeParameters(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Attributes.cs", line, token, nth });
  await expectGoto(fixture, index, at(5, "word"), at(6, "word", 1));
  await expectGoto(fixture, index, at(7, "input", 1), at(7, "input", 2));
  for (const [line, name, useCount] of [
    [9, "first", 2],
    [9, "second", 2],
    [10, "local", 3],
  ] as const) {
    await expectGoto(fixture, index, at(line, name, 1), at(line, name, 2));
    if (useCount === 3) await expectGoto(fixture, index, at(line, name, 3), at(line, name, 2));
    const places = [at(line, name, 1), at(line, name, 2)];
    if (useCount === 3) places.push(at(line, name, 3));
    await expectReferences(fixture, index, at(line, name, 2), places, "complete");
    await expectReferences(fixture, index, at(8, name), [at(8, name)], "complete");
  }
  await expectReferences(
    fixture,
    index,
    at(6, "word", 1),
    [at(5, "word"), at(6, "word", 1), at(6, "word", 2)],
    "complete",
  );
  await expectReferences(
    fixture,
    index,
    at(7, "input", 2),
    [at(7, "input", 1), at(7, "input", 2), at(7, "input", 3)],
    "complete",
  );
  await expectReferences(fixture, index, at(3, "word"), [at(3, "word")], "complete");
  await expectReferences(fixture, index, at(4, "input"), [at(4, "input")], "complete");
  const graph = await buildSymbolGraphDetailed(index);
  const call = placeOf(fixture.sources, at(10, "Local", 2));
  const targets = graph.edges
    .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "LocalOwner")
    .filter((edge) => edge.site?.range.start.line === call.line && edge.site.range.start.column === call.column)
    .map((edge) => graph.nodes.get(edge.to)?.name);
  expect(targets).toEqual(["Local"]);
}

export const CSHARP_RECOVERED_ASSIGNMENT_SOURCES: Sources = {
  "Recovered.cs": [
    "using System.Threading.Tasks;",
    "class Recovered {",
    "  public async Task M(bool async, bool defaultValue, bool expected) {",
    "    var console = new TestConsole().EmitAnsiSequences();",
    "    console.Input.PushKey(ConsoleKey.Enter);",
    "    bool result;",
    "    if (async)",
    "    {",
    '      result = await console.ConfirmAsync("Want some prompt?", defaultValue);',
    "    }",
    "    else",
    "    {",
    '      result = console.Confirm("Want some prompt?", defaultValue);',
    "    }",
    "    result.ShouldBe(expected);",
    "  }",
    "}",
    "",
  ].join("\n"),
};

export async function expectCsharpRecoveredAssignments(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number): Place => ({ file: "Recovered.cs", line, token: "result" });
  for (const line of [9, 13, 15]) await expectGoto(fixture, index, at(line), at(6));
  await expectReferences(fixture, index, at(6), [at(6), at(9), at(13), at(15)], "partial");
}

export const JAVA_SELECTOR_SCOPE_SOURCES: Sources = {
  "Selectors.java": [
    "class Box { int value; }",
    "class Test {",
    "  int value;",
    "  int run(Box value) { return value.value + this.value; }",
    "}",
    "",
  ].join("\n"),
};

export async function expectJavaSelectorScopes(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Selectors.java", line, token, nth });
  await expectGoto(fixture, index, at(4, "value", 2), at(4, "value", 1));
  await expectGoto(fixture, index, at(4, "value", 3), at(1, "value"));
  await expectGoto(fixture, index, at(4, "value", 4), at(3, "value"));
  await expectReferences(fixture, index, at(4, "value", 1), [at(4, "value", 1), at(4, "value", 2)], "complete");
}

export const JAVA_PATTERN_AND_ANNOTATION_SOURCES: Sources = {
  "Patterns.java": [
    "@interface Ann { int value(); String name(); }",
    "record Box(int x) {}",
    "class Test {",
    "  int value;",
    "  String name;",
    '  @Ann(value = 1, name = "test")',
    "  int run(Object o) {",
    "    if (o instanceof String value && value.length() > 0) { return value.length(); }",
    "    if (o instanceof Box(int value) && value > 0) { return value; }",
    "    return switch (o) {",
    "      case String value when value.length() > 0 -> value.length();",
    "      case Box(int value) -> value;",
    "      default -> this.value;",
    "    };",
    "  }",
    "  int other;",
    "  int after(Object o) { if (o instanceof Integer other) { } return other; }",
    "  int negative(Object o) { if (!(o instanceof Integer other)) return 0; return other; }",
    "  int alternative(Object o) { if (o instanceof Integer other) return other; else return other; }",
    "  int lambda(java.util.List<Object> items) { return items.stream().mapToInt(o -> o instanceof Integer other ? other : 0).sum() + other; }",
    "  int ternary(Object o) { return (o instanceof Integer other ? other : 0) + other; }",
    "  int lambdaBlock(Object o) { java.util.function.IntSupplier a = () -> { if (!(o instanceof Integer other)) return 0; return other; }; return other; }",
    "  int block(Object o) { { if (!(o instanceof Integer other)) return 0; } return other; }",
    "}",
    "enum Fields { ONE; int other; int binds(Object o) { if (!(o instanceof Integer other)) return 0; return other; } int reads() { return other; } }",
    "",
  ].join("\n"),
  "scopes/Values.java": "package scopes; public class Values { public static int NAME = 1; }\n",
  "scopes/Constants.java": [
    "package scopes;",
    "import static scopes.Values.NAME;",
    "interface Constants {",
    "  default int binds(Object o) { if (!(o instanceof Integer NAME)) return 0; return NAME; }",
    "  default int reads() { return NAME; }",
    "}",
    "",
  ].join("\n"),
};

export async function expectJavaPatternAndAnnotationBindings(
  fixture: Batch3Fixture,
  index: ProjectIndex,
): Promise<void> {
  const at = (line: number, token: string, nth = 1): Place => ({ file: "Patterns.java", line, token, nth });
  await expectGoto(fixture, index, at(6, "value"), at(1, "value"));
  await expectGoto(fixture, index, at(6, "name"), at(1, "name"));
  await expectReferences(fixture, index, at(1, "value"), [at(1, "value"), at(6, "value")], "complete");
  await expectReferences(fixture, index, at(1, "name"), [at(1, "name"), at(6, "name")], "complete");
  for (const line of [8, 9, 11, 12]) {
    const declaration = at(line, "value", 1);
    await expectGoto(fixture, index, at(line, "value", 2), declaration);
    if (line !== 12) await expectGoto(fixture, index, at(line, "value", 3), declaration);
    const refs = [declaration, at(line, "value", 2)];
    if (line !== 12) refs.push(at(line, "value", 3));
    await expectReferences(fixture, index, declaration, refs, "complete");
  }
  await expectGoto(fixture, index, at(13, "value"), at(4, "value"));
  await expectGoto(fixture, index, at(17, "other", 2), at(16, "other"));
  await expectGoto(fixture, index, at(18, "other", 2), "not_found");
  await expectGoto(fixture, index, at(19, "other", 3), at(16, "other"));
  for (const line of [20, 21, 22]) {
    await expectGoto(fixture, index, at(line, "other", 2), "not_found");
    await expectGoto(fixture, index, at(line, "other", 3), at(16, "other"));
  }
  await expectGoto(fixture, index, at(23, "other", 2), at(16, "other"));
  await expectGoto(fixture, index, at(25, "other", 3), "not_found");
  await expectGoto(fixture, index, at(25, "other", 4), at(25, "other", 1));
  const inInterface = (line: number, nth = 1): Place => ({ file: "scopes/Constants.java", line, token: "NAME", nth });
  await expectGoto(fixture, index, inInterface(4, 2), "not_found");
  await expectGoto(fixture, index, inInterface(5), { file: "scopes/Values.java", token: "NAME" });
}

export const JAVA_ANNOTATION_COVERAGE_SOURCES: Sources = {
  "AnnotationCoverage.java": [
    "import external.Column;",
    "@interface Other { String name(); }",
    "class Entity {",
    '  @Column(name = "n")',
    "  String name;",
    "  String read() { return name; }",
    "  String name() { return name; }",
    "  String call() { return name(); }",
    "  void param(String name) { System.out.println(name); }",
    "}",
    "",
  ].join("\n"),
};

export async function expectJavaAnnotationCoverage(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, nth = 1): Place => ({ file: "AnnotationCoverage.java", line, token: "name", nth });
  await expectGoto(fixture, index, at(4), "not_found");
  await expectReferences(fixture, index, at(5), [at(5), at(6), at(7, 2)], "complete");
  await expectReferences(fixture, index, at(7), [at(7), at(8)], "complete");
  await expectReferences(fixture, index, at(9), [at(9), at(9, 2)], "complete");
  await expectReferences(fixture, index, at(2), [at(2)], "partial");
}

export const CSHARP_LABEL_COVERAGE_SOURCES: Sources = {
  "Labels.cs": [
    "class Labels {",
    "  int value;",
    "  int Run(int value) {",
    "    var tuple = (value: value, other: 0);",
    "    var anonymous = new { value = value };",
    "    var shorthand = new { value };",
    "    return value + this.value;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

export async function expectCsharpLabelCoverage(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (line: number, nth = 1): Place => ({ file: "Labels.cs", line, token: "value", nth });
  await expectGoto(fixture, index, at(4), "not_found");
  await expectGoto(fixture, index, at(5), "not_found");
  await expectReferences(fixture, index, at(2), [at(2), at(7, 2)], "complete");
  await expectReferences(fixture, index, at(3), [at(3), at(4, 2), at(5, 2), at(6), at(7)], "complete");
}

/** Call labels name the selected callable's parameters, not fields of the calling type. */
export const CSHARP_NAMED_ARGUMENT_SOURCES: Sources = {
  "Api.cs": [
    "namespace Labels;",
    "public class Api {",
    "  public int Echo(int item) => item;",
    "  public Api(int number) { }",
    "  public const int Unit = 8;",
    "}",
    "",
  ].join("\n"),
  "Use.cs": [
    "namespace Labels;",
    "class Use {",
    "  int item = 7;",
    "  int number = 8;",
    "  int Run(Api other) => other.Echo(item: item);",
    "  Api Make() => new Api(number: number);",
    "  int U() => Api.Unit;",
    "  int Unit = 1;",
    "  int V() => Unit;",
    "}",
    "",
  ].join("\n"),
  "Comments.cs": [
    "namespace Labels;",
    "class Comments {",
    "  int Run(Api api, int value) => api.Echo(@item /* label */ : value);",
    "  int Next(Api api, int value) => api.Echo(item // label",
    "    : value);",
    "}",
    "",
  ].join("\n"),
  "Unicode.cs": [
    "namespace Labels;",
    "class Unicode {",
    "  int Run(Api api, int value) => api.Echo(it\u200cem: value);",
    "}",
    "",
  ].join("\n"),
  "Extension.cs": [
    "namespace Labels;",
    "static class Extensions { public static int Convert(this string text, int amount) => amount; }",
    "class ExtensionUse {",
    "  int amount;",
    "  int Convert(int amount) => amount;",
    "  int Run(string text) => text.Convert(amount: amount);",
    "}",
    "",
  ].join("\n"),
};

export async function expectCsharpNamedArguments(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const at = (file: string, line: number, token: string, nth = 1): Place => ({ file, line, token, nth });
  const methodParameter = at("Api.cs", 3, "item");
  const constructorParameter = at("Api.cs", 4, "number");
  await expectGoto(fixture, index, at("Use.cs", 5, "item"), methodParameter);
  await expectGoto(fixture, index, at("Use.cs", 5, "item", 2), at("Use.cs", 3, "item"));
  await expectGoto(fixture, index, at("Comments.cs", 3, "item"), methodParameter);
  await expectGoto(fixture, index, at("Comments.cs", 4, "item"), methodParameter);
  await expectGoto(fixture, index, at("Unicode.cs", 3, "it\u200cem"), methodParameter);
  await expectGoto(fixture, index, at("Use.cs", 6, "number"), constructorParameter);
  await expectGoto(fixture, index, at("Use.cs", 6, "number", 2), at("Use.cs", 4, "number"));
  await expectGoto(fixture, index, at("Use.cs", 7, "Unit"), at("Api.cs", 5, "Unit"));
  await expectGoto(fixture, index, at("Use.cs", 9, "Unit"), at("Use.cs", 8, "Unit"));
  await expectGoto(fixture, index, at("Extension.cs", 6, "amount"), "not_found");
  await expectGoto(fixture, index, at("Extension.cs", 6, "amount", 2), at("Extension.cs", 4, "amount"));
  await expectReferences(
    fixture,
    index,
    at("Api.cs", 5, "Unit"),
    [at("Api.cs", 5, "Unit"), at("Use.cs", 7, "Unit")],
    "complete",
  );
  await expectReferences(
    fixture,
    index,
    at("Extension.cs", 2, "amount"),
    [at("Extension.cs", 2, "amount"), at("Extension.cs", 2, "amount", 2)],
    "partial",
  );
  await expectReferences(
    fixture,
    index,
    at("Extension.cs", 5, "amount"),
    [at("Extension.cs", 5, "amount"), at("Extension.cs", 5, "amount", 2)],
    "partial",
  );
  await expectReferences(
    fixture,
    index,
    methodParameter,
    [
      methodParameter,
      at("Api.cs", 3, "item", 2),
      at("Comments.cs", 3, "item"),
      at("Comments.cs", 4, "item"),
      at("Unicode.cs", 3, "it\u200cem"),
      at("Use.cs", 5, "item"),
    ],
    "complete",
  );
  await expectReferences(
    fixture,
    index,
    constructorParameter,
    [constructorParameter, at("Use.cs", 6, "number")],
    "complete",
  );
}

/** Named labels follow their callable as its declaration is edited, removed, restored, and renamed. */
export async function expectCsharpNamedArgumentsThroughEdits(fixture: Batch3Fixture): Promise<void> {
  const apiFile = path.join(fixture.root, "Api.cs");
  const renamedFile = path.join(fixture.root, "ApiRenamed.cs");
  const original = CSHARP_NAMED_ARGUMENT_SOURCES["Api.cs"]!;
  const edited = original.replace("Echo(int item) => item;", "Echo(int entry) => entry;");
  const label = placeOf(fixture.sources, { file: "Use.cs", line: 5, token: "item" });
  const value = placeOf(fixture.sources, { file: "Use.cs", line: 5, token: "item", nth: 2 });
  const answer = async (index: ProjectIndex) => {
    const result = await goToDefinition(index, { file: fixture.files["Use.cs"]!, ...label });
    const field = await goToDefinition(index, { file: fixture.files["Use.cs"]!, ...value });
    const fieldTarget =
      field.status === "ok"
        ? `${path.basename(field.definition.file)}:${field.definition.range.start.line}`
        : field.status;
    if (result.status !== "ok") return { target: result.status, fieldTarget, references: [], coverage: "" };
    const definition = result.definition;
    const refs = await findReferences(index, { file: definition.file, ...definition.range.start });
    if (refs.status !== "ok") throw new Error(`Named argument references: ${refs.status}`);
    return {
      target: `${path.basename(definition.file)}:${definition.range.start.line}`,
      fieldTarget,
      references: refs.references
        .map((ref) => `${path.basename(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`)
        .sort(),
      coverage: refs.referenceCoverage.state,
    };
  };
  const mutations = [
    { label: "initial", apply: async () => {}, target: "Api.cs:3" },
    { label: "edit", apply: () => fsp.writeFile(apiFile, edited), target: "not_found" },
    { label: "delete", apply: () => fsp.rm(apiFile), target: "not_found" },
    { label: "restore", apply: () => fsp.writeFile(apiFile, original), target: "Api.cs:3" },
    { label: "rename", apply: () => fsp.rename(apiFile, renamedFile), target: "ApiRenamed.cs:3" },
    { label: "rename back", apply: () => fsp.rename(renamedFile, apiFile), target: "Api.cs:3" },
  ];
  try {
    for (const mutation of mutations) {
      await mutation.apply();
      const cold = await answer(await buildProjectIndex(fixture.root, { cache: "off" }));
      const warm = await answer(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
      const memory = await answer(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
      closeDiskCacheDatabase(fixture.root);
      const reopened = await answer(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
      expect(cold.target, mutation.label).toBe(mutation.target);
      expect(cold.fieldTarget, mutation.label).toBe("Use.cs:3");
      if (mutation.target !== "not_found") {
        expect(cold.coverage, mutation.label).toBe("complete");
        expect(cold.references, mutation.label).toContain(`Use.cs:${label.line}:${label.column}`);
        expect(cold.references, mutation.label).not.toContain(`Use.cs:${value.line}:${value.column}`);
      }
      expect(warm, mutation.label).toEqual(cold);
      expect(memory, mutation.label).toEqual(cold);
      expect(reopened, mutation.label).toEqual(cold);
    }
  } finally {
    closeDiskCacheDatabase(fixture.root);
  }
}

export type Batch3Case = {
  name: string;
  language: "csharp" | "java";
  /** Whether the check asserts `findReferences` results and coverage. */
  references: boolean;
  sources: Sources;
  check: (fixture: Batch3Fixture, index: ProjectIndex) => Promise<void>;
};

/** Every static-receiver, record-parameter, attribute, and binder fixture, with the assertions that go with it. */
export const BATCH3_CASES: readonly Batch3Case[] = [
  {
    name: "initializer members, record selectors, and query source variables",
    language: "csharp",
    references: true,
    sources: CSHARP_BATCH5_REVIEW_SOURCES,
    check: expectCsharpBatch5Review,
  },
  {
    name: "initializer lambda members and varargs parameters",
    language: "java",
    references: true,
    sources: JAVA_BATCH5_REVIEW_SOURCES,
    check: expectJavaBatch5Review,
  },
  {
    name: "query ranges, pointer expressions, and selector coverage",
    language: "csharp",
    references: true,
    sources: CSHARP_BATCH5_SOURCES,
    check: expectCsharpBatch5,
  },
  {
    name: "switch labels, lambda parameters, and ternary patterns",
    language: "java",
    references: true,
    sources: JAVA_BATCH5_SOURCES,
    check: expectJavaBatch5,
  },
  {
    name: "T.Static() beside typed members",
    language: "csharp",
    references: false,
    sources: CSHARP_STATIC_RECEIVER_SOURCES,
    check: expectStaticReceiverEdges,
  },
  {
    name: "record and primary-constructor parameters",
    language: "csharp",
    references: true,
    sources: CSHARP_RECORD_SOURCES,
    check: expectCsharpRecordComponents,
  },
  {
    name: "attribute names",
    language: "csharp",
    references: true,
    sources: CSHARP_ATTRIBUTE_SOURCES,
    check: expectCsharpAttributeNames,
  },
  {
    name: "nearer binders",
    language: "csharp",
    references: true,
    sources: CSHARP_BINDER_SOURCES,
    check: expectCsharpBinderForms,
  },
  {
    name: "base-constructor arguments",
    language: "csharp",
    references: false,
    sources: CSHARP_HERITAGE_SOURCES,
    check: expectCsharpHeritageArguments,
  },
  {
    name: "parameters named like their type",
    language: "csharp",
    references: true,
    sources: CSHARP_COLOR_COLOR_SOURCES,
    check: expectCsharpColorColorHeaders,
  },
  {
    name: "members of other parts and base classes",
    language: "csharp",
    references: true,
    sources: CSHARP_PARTIAL_SOURCES,
    check: expectCsharpPartialAndInheritedMembers,
  },
  {
    name: "member designators",
    language: "csharp",
    references: true,
    sources: CSHARP_DESIGNATOR_SOURCES,
    check: expectCsharpDesignators,
  },
  {
    name: "selectors and initializer variables",
    language: "csharp",
    references: true,
    sources: CSHARP_SELECTOR_SCOPE_SOURCES,
    check: expectCsharpSelectorAndInitializerScopes,
  },
  {
    name: "parameters in attributes",
    language: "csharp",
    references: true,
    sources: CSHARP_ATTRIBUTE_PARAMETER_SOURCES,
    check: expectCsharpAttributeParameters,
  },
  {
    name: "recovered assignments",
    language: "csharp",
    references: true,
    sources: CSHARP_RECOVERED_ASSIGNMENT_SOURCES,
    check: expectCsharpRecoveredAssignments,
  },
  {
    name: "named arguments",
    language: "csharp",
    references: true,
    sources: CSHARP_NAMED_ARGUMENT_SOURCES,
    check: expectCsharpNamedArguments,
  },
  {
    name: "member selectors",
    language: "java",
    references: true,
    sources: JAVA_SELECTOR_SCOPE_SOURCES,
    check: expectJavaSelectorScopes,
  },
  {
    name: "pattern variables and annotation elements",
    language: "java",
    references: true,
    sources: JAVA_PATTERN_AND_ANNOTATION_SOURCES,
    check: expectJavaPatternAndAnnotationBindings,
  },
  {
    name: "record components",
    language: "java",
    references: true,
    sources: JAVA_RECORD_SOURCES,
    check: expectJavaRecordComponents,
  },
  {
    name: "nearer binders",
    language: "java",
    references: true,
    sources: JAVA_BINDER_SOURCES,
    check: expectJavaBinderForms,
  },
  {
    name: "annotation key coverage",
    language: "java",
    references: true,
    sources: JAVA_ANNOTATION_COVERAGE_SOURCES,
    check: expectJavaAnnotationCoverage,
  },
  {
    name: "non-reference labels",
    language: "csharp",
    references: true,
    sources: CSHARP_LABEL_COVERAGE_SOURCES,
    check: expectCsharpLabelCoverage,
  },
];
