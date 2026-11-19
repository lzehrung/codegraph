import fsp from "node:fs/promises";
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
import { clearMemoryCache, closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import {
  expectGoto,
  expectReferences,
  placeOf,
  type Batch3Fixture,
  type Place,
  type Sources,
} from "./csharp-java-batch3-fixture.js";

// Expected bindings checked with Roslyn, javac 21, and swiftc 5.10.
export const CSHARP_BATCH6_SOURCES: Sources = {
  "Scopes.cs": [
    "using System;",
    "class Scopes {",
    "  int x = 99;",
    "  static int[] Make(out int value) { value = 3; return new[] { value }; }",
    "  int Foreach() { foreach (var a in Make(out var x)) { Console.WriteLine(x); } return x; }",
    "  int ForeachPattern(object o) { foreach (var a in (o is int x ? new[] { x } : throw new Exception())) { Console.WriteLine(x); } return x; }",
    '  int While() { while (int.TryParse("1", out var x)) { return x; } return x; }',
    "  int WhilePattern(object o) { while (o is int x) { return x; } return x; }",
    "  int Arm(object o) => o switch { int x => x, _ => x };",
    '  int ArmOut(int n) => n switch { 0 when int.TryParse("1", out var x) => x, _ => x };',
    "}",
    "",
  ].join("\n"),
  "Records.cs": [
    "public record Person(string Name, int Age);",
    "public readonly record struct Point(string Label);",
    "public record Own(string Name) { public string Name { get; init; } = Name; }",
    "public record OwnField(string Name) { public string Name = Name; }",
    "public record Base(string Name);",
    "public record Derived(string Name) : Base(Name);",
    "public class Decoy { public string Name { get; set; } }",
    "public class Primary(string Name) { public string Read() => Name; }",
    "",
  ].join("\n"),
  "Readers.cs": [
    "class Readers {",
    "  string PersonRead(Person p) => p.Name;",
    "  string LocalRead(Person source) { Person p = source; return p.Name; }",
    '  Person Copy(Person p) => p with { Name = "copy" };',
    "  string Deconstruct(Person p) { var (copied, age) = p; return copied; }",
    "  string PointRead(Point p) => p.Label;",
    "  string OwnRead(Own p) => p.Name;",
    "  string FieldRead(OwnField p) => p.Name;",
    "  string DerivedRead(Derived p) => p.Name;",
    "  string DecoyRead(Decoy p) => p.Name;",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_RECORD_TYPED_SOURCES: Sources = {
  "Person.cs": "public record Person(string Name);\n",
  "Reader.cs": "class Reader { string Read(Person p) => p.Name; }\n",
};

// Roslyn rejects the two member reads with CS1061: primary-constructor parameters are not properties.
export const CSHARP_PRIMARY_NONMEMBER_SOURCES: Sources = {
  "Primary.cs": [
    "class Primary(string Name) { public string Read() => Name; }",
    "struct Value(string Name) { public string Read() => Name; }",
    "class Reader {",
    "  string Read(Primary p) => p.Name;",
    "  string Read(Value p) => p.Name;",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_FOREACH_REVIEW_SOURCES: Sources = {
  "Foreach.cs": [
    "using System;",
    "class ForeachScopes {",
    "  int x = 99;",
    "  static int[] Seq(int n) => new[] { n };",
    "  static bool Try(object o, out int n) { n = 1; return true; }",
    "  int Typed() { foreach ((int x, int y) in new[] { (x, 2) }) { Console.WriteLine(x); } return x; }",
    "  int Vars() { foreach ((var x, var y) in new[] { (x, 2) }) { Console.WriteLine(x); } return x; }",
    "  int Nested() { foreach ((int x, (int y, int z)) in new[] { (x, (2, 3)) }) Console.WriteLine(x); return x; }",
    "  int Embedded() { foreach (var v in Seq(x)) Try(null, out var x); return x; }",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_RECORD_REVIEW_SOURCES: Sources = {
  "Shapes.cs": [
    "public record Root(string Name);",
    "public interface ITag { }",
    'public record Derived(string Other) : Root("x");',
    "public record Tagged(string Tag) : ITag;",
    "public record Inherited(string Name) : Root(Name);",
    "public record Nested(string Name) { public record Inner(string Name); }",
    "public partial record Split(string Unproven);",
    'public record Own(string Explicit) : Root("x") { public string Explicit { get; init; } = Explicit; }',
    "public record struct TaggedValue(string Label) : ITag;",
    "",
  ].join("\n"),
  "Split.cs": "public partial record Split { }\n",
  "Readers.cs": [
    "class Reader {",
    "  string D(Derived p) => p.Other;",
    "  string T(Tagged p) => p.Tag;",
    "  string I(Inherited p) => p.Name;",
    "  string N(Nested p) => p.Name;",
    "  string P(Split p) => p.Unproven;",
    "  string O(Own p) => p.Explicit;",
    "  string V(TaggedValue p) => p.Label;",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_UNPROVEN_MEMBER_SOURCES: Sources = {
  "Members.cs": [
    "public record Address(string City);",
    "public record Person(Address Home);",
    "public class Plain { public Address Home { get; set; } }",
    "class Reader {",
    "  Address Direct(Person p) => p.Home;",
    "  Address Conditional(Person p) => p?.Home;",
    '  bool Extended(Person p, WrongAddress Home) => p is { Home.City: "x" } && Home.City == "x";',
    "  Address DirectPlain(Plain p) => p.Home;",
    "  Address ConditionalPlain(Plain p) => p?.Home;",
    '  bool ExtendedPlain(Plain p) => p is { Home.City: "x" };',
    "  bool Value(Person p, string City) => p is { Home.City: var x } && x == City;",
    "}",
    "public record WrongAddress(string City);",
    "",
  ].join("\n"),
};

export const SWIFT_CONDITIONAL_PATTERN_SOURCES: Sources = {
  "main.swift": [
    "enum Item { case item(title: Int, value: Int) }",
    "func cases(_ title: Int, _ payload: Item) -> Int {",
    "  while case .item(title: let a, value: _) = payload { return a + title }",
    "  return title",
    "}",
    "func optionals(_ title: Int, _ pair: (title: Int, value: Int)?) -> Int {",
    "  if let (title: t, value: v) = pair { return title + t + v }",
    "  guard let (title: t, value: v) = pair else { return title }",
    "  return title + t + v",
    "}",
    "func locals() -> Int {",
    "  let title = 2",
    "  let pair: (title: Int, value: Int)? = (title: 1, value: 3)",
    "  while let (title: t, value: v) = pair { return title + t + v }",
    "  return title",
    "}",
    "func expressions(_ title: Int, _ payload: Item) -> Int {",
    "  while case .item(title: title, value: _) = payload { return title }",
    "  return title",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_UNKNOWN_RECORD_BASE_SOURCES: Sources = {
  "Ext/Ext.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  "App/App.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../Ext/Ext.csproj" /></ItemGroup></Project>',
  "Ext/Bases.cs": [
    "namespace Ext { public record Base(string Hidden); public record Generic<T>(T Value); }",
    "namespace Missing.Lib { public record Base(string A); }",
    "public record MissingBase(string A);",
    "public record MissingBase<T>(T A);",
    "",
  ].join("\n"),
  "App/Records.cs": [
    "public record Derived(string Hidden, string Own) : Ext.Base(Hidden);",
    "public record GenericDerived(int Value) : Ext.Generic<int>(Value);",
    "public record U1(string A) : Missing.Lib.Base(A);",
    "public record U2(string A) : MissingBase(A);",
    "public record U3(int A) : MissingBase<int>(A);",
    "class Reader {",
    "  string Read(Derived p) => p.Hidden + p.Own;",
    "  int Read(GenericDerived p) => p.Value;",
    "  string Read(U1 p) => p.A;",
    "  string Read(U2 p) => p.A;",
    "  int Read(U3 p) => p.A;",
    "  string Decoy(string Hidden) => Hidden;",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_NESTED_RECORD_BASE_SOURCES: Sources = {
  "Nested.cs": [
    "namespace Q.Lib { public class Outer { public record NestedBase(string N); } }",
    "namespace Q.App {",
    "  public record Derived(string N, string Own) : Q.Lib.Outer.NestedBase(N);",
    "  class Reader {",
    "    string Read(Derived p) => p.N + p.Own;",
    "    string Decoy(string N) => N;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_INTERFACE_RENAME_SOURCES: Sources = {
  "Contracts.cs": [
    "public interface IHasName { string Name { get; } }",
    "public interface IChild : IHasName { }",
    "public interface IMethod { int Run(); }",
    'public class ImplC : IHasName { public string Name { get; init; } = ""; }',
    "public record ImplR(string Name) : IHasName;",
    'public record ImplE : IHasName { public string Name { get; init; } = ""; }',
    "public record BodyParam(string Name) : IHasName { public string Name { get; init; } = Name; }",
    'public class Base { public string Name { get; init; } = ""; }',
    "public class Inherited : Base, IChild { }",
    "public class Method : IMethod { public int Run() => 1; public int Extra() => 2; }",
    'public class Unrelated { public string Name { get; init; } = ""; public int Run() => 3; }',
    'public class Decoy { public string Name = ""; }',
    "public interface Unused { string Name { get; } }",
    'public partial class Partly { public string Name { get; init; } = ""; }',
    "",
  ].join("\n"),
  "Uses.cs": [
    "class Uses {",
    "  string Contract(IHasName p) => p.Name;",
    "  string Child(IHasName p) => p.Name;",
    "  string Class(ImplC p) => p.Name;",
    "  string Positional(ImplR p) => p.Name;",
    "  string Explicit(ImplE p) => p.Name;",
    "  string Body(BodyParam p) => p.Name;",
    "  string Base(Base p) => p.Name;",
    "  string Inherited(Inherited p) => p.Name;",
    "  int ContractMethod(IMethod p) => p.Run();",
    "  int Method(Method p) => p.Run();",
    "  int ReadExtra(Method p) => p.Extra();",
    "  string Unrelated(Unrelated p) => p.Name;",
    "  int UnrelatedMethod(Unrelated p) => p.Run();",
    "  string Field(Decoy p) => p.Name;",
    "  string Unused(Unused p) => p.Name;",
    "  string Local(string Name) => Name;",
    "  string Partial(Partly p) => p.Name;",
    "}",
    "",
  ].join("\n"),
  "Other.cs": "public partial class Partly : IHasName { }\n",
};

export const CSHARP_RENAME_BOUNDARY_SOURCES: Sources = {
  "Boundaries.cs": [
    "using System;",
    "public class External : IDisposable {",
    "  private int Helper() => 1;",
    '  string Secret { get; set; } = "";',
    "  void Hidden() { }",
    "  public static int S() => 3;",
    "  internal int Mid() => 2;",
    "  protected int Guard() => 3;",
    "  private protected int Restricted() => 4;",
    '  public string Plain { get; set; } = "";',
    "  private event Action Fire;",
    "  public void Dispose() { }",
    "  public int Use() { Hidden(); Fire?.Invoke(); return Helper() + S() + Mid() + Secret.Length; }",
    "}",
    "public interface IExplicit { int Get(); }",
    "public class Explicit : IDisposable, IExplicit {",
    "  int IExplicit.Get() => 1;",
    "  public void Dispose() { }",
    "}",
    "public interface IStatic<T> where T : IStatic<T> { static abstract int Make(); }",
    "public class StaticContract : Exception, IStatic<StaticContract> {",
    "  public static int Make() => 1;",
    "  public static int Other() => 2;",
    "}",
    "public abstract record AbsBase { public abstract string Name { get; init; } }",
    "public record Concrete(string Name) : AbsBase;",
    "public class VirtualBase { public virtual int Work() => 1; }",
    "public class Override : VirtualBase { public override int Work() => 2; }",
    "public class Lone { public virtual int Work() => 3; }",
    "public class Decoy { public int Work() => 4; }",
    "public abstract class Abstract { public abstract void Run(); }",
    "public class Derived : Abstract { public override void Run() { } }",
    "public record Own(string Name) : AbsBase { public override string Name { get; init; } = Name; }",
    "public class Uses {",
    "  int Read(Override p) => p.Work();",
    "  int Read(VirtualBase p) => p.Work();",
    "  int Read(Lone p) => p.Work();",
    "  int Read(Decoy p) => p.Work();",
    "  void Read(Derived p) => p.Run();",
    "  string Read(Concrete p) => p.Name;",
    "  string Read(AbsBase p) => p.Name;",
    "  string Read(Own p) => p.Name;",
    "  int Read(IExplicit p) => p.Get();",
    "}",
    "public class K1 {",
    '  public override string ToString() => "class";',
    "  public override bool Equals(object other) => true;",
    "  public override int GetHashCode() => 1;",
    "  public int Plain() => 1;",
    "}",
    'public struct K2 { public override string ToString() => "struct"; }',
    "public record K3(string Value) { public override string ToString() => Value; }",
    "public class OverrideUses {",
    "  string Object(K1 value) => value.ToString();",
    "  bool Equal(K1 value, object other) => value.Equals(other);",
    "  int Hash(K1 value) => value.GetHashCode();",
    "  int Plain(K1 value) => value.Plain();",
    "  string Struct(K2 value) => value.ToString();",
    "  string Record(K3 value) => value.ToString();",
    "}",
    "",
  ].join("\n"),
};

export const JAVA_BATCH6_SOURCES: Sources = {
  "Size.java": "package batch6; enum Size { SMALL, BIG } class Carrier { Size field; }\n",
  "Subjects.java": [
    "package batch6; class Subjects {",
    "  static final int SMALL = 99;",
    "  Size field;",
    "  int loop(Size[] sizes) { for (Size s : sizes) { switch (s) { case SMALL: return 1; default: break; } } return 0; }",
    "  int pattern(Object o) { if (o instanceof Size s) { return switch (s) { case SMALL -> 1; default -> 0; }; } return 0; }",
    "  int own() { return switch (this.field) { case SMALL -> 1; default -> 0; }; }",
    "  int other(Subjects other) { return switch (other.field) { case SMALL -> 1; default -> 0; }; }",
    "  int carrier(Carrier other) { return switch (other.field) { case SMALL -> 1; default -> 0; }; }",
    "  int constant(int n) { return switch (n) { case SMALL -> 1; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
};

export const SWIFT_BATCH6_SOURCES: Sources = {
  "main.swift": [
    "enum Item { case item(title: Int, value: Int) }",
    "func patterns(_ title: Int, _ value: Int) -> Int {",
    "  let pair = (title: title, value: value)",
    "  let (title: t1, value: v1) = pair",
    "  var result = t1 + v1",
    "  switch pair { case let (title: x, value: y): result += x + y }",
    "  if case (title: let tt, value: let vv) = pair { result += tt + vv }",
    "  let payload = Item.item(title: title, value: value)",
    "  if case .item(title: let it, value: let iv) = payload { result += it + iv }",
    "  switch pair { case (title: title, value: value): break; default: break }",
    "  return result + title + value",
    "}",
    "func localPatterns() -> Int {",
    "  let title = 2",
    "  let pair = (title: 1, value: 3)",
    "  let (title: t, value: v) = pair",
    "  return title + t + v",
    "}",
    "func guarded(_ title: Int, _ payload: Item) -> Int {",
    "  guard case .item(title: let it, value: let iv) = payload else { return title }",
    "  return title + it + iv",
    "}",
    "",
  ].join("\n"),
};

const at = (file: string, line: number, token: string, nth = 1): Place => ({ file, line, token, nth });

/** The exact references a rename must edit; neighboring same-name declarations are intentional decoys. */
export const BATCH6_RENAME_ROWS: readonly {
  sources: Sources;
  declaration: Place;
  references: readonly Place[];
  renameReferences?: readonly Place[];
  coverage?: "partial";
  unsafe?: boolean;
}[] = [
  ...[5, 6, 7, 8, 9, 10].map((line) => ({
    sources: CSHARP_BATCH6_SOURCES,
    declaration: at("Scopes.cs", line, "x"),
    references: Array.from({ length: line === 6 ? 3 : 2 }, (_, n) => at("Scopes.cs", line, "x", n + 1)),
  })),
  {
    sources: CSHARP_BATCH6_SOURCES,
    declaration: at("Records.cs", 1, "Name"),
    references: [at("Records.cs", 1, "Name"), ...[2, 4].map((line) => at("Readers.cs", line, "Name"))],
    coverage: "partial",
  },
  {
    sources: CSHARP_RECORD_TYPED_SOURCES,
    declaration: at("Person.cs", 1, "Name"),
    references: [at("Person.cs", 1, "Name"), at("Reader.cs", 1, "Name")],
  },
  {
    sources: JAVA_BATCH6_SOURCES,
    declaration: at("Size.java", 1, "SMALL"),
    references: [at("Size.java", 1, "SMALL"), ...[4, 5, 6, 7, 8].map((line) => at("Subjects.java", line, "SMALL"))],
  },
  {
    sources: SWIFT_BATCH6_SOURCES,
    declaration: at("main.swift", 2, "title"),
    references: [
      at("main.swift", 2, "title"),
      ...[3, 8, 10].map((line) => at("main.swift", line, "title", 2)),
      at("main.swift", 11, "title"),
    ],
  },
  {
    sources: SWIFT_BATCH6_SOURCES,
    declaration: at("main.swift", 14, "title"),
    references: [at("main.swift", 14, "title"), at("main.swift", 17, "title")],
  },
  {
    sources: SWIFT_BATCH6_SOURCES,
    declaration: at("main.swift", 19, "title"),
    references: [at("main.swift", 19, "title"), at("main.swift", 20, "title", 2), at("main.swift", 21, "title")],
  },
  {
    sources: CSHARP_FOREACH_REVIEW_SOURCES,
    declaration: at("Foreach.cs", 3, "x"),
    references: [
      at("Foreach.cs", 3, "x"),
      ...[6, 7, 8].flatMap((line) => [at("Foreach.cs", line, "x", 2), at("Foreach.cs", line, "x", 4)]),
      at("Foreach.cs", 9, "x"),
      at("Foreach.cs", 9, "x", 3),
    ],
  },
  ...[6, 7, 8].map((line) => ({
    sources: CSHARP_FOREACH_REVIEW_SOURCES,
    declaration: at("Foreach.cs", line, "x"),
    references: [at("Foreach.cs", line, "x"), at("Foreach.cs", line, "x", 3)],
  })),
  ...(
    [
      [3, 2, "Other"],
      [4, 3, "Tag"],
      [6, 5, "Name"],
      [9, 8, "Label"],
    ] as const
  ).map(([declarationLine, readLine, token]) => ({
    sources: CSHARP_RECORD_REVIEW_SOURCES,
    declaration: at("Shapes.cs", declarationLine, token),
    references: [at("Shapes.cs", declarationLine, token), at("Readers.cs", readLine, token)],
  })),
  {
    sources: CSHARP_RECORD_REVIEW_SOURCES,
    declaration: at("Shapes.cs", 7, "Unproven"),
    references: [at("Shapes.cs", 7, "Unproven")],
    coverage: "partial",
  },
  ...(
    [
      [2, 5],
      [3, 8],
    ] as const
  ).map(([declarationLine, readLine]) => ({
    sources: CSHARP_UNPROVEN_MEMBER_SOURCES,
    declaration: at("Members.cs", declarationLine, "Home"),
    references: [at("Members.cs", declarationLine, "Home"), at("Members.cs", readLine, "Home")],
    coverage: "partial" as const,
  })),
  {
    sources: CSHARP_UNPROVEN_MEMBER_SOURCES,
    declaration: at("Members.cs", 7, "Home"),
    references: [at("Members.cs", 7, "Home"), at("Members.cs", 7, "Home", 3)],
  },
  {
    sources: CSHARP_UNPROVEN_MEMBER_SOURCES,
    declaration: at("Members.cs", 11, "City"),
    references: [at("Members.cs", 11, "City"), at("Members.cs", 11, "City", 3)],
  },
  {
    sources: CSHARP_UNPROVEN_MEMBER_SOURCES,
    declaration: at("Members.cs", 1, "City"),
    references: [at("Members.cs", 1, "City")],
    coverage: "partial",
  },
  {
    sources: SWIFT_CONDITIONAL_PATTERN_SOURCES,
    declaration: at("main.swift", 2, "title"),
    references: [at("main.swift", 2, "title"), at("main.swift", 3, "title", 2), at("main.swift", 4, "title")],
  },
  {
    sources: SWIFT_CONDITIONAL_PATTERN_SOURCES,
    declaration: at("main.swift", 6, "title"),
    references: [
      at("main.swift", 6, "title"),
      at("main.swift", 7, "title", 2),
      at("main.swift", 8, "title", 2),
      at("main.swift", 9, "title"),
    ],
  },
  {
    sources: SWIFT_CONDITIONAL_PATTERN_SOURCES,
    declaration: at("main.swift", 12, "title"),
    references: [at("main.swift", 12, "title"), at("main.swift", 14, "title", 2), at("main.swift", 15, "title")],
  },
  {
    sources: SWIFT_CONDITIONAL_PATTERN_SOURCES,
    declaration: at("main.swift", 17, "title"),
    references: [
      at("main.swift", 17, "title"),
      at("main.swift", 18, "title", 2),
      at("main.swift", 18, "title", 3),
      at("main.swift", 19, "title"),
    ],
  },
  ...(
    [
      [1, "Hidden"],
      [1, "Own"],
      [2, "Value"],
      [3, "A"],
      [4, "A"],
      [5, "A"],
    ] as const
  ).map(([declarationLine, token]) => ({
    sources: CSHARP_UNKNOWN_RECORD_BASE_SOURCES,
    declaration: at("App/Records.cs", declarationLine, token),
    references: [
      at("App/Records.cs", declarationLine, token),
      ...(token !== "Own" ? [at("App/Records.cs", declarationLine, token, 2)] : []),
    ],
    coverage: "partial" as const,
  })),
  {
    sources: CSHARP_UNKNOWN_RECORD_BASE_SOURCES,
    declaration: at("App/Records.cs", 12, "Hidden"),
    references: [at("App/Records.cs", 12, "Hidden"), at("App/Records.cs", 12, "Hidden", 2)],
    // Main also retains partial coverage across this unresolved project boundary.
    coverage: "partial",
  },
  ...["N", "Own"].map((token) => ({
    sources: CSHARP_NESTED_RECORD_BASE_SOURCES,
    declaration: at("Nested.cs", 3, token),
    references: [at("Nested.cs", 3, token), ...(token === "N" ? [at("Nested.cs", 3, token, 2)] : [])],
    coverage: "partial" as const,
  })),
  {
    sources: CSHARP_NESTED_RECORD_BASE_SOURCES,
    declaration: at("Nested.cs", 6, "N"),
    references: [at("Nested.cs", 6, "N"), at("Nested.cs", 6, "N", 2)],
  },
  ...(
    [
      [1, [2, 3], "Name", true],
      [3, [10], "Run", true],
      [4, [4], "Name", true],
      [5, [5], "Name", true],
      [6, [6], "Name", true],
      [8, [8, 9], "Name", true],
      [10, [11], "Run", true],
      [11, [13], "Name", false],
      [11, [14], "Run", false],
      [12, [15], "Name", false],
      [13, [16], "Name", false],
      [10, [12], "Extra", false],
      [14, [18], "Name", true],
    ] as const
  ).map(([declarationLine, readLines, token, unsafe]) => ({
    sources: CSHARP_INTERFACE_RENAME_SOURCES,
    declaration: at("Contracts.cs", declarationLine, token),
    references: [at("Contracts.cs", declarationLine, token), ...readLines.map((line) => at("Uses.cs", line, token))],
    ...(declarationLine === 3
      ? {
          renameReferences: [
            at("Contracts.cs", 3, "Run"),
            at("Contracts.cs", 10, "Run"),
            at("Uses.cs", 10, "Run"),
            at("Uses.cs", 11, "Run"),
          ],
        }
      : {}),
    unsafe,
  })),
  {
    sources: CSHARP_INTERFACE_RENAME_SOURCES,
    declaration: at("Contracts.cs", 7, "Name", 2),
    references: [at("Contracts.cs", 7, "Name", 2), at("Uses.cs", 7, "Name")],
    unsafe: true,
  },
  {
    sources: CSHARP_INTERFACE_RENAME_SOURCES,
    declaration: at("Contracts.cs", 7, "Name"),
    references: [at("Contracts.cs", 7, "Name"), at("Contracts.cs", 7, "Name", 3)],
  },
  {
    sources: CSHARP_INTERFACE_RENAME_SOURCES,
    declaration: at("Uses.cs", 17, "Name"),
    references: [at("Uses.cs", 17, "Name"), at("Uses.cs", 17, "Name", 2)],
  },
];

async function expectRows(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const row of BATCH6_RENAME_ROWS) {
    if (row.sources !== fixture.sources) continue;
    for (const use of row.references) await expectGoto(fixture, index, use, row.declaration);
    await expectReferences(fixture, index, row.declaration, row.references, row.coverage ?? "complete");
  }
  const graph = await buildSymbolGraphDetailed(index);
  // The detailed graph omits lexical value reads. None may instead acquire a same-named decoy edge.
  for (const edge of graph.edges) {
    if (!edge.site) continue;
    for (const row of BATCH6_RENAME_ROWS) {
      if (row.sources !== fixture.sources) continue;
      for (const use of row.references.slice(1)) {
        const position = placeOf(fixture.sources, use);
        if (edge.site.file !== fixture.files[use.file]) continue;
        if (edge.site.range.start.line !== position.line || edge.site.range.start.column !== position.column) continue;
        const target = await goToDefinition(index, {
          file: fixture.files[row.declaration.file]!,
          ...placeOf(fixture.sources, row.declaration),
        });
        expect(target.status).toBe("ok");
        if (target.status !== "ok") continue;
        expect(edge.to).toBe(defNodeId(target.definition));
        const targetFile = graph.nodes.get(edge.to)?.file;
        expect(targetFile).toBeDefined();
        expect(fileIdentityKey(targetFile!)).toBe(fileIdentityKey(target.definition.file));
      }
    }
  }
}

export async function expectCsharpBatch6(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  await expectGoto(fixture, index, at("Readers.cs", 3, "Name"), "not_found");
  const field = at("Scopes.cs", 3, "x");
  const fieldReads = [5, 6, 7, 8, 9, 10].map((line) => at("Scopes.cs", line, "x", line === 6 ? 4 : 3));
  for (const use of fieldReads) await expectGoto(fixture, index, use, field);
  await expectReferences(fixture, index, field, [field, ...fieldReads], "complete");
  for (const [useLine, declarationLine, name, nth] of [
    [6, 2, "Label", 1],
    [7, 3, "Name", 2],
    [8, 4, "Name", 2],
    [9, 5, "Name", 1],
    [10, 7, "Name", 1],
  ] as const) {
    await expectGoto(fixture, index, at("Readers.cs", useLine, name), at("Records.cs", declarationLine, name, nth));
  }
}

export async function expectJavaBatch6(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  const constant = at("Subjects.java", 2, "SMALL");
  await expectGoto(fixture, index, at("Subjects.java", 9, "SMALL"), constant);
  await expectReferences(fixture, index, constant, [constant, at("Subjects.java", 9, "SMALL")], "complete");
}

export async function expectSwiftBatch6(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  for (const line of [3, 4, 6, 7, 8, 9, 10, 15, 16, 20]) {
    await expectGoto(fixture, index, at("main.swift", line, "title"), "not_found");
  }
}

async function expectCsharpPrimaryNonmembers(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const line of [4, 5]) await expectGoto(fixture, index, at("Primary.cs", line, "Name"), "not_found");
  for (const line of [1, 2]) {
    const declaration = at("Primary.cs", line, "Name");
    await expectReferences(fixture, index, declaration, [declaration, at("Primary.cs", line, "Name", 2)], "complete");
  }
}

async function expectCsharpRecordReview(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  await expectGoto(fixture, index, at("Readers.cs", 4, "Name"), at("Shapes.cs", 1, "Name"));
  await expectGoto(fixture, index, at("Readers.cs", 6, "Unproven"), "not_found");
  await expectGoto(fixture, index, at("Readers.cs", 7, "Explicit"), at("Shapes.cs", 8, "Explicit", 2));
}

async function expectCsharpUnprovenMembers(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  for (const line of [6, 9]) await expectGoto(fixture, index, at("Members.cs", line, "Home"), "not_found");
  for (const [line, nth] of [
    [7, 2],
    [10, 1],
    [11, 1],
  ] as const) {
    await expectGoto(fixture, index, at("Members.cs", line, "Home", nth), "not_found");
  }
  for (const [line, nth] of [
    [7, 1],
    [10, 1],
    [11, 2],
  ] as const) {
    await expectGoto(fixture, index, at("Members.cs", line, "City", nth), "not_found");
  }
  await expectGoto(fixture, index, at("Members.cs", 7, "City", 2), at("Members.cs", 13, "City"));
  await expectGoto(fixture, index, at("Members.cs", 11, "x", 2), at("Members.cs", 11, "x"));
}

async function expectSwiftConditionalPatterns(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  for (const line of [3, 7, 8, 14, 18]) {
    await expectGoto(fixture, index, at("main.swift", line, "title"), "not_found");
  }
  // These compiler-valid bindings are unmodeled on main too; excluding labels must not fabricate a binding.
  await expectGoto(fixture, index, at("main.swift", 3, "a", 2), "not_found");
  for (const line of [7, 9, 14]) {
    await expectGoto(fixture, index, at("main.swift", line, "t", line === 9 ? 1 : 2), "not_found");
  }
}

async function expectUnknownRecordBases(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  for (const [line, token] of [
    [7, "Hidden"],
    [7, "Own"],
    [8, "Value"],
    [9, "A"],
    [10, "A"],
    [11, "A"],
  ] as const) {
    await expectGoto(fixture, index, at("App/Records.cs", line, token), "not_found");
  }
}

async function expectNestedRecordBase(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  await expectRows(fixture, index);
  for (const token of ["N", "Own"]) await expectGoto(fixture, index, at("Nested.cs", 5, token), "not_found");
}

export const BATCH6_CASES = [
  {
    name: "unknown record bases do not synthesize inherited properties",
    language: "csharp",
    references: true,
    sources: CSHARP_UNKNOWN_RECORD_BASE_SOURCES,
    check: expectUnknownRecordBases,
  },
  {
    name: "nested record bases remain unproven",
    language: "csharp",
    references: true,
    sources: CSHARP_NESTED_RECORD_BASE_SOURCES,
    check: expectNestedRecordBase,
  },
  {
    name: "interface member rename linkage",
    language: "csharp",
    references: true,
    sources: CSHARP_INTERFACE_RENAME_SOURCES,
    check: expectRows,
  },
  {
    name: "foreach tuple designations and embedded bodies",
    language: "csharp",
    references: true,
    sources: CSHARP_FOREACH_REVIEW_SOURCES,
    check: expectRows,
  },
  {
    name: "base-list nested and partial record properties",
    language: "csharp",
    references: true,
    sources: CSHARP_RECORD_REVIEW_SOURCES,
    check: expectCsharpRecordReview,
  },
  {
    name: "conditional and extended-pattern member coverage",
    language: "csharp",
    references: true,
    sources: CSHARP_UNPROVEN_MEMBER_SOURCES,
    check: expectCsharpUnprovenMembers,
  },
  {
    name: "conditional tuple and payload pattern labels",
    language: "swift",
    references: true,
    sources: SWIFT_CONDITIONAL_PATTERN_SOURCES,
    check: expectSwiftConditionalPatterns,
  },
  {
    name: "primary constructor parameters are not properties",
    language: "csharp",
    references: true,
    sources: CSHARP_PRIMARY_NONMEMBER_SOURCES,
    check: expectCsharpPrimaryNonmembers,
  },
  {
    name: "cross-file positional record property reads",
    language: "csharp",
    references: true,
    sources: CSHARP_RECORD_TYPED_SOURCES,
    check: expectRows,
  },
  {
    name: "expression scopes and positional record receivers",
    language: "csharp",
    references: true,
    sources: CSHARP_BATCH6_SOURCES,
    check: expectCsharpBatch6,
  },
  {
    name: "declared enum switch subjects",
    language: "java",
    references: true,
    sources: JAVA_BATCH6_SOURCES,
    check: expectJavaBatch6,
  },
  {
    name: "tuple and enum payload pattern labels",
    language: "swift",
    references: true,
    sources: SWIFT_BATCH6_SOURCES,
    check: expectSwiftBatch6,
  },
] as const;

/** Edited, renamed, deleted, and restored declarations never retain stale scope or member answers. */
export async function expectBatch6CacheTransitions(
  fixture: Batch3Fixture,
  checkAnswers: (fixture: Batch3Fixture, index: ProjectIndex) => Promise<void>,
): Promise<void> {
  const name = Object.keys(fixture.sources)[0]!;
  const original = fixture.files[name]!;
  const renamed = path.join(fixture.root, `Renamed${path.extname(original)}`);
  const source = fixture.sources[name]!;
  let deleted = false;
  const sites = BATCH6_RENAME_ROWS.filter((row) => row.sources === fixture.sources).flatMap((row) => row.references);
  const describe = async (index: ProjectIndex): Promise<unknown> => {
    const answers = [];
    for (const site of sites) {
      const file = fixture.files[site.file]!;
      if (!index.byFile.has(fileIdentityKey(file))) {
        answers.push("deleted");
        continue;
      }
      const result = await goToDefinition(index, { file, ...placeOf(fixture.sources, site) });
      if (result.status !== "ok") {
        answers.push(result.status);
        continue;
      }
      const refs = await findReferences(index, { def: result.definition });
      answers.push({
        target: [result.definition.file, result.definition.range.start],
        coverage: refs.status === "ok" ? refs.referenceCoverage.state : refs.status,
        references: refs.status === "ok" ? refs.references.map((ref) => [ref.file, ref.range.start]) : [],
      });
    }
    const graph = await buildSymbolGraphDetailed(index);
    return { answers, edges: graph.edges.map((edge) => JSON.stringify(edge)).sort() };
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
    if (!deleted) await checkAnswers(fixture, reopened);
  };
  try {
    await check();
    await fsp.writeFile(original, `${source}// edited\n`);
    await check();
    await fsp.rename(original, renamed);
    fixture.files[name] = renamed;
    await check();
    await fsp.rename(renamed, original);
    fixture.files[name] = original;
    await check();
    await fsp.rm(original);
    deleted = true;
    await check();
    await fsp.writeFile(original, source);
    deleted = false;
    await check();
  } finally {
    clearMemoryCache();
    closeDiskCacheDatabase(fixture.root);
  }
}
