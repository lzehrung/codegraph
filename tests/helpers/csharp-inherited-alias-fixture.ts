/**
 * C# simple-name lookup searches the enclosing types, each with its base classes, before any namespace or `using`
 * alias, so a member named like an alias binds `a.Run()` first. dotnet compiled every case below; `outcome` is what
 * go-to-definition, references, and the detailed graph must answer for the one `.Run()` call in `Use.cs`:
 *  - alias: `N.Target.Run`, the alias target; no member of that name is proven;
 *  - member: `Decoy.Target.Run`, the type the member declares, read in the file that declares it;
 *  - unresolved: a member hides the alias or may, but its type is not a project type or the base is unproven:
 *    `not_found`, partial coverage, and no edge to either target.
 */
export type CsharpInheritedAliasOutcome = "alias" | "member" | "unresolved";

export const CSHARP_INHERITED_ALIAS_COMMON_FILES = {
  "N.cs": "namespace N; public class Target { public static void Run() {} }\n",
  "Decoy.cs":
    "namespace Decoy; public class Target { public void Run() {} } public class Holder { public Target Target = new Target(); }\n",
} as const;

type CsharpInheritedAliasSource = {
  name: string;
  outcome: CsharpInheritedAliasOutcome;
  /** The lines of `Use.cs` before the body: the alias directive and what encloses it. */
  header?: readonly string[];
  /** The rest of `Use.cs`. Exactly one line holds `site`. */
  body: readonly string[];
  /** The text that marks the use under test; the `.Run()` call by default. */
  site?: string;
  /** The alias the directive declares; `a` by default. */
  alias?: string;
  /** The other project files. */
  others?: Readonly<Record<string, string>>;
  /** The file declaring the member that hides the alias, when a lookup proves one; `Use.cs` for `member` cases. */
  memberFile?: string;
};

const ALIAS = "using a = N.Target;";
const BASE_FIELD = "class Base { protected Decoy.Target a = new Decoy.Target(); }";

const SOURCES: readonly CsharpInheritedAliasSource[] = [
  // The member's declared type proves the receiver, wherever the member is declared.
  {
    name: "inherited field",
    outcome: "member",
    body: [BASE_FIELD, "class Use : Base { void F() { a.Run(); } }"],
  },
  {
    name: "inherited property",
    outcome: "member",
    body: [
      "class Base { protected Decoy.Target a { get; } = new Decoy.Target(); }",
      "class Use : Base { void F() { a.Run(); } }",
    ],
  },
  {
    name: "field two bases up",
    outcome: "member",
    body: [BASE_FIELD, "class Mid : Base { }", "class Use : Mid { void F() { a.Run(); } }"],
  },
  {
    name: "static field reached from a static method",
    outcome: "member",
    body: [
      "class Base { protected static Decoy.Target a = new Decoy.Target(); }",
      "class Use : Base { static void F() { a.Run(); } }",
    ],
  },
  {
    name: "field of a generic base",
    outcome: "member",
    body: [
      "class Base<T> { protected Decoy.Target a = new Decoy.Target(); }",
      "class Use : Base<int> { void F() { a.Run(); } }",
    ],
  },
  {
    name: "field of a base record",
    outcome: "member",
    body: [
      "record BaseRecord { protected Decoy.Target a = new Decoy.Target(); }",
      "record Use : BaseRecord { void F() { a.Run(); } }",
    ],
  },
  {
    name: "private protected field",
    outcome: "member",
    body: [
      "class Base { private protected Decoy.Target a = new Decoy.Target(); }",
      "class Use : Base { void F() { a.Run(); } }",
    ],
  },
  {
    name: "verbatim inherited field",
    outcome: "member",
    body: [
      "class Base { protected Decoy.Target @a = new Decoy.Target(); }",
      "class Use : Base { void F() { a.Run(); } }",
    ],
  },
  {
    name: "inherited static field in a nested class of the derived type",
    outcome: "member",
    body: [
      "class Base { protected static Decoy.Target a = new Decoy.Target(); }",
      "class Outer : Base { class Inner { void F() { a.Run(); } } }",
    ],
  },
  {
    name: "inherited value beside a namespace alias",
    outcome: "member",
    header: ["using a = N;"],
    body: [
      "class Base { protected Decoy.Holder a = new Decoy.Holder(); }",
      "class Use : Base { void F() { a.Target.Run(); } }",
    ],
  },
  {
    name: "inherited property named like a PascalCase alias",
    outcome: "member",
    alias: "Logger",
    header: ["using Logger = N.Target;"],
    body: [
      "class Base { protected Decoy.Target Logger { get; } = new Decoy.Target(); }",
      "class Use : Base { void F() { Logger.Run(); } }",
    ],
  },
  {
    name: "own field",
    outcome: "member",
    body: ["class Use {", "  Decoy.Target a = new Decoy.Target();", "  void F() { a.Run(); }", "}"],
  },
  {
    name: "own property",
    outcome: "member",
    body: ["class Use {", "  Decoy.Target a { get; } = new Decoy.Target();", "  void F() { a.Run(); }", "}"],
  },
  {
    name: "record positional parameter",
    outcome: "member",
    body: ["record Use(Decoy.Target a) { void F() { a.Run(); } }"],
  },
  {
    name: "class primary constructor parameter",
    outcome: "member",
    body: ["class Use(Decoy.Target a) { void F() { a.Run(); } }"],
  },
  {
    name: "inherited field in a namespace block with its alias",
    outcome: "member",
    header: ["namespace C {", `  ${ALIAS}`],
    body: [`  ${BASE_FIELD}`, "  class Use : Base { void F() { a.Run(); } }", "}"],
  },
  {
    name: "inherited field declared in another file",
    outcome: "member",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": `${BASE_FIELD}\n` },
    memberFile: "Base.cs",
  },
  {
    name: "inherited property declared in another file",
    outcome: "member",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base { protected Decoy.Target a { get; } = new Decoy.Target(); }\n" },
    memberFile: "Base.cs",
  },
  {
    name: "field in another part of a partial type",
    outcome: "member",
    body: ["partial class Use { void F() { a.Run(); } }"],
    others: { "Part.cs": "partial class Use { Decoy.Target a = new Decoy.Target(); }\n" },
    memberFile: "Part.cs",
  },
  {
    name: "base list in another part of a partial type",
    outcome: "member",
    body: ["partial class Use { void F() { a.Run(); } }"],
    others: { "Base.cs": `${BASE_FIELD}\n`, "Part.cs": "partial class Use : Base { }\n" },
    memberFile: "Base.cs",
  },
  // dotnet: CS0119, a method group has no members; the method still binds the name before the alias.
  {
    name: "inherited method",
    outcome: "unresolved",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base { protected void a() { } }\n" },
    memberFile: "Base.cs",
  },
  // dotnet: CS1061, StringBuilder has no Run; the field still binds the name before the alias.
  {
    name: "inherited field of a type no project file declares",
    outcome: "unresolved",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base { protected System.Text.StringBuilder a = null; }\n" },
    memberFile: "Base.cs",
  },
  // A base the project cannot read may declare a member of that name.
  {
    name: "external base class",
    outcome: "unresolved",
    body: ["class Use : System.Exception { void F() { a.Run(); } }"],
  },
  {
    name: "external base class named through a using",
    outcome: "unresolved",
    header: ["using System;", ALIAS],
    body: ["class Use : Exception { void F() { a.Run(); } }"],
  },
  {
    name: "external interface",
    outcome: "unresolved",
    body: ["class Use : System.IDisposable { public void Dispose() { } void F() { a.Run(); } }"],
  },
  {
    name: "qualified project base",
    outcome: "unresolved",
    body: ["class Use : Lib.Base { void F() { a.Run(); } }"],
    others: { "Lib.cs": "namespace Lib { public class Base { } }\n" },
  },
  {
    name: "base that no file declares",
    outcome: "unresolved",
    body: ["class Use : MissingBase { void F() { a.Run(); } }"],
  },
  {
    name: "external base two levels up",
    outcome: "unresolved",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base : System.Exception { }\n" },
  },
  {
    name: "partial type whose other part has an external base",
    outcome: "unresolved",
    body: ["partial class Use { void F() { a.Run(); } }"],
    others: { "Part.cs": "partial class Use : System.Exception { }\n" },
  },
  // No member of that name is reachable, so the alias stands.
  {
    name: "class without a base beside a class that declares the field",
    outcome: "alias",
    body: ["class Use { void F() { a.Run(); } }"],
    others: { "Other.cs": "class Other { protected Decoy.Target a = new Decoy.Target(); }\n" },
  },
  {
    name: "static class",
    outcome: "alias",
    body: ["static class Use { static void F() { a.Run(); } }"],
  },
  {
    name: "struct that implements an external interface",
    outcome: "alias",
    body: ["struct Use : System.IDisposable { public void Dispose() { } void F() { a.Run(); } }"],
  },
  {
    name: "private field of a base",
    outcome: "alias",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base { private Decoy.Target a = new Decoy.Target(); }\n" },
  },
  {
    name: "field of a base without an access modifier",
    outcome: "alias",
    body: ["class Use : Base { void F() { a.Run(); } }"],
    others: { "Base.cs": "class Base { Decoy.Target a = new Decoy.Target(); }\n" },
  },
  {
    name: "base chain without the member",
    outcome: "alias",
    body: ["class Use : Mid { void F() { a.Run(); } }"],
    others: { "Mid.cs": "class Mid : Root { }\n", "Root.cs": "class Root { }\n" },
  },
  {
    name: "project interface base",
    outcome: "alias",
    body: ["class Use : IFace { void F() { a.Run(); } }"],
    others: { "IFace.cs": "interface IFace { }\n" },
  },
  {
    name: "external base in another class of the file",
    outcome: "alias",
    body: ["class Other : System.Exception { }", "class Use { void F() { a.Run(); } }"],
  },
  {
    name: "namespace alias with no member of its name",
    outcome: "alias",
    header: ["using a = N;"],
    body: ["class Use { void F() { a.Target.Run(); } }"],
  },
  // `::` reaches aliases only, whatever the enclosing types declare.
  {
    name: "alias-qualified name beside an inherited value",
    outcome: "alias",
    header: ["using a = N;"],
    body: [
      "class Base { protected Decoy.Holder a = new Decoy.Holder(); }",
      "class Use : Base { void F() { a::Target.Run(); } }",
    ],
  },
];

export type CsharpInheritedAliasCase = {
  name: string;
  outcome: CsharpInheritedAliasOutcome;
  files: Readonly<Record<string, string>>;
  /** The lines of `Use.cs`. */
  lines: readonly string[];
  /** The 1-based line of its `.Run()` call. */
  line: number;
  /** The file declaring the member that hides the alias, when a lookup proves one. */
  memberFile?: string;
  /** The alias name the use spells. */
  alias: string;
};

function buildCase(source: CsharpInheritedAliasSource): CsharpInheritedAliasCase {
  const lines = [...(source.header ?? [ALIAS]), ...source.body];
  const line = lines.findIndex((text) => text.includes(source.site ?? ".Run()")) + 1;
  const memberFile = source.memberFile ?? (source.outcome === "member" ? "Use.cs" : undefined);
  return {
    name: source.name,
    outcome: source.outcome,
    files: {
      ...CSHARP_INHERITED_ALIAS_COMMON_FILES,
      ...source.others,
      "Use.cs": `${lines.join("\n")}\n`,
    },
    lines,
    line,
    ...(memberFile ? { memberFile } : {}),
    alias: source.alias ?? "a",
  };
}

export const CSHARP_INHERITED_ALIAS_CASES: readonly CsharpInheritedAliasCase[] = SOURCES.map(buildCase);

/** The issue's repro: an inherited field of another type hides the alias in `a.Run()`. */
export const CSHARP_INHERITED_ALIAS_ISSUE_CASE: CsharpInheritedAliasCase = CSHARP_INHERITED_ALIAS_CASES[0]!;

/** The case with `name`, for tests that vary one of its files. */
export function csharpInheritedAliasCase(name: string): CsharpInheritedAliasCase {
  const found = CSHARP_INHERITED_ALIAS_CASES.find((testCase) => testCase.name === name);
  if (!found) throw new Error(`no C# inherited alias case named ${name}`);
  return found;
}

/** An inherited nested type binds the name as a type receiver, so its own `Run` answers, not the alias target's. */
export const CSHARP_INHERITED_NESTED_TYPE_CASE: CsharpInheritedAliasCase = buildCase({
  name: "inherited nested type",
  outcome: "member",
  body: [
    "class Base { public class a { public static void Run() { } } }",
    "class Use : Base { void F() { a.Run(); } }",
  ],
});

/** A type position reaches no field, so an inherited field leaves the alias in `new a()`. */
export const CSHARP_INHERITED_TYPE_POSITION_CASE: CsharpInheritedAliasCase = buildCase({
  name: "type position beside an inherited field",
  outcome: "alias",
  body: ["class Use : Base { void F() { var value = new a(); } }"],
  others: { "Base.cs": `${BASE_FIELD}\n` },
  site: "new a()",
});
