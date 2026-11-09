import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import type { SymbolGraph, SymbolNode } from "../../src/graphs/symbol-graph.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../../src/index.js";
import { findImplementations, findTypeHierarchy } from "../../src/indexer/type-hierarchy.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { normalizePath } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";

/**
 * A Kotlin class that declares only secondary constructors names its base class bare
 * (`class V : Base { constructor() : super(1) }`), beside the constructor-call form (`class W : Base(2)`) of the same
 * base. Each shape appears for a concrete base, an abstract base, a sealed base, and a class that also implements an
 * interface, with the class listed first (`X`) and last (`Y`, and `Z` through a constructor call). Package `z` declares
 * a decoy `Base` and `Marker` with their own subclass, so every answer checks inclusion and exclusion together.
 *
 * The sources compile with kotlinc 2.4.21.
 */
export const KOTLIN_SECONDARY_CONSTRUCTOR_FILES: Readonly<Record<string, string>> = {
  "a/Base.kt": [
    "package a",
    "",
    "open class Base(val x: Int) {",
    "    open fun run(): Int = x",
    "}",
    "",
    "abstract class Shape {",
    "    abstract fun execute(): Int",
    "}",
    "",
    "interface Marker {",
    "    fun mark(): Int = 0",
    "}",
    "",
  ].join("\n"),
  // A sealed class's subclasses must share its package.
  "a/Token.kt": [
    "package a",
    "",
    "sealed class Token {",
    "    open fun tag(): Int = 1",
    "}",
    "",
    "class Leaf : Token {",
    "    constructor() : super()",
    "}",
    "",
    "class Branch : Token()",
    "",
  ].join("\n"),
  "b/Subs.kt": [
    "package b",
    "",
    "import a.Base",
    "import a.Marker",
    "import a.Shape",
    "",
    "class V : Base {",
    "    constructor() : super(1)",
    "",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
    "class W : Base(2) {",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
    "class Square : Shape {",
    "    constructor() : super()",
    "",
    "    override fun execute(): Int = 4",
    "}",
    "",
    "class Circle : Shape() {",
    "    override fun execute(): Int = 3",
    "}",
    "",
    "class X : Base, Marker {",
    "    constructor() : super(3)",
    "",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
    "class Y : Marker, Base {",
    "    constructor() : super(4)",
    "",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
    "class Z : Marker, Base(5) {",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
  ].join("\n"),
  "z/Decoy.kt": [
    "package z",
    "",
    "open class Base(val x: Int) {",
    "    open fun run(): Int = -x",
    "}",
    "",
    "interface Marker {",
    "    fun mark(): Int = 9",
    "}",
    "",
    "class DecoyChild : Base {",
    "    constructor() : super(0)",
    "",
    "    fun go(): Int {",
    "        return super.run()",
    "    }",
    "}",
    "",
    "class DecoyImpl : Marker",
    "",
  ].join("\n"),
};

/** Every `extends` and `implements` edge of the project, keyed `Name@file`; the decoy chain stays apart. */
const RELATIONS: readonly string[] = [
  "Branch@a/Token.kt extends Token@a/Token.kt",
  "Circle@b/Subs.kt extends Shape@a/Base.kt",
  "DecoyChild@z/Decoy.kt extends Base@z/Decoy.kt",
  "DecoyImpl@z/Decoy.kt implements Marker@z/Decoy.kt",
  "Leaf@a/Token.kt extends Token@a/Token.kt",
  "Square@b/Subs.kt extends Shape@a/Base.kt",
  "V@b/Subs.kt extends Base@a/Base.kt",
  "W@b/Subs.kt extends Base@a/Base.kt",
  "X@b/Subs.kt extends Base@a/Base.kt",
  "X@b/Subs.kt implements Marker@a/Base.kt",
  "Y@b/Subs.kt extends Base@a/Base.kt",
  "Y@b/Subs.kt implements Marker@a/Base.kt",
  "Z@b/Subs.kt extends Base@a/Base.kt",
  "Z@b/Subs.kt implements Marker@a/Base.kt",
];

const TYPE_NODE_KINDS = new Set<string>(["class", "interface", "type"]);

/** The 1-based lines of `needle` in a fixture file. */
function linesContaining(file: string, needle: string): number[] {
  return KOTLIN_SECONDARY_CONSTRUCTOR_FILES[file]!.split("\n").flatMap((text, index) =>
    text.includes(needle) ? [index + 1] : [],
  );
}

async function withProject(run: (root: string, files: Record<string, string>) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-secondary-constructor-"));
  try {
    await run(root, await writeFixtureFiles(root, KOTLIN_SECONDARY_CONSTRUCTOR_FILES));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/**
 * A class with only secondary constructors extends its base exactly as a constructor-call subclass does: the same
 * graph relation, supertypes, and implementations, whatever the base kind and wherever the class sits in the list.
 */
export function expectKotlinSecondaryConstructorHierarchy(
  root: string,
  index: ProjectIndex,
  graph: SymbolGraph,
  label: string,
): void {
  const normalizedRoot = normalizePath(root);
  const nodeKey = (node: SymbolNode | undefined): string =>
    node ? `${node.name}@${path.posix.relative(normalizedRoot, normalizePath(node.file))}` : "<missing>";
  const nodeAt = (name: string, file: string): SymbolNode => {
    const found = [...graph.nodes.values()].filter(
      (node) => TYPE_NODE_KINDS.has(node.kind) && nodeKey(node) === `${name}@${file}`,
    );
    if (found.length !== 1)
      throw new Error(`${label}: expected one type node for ${name}@${file}, found ${found.length}`);
    return found[0]!;
  };
  const relations = graph.edges
    .filter((edge) => edge.label === "extends" || edge.label === "implements")
    .map((edge) => `${nodeKey(graph.nodes.get(edge.from))} ${edge.label} ${nodeKey(graph.nodes.get(edge.to))}`)
    .sort();
  expect(relations, `${label}: extends and implements edges`).toEqual([...RELATIONS].sort());

  const supertypes = (name: string, file: string): string[] => {
    const result = findTypeHierarchy(graph, nodeAt(name, file).id, "super", { depth: 3 });
    if (result.status !== "ok") throw new Error(`${label}: expected supertypes of ${name}`);
    return result.relations
      .map((relation) => `${nodeKey(graph.nodes.get(relation.targetId))} ${relation.relation}@${relation.depth}`)
      .sort();
  };
  expect(supertypes("V", "b/Subs.kt"), `${label}: supertypes of V`).toEqual(["Base@a/Base.kt extends@1"]);
  expect(supertypes("W", "b/Subs.kt"), `${label}: supertypes of W`).toEqual(["Base@a/Base.kt extends@1"]);
  for (const name of ["X", "Y", "Z"]) {
    expect(supertypes(name, "b/Subs.kt"), `${label}: supertypes of ${name}`).toEqual([
      "Base@a/Base.kt extends@1",
      "Marker@a/Base.kt implements@1",
    ]);
  }
  expect(supertypes("DecoyChild", "z/Decoy.kt"), `${label}: supertypes of the decoy child`).toEqual([
    "Base@z/Decoy.kt extends@1",
  ]);

  const implementations = (name: string, file: string): string[] | "unsupported_target" => {
    const result = findImplementations(index, graph, nodeAt(name, file).id);
    if (result.status === "unsupported_target") return result.status;
    if (result.status !== "ok") throw new Error(`${label}: expected implementations of ${name}, got ${result.status}`);
    expect(result.ambiguous, `${label}: ${name} ambiguity`).toBe(0);
    return result.implementations
      .map((match) => `${nodeKey(graph.nodes.get(match.symbolId))} ${match.relation}`)
      .sort();
  };
  // A concrete or sealed class is no contract, so a secondary-constructor subclass cannot make it one.
  expect(implementations("Base", "a/Base.kt"), `${label}: implementations of a concrete class`).toBe(
    "unsupported_target",
  );
  expect(implementations("Token", "a/Token.kt"), `${label}: implementations of a sealed class`).toBe(
    "unsupported_target",
  );
  expect(implementations("Base", "z/Decoy.kt"), `${label}: implementations of the decoy class`).toBe(
    "unsupported_target",
  );
  // An abstract class lists both forms as extending it, and only the interface lists its implementers.
  expect(implementations("Shape", "a/Base.kt"), `${label}: implementations of an abstract class`).toEqual([
    "Circle@b/Subs.kt extends",
    "Square@b/Subs.kt extends",
  ]);
  expect(implementations("Marker", "a/Base.kt"), `${label}: implementations of the interface`).toEqual([
    "X@b/Subs.kt implements",
    "Y@b/Subs.kt implements",
    "Z@b/Subs.kt implements",
  ]);
  expect(implementations("Marker", "z/Decoy.kt"), `${label}: implementations of the decoy interface`).toEqual([
    "DecoyImpl@z/Decoy.kt implements",
  ]);
}

/**
 * `super.run()` in a class with only secondary constructors reaches the base's `run` in go-to-definition and in the
 * detailed graph alike, for every class position, and never the decoy base's.
 */
export async function expectKotlinSecondaryConstructorSuperCalls(): Promise<void> {
  await withProject(async (root, files) => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const sites = [
      ...linesContaining("b/Subs.kt", "super.run()").map((line) => ({ file: "b/Subs.kt", line, base: "a/Base.kt" })),
      ...linesContaining("z/Decoy.kt", "super.run()").map((line) => ({ file: "z/Decoy.kt", line, base: "z/Decoy.kt" })),
    ];
    // V, W, X, Y, and Z call the real base; the decoy child calls its own.
    expect(sites.map((site) => `${site.file}:${site.base}`)).toEqual([
      "b/Subs.kt:a/Base.kt",
      "b/Subs.kt:a/Base.kt",
      "b/Subs.kt:a/Base.kt",
      "b/Subs.kt:a/Base.kt",
      "b/Subs.kt:a/Base.kt",
      "z/Decoy.kt:z/Decoy.kt",
    ]);
    for (const site of sites) {
      const lines = KOTLIN_SECONDARY_CONSTRUCTOR_FILES[site.file]!.split("\n");
      const located = `${site.file}:${site.line}`;
      const goto = await goToDefinition(index, {
        file: files[site.file]!,
        line: site.line,
        column: columnOf(lines, site.line, "run"),
      });
      expect(goto.status, located).toBe("ok");
      if (goto.status !== "ok") continue;
      expect(goto.definition.file, located).toBe(files[site.base]);
      expect(goto.definition.range.start.line, located).toBe(linesContaining(site.base, "fun run()")[0]);
      // The graph's call edge for the same site reaches the same declaration.
      const callTargets = graph.edges
        .filter(
          (edge) =>
            edge.label === "calls" && edge.site?.file === files[site.file] && edge.site.range.start.line === site.line,
        )
        .map((edge) => `${graph.nodes.get(edge.to)?.name}@${graph.nodes.get(edge.to)?.file}`);
      expect(callTargets, `${located}: graph calls edge`).toEqual([`run@${files[site.base]}`]);
    }
  });
}

/** References to the base's `run` include every `super.run()` call, complete, and never the decoy base's. */
export async function expectKotlinSecondaryConstructorSuperReferences(): Promise<void> {
  await withProject(async (root, files) => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const referenceSites = async (file: string): Promise<string[]> => {
      const lines = KOTLIN_SECONDARY_CONSTRUCTOR_FILES[file]!.split("\n");
      const line = linesContaining(file, "fun run()")[0]!;
      const refs = await findReferences(index, { file: files[file]!, line, column: columnOf(lines, line, "run") });
      if (refs.status !== "ok") throw new Error(`Expected references of ${file} run`);
      expect(refs.referenceCoverage, file).toEqual({ scope: "indexed_candidates", state: "complete" });
      return refs.references
        .map((reference) => `${path.relative(root, reference.file).replace(/\\/g, "/")}:${reference.range.start.line}`)
        .sort();
    };
    const calls = linesContaining("b/Subs.kt", "super.run()").map((line) => `b/Subs.kt:${line}`);
    expect(await referenceSites("a/Base.kt")).toEqual(
      [`a/Base.kt:${linesContaining("a/Base.kt", "fun run()")[0]}`, ...calls].sort(),
    );
    const decoyDeclaration = linesContaining("z/Decoy.kt", "fun run()")[0];
    expect(await referenceSites("z/Decoy.kt")).toEqual(
      [`z/Decoy.kt:${decoyDeclaration}`, `z/Decoy.kt:${linesContaining("z/Decoy.kt", "super.run()")[0]}`].sort(),
    );
  });
}

/** Builds the fixture project and runs the hierarchy expectation through the public index and graph. */
export async function expectKotlinSecondaryConstructorHierarchyInProject(): Promise<void> {
  await withProject(async (root) => {
    const index = await buildProjectIndex(root, { cache: "off" });
    expectKotlinSecondaryConstructorHierarchy(root, index, await buildSymbolGraphDetailed(index), "cold");
  });
}
