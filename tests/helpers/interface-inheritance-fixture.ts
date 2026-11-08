import path from "node:path";
import { expect } from "vitest";
import type { SymbolGraph, SymbolNode } from "../../src/graphs/symbol-graph.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { findImplementations, findTypeHierarchy } from "../../src/indexer/type-hierarchy.js";
import { normalizePath } from "../../src/util/paths.js";

/** A declared type, named by its project-relative file so a same-named decoy in another file stays distinct. */
export type InterfaceInheritanceSite = { name: string; file: string };

/**
 * One language's interface inheritance project: a parent interface, a child that extends it, and a lonely child
 * that nobody implements. A decoy parent, child, and implementer share the names in another namespace, package,
 * or directory, so every answer checks inclusion and exclusion together.
 *
 * The C#, Kotlin, Java, and TypeScript sources compile with Roslyn, kotlinc, javac, and tsc. Go has no
 * compiler in the test environment; its sources follow the language specification's interface embedding.
 */
export type InterfaceInheritanceFixture = {
  language: string;
  files: Readonly<Record<string, string>>;
  parent: InterfaceInheritanceSite;
  child: InterfaceInheritanceSite;
  lonely: InterfaceInheritanceSite;
  /** Concrete types that implement the parent directly. */
  direct: readonly InterfaceInheritanceSite[];
  /** Concrete types that implement the child, so they implement the parent through it. */
  viaChild: readonly InterfaceInheritanceSite[];
  decoy: { parent: InterfaceInheritanceSite; child: InterfaceInheritanceSite; implementer: InterfaceInheritanceSite };
};

export const INTERFACE_INHERITANCE_FIXTURES: readonly InterfaceInheritanceFixture[] = [
  {
    language: "C#",
    files: {
      "Parent.cs": [
        "namespace A",
        "{",
        "    public interface IParent",
        "    {",
        "        void Run();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "Child.cs": [
        "using A;",
        "",
        "namespace B",
        "{",
        "    public interface IChild : IParent",
        "    {",
        "    }",
        "",
        "    public interface ILonely : IParent",
        "    {",
        "    }",
        "}",
        "",
      ].join("\n"),
      "Widget.cs": [
        "using A;",
        "using B;",
        "",
        "namespace C",
        "{",
        "    public class Widget : IChild",
        "    {",
        "        public void Run() { }",
        "    }",
        "",
        "    public struct Gadget : IChild",
        "    {",
        "        public void Run() { }",
        "    }",
        "",
        "    public record WidgetRecord : IChild",
        "    {",
        "        public void Run() { }",
        "    }",
        "",
        "    public class Direct : IParent",
        "    {",
        "        public void Run() { }",
        "    }",
        "}",
        "",
      ].join("\n"),
      "Decoy.cs": [
        "namespace Z",
        "{",
        "    public interface IParent",
        "    {",
        "    }",
        "",
        "    public interface IChild : IParent",
        "    {",
        "    }",
        "",
        "    public class DecoyImpl : IChild",
        "    {",
        "    }",
        "}",
        "",
      ].join("\n"),
    },
    parent: { name: "IParent", file: "Parent.cs" },
    child: { name: "IChild", file: "Child.cs" },
    lonely: { name: "ILonely", file: "Child.cs" },
    direct: [{ name: "Direct", file: "Widget.cs" }],
    viaChild: [
      { name: "Gadget", file: "Widget.cs" },
      { name: "Widget", file: "Widget.cs" },
      { name: "WidgetRecord", file: "Widget.cs" },
    ],
    decoy: {
      parent: { name: "IParent", file: "Decoy.cs" },
      child: { name: "IChild", file: "Decoy.cs" },
      implementer: { name: "DecoyImpl", file: "Decoy.cs" },
    },
  },
  {
    language: "Kotlin",
    files: {
      "a/Parent.kt": ["package a", "", "interface Parent {", "    fun run()", "}", ""].join("\n"),
      "b/Child.kt": [
        "package b",
        "",
        "import a.Parent",
        "",
        "interface Child : Parent",
        "",
        "interface Lonely : Parent",
        "",
      ].join("\n"),
      "c/Widget.kt": [
        "package c",
        "",
        "import a.Parent",
        "import b.Child",
        "",
        "class Widget : Child {",
        "    override fun run() {}",
        "}",
        "",
        "class Direct : Parent {",
        "    override fun run() {}",
        "}",
        "",
        "object Singleton : Child {",
        "    override fun run() {}",
        "}",
        "",
        "enum class Mode : Child {",
        "    FAST;",
        "",
        "    override fun run() {}",
        "}",
        "",
      ].join("\n"),
      "z/Decoy.kt": [
        "package z",
        "",
        "interface Parent",
        "",
        "interface Child : Parent",
        "",
        "class DecoyImpl : Child",
        "",
      ].join("\n"),
    },
    parent: { name: "Parent", file: "a/Parent.kt" },
    child: { name: "Child", file: "b/Child.kt" },
    lonely: { name: "Lonely", file: "b/Child.kt" },
    direct: [{ name: "Direct", file: "c/Widget.kt" }],
    viaChild: [
      { name: "Mode", file: "c/Widget.kt" },
      { name: "Singleton", file: "c/Widget.kt" },
      { name: "Widget", file: "c/Widget.kt" },
    ],
    decoy: {
      parent: { name: "Parent", file: "z/Decoy.kt" },
      child: { name: "Child", file: "z/Decoy.kt" },
      implementer: { name: "DecoyImpl", file: "z/Decoy.kt" },
    },
  },
  {
    language: "Java",
    files: {
      "a/Parent.java": ["package a;", "", "public interface Parent {", "    void run();", "}", ""].join("\n"),
      "b/Child.java": [
        "package b;",
        "",
        "import a.Parent;",
        "",
        "public interface Child extends Parent {",
        "}",
        "",
      ].join("\n"),
      "b/Lonely.java": [
        "package b;",
        "",
        "import a.Parent;",
        "",
        "public interface Lonely extends Parent {",
        "}",
        "",
      ].join("\n"),
      "c/Widget.java": [
        "package c;",
        "",
        "import b.Child;",
        "",
        "public class Widget implements Child {",
        "    public void run() {}",
        "}",
        "",
        "enum Mode implements Child {",
        "    FAST;",
        "",
        "    public void run() {}",
        "}",
        "",
      ].join("\n"),
      "c/Direct.java": [
        "package c;",
        "",
        "import a.Parent;",
        "",
        "public class Direct implements Parent {",
        "    public void run() {}",
        "}",
        "",
      ].join("\n"),
      "z/Parent.java": ["package z;", "", "public interface Parent {", "}", ""].join("\n"),
      "z/Child.java": ["package z;", "", "public interface Child extends Parent {", "}", ""].join("\n"),
      "z/DecoyImpl.java": ["package z;", "", "public class DecoyImpl implements Child {", "}", ""].join("\n"),
    },
    parent: { name: "Parent", file: "a/Parent.java" },
    child: { name: "Child", file: "b/Child.java" },
    lonely: { name: "Lonely", file: "b/Lonely.java" },
    direct: [{ name: "Direct", file: "c/Direct.java" }],
    viaChild: [
      { name: "Mode", file: "c/Widget.java" },
      { name: "Widget", file: "c/Widget.java" },
    ],
    decoy: {
      parent: { name: "Parent", file: "z/Parent.java" },
      child: { name: "Child", file: "z/Child.java" },
      implementer: { name: "DecoyImpl", file: "z/DecoyImpl.java" },
    },
  },
  {
    language: "TypeScript",
    files: {
      "parent.ts": ["export interface Parent {", "  run(): void;", "}", ""].join("\n"),
      "child.ts": [
        'import { Parent } from "./parent";',
        "",
        "export interface Child extends Parent {}",
        "",
        "export interface Lonely extends Parent {}",
        "",
      ].join("\n"),
      "widget.ts": [
        'import { Child } from "./child";',
        "",
        "export class Widget implements Child {",
        "  run(): void {}",
        "}",
        "",
      ].join("\n"),
      "direct.ts": [
        'import { Parent } from "./parent";',
        "",
        "export class Direct implements Parent {",
        "  run(): void {}",
        "}",
        "",
      ].join("\n"),
      "decoy.ts": [
        "export interface Parent {}",
        "",
        "export interface Child extends Parent {}",
        "",
        "export class DecoyImpl implements Child {}",
        "",
      ].join("\n"),
    },
    parent: { name: "Parent", file: "parent.ts" },
    child: { name: "Child", file: "child.ts" },
    lonely: { name: "Lonely", file: "child.ts" },
    direct: [{ name: "Direct", file: "direct.ts" }],
    viaChild: [{ name: "Widget", file: "widget.ts" }],
    decoy: {
      parent: { name: "Parent", file: "decoy.ts" },
      child: { name: "Child", file: "decoy.ts" },
      implementer: { name: "DecoyImpl", file: "decoy.ts" },
    },
  },
  {
    language: "Go",
    files: {
      "p/base.go": ["package p", "", "type GoBase interface {", "\tBase()", "}", ""].join("\n"),
      "p/worker.go": [
        "package p",
        "",
        "type GoWorker interface {",
        "\tGoBase",
        "\tWork()",
        "}",
        "",
        "type GoLonely interface {",
        "\tGoBase",
        "}",
        "",
      ].join("\n"),
      "p/impl.go": [
        "package p",
        "",
        "type GoStruct struct {",
        "\tGoBase",
        "}",
        "",
        "type GoRefined struct {",
        "\tGoWorker",
        "}",
        "",
        "type GoNamed struct {",
        "\tbase GoBase",
        "}",
        "",
      ].join("\n"),
      "q/decoy.go": [
        "package q",
        "",
        "type GoBase interface {",
        "\tBase()",
        "}",
        "",
        "type GoWorker interface {",
        "\tGoBase",
        "}",
        "",
        "type GoDecoy struct {",
        "\tGoWorker",
        "}",
        "",
      ].join("\n"),
    },
    parent: { name: "GoBase", file: "p/base.go" },
    child: { name: "GoWorker", file: "p/worker.go" },
    lonely: { name: "GoLonely", file: "p/worker.go" },
    direct: [{ name: "GoStruct", file: "p/impl.go" }],
    viaChild: [{ name: "GoRefined", file: "p/impl.go" }],
    decoy: {
      parent: { name: "GoBase", file: "q/decoy.go" },
      child: { name: "GoWorker", file: "q/decoy.go" },
      implementer: { name: "GoDecoy", file: "q/decoy.go" },
    },
  },
];

const TYPE_NODE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "type"]);

/**
 * Asserts the interface inheritance facts of `fixture` from an index of its files rooted at `root`: a child interface
 * extends its parent, only concrete types implement an interface, `implementations` of the parent finds the types that
 * implement the child and never the child, and the same-named decoy stays separate in every answer.
 */
export function expectInterfaceInheritance(
  root: string,
  index: ProjectIndex,
  graph: SymbolGraph,
  fixture: InterfaceInheritanceFixture,
  phase: string,
): void {
  const label = `${fixture.language} ${phase}`;
  const normalizedRoot = normalizePath(root);
  const keyOf = (name: string, file: string): string => `${name}@${file}`;
  const nodeKey = (node: SymbolNode | undefined): string =>
    node ? keyOf(node.name, path.posix.relative(normalizedRoot, normalizePath(node.file))) : "<missing>";
  const siteKey = (site: InterfaceInheritanceSite): string => keyOf(site.name, site.file);
  const nodeAt = (site: InterfaceInheritanceSite): SymbolNode => {
    const found = [...graph.nodes.values()].filter(
      (node) => TYPE_NODE_KINDS.has(node.kind) && nodeKey(node) === siteKey(site),
    );
    if (found.length !== 1)
      throw new Error(`${label}: expected one type node for ${siteKey(site)}, found ${found.length}`);
    return found[0]!;
  };
  const edges = (relation: "extends" | "implements"): string[] =>
    graph.edges
      .filter((edge) => edge.label === relation)
      .map((edge) => `${nodeKey(graph.nodes.get(edge.from))} ${relation} ${nodeKey(graph.nodes.get(edge.to))}`)
      .sort();
  const implementationsOf = (site: InterfaceInheritanceSite): string[] => {
    const result = findImplementations(index, graph, nodeAt(site).id);
    if (result.status !== "ok") throw new Error(`${label}: expected implementations of ${siteKey(site)}`);
    expect(result.ambiguous, `${label}: ${siteKey(site)} ambiguity`).toBe(0);
    return result.implementations.map((match) => nodeKey(graph.nodes.get(match.symbolId))).sort();
  };
  const related = (site: InterfaceInheritanceSite, direction: "super" | "sub", depth: number): string[] => {
    const result = findTypeHierarchy(graph, nodeAt(site).id, direction, { depth });
    if (result.status !== "ok") throw new Error(`${label}: expected ${direction}types of ${siteKey(site)}`);
    return result.relations
      .map((relation) => `${nodeKey(graph.nodes.get(relation.targetId))} ${relation.relation}@${relation.depth}`)
      .sort();
  };

  const { parent, child, lonely, direct, viaChild, decoy } = fixture;
  // Interface inheritance is `extends`; only concrete types implement, and a decoy chain never joins the real one.
  expect(edges("extends"), `${label}: extends edges`).toEqual(
    [
      `${siteKey(child)} extends ${siteKey(parent)}`,
      `${siteKey(lonely)} extends ${siteKey(parent)}`,
      `${siteKey(decoy.child)} extends ${siteKey(decoy.parent)}`,
    ].sort(),
  );
  expect(edges("implements"), `${label}: implements edges`).toEqual(
    [
      ...direct.map((site) => `${siteKey(site)} implements ${siteKey(parent)}`),
      ...viaChild.map((site) => `${siteKey(site)} implements ${siteKey(child)}`),
      `${siteKey(decoy.implementer)} implements ${siteKey(decoy.child)}`,
    ].sort(),
  );

  // The parent's implementations include the child's implementers, found through the child, and never an interface.
  const concrete = [...direct, ...viaChild].map(siteKey).sort();
  expect(implementationsOf(parent), `${label}: implementations of the parent`).toEqual(concrete);
  expect(implementationsOf(child), `${label}: implementations of the child`).toEqual(viaChild.map(siteKey).sort());
  expect(implementationsOf(lonely), `${label}: implementations of an interface nobody implements`).toEqual([]);
  expect(implementationsOf(decoy.parent), `${label}: implementations of the decoy parent`).toEqual([
    siteKey(decoy.implementer),
  ]);
  expect(implementationsOf(decoy.child), `${label}: implementations of the decoy child`).toEqual([
    siteKey(decoy.implementer),
  ]);

  // Supertypes and subtypes keep the relation each edge records.
  expect(related(child, "super", 3), `${label}: supertypes of the child`).toEqual([`${siteKey(parent)} extends@1`]);
  expect(related(parent, "sub", 1), `${label}: direct subtypes of the parent`).toEqual(
    [
      `${siteKey(child)} extends@1`,
      `${siteKey(lonely)} extends@1`,
      ...direct.map((site) => `${siteKey(site)} implements@1`),
    ].sort(),
  );
  for (const site of viaChild) {
    expect(related(site, "super", 3), `${label}: supertypes of ${site.name}`).toEqual(
      [`${siteKey(child)} implements@1`, `${siteKey(parent)} extends@2`].sort(),
    );
  }
  expect(related(decoy.child, "super", 3), `${label}: supertypes of the decoy child`).toEqual([
    `${siteKey(decoy.parent)} extends@1`,
  ]);
}
