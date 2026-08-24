import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { findImplementations } from "../src/indexer/type-hierarchy.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
import { mkTmpDir } from "./helpers/filesystem.js";

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
      ].join("\n"),
      "Types.cs": [
        "interface CsService { void Run(); }",
        "class CsWorker : CsService { public void Run() {} }",
        "class CsSpecialized : CsWorker {}",
        "abstract class CsAbstract { public abstract void Execute(); }",
        "class CsConcrete : CsAbstract { public override void Execute() {} }",
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
        "class RubyBase",
        "end",
        "",
        "class RubyWorker < RubyBase",
        "  include RubyGreets",
        "end",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off", native: "on" });
    const graph = await buildSymbolGraphDetailed(index);
    const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node.id]));
    const actualRelations = new Set(
      graph.edges
        .filter((edge) => !!edge.label && ["extends", "implements", "trait", "mixin"].includes(edge.label))
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
});
