import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";

export type Sources = Readonly<Record<string, string>>;
export type Place = { file: string; token: string; nth?: number; line?: number };

/** 1-based line and column of the `nth` whole-word `token` on `line` (or in the file when no line is given). */
export function placeOf(sources: Sources, place: Place): { line: number; column: number } {
  const lines = sources[place.file]!.split("\n");
  const wanted = new RegExp(`(?<![\\w@])@?${place.token.replace("@", "")}(?!\\w)`, "gu");
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (place.line !== undefined && place.line !== index + 1) continue;
    for (const match of lines[index]!.matchAll(wanted)) {
      seen += 1;
      if (seen === (place.nth ?? 1)) return { line: index + 1, column: match.index + 1 };
    }
  }
  throw new Error(`${place.file}: no #${place.nth ?? 1} ${place.token} on line ${place.line ?? "any"}`);
}

export type Batch3Fixture = { root: string; files: Record<string, string>; sources: Sources };

export async function withBatch3Fixture<T>(
  prefix: string,
  sources: Sources,
  run: (fixture: Batch3Fixture) => Promise<T>,
): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const files = await writeFixtureFiles(root, sources);
    return await run({ root, files, sources });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** The same assertions through an in-memory build, a cold disk build, and a reopened disk cache. */
export async function eachIndexMode(
  fixture: Batch3Fixture,
  check: (index: ProjectIndex) => Promise<void>,
): Promise<void> {
  await check(await buildProjectIndex(fixture.root, { cache: "off" }));
  await check(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
  await check(await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 }));
}

export type Target = Place | "not_found";

export async function expectGoto(
  fixture: Batch3Fixture,
  index: ProjectIndex,
  use: Place,
  target: Target,
): Promise<void> {
  const at = placeOf(fixture.sources, use);
  const label = `${use.file}:${at.line}:${use.token}#${use.nth ?? 1}`;
  const result = await goToDefinition(index, { file: fixture.files[use.file]!, line: at.line, column: at.column });
  if (target === "not_found") {
    expect(result.status, label).toBe("not_found");
    return;
  }
  expect(result.status, label).toBe("ok");
  if (result.status !== "ok") return;
  const expected = placeOf(fixture.sources, target);
  expect(fileIdentityKey(result.definition.file), label).toBe(fileIdentityKey(fixture.files[target.file]!));
  expect([result.definition.range.start.line, result.definition.range.start.column], label).toEqual([
    expected.line,
    expected.column,
  ]);
}

export async function expectReferences(
  fixture: Batch3Fixture,
  index: ProjectIndex,
  declaration: Place,
  expected: readonly Place[],
  coverage: "complete" | "partial",
): Promise<void> {
  const at = placeOf(fixture.sources, declaration);
  const result = await findReferences(index, {
    file: fixture.files[declaration.file]!,
    line: at.line,
    column: at.column,
  });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  const found = result.references
    .map(
      (reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}:${reference.range.start.column}`,
    )
    .sort();
  const wanted = expected
    .map((place) => {
      const position = placeOf(fixture.sources, place);
      return `${fileIdentityKey(fixture.files[place.file]!)}:${position.line}:${position.column}`;
    })
    .sort();
  expect(found).toEqual(wanted);
  expect(result.referenceCoverage.state).toBe(coverage);
}

/** `T.Static()` with a field, property, local, or parameter typed `T`, a same-named decoy, and a value named like `T`. */
export const CSHARP_STATIC_RECEIVER_SOURCES: Sources = {
  "Lib.cs": [
    "namespace Lib;",
    "public class Widget { public static int Make() => 1; public int Inst() => 2; }",
    "public class Other { public int Make() => 3; }",
    "",
  ].join("\n"),
  "Decoy.cs": [
    "namespace Decoy;",
    "public class Widget { public static int Make() => -1; public int Inst() => -2; }",
    "",
  ].join("\n"),
  "UseField.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseField { public Widget w; public int F() => Widget.Make(); }",
    "",
  ].join("\n"),
  "UseProp.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseProp { public Widget W { get; set; } public int F() => Widget.Make(); }",
    "",
  ].join("\n"),
  "UseLocal.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseLocal { public int F() { Widget w = null; return Widget.Make(); } }",
    "",
  ].join("\n"),
  "UseParam.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseParam { public int F(Widget w) => Widget.Make(); }",
    "",
  ].join("\n"),
  "UseMulti.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseMulti { public Widget a, b; public int F() => Widget.Make(); }",
    "",
  ].join("\n"),
  "UseInit.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseInit { public Widget P { get; } = null; public int F() => Widget.Make(); }",
    "",
  ].join("\n"),
  "UseUsing.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseUsing { public int F() { using (Widget w = null) { return Widget.Make(); } } }",
    "",
  ].join("\n"),
  // A field, a local, and a parameter named like their own type: the instance call still reaches `Widget.Inst`.
  "UseColor.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseColor {",
    "  public Widget Widget;",
    "  public int F() => Widget.Inst();",
    "  public int G() { Widget Widget = null; return Widget.Inst(); }",
    "  public int H(Widget Widget) => Widget.Inst();",
    "}",
    "",
  ].join("\n"),
  "UseValue.cs": [
    "using Lib;",
    "namespace App;",
    "public class UseValue { Other Widget; public int F() => Widget.Make(); }",
    "",
  ].join("\n"),
};

export async function expectStaticReceiverEdges(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const widgetMake: Place = { file: "Lib.cs", token: "Make", line: 2 };
  const target = await goToDefinition(index, {
    file: fixture.files["Lib.cs"]!,
    ...placeOf(fixture.sources, widgetMake),
  });
  if (target.status !== "ok") throw new Error("Widget.Make is not indexed");
  const widgetMakeId = defNodeId(target.definition);
  const callsFrom = (file: string): string[] =>
    graph.edges
      .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.file === fixture.files[file])
      .map((edge) => edge.to);
  for (const file of [
    "UseField.cs",
    "UseProp.cs",
    "UseLocal.cs",
    "UseParam.cs",
    "UseMulti.cs",
    "UseInit.cs",
    "UseUsing.cs",
  ]) {
    expect(callsFrom(file), file).toEqual([widgetMakeId]);
    await expectGoto(fixture, index, { file, token: "Make" }, widgetMake);
  }
  // A field, a local, and a parameter named like their own type still call the instance method of that type.
  const inst: Place = { file: "Lib.cs", token: "Inst", line: 2 };
  const instTarget = await goToDefinition(index, { file: fixture.files["Lib.cs"]!, ...placeOf(fixture.sources, inst) });
  if (instTarget.status !== "ok") throw new Error("Widget.Inst is not indexed");
  expect(callsFrom("UseColor.cs")).toEqual(Array(3).fill(defNodeId(instTarget.definition)));
  for (const line of [5, 6, 7]) await expectGoto(fixture, index, { file: "UseColor.cs", line, token: "Inst" }, inst);
  // A value named `Widget` is not the type: no edge reaches the static `Widget.Make`, and nothing reaches the decoy.
  expect(callsFrom("UseValue.cs")).not.toContain(widgetMakeId);
  for (const edge of graph.edges.filter((candidate) => candidate.label === "calls")) {
    expect(graph.nodes.get(edge.to)?.file).not.toBe(fixture.files["Decoy.cs"]);
  }
}

/** Record components and primary-constructor parameters in bodies, with decoys and Roslyn's lookup order. */
export const CSHARP_RECORD_SOURCES: Sources = {
  "Records.cs": [
    "namespace Rec;",
    "public class Dto { public int Id; public int X { get; set; } }",
    "public record Person(string FirstName, string LastName) { public string Full() => FirstName + LastName; }",
    'public record Teacher(string FirstName, string Subject) : Person(FirstName, "x") { public string D() => FirstName + Subject; }',
    "public record Point(int X, int Y) { public int Sum() => X + Y; public Dto ToDto() => new Dto { Id = Y, X = X }; public Point Bump() => this with { X = X + 1 }; }",
    "public record Named(string Name) { public string Name { get; init; } = Name; public string Up() => Name.ToUpper(); }",
    "public record Outer(int O) { public record Inner(int I) { public int G() => I; } public int H() => O; }",
    "public record Gen<T>(T Item) { public T Get() => Item; }",
    "public class Svc(int count) { public int Twice() => count * 2; }",
    "public class Unrelated { public int X; public int Read() => X; public int Missing() => Y; }",
    "",
  ].join("\n"),
};

export async function expectCsharpRecordComponents(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const f = "Records.cs";
  const goto = (line: number, token: string, nth: number, target: Target): Promise<void> =>
    expectGoto(fixture, index, { file: f, line, token, nth }, target);
  const own = (line: number, token: string, nth = 1): Place => ({ file: f, line, token, nth });
  await goto(3, "FirstName", 2, own(3, "FirstName"));
  await goto(3, "LastName", 2, own(3, "LastName"));
  // A derived record that repeats a base parameter reads the inherited property in its body, its own parameter in the
  // base arguments.
  await goto(4, "FirstName", 2, own(4, "FirstName"));
  await goto(4, "FirstName", 3, own(3, "FirstName"));
  await goto(4, "Subject", 2, own(4, "Subject"));
  await goto(5, "X", 2, own(5, "X"));
  await goto(5, "Y", 2, own(5, "Y"));
  await goto(5, "Y", 3, own(5, "Y"));
  // `X =` in an object or `with` initializer names a member of the initialized type; the value read is the parameter.
  await goto(5, "X", 3, "not_found");
  await goto(5, "X", 4, own(5, "X"));
  await goto(5, "X", 5, "not_found");
  await goto(5, "X", 6, own(5, "X"));
  // A body member of the same name wins in a member body; an initializer still reads the parameter.
  await goto(6, "Name", 3, own(6, "Name"));
  await goto(6, "Name", 4, own(6, "Name", 2));
  // Nested and generic records, and a primary-constructor class.
  await goto(7, "I", 2, own(7, "I"));
  await goto(7, "O", 2, own(7, "O"));
  await goto(8, "Item", 2, own(8, "Item"));
  await goto(9, "count", 2, own(9, "count"));
  // Another type's same-named field binds there; a name no type declares stays unresolved.
  await goto(10, "X", 2, own(10, "X"));
  await goto(10, "Y", 1, "not_found");
  await expectReferences(fixture, index, own(5, "Y"), [own(5, "Y"), own(5, "Y", 2), own(5, "Y", 3)], "complete");
  // `with { X = ... }` and `new Dto { X = ... }` may name another type's member, so coverage says so.
  await expectReferences(
    fixture,
    index,
    own(5, "X"),
    [own(5, "X"), own(5, "X", 2), own(5, "X", 4), own(5, "X", 6)],
    "partial",
  );
}

export const JAVA_RECORD_SOURCES: Sources = {
  "Rec.java": [
    "public record Rec(int value, String label) {",
    "  static int COUNT = 0;",
    "  Rec { value = value + 1; }",
    "  int twice() { return value * 2; }",
    "  String tag() { return label; }",
    "  class Inner { int peek() { return value; } }",
    "  int shadow(int value) { return value; }",
    "  record Nested(int value) { int own() { return value; } }",
    "}",
    "",
  ].join("\n"),
  "Other.java": "public class Other { int g() { return value; } }\n",
  // A component named like its own type is not bound: type positions and `Money.LIMIT` read the type.
  "Money.java": "package app;\npublic class Money { static int LIMIT = 1; }\n",
  "Order.java": [
    "package app;",
    "public record Order(Money Money, int qty) {",
    "  Money copy(Money other) { return other; }",
    "  int limit() { return Money.LIMIT; }",
    "}",
    "",
  ].join("\n"),
  "Pat.java": [
    "public record Pat(int value) {",
    "  int p(Object o) { if (o instanceof Integer value) { return value; } return 0; }",
    "  int q() { return value; }",
    "}",
    "",
  ].join("\n"),
};

export async function expectJavaRecordComponents(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const goto = (file: string, line: number, token: string, nth: number, target: Target): Promise<void> =>
    expectGoto(fixture, index, { file, line, token, nth }, target);
  const declared = (file: string, line: number, token: string, nth = 1): Place => ({ file, line, token, nth });
  const value = declared("Rec.java", 1, "value");
  await goto("Rec.java", 3, "value", 1, value);
  await goto("Rec.java", 3, "value", 2, value);
  await goto("Rec.java", 4, "value", 1, value);
  await goto("Rec.java", 5, "label", 1, declared("Rec.java", 1, "label"));
  await goto("Rec.java", 6, "value", 1, value);
  // A method parameter and a nested record's own component are closer; another class never sees the component.
  await goto("Rec.java", 7, "value", 2, declared("Rec.java", 7, "value"));
  await goto("Rec.java", 8, "value", 2, declared("Rec.java", 8, "value"));
  await goto("Other.java", 1, "value", 1, "not_found");
  const money: Place = { file: "Money.java", token: "Money", line: 2 };
  await goto("Order.java", 3, "Money", 1, money);
  await goto("Order.java", 3, "Money", 2, money);
  await goto("Order.java", 4, "LIMIT", 1, { file: "Money.java", token: "LIMIT", line: 2 });
  // A pattern variable of the component's name is not bound by the scope, so the use stays unresolved.
  await goto("Pat.java", 2, "value", 2, "not_found");
  await goto("Pat.java", 3, "value", 1, declared("Pat.java", 1, "value"));
  await expectReferences(
    fixture,
    index,
    value,
    [
      value,
      declared("Rec.java", 3, "value"),
      declared("Rec.java", 3, "value", 2),
      declared("Rec.java", 4, "value"),
      declared("Rec.java", 6, "value"),
    ],
    "complete",
  );
}

/** `[Marker]` names `MarkerAttribute`; both `Dual` and `DualAttribute` is the ambiguity C# rejects. */
export const CSHARP_ATTRIBUTE_SOURCES: Sources = {
  "Lib.cs": [
    "namespace Lib;",
    "public class MarkerAttribute : System.Attribute { }",
    "public class Dual : System.Attribute { }",
    "public class DualAttribute : System.Attribute { }",
    "",
  ].join("\n"),
  "Decoy.cs": ["namespace Decoy;", "public class Marker { }", ""].join("\n"),
  // A file in the declaring namespace reads the attributes without a `using`.
  "Peer.cs": ["namespace Lib;", "[Marker] public class PeerA { }", "[Dual] public class PeerB { }", ""].join("\n"),
  "Use.cs": [
    "using Lib;",
    "namespace App;",
    "[Marker] public class A { }",
    "[Marker()] public class B { }",
    "[MarkerAttribute] public class C { }",
    "[Dual] public class D { }",
    "[@Dual] public class E { }",
    "[DualAttribute] public class F { }",
    "[Marker, Dual] public class G { }",
    "",
  ].join("\n"),
};

export async function expectCsharpAttributeNames(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const marker: Place = { file: "Lib.cs", token: "MarkerAttribute", line: 2 };
  const use = (line: number, token: string): Place => ({ file: "Use.cs", line, token });
  for (const [line, token] of [
    [3, "Marker"],
    [4, "Marker"],
    [5, "MarkerAttribute"],
    [9, "Marker"],
  ] as const) {
    await expectGoto(fixture, index, use(line, token), marker);
  }
  await expectGoto(fixture, index, use(6, "Dual"), "not_found");
  await expectGoto(fixture, index, use(7, "@Dual"), { file: "Lib.cs", token: "Dual", line: 3 });
  await expectGoto(fixture, index, use(8, "DualAttribute"), { file: "Lib.cs", token: "DualAttribute", line: 4 });
  const peer = (line: number, token: string): Place => ({ file: "Peer.cs", line, token });
  await expectGoto(fixture, index, peer(2, "Marker"), marker);
  await expectGoto(fixture, index, peer(3, "Dual"), "not_found");
  await expectReferences(
    fixture,
    index,
    marker,
    [marker, use(3, "Marker"), use(4, "Marker"), use(5, "MarkerAttribute"), use(9, "Marker"), peer(2, "Marker")],
    "complete",
  );
  // A name that matches both classes is no reference of either, and either may be the one meant: coverage is partial.
  const dual: Place = { file: "Lib.cs", token: "Dual", line: 3 };
  const dualAttribute: Place = { file: "Lib.cs", token: "DualAttribute", line: 4 };
  await expectReferences(fixture, index, dual, [dual, use(7, "@Dual")], "partial");
  await expectReferences(fixture, index, dualAttribute, [dualAttribute, use(8, "DualAttribute")], "partial");
  // The decoy `Decoy.Marker` is not imported: no attribute names it.
  await expectReferences(
    fixture,
    index,
    { file: "Decoy.cs", token: "Marker", line: 2 },
    [{ file: "Decoy.cs", token: "Marker", line: 2 }],
    "complete",
  );
}
