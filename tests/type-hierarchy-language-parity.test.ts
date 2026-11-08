import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { findImplementations, findTypeHierarchy } from "../src/indexer/type-hierarchy.js";
import * as nativeRuntime from "../src/native/tree-sitter-native.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { INTERFACE_INHERITANCE_FIXTURES, expectInterfaceInheritance } from "./helpers/interface-inheritance-fixture.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

type ProvenRelation = {
  from: string;
  to: string;
  relation: "extends" | "implements" | "trait" | "mixin";
};

const PROVEN_RELATIONS: ProvenRelation[] = [
  { from: "TsWorker", to: "TsBase", relation: "extends" },
  { from: "TsWorker", to: "TsService", relation: "implements" },
  { from: "TsConcrete", to: "TsAbstract", relation: "extends" },
  { from: "JavaWorker", to: "JavaService", relation: "implements" },
  { from: "JavaSpecialized", to: "JavaWorker", relation: "extends" },
  { from: "CsWorker", to: "CsService", relation: "implements" },
  { from: "CsSpecialized", to: "CsWorker", relation: "extends" },
  { from: "CsConcrete", to: "CsAbstract", relation: "extends" },
  { from: "RustWorker", to: "RustService", relation: "implements" },
  { from: "SwiftWorker", to: "SwiftService", relation: "implements" },
  { from: "SwiftSpecialized", to: "SwiftWorker", relation: "extends" },
  { from: "CppWorker", to: "CppBase", relation: "extends" },
  { from: "PyWorker", to: "PyBase", relation: "extends" },
  { from: "KotlinWorker", to: "KotlinService", relation: "implements" },
  { from: "KotlinSpecialized", to: "KotlinWorker", relation: "extends" },
  { from: "PhpWorker", to: "PhpBase", relation: "extends" },
  { from: "PhpWorker", to: "PhpService", relation: "implements" },
  { from: "PhpWorker", to: "PhpGreets", relation: "trait" },
  { from: "PhpStatus", to: "PhpService", relation: "implements" },
  { from: "RubyWorker", to: "RubyBase", relation: "extends" },
  { from: "RubyWorker", to: "RubyGreets", relation: "mixin" },
  { from: "RubyWorker", to: "RubyExtends", relation: "mixin" },
  { from: "RubyWorker", to: "RubyPrepends", relation: "mixin" },
  { from: "JavaRecord", to: "JavaService", relation: "implements" },
  { from: "CsRecordClass", to: "CsRecordBase", relation: "extends" },
  { from: "CsRecordClass", to: "CsService", relation: "implements" },
  { from: "CsRecordStruct", to: "CsService", relation: "implements" },
];

type NestedBaseClauseFixture = { language: string; file: string; source: string; relations: readonly string[] };

/** Compiler-verified where one exists (Roslyn, javac, kotlinc, tsc, Python); each outer type has no base clause. */
const NESTED_BASE_CLAUSE_FIXTURES: readonly NestedBaseClauseFixture[] = [
  {
    language: "Java",
    file: "Nested.java",
    source: [
      "interface Contract {}",
      "",
      "class Base {}",
      "",
      "class Outer {",
      "    interface Inner extends Contract {}",
      "",
      "    static class Child extends Base {}",
      "}",
      "",
    ].join("\n"),
    relations: ["Child:extends:Base", "Inner:extends:Contract"],
  },
  {
    language: "C#",
    file: "Nested.cs",
    source: [
      "interface IContract { }",
      "class Base { }",
      "class Outer",
      "{",
      "    public interface IInner : IContract { }",
      "    public class Child : Base { }",
      "}",
      "interface IOuter",
      "{",
      "    class Nested : Base { }",
      "}",
      "",
    ].join("\n"),
    relations: ["Child:extends:Base", "IInner:extends:IContract", "Nested:extends:Base"],
  },
  {
    language: "Kotlin",
    file: "Nested.kt",
    source: [
      "interface Contract",
      "",
      "open class Base",
      "",
      "class Outer {",
      "    interface Inner : Contract",
      "",
      "    class Child : Base()",
      "",
      "    companion object : Contract",
      "}",
      "",
    ].join("\n"),
    relations: ["Child:extends:Base", "Inner:extends:Contract"],
  },
  {
    language: "TypeScript",
    file: "nested.ts",
    source: [
      "class Base {}",
      "",
      "export class Outer {",
      "  make() {",
      "    class Child extends Base {}",
      "    return Child;",
      "  }",
      "}",
      "",
    ].join("\n"),
    relations: ["Child:extends:Base"],
  },
  {
    language: "Python",
    file: "nested.py",
    source: [
      "class Bar:",
      "    pass",
      "",
      "",
      "def foo(x):",
      "    return x",
      "",
      "",
      "class Plain:",
      "    value = foo(Bar)",
      "",
      "",
      "class Outer:",
      "    class Inner(Bar):",
      "        pass",
      "",
    ].join("\n"),
    relations: ["Inner:extends:Bar"],
  },
  {
    language: "Swift",
    file: "Nested.swift",
    source: ["class Base {}", "protocol P {}", "class Outer {", "    class Inner: Base, P {}", "}", ""].join("\n"),
    relations: ["Inner:extends:Base", "Inner:implements:P"],
  },
  {
    language: "Ruby",
    file: "nested.rb",
    source: ["class Base", "end", "", "module Outer", "  class Inner < Base", "  end", "end", ""].join("\n"),
    relations: ["Inner:extends:Base"],
  },
  {
    language: "C++",
    file: "nested.cpp",
    source: ["class Base {};", "class Outer { class Inner : public Base {}; };", ""].join("\n"),
    relations: ["Inner:extends:Base"],
  },
  {
    language: "PHP",
    file: "nested.php",
    source: [
      "<?php",
      "trait T {}",
      "class Base {}",
      "class Outer {",
      "    function make() {",
      "        return new class extends Base { use T; };",
      "    }",
      "}",
      "",
    ].join("\n"),
    relations: [],
  },
];

nativeDescribe("type hierarchy language parity", () => {
  it("extracts only proven current inheritance and conformance forms across ten languages", async () => {
    const root = await mkTmpDir("cg-hierarchy-parity-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "types.ts": [
        "interface TsService { run(): void }",
        "class TsBase {}",
        "class TsWorker extends TsBase implements TsService { run(): void {} }",
        "class TsUnrelated { run(): void {} }",
        "abstract class TsAbstract { abstract execute(): void }",
        "class TsConcrete extends TsAbstract { execute(): void {} }",
      ].join("\n"),
      "Types.java": [
        "interface JavaService { void run(); }",
        "class JavaWorker implements JavaService { public void run() {} }",
        "class JavaSpecialized extends JavaWorker {}",
        "record JavaRecord(int amount) implements JavaService { public void run() {} }",
      ].join("\n"),
      "Types.cs": [
        "interface CsService { void Run(); }",
        "class CsWorker : CsService { public void Run() {} }",
        "class CsSpecialized : CsWorker {}",
        "abstract class CsAbstract { public abstract void Execute(); }",
        "class CsConcrete : CsAbstract { public override void Execute() {} }",
        "public record class CsRecordBase {}",
        "public record class CsRecordClass(int Size) : CsRecordBase, CsService { public void Run() {} }",
        "public record struct CsRecordStruct(int Width) : CsService { public void Run() {} }",
      ].join("\n"),
      "types.rs": [
        "trait RustService { fn run(&self); }",
        "struct RustWorker;",
        "impl RustService for RustWorker { fn run(&self) {} }",
      ].join("\n"),
      "Types.swift": [
        "protocol SwiftService { func run() }",
        "class SwiftWorker: SwiftService { func run() {} }",
        "class SwiftSpecialized: SwiftWorker {}",
      ].join("\n"),
      "types.cpp": ["class CppBase {};", "class CppWorker : public CppBase {};"].join("\n"),
      "types.py": ["class PyBase:", "    pass", "class PyWorker(PyBase):", "    pass"].join("\n"),
      "Types.kt": [
        "interface KotlinService {",
        "  fun run()",
        "}",
        "open class KotlinWorker : KotlinService {",
        "  override fun run() {}",
        "}",
        "class KotlinSpecialized : KotlinWorker()",
      ].join("\n"),
      "Types.php": [
        "<?php",
        "interface PhpService { public function run(): void; }",
        'trait PhpGreets { public function greet(): string { return "hi"; } }',
        "class PhpBase {}",
        "class PhpWorker extends PhpBase implements PhpService {",
        "  use PhpGreets;",
        "  public function run(): void {}",
        "}",
        "enum PhpStatus implements PhpService {",
        "  case Active;",
        "  case Inactive;",
        "  public function run(): void {}",
        "}",
      ].join("\n"),
      "types.rb": [
        "module RubyGreets",
        "  def greet",
        '    "hi"',
        "  end",
        "end",
        "",
        "module RubyExtends",
        "  def extended_greet",
        '    "hi"',
        "  end",
        "end",
        "",
        "module RubyPrepends",
        "  def prepended_greet",
        '    "hi"',
        "  end",
        "end",
        "",
        "class RubyBase",
        "end",
        "",
        "class RubyWorker < RubyBase",
        "  include RubyGreets",
        "  extend RubyExtends",
        "  prepend RubyPrepends",
        "end",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node.id]));
    const actualRelations = new Set(
      graph.edges
        .filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
        .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`),
    );

    for (const expected of PROVEN_RELATIONS) {
      expect(nodesByName.has(expected.from), `${expected.from} was not indexed`).toBe(true);
      expect(nodesByName.has(expected.to), `${expected.to} was not indexed`).toBe(true);
      expect(actualRelations).toContain(`${expected.from}:${expected.relation}:${expected.to}`);
    }
    expect(actualRelations.size, "unexpected extra extends/implements/trait/mixin edges were emitted").toBe(
      PROVEN_RELATIONS.length,
    );
    expect(actualRelations).not.toContain("TsUnrelated:implements:TsService");
    for (const [recordName, componentName] of [
      ["JavaRecord", "amount"],
      ["CsRecordClass", "Size"],
      ["CsRecordStruct", "Width"],
    ] as const) {
      const recordId = nodesByName.get(recordName);
      expect(recordId, `${recordName} was not indexed`).toBeDefined();
      const memberNames = graph.edges
        .filter((edge) => edge.to === recordId && edge.label === "member_of")
        .map((edge) => graph.nodes.get(edge.from)?.name);
      expect(memberNames, `${recordName} exposed a component-derived member symbol`).not.toContain(componentName);
    }
    const moduleLocals = [...index.byFile.values()].flatMap((entry) =>
      entry.locals.map((local) => ({ name: local.localName, kind: local.kind })),
    );
    const componentKinds = moduleLocals.filter((local) => local.name === "amount").map((local) => local.kind);
    expect(componentKinds, "Java record components are indexed as variable locals").toEqual(["variable"]);
    expect(
      moduleLocals.filter((local) => ["amount", "Size", "Width"].includes(local.name) && local.kind !== "variable"),
      "record components must not become accessor or field symbols",
    ).toEqual([]);
    for (const [ownerName, implementationName, memberName] of [
      ["TsAbstract", "TsConcrete", "execute"],
      ["CsAbstract", "CsConcrete", "Execute"],
    ] as const) {
      const ownerId = nodesByName.get(ownerName);
      expect(ownerId, `${ownerName} was not indexed`).toBeDefined();
      const memberId = graph.edges
        .filter((edge) => edge.to === ownerId && edge.label === "member_of")
        .map((edge) => edge.from)
        .find((id) => graph.nodes.get(id)?.name === memberName);
      expect(memberId, `${ownerName}.${memberName} was not indexed`).toBeDefined();
      const result = findImplementations(index, graph, memberId!);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(
        result.implementations.map((entry) =>
          entry.implementingTypeId ? graph.nodes.get(entry.implementingTypeId)?.name : undefined,
        ),
      ).toEqual([implementationName]);
    }
  });

  it("excludes generic type arguments and namespace/enclosing-type qualifiers from base-specifier extraction", async () => {
    const root = await mkTmpDir("cg-hierarchy-generic-qualifier-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "types2.ts": [
        "class TsPayload {}",
        "interface TsGenericService<T> {}",
        "class TsGenericWorker implements TsGenericService<TsPayload> {}",
      ].join("\n"),
      "Types2.java": [
        "class JavaPayload {}",
        "interface JavaGenericService<T> { void run(); }",
        "class JavaGenericWorker implements JavaGenericService<JavaPayload> { public void run() {} }",
        "class JavaQualifierHost { static class JavaQualifiedBase {} }",
        "class JavaQualifiedDerived extends JavaQualifierHost.JavaQualifiedBase {}",
      ].join("\n"),
      "Types2.cs": [
        "public class CsPayload {}",
        "public class CsGenericBase<T> {}",
        "public class CsGenericDerived : CsGenericBase<CsPayload> {}",
        "public class CsQualifierHost { public class CsQualifiedBase {} }",
        "public class CsQualifiedDerived : CsQualifierHost.CsQualifiedBase {}",
      ].join("\n"),
      "Types2.swift": [
        "class SwiftPayload {}",
        "protocol SwiftGenericService {}",
        "class SwiftGenericBase<T> {}",
        "class SwiftGenericDerived: SwiftGenericBase<SwiftPayload>, SwiftGenericService {}",
      ].join("\n"),
      "types2.cpp": [
        "class CppPayload {};",
        "template<typename T> class CppGenericBase {};",
        "class CppGenericDerived : public CppGenericBase<CppPayload> {};",
        "class CppQualifierHost { public: class CppQualifiedBase {}; };",
        "class CppQualifiedDerived : public CppQualifierHost::CppQualifiedBase {};",
      ].join("\n"),
      "types2.py": [
        "class PyPayload:",
        "    pass",
        "class PyGenericBase:",
        "    pass",
        "class PyGenericDerived(PyGenericBase[PyPayload]):",
        "    pass",
      ].join("\n"),
      "Types2.kt": [
        "class KotlinPayload",
        "interface KotlinGenericService<T> {",
        "  fun run()",
        "}",
        "open class KotlinGenericWorker : KotlinGenericService<KotlinPayload> {",
        "  override fun run() {}",
        "}",
        "class KotlinArgPayload",
        "open class KotlinArgBase(value: KotlinArgPayload)",
        "class KotlinArgDerived : KotlinArgBase(KotlinArgPayload())",
      ].join("\n"),
      "types2.rb": [
        "module RubyQualifierHost",
        "  class RubyQualifiedBase",
        "  end",
        "end",
        "",
        "class RubyQualifiedDerived < RubyQualifierHost::RubyQualifiedBase",
        "end",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const actualRelations = new Set(
      graph.edges
        .filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
        .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`),
    );

    const expectedRelations: ProvenRelation[] = [
      { from: "TsGenericWorker", to: "TsGenericService", relation: "implements" },
      { from: "JavaGenericWorker", to: "JavaGenericService", relation: "implements" },
      { from: "JavaQualifiedDerived", to: "JavaQualifiedBase", relation: "extends" },
      { from: "CsGenericDerived", to: "CsGenericBase", relation: "extends" },
      { from: "CsQualifiedDerived", to: "CsQualifiedBase", relation: "extends" },
      { from: "SwiftGenericDerived", to: "SwiftGenericBase", relation: "extends" },
      { from: "SwiftGenericDerived", to: "SwiftGenericService", relation: "implements" },
      { from: "CppGenericDerived", to: "CppGenericBase", relation: "extends" },
      { from: "CppQualifiedDerived", to: "CppQualifiedBase", relation: "extends" },
      { from: "PyGenericDerived", to: "PyGenericBase", relation: "extends" },
      { from: "KotlinGenericWorker", to: "KotlinGenericService", relation: "implements" },
      { from: "KotlinArgDerived", to: "KotlinArgBase", relation: "extends" },
      { from: "RubyQualifiedDerived", to: "RubyQualifiedBase", relation: "extends" },
    ];
    expect(actualRelations).toEqual(
      new Set(expectedRelations.map((expected) => `${expected.from}:${expected.relation}:${expected.to}`)),
    );
    expect(actualRelations).not.toContain("CppQualifiedDerived:extends:CppQualifierHost");
  });

  it("extracts JavaScript extends, Go struct embedding, and Go interface embedding as interface inheritance", async () => {
    const root = await mkTmpDir("cg-hierarchy-js-go-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "hierarchy.js": [
        "class JsBase {",
        "  shared() { return 1; }",
        "}",
        "class JsChild extends JsBase {",
        "  run() { return super.shared(); }",
        "}",
      ].join("\n"),
      "hierarchy.go": [
        "package hierarchy",
        "",
        "type GoBase interface {",
        "  Base()",
        "}",
        "type GoWorker interface {",
        "  GoBase",
        "  Work()",
        "}",
        "type GoStruct struct {",
        "  GoBase",
        "}",
        "type GoRefined struct {",
        "  GoWorker",
        "}",
        "type GoNamed struct {",
        "  base GoBase",
        "}",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node.id]));
    const actualRelations = new Set(
      graph.edges
        .filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
        .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`),
    );

    // An interface embedding an interface extends it; only a struct embedding an interface implements it.
    expect(actualRelations).toEqual(
      new Set([
        "JsChild:extends:JsBase",
        "GoWorker:extends:GoBase",
        "GoStruct:implements:GoBase",
        "GoRefined:implements:GoWorker",
      ]),
    );

    const jsChildId = nodesByName.get("JsChild");
    expect(jsChildId, "JsChild was not indexed").toBeDefined();
    if (jsChildId) {
      const supers = findTypeHierarchy(graph, jsChildId, "super");
      expect(supers.status).toBe("ok");
      if (supers.status === "ok") {
        expect(supers.relations.map((relation) => graph.nodes.get(relation.targetId)?.name)).toEqual(["JsBase"]);
      }
    }

    const goBaseId = nodesByName.get("GoBase");
    expect(goBaseId, "GoBase was not indexed").toBeDefined();
    if (goBaseId) {
      const implementations = findImplementations(index, graph, goBaseId);
      expect(implementations.status).toBe("ok");
      if (implementations.status === "ok") {
        // The refining interface never implements GoBase, but the struct embedding it does.
        expect(implementations.implementations.map((match) => graph.nodes.get(match.symbolId)?.name).sort()).toEqual([
          "GoRefined",
          "GoStruct",
        ]);
      }
    }
  });

  it("classifies imported Swift extension protocol conformance without inheriting a decoy", async () => {
    const root = await mkTmpDir("cg-hierarchy-swift-extension-");
    roots.push(root);
    await fs.writeFile(
      path.join(root, "Models.swift"),
      "protocol Proto {}\nstruct Widget {}\nstruct Box<Element> {}\n",
    );
    await fs.writeFile(path.join(root, "Extension.swift"), "import Models\nextension Widget: Proto {}\n");
    await fs.writeFile(path.join(root, "Decoy.swift"), "private struct Widget {}\n");
    await fs.writeFile(
      path.join(root, "Conditional.swift"),
      "import Models\nextension Box: Proto where Element: Equatable {}\n",
    );
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const owner = [...graph.nodes.values()].find(
      (node) => node.name === "Widget" && path.basename(node.file) === "Extension.swift",
    );
    const nominal = [...graph.nodes.values()].find(
      (node) => node.name === "Widget" && path.basename(node.file) === "Models.swift",
    );
    const protocol = [...graph.nodes.values()].find(
      (node) => node.name === "Proto" && path.basename(node.file) === "Models.swift",
    );
    const decoy = [...graph.nodes.values()].find(
      (node) => node.name === "Widget" && path.basename(node.file) === "Decoy.swift",
    );
    const box = [...graph.nodes.values()].find(
      (node) => node.name === "Box" && path.basename(node.file) === "Models.swift",
    );
    expect(owner).toBeDefined();
    expect(nominal).toBeDefined();
    expect(protocol).toBeDefined();
    expect(decoy).toBeDefined();
    expect(box).toBeDefined();
    expect(
      graph.edges.some((edge) => edge.from === owner!.id && edge.to === nominal!.id && edge.label === "uses"),
    ).toBe(true);
    expect(
      graph.edges.some((edge) => edge.from === nominal!.id && edge.to === protocol!.id && edge.label === "implements"),
    ).toBe(true);
    expect(graph.edges.some((edge) => edge.from === owner!.id && edge.to === protocol!.id)).toBe(false);
    expect(
      graph.edges.some((edge) => edge.from === owner!.id && edge.to === protocol!.id && edge.label === "extends"),
    ).toBe(false);
    expect(graph.edges.some((edge) => edge.from === owner!.id && edge.to === decoy!.id)).toBe(false);
    const hierarchy = findTypeHierarchy(graph, owner!.id, "super");
    expect(hierarchy.status).toBe("ok");
    if (hierarchy.status !== "ok") throw new Error("Expected Swift extension conformance");
    expect(hierarchy.relations).toEqual([]);
    const nominalHierarchy = findTypeHierarchy(graph, nominal!.id, "super");
    expect(nominalHierarchy.status).toBe("ok");
    if (nominalHierarchy.status !== "ok") throw new Error("Expected the nominal type hierarchy");
    expect(nominalHierarchy.relations.map((relation) => relation.targetId)).toEqual([protocol!.id]);
    const boxHierarchy = findTypeHierarchy(graph, box!.id, "super");
    expect(boxHierarchy.status).toBe("ok");
    if (boxHierarchy.status !== "ok") throw new Error("Expected the nominal Box type hierarchy");
    expect(boxHierarchy.relations).toEqual([]);
    const implementations = findImplementations(index, graph, protocol!.id);
    expect(implementations.status).toBe("ok");
    if (implementations.status !== "ok") throw new Error("Expected unique Swift implementing type");
    expect(implementations.implementations.map((match) => match.symbolId)).toEqual([nominal!.id]);
  });

  it("follows typealiases to the class or protocol they name in hierarchy and conformance", async () => {
    const root = await mkTmpDir("cg-hierarchy-swift-alias-");
    roots.push(root);
    await fs.writeFile(
      path.join(root, "Types.swift"),
      [
        "protocol P {}",
        "struct Widget {}",
        "class Base: P {}",
        "struct Other {}",
        "typealias Alias = Widget",
        "typealias BaseAlias = Base",
        "typealias ProtocolAlias = P",
        "class Sub: BaseAlias {}",
        "extension Alias: P {}",
        "extension Other: ProtocolAlias {}",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(root, "Generic.swift"),
      [
        "struct Box<Element> {}",
        "typealias IntBox = Box<Int>",
        "extension IntBox: P {}",
        "class GenericBase<Element> {}",
        "typealias IntBase = GenericBase<Int>",
        "class FromGeneric: IntBase {}",
        "",
      ].join("\n"),
    );
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const named = (name: string, file: string, kind: string) =>
      [...graph.nodes.values()].find(
        (node) => node.name === name && path.basename(node.file) === file && node.kind === kind,
      );
    const protocol = named("P", "Types.swift", "type");
    const nominal = named("Widget", "Types.swift", "class");
    const base = named("Base", "Types.swift", "class");
    const other = named("Other", "Types.swift", "class");
    const alias = named("Alias", "Types.swift", "type");
    const baseAlias = named("BaseAlias", "Types.swift", "type");
    const protocolAlias = named("ProtocolAlias", "Types.swift", "type");
    const sub = named("Sub", "Types.swift", "class");
    const box = named("Box", "Generic.swift", "class");
    const fromGeneric = named("FromGeneric", "Generic.swift", "class");
    for (const target of [protocol, nominal, base, other, alias, baseAlias, protocolAlias, sub, box, fromGeneric]) {
      expect(target).toBeDefined();
    }
    const related = (id: string, direction: "super" | "sub"): Array<[string, string]> => {
      const hierarchy = findTypeHierarchy(graph, id, direction);
      if (hierarchy.status !== "ok") throw new Error("Expected a Swift hierarchy");
      return hierarchy.relations.map((relation) => [graph.nodes.get(relation.targetId)?.name ?? "", relation.relation]);
    };
    // An alias names the declaration it provably reaches, so the alias itself is never a hierarchy node.
    expect(related(nominal!.id, "super")).toEqual([["P", "implements"]]);
    expect(related(other!.id, "super")).toEqual([["P", "implements"]]);
    expect(related(sub!.id, "super")).toEqual([["Base", "extends"]]);
    expect(related(base!.id, "sub")).toEqual([["Sub", "extends"]]);
    for (const aliasNode of [alias!, baseAlias!, protocolAlias!]) {
      expect(related(aliasNode.id, "super"), aliasNode.name).toEqual([]);
      expect(related(aliasNode.id, "sub"), aliasNode.name).toEqual([]);
    }
    // A generic specialization is not a proven nominal identity, so it adds no edge in either direction.
    expect(related(box!.id, "super")).toEqual([]);
    expect(related(fromGeneric!.id, "super")).toEqual([]);
    expect(related(protocol!.id, "sub")).toEqual([
      ["Base", "implements"],
      ["Other", "implements"],
      ["Widget", "implements"],
    ]);
    const implementations = findImplementations(index, graph, protocol!.id);
    expect(implementations.status).toBe("ok");
    if (implementations.status !== "ok") throw new Error("Expected the aliased implementations");
    expect(implementations.implementations.map((match) => graph.nodes.get(match.symbolId)?.name).sort()).toEqual([
      "Base",
      "Other",
      "Sub",
      "Widget",
    ]);
  });

  it("keeps Swift protocol inheritance as extends and finds conformers through inherited protocols", async () => {
    const root = await mkTmpDir("cg-hierarchy-swift-refinement-");
    roots.push(root);
    const files: Record<string, string> = {
      "Parent.swift": "protocol Parent {}\n",
      "Child.swift": "protocol Child: Parent {}\nprotocol Grand: Child {}\nprotocol Lonely: Parent {}\n",
      "Conformer.swift":
        "struct Widget: Child {}\nstruct Leaf: Grand {}\nclass Direct: Parent {}\nclass Sub: Direct {}\n",
      "Late.swift": "struct Late {}\nextension Late: Grand {}\n",
      "Same.swift": "protocol SameParent {}\nprotocol SameChild: SameParent {}\nstruct SameWidget: SameChild {}\n",
      "Other.swift": "protocol Unrelated {}\nstruct Decoy: Unrelated {}\n",
    };
    for (const [file, source] of Object.entries(files)) await fs.writeFile(path.join(root, file), source);
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const edgesByLabel = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const keys = edgesByLabel.get(edge.label ?? "") ?? [];
      keys.push(`${graph.nodes.get(edge.from)?.name}->${graph.nodes.get(edge.to)?.name}`);
      edgesByLabel.set(edge.label ?? "", keys);
    }
    // Protocol inheritance never reads as conformance, in one file or across files; only nominal types conform.
    expect(edgesByLabel.get("extends")?.sort()).toEqual([
      "Child->Parent",
      "Grand->Child",
      "Lonely->Parent",
      "SameChild->SameParent",
      "Sub->Direct",
    ]);
    expect(edgesByLabel.get("implements")?.sort()).toEqual([
      "Decoy->Unrelated",
      "Direct->Parent",
      "Late->Grand",
      "Leaf->Grand",
      "SameWidget->SameChild",
      "Widget->Child",
    ]);
    const named = (name: string) => {
      const node = [...graph.nodes.values()].find((candidate) => candidate.name === name && candidate.kind !== "class");
      if (!node) throw new Error(`Expected the ${name} protocol`);
      return node;
    };
    const related = (id: string, direction: "super" | "sub"): string[] => {
      const hierarchy = findTypeHierarchy(graph, id, direction);
      if (hierarchy.status !== "ok") throw new Error("Expected a Swift hierarchy");
      return hierarchy.relations
        .map((relation) => `${graph.nodes.get(relation.targetId)?.name}:${relation.relation}`)
        .sort();
    };
    expect(related(named("Child").id, "super")).toEqual(["Parent:extends"]);
    expect(related(named("Child").id, "sub")).toEqual(["Grand:extends", "Widget:implements"]);
    expect(related(named("Parent").id, "sub")).toEqual(["Child:extends", "Direct:implements", "Lonely:extends"]);
    expect(related(named("SameChild").id, "super")).toEqual(["SameParent:extends"]);
    const implementationsOf = (name: string): string[] => {
      const result = findImplementations(index, graph, named(name).id);
      if (result.status !== "ok") throw new Error(`Expected implementations of ${name}`);
      return result.implementations.map((match) => graph.nodes.get(match.symbolId)?.name ?? "").sort();
    };
    // Conformers of a refining protocol implement what it inherits; the protocols themselves never do.
    expect(implementationsOf("Parent")).toEqual(["Direct", "Late", "Leaf", "Sub", "Widget"]);
    expect(implementationsOf("Child")).toEqual(["Late", "Leaf", "Widget"]);
    expect(implementationsOf("Grand")).toEqual(["Late", "Leaf"]);
    expect(implementationsOf("SameParent")).toEqual(["SameWidget"]);
    expect(implementationsOf("Unrelated")).toEqual(["Decoy"]);
  });

  it.each(INTERFACE_INHERITANCE_FIXTURES)(
    "keeps $language interface inheritance as extends and finds implementers through the child interface",
    async (fixture) => {
      const root = await mkTmpDir("cg-hierarchy-interface-inheritance-");
      roots.push(root);
      await writeFixtureFiles(root, fixture.files);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      expectInterfaceInheritance(root, index, graph, fixture, "cold");
    },
  );

  it.each(NESTED_BASE_CLAUSE_FIXTURES)(
    "reads a $language type's own base clause, never a nested type's or a call in its body",
    async ({ file, source, relations }) => {
      const root = await mkTmpDir("cg-hierarchy-nested-clause-");
      roots.push(root);
      await fs.writeFile(path.join(root, file), source);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const actual = graph.edges
        .filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
        .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`)
        .sort();
      // Only the nested declaration carries its clause; the enclosing type, which has none, carries no edge.
      expect(actual).toEqual([...relations].sort());
    },
  );

  it("adds no edge for a TypeScript namespace-qualified heritage type instead of binding a same-named local", async () => {
    const root = await mkTmpDir("cg-hierarchy-ts-qualified-");
    roots.push(root);
    await writeFixtureFiles(root, {
      "contracts.ts": ["export interface Contract {", "  run(): void;", "}", ""].join("\n"),
      "use.ts": [
        'import * as ns from "./contracts";',
        "",
        "interface Contract {",
        "  other(): void;",
        "}",
        "",
        "export class Widget implements ns.Contract {",
        "  run(): void {}",
        "}",
        "",
        "export interface Refined extends ns.Contract {}",
        "",
        "export const local: Contract = { other() {} };",
        "",
      ].join("\n"),
    });
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    // `ns.Contract` names a member of the namespace import; its bare name `Contract` is the local decoy, so neither
    // heritage clause proves a base and neither adds an edge to the real contract or the local interface.
    expect(
      graph.edges.filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label)),
    ).toEqual([]);
    for (const file of ["contracts.ts", "use.ts"]) {
      const contract = [...graph.nodes.values()].find(
        (node) => node.name === "Contract" && path.basename(node.file) === file,
      );
      expect(contract, `${file} Contract`).toBeDefined();
      const implementations = findImplementations(index, graph, contract!.id);
      expect(implementations.status, file).toBe("ok");
      if (implementations.status !== "ok") throw new Error("Expected an empty implementation result");
      expect(implementations.implementations, file).toEqual([]);
    }
  });

  it("records no edge for a Rust supertrait bound, while every implementer keeps its own impl edge", async () => {
    const root = await mkTmpDir("cg-hierarchy-rust-supertrait-");
    roots.push(root);
    await fs.writeFile(
      path.join(root, "traits.rs"),
      [
        "trait RustParent {",
        "    fn run(&self);",
        "}",
        "trait RustChild: RustParent {}",
        "struct RustWidget;",
        "impl RustParent for RustWidget {",
        "    fn run(&self) {}",
        "}",
        "impl RustChild for RustWidget {}",
        "",
      ].join("\n"),
    );
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    const relations = graph.edges
      .filter((edge) => edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
      .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`)
      .sort();
    // rustc rejects `impl RustChild for Orphan` without `impl RustParent for Orphan`, so the trait bound adds no
    // implementer that a direct impl edge misses, and the trait is never an implementation of its supertrait.
    expect(relations).toEqual(["RustWidget:implements:RustChild", "RustWidget:implements:RustParent"]);
    const parent = [...graph.nodes.values()].find((node) => node.name === "RustParent");
    expect(parent).toBeDefined();
    const implementations = findImplementations(index, graph, parent!.id);
    if (implementations.status !== "ok") throw new Error("Expected Rust trait implementations");
    expect(implementations.implementations.map((match) => graph.nodes.get(match.symbolId)?.name)).toEqual([
      "RustWidget",
    ]);
  });
});
