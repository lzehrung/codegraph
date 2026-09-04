import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
import {
  emitReceiverCallEdges,
  type ReceiverCallCandidate,
} from "../src/graphs/symbol-graph-detailed/receiverCalls.js";
import type { SymbolGraph, SymbolNode } from "../src/graphs/symbol-graph.js";
import { findCallHierarchy } from "../src/indexer/call-hierarchy.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function buildFixture(prefix: string, files: Record<string, string>): Promise<DetailedSymbolGraph> {
  const root = await mkTmpDir(prefix);
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source);
  }
  // Detailed graphs require native Tree-sitter. This helper is only called from
  // nativeDescribe suites, so it does not run when that runtime is unavailable.
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
  return await buildSymbolGraphDetailed(index);
}

/** Function members named `memberName` owned by the type named `ownerName`. */
function membersOwnedBy(graph: DetailedSymbolGraph, ownerName: string, memberName: string): string[] {
  const owners = [...graph.nodes.values()].filter((node) => node.name === ownerName && node.kind !== "function");
  expect(owners, `expected exactly one ${ownerName} type`).toHaveLength(1);
  const ownerId = owners[0]!.id;
  return graph.edges
    .filter((edge) => edge.label === "member_of" && edge.to === ownerId)
    .map((edge) => edge.from)
    .filter((id) => {
      const node = graph.nodes.get(id);
      return node?.kind === "function" && node.name === memberName;
    });
}

/** Resolves the graph node for a declaration by name and declaring file basename. */
function nodeIn(graph: DetailedSymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter(
    (node) => node.name === name && path.basename(node.file) === file && node.kind === "function",
  );
  expect(matches, `expected exactly one ${name} function in ${file}`).toHaveLength(1);
  return matches[0]!.id;
}

/** Callsite texts of `caller -> callee` from the resolved calls edges, or null when no edge exists. */
function callsiteTexts(
  graph: DetailedSymbolGraph,
  calleeId: string,
  callerId: string,
  sources: Record<string, string>,
): string[] | null {
  const result = findCallHierarchy(graph, calleeId, "incoming");
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return null;
  const entry = result.entries.find((candidate) => candidate.symbolId === callerId);
  if (!entry) return null;
  return entry.callsites.map((site) => {
    const source = sources[path.basename(site.file)];
    expect(source, `no fixture source for ${site.file}`).toBeDefined();
    return (source ?? "").slice(site.range.start.index, site.range.end.index);
  });
}

const TS_REPORTER_FIXTURE: Record<string, string> = {
  "lib.ts": "export class Lib { target(): number { return 1; } }\n",
  "caller.ts": [
    'import { Lib } from "./lib";',
    "export class Caller {",
    "  plain(): number { const l = new Lib(); return l.target(); }",
    "  viaThis(): number { return this.plain(); }",
    "}",
  ].join("\n"),
  "lib2.ts": "export function targetFn(): number { return 1; }\n",
  "caller2.ts": ['import { targetFn } from "./lib2";', "export function callIt(): number { return targetFn(); }"].join(
    "\n",
  ),
};

nativeDescribe("receiver method call edges", () => {
  it("records a calls edge for a TypeScript instance method invoked on a constructed receiver", async () => {
    const graph = await buildFixture("cg-receiver-ts-", TS_REPORTER_FIXTURE);
    const target = nodeIn(graph, "lib.ts", "target");
    const plain = nodeIn(graph, "caller.ts", "plain");
    expect(callsiteTexts(graph, target, plain, TS_REPORTER_FIXTURE)).toEqual(["target"]);
  });

  it("records a calls edge for a TypeScript this-receiver method invocation", async () => {
    const graph = await buildFixture("cg-receiver-ts-this-", TS_REPORTER_FIXTURE);
    const plain = nodeIn(graph, "caller.ts", "plain");
    const viaThis = nodeIn(graph, "caller.ts", "viaThis");
    expect(callsiteTexts(graph, plain, viaThis, TS_REPORTER_FIXTURE)).toEqual(["plain"]);
  });

  it("keeps the free-function control case resolved", async () => {
    const graph = await buildFixture("cg-receiver-ts-free-", TS_REPORTER_FIXTURE);
    const targetFn = nodeIn(graph, "lib2.ts", "targetFn");
    const callIt = nodeIn(graph, "caller2.ts", "callIt");
    expect(callsiteTexts(graph, targetFn, callIt, TS_REPORTER_FIXTURE)).toEqual(["targetFn"]);
  });

  it("resolves each same-named method to the class of its own receiver", async () => {
    const files: Record<string, string> = {
      "a.ts": "export class A { run(): number { return 1; } }\n",
      "b.ts": "export class B { run(): number { return 2; } }\n",
      "use.ts": [
        'import { A } from "./a";',
        'import { B } from "./b";',
        "export function useA(): number { const a = new A(); return a.run(); }",
        "export function useB(): number { const b = new B(); return b.run(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-distinct-", files);
    const aRun = nodeIn(graph, "a.ts", "run");
    const bRun = nodeIn(graph, "b.ts", "run");
    const useA = nodeIn(graph, "use.ts", "useA");
    const useB = nodeIn(graph, "use.ts", "useB");
    expect(callsiteTexts(graph, aRun, useA, files)).toEqual(["run"]);
    expect(callsiteTexts(graph, aRun, useB, files)).toBeNull();
    expect(callsiteTexts(graph, bRun, useB, files)).toEqual(["run"]);
    expect(callsiteTexts(graph, bRun, useA, files)).toBeNull();
  });

  it("leaves a structurally typed receiver unresolved instead of guessing by name", async () => {
    const files: Record<string, string> = {
      "svc.ts": "export class Svc { run(): number { return 1; } }\n",
      "dynamic.ts": ["export function callDynamic(value: { run(): number }): number { return value.run(); }"].join(
        "\n",
      ),
    };
    const graph = await buildFixture("cg-receiver-ts-dynamic-", files);
    const svcRun = nodeIn(graph, "svc.ts", "run");
    const callDynamic = nodeIn(graph, "dynamic.ts", "callDynamic");
    expect(callsiteTexts(graph, svcRun, callDynamic, files)).toBeNull();
  });

  it("leaves a factory-assigned receiver unresolved instead of guessing by name", async () => {
    const files: Record<string, string> = {
      "svc.ts": [
        "export class Svc { run(): number { return 1; } }",
        "export function getSvc(): Svc { return new Svc(); }",
      ].join("\n"),
      "dyn.ts": [
        'import { getSvc } from "./svc";',
        "export function callIt(): number { const value = getSvc(); return value.run(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-factory-", files);
    const svcRun = nodeIn(graph, "svc.ts", "run");
    const callIt = nodeIn(graph, "dyn.ts", "callIt");
    expect(callsiteTexts(graph, svcRun, callIt, files)).toBeNull();
  });

  it("records calls edges for PHP instance, self, static, class-qualified, and free calls", async () => {
    const files: Record<string, string> = {
      "example.php": [
        "<?php",
        "function php_free() {}",
        "class Example {",
        "    function helper() {}",
        "    static function shared() {}",
        "    function run() {",
        "        php_free();",
        "        $this->helper();",
        "        self::helper();",
        "        static::shared();",
        "        Example::shared();",
        "    }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-", files);
    const helper = nodeIn(graph, "example.php", "helper");
    const shared = nodeIn(graph, "example.php", "shared");
    const free = nodeIn(graph, "example.php", "php_free");
    const run = nodeIn(graph, "example.php", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper", "helper"]);
    expect(callsiteTexts(graph, shared, run, files)).toEqual(["shared", "shared"]);
    expect(callsiteTexts(graph, free, run, files)).toEqual(["php_free"]);
  });

  it("resolves PHP inherited and parent-qualified receiver calls to the base declaration", async () => {
    const files: Record<string, string> = {
      "inherit.php": [
        "<?php",
        "class Base {",
        "    function shared() {}",
        "}",
        "class Child extends Base {",
        "    function run() {",
        "        $this->shared();",
        "        parent::shared();",
        "    }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-inherit-", files);
    const shared = nodeIn(graph, "inherit.php", "shared");
    const run = nodeIn(graph, "inherit.php", "run");
    expect(callsiteTexts(graph, shared, run, files)).toEqual(["shared", "shared"]);
  });

  it("records a PHP trait method invoked on $this", async () => {
    const files: Record<string, string> = {
      "trait.php": [
        "<?php",
        "trait Greeter { function greet() {} }",
        "class Host {",
        "    use Greeter;",
        "    function run() { $this->greet(); }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-trait-", files);
    const greet = nodeIn(graph, "trait.php", "greet");
    const run = nodeIn(graph, "trait.php", "run");
    expect(callsiteTexts(graph, greet, run, files)).toEqual(["greet"]);
  });

  it("records PHP parent:: on the class ancestor when a trait declares the same name", async () => {
    const files: Record<string, string> = {
      "parent.php": [
        "<?php",
        "trait Greeter { function shared() {} }",
        "class Base { function shared() {} }",
        "class Child extends Base {",
        "    use Greeter;",
        "    function run() {",
        "        $this->shared();",
        "        parent::shared();",
        "    }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-parent-trait-", files);
    const run = nodeIn(graph, "parent.php", "run");
    const baseShared = membersOwnedBy(graph, "Base", "shared");
    const traitShared = membersOwnedBy(graph, "Greeter", "shared");
    expect(baseShared).toHaveLength(1);
    expect(traitShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, run, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, traitShared[0]!, run, files)).toBeNull();
  });
});

nativeDescribe("receiver method call edge language parity", () => {
  it("records calls edges for Python self receivers", async () => {
    const files: Record<string, string> = {
      "pyexample.py": [
        "class PyExample:",
        "    def py_helper(self):",
        "        return 1",
        "    def py_run(self):",
        "        return self.py_helper()",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-py-", files);
    const helper = nodeIn(graph, "pyexample.py", "py_helper");
    const run = nodeIn(graph, "pyexample.py", "py_run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["py_helper"]);
  });

  it("records calls edges for C# this receivers", async () => {
    const files: Record<string, string> = {
      "Csx.cs": ["class Csx {", "  void CsHelper() {}", "  void CsRun() { this.CsHelper(); }", "}"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-cs-", files);
    const helper = nodeIn(graph, "Csx.cs", "CsHelper");
    const run = nodeIn(graph, "Csx.cs", "CsRun");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["CsHelper"]);
  });

  it("records a C# base call on the class ancestor when an interface declares the same name", async () => {
    const files: Record<string, string> = {
      "CsBase.cs": [
        "interface CsFace { void Shared(); }",
        "class CsBase { public void Shared() {} }",
        "class CsLeaf : CsBase, CsFace { public void Go() { base.Shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-cs-base-", files);
    const go = nodeIn(graph, "CsBase.cs", "Go");
    const baseShared = membersOwnedBy(graph, "CsBase", "Shared");
    const faceShared = membersOwnedBy(graph, "CsFace", "Shared");
    expect(baseShared).toHaveLength(1);
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, go, files)).toEqual(["Shared"]);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toBeNull();
  });

  // Documented limitation (docs/language-parity.md): Go declares methods outside the
  // receiver type, so no member ownership edge ties a method to its type and no
  // receiver call can be proven. Free Go calls keep working.
  it("leaves Go receiver calls unresolved while keeping free Go calls resolved", async () => {
    const files: Record<string, string> = {
      "gox.go": [
        "package gox",
        "type GoBox struct{}",
        "func (b GoBox) GoHelper() {}",
        "func goFree() {}",
        "func GoRun() { b := GoBox{}; b.GoHelper(); goFree() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-", files);
    const helper = nodeIn(graph, "gox.go", "GoHelper");
    const free = nodeIn(graph, "gox.go", "goFree");
    const run = nodeIn(graph, "gox.go", "GoRun");
    expect(callsiteTexts(graph, helper, run, files)).toBeNull();
    expect(callsiteTexts(graph, free, run, files)).toEqual(["goFree"]);
  });

  it("records calls edges for Rust self receivers", async () => {
    const files: Record<string, string> = {
      "rsx.rs": [
        "pub struct RsBox;",
        "impl RsBox {",
        "  pub fn rs_helper(&self) {}",
        "  pub fn rs_run(&self) { self.rs_helper(); }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-rs-", files);
    const helper = nodeIn(graph, "rsx.rs", "rs_helper");
    const run = nodeIn(graph, "rsx.rs", "rs_run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["rs_helper"]);
  });

  it("records calls edges for Java this receivers", async () => {
    const files: Record<string, string> = {
      "Jav.java": ["class Jav {", "  void javHelper() {}", "  void javRun() { this.javHelper(); }", "}"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-java-", files);
    const helper = nodeIn(graph, "Jav.java", "javHelper");
    const run = nodeIn(graph, "Jav.java", "javRun");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["javHelper"]);
  });

  it("records calls edges for Kotlin this receivers", async () => {
    const files: Record<string, string> = {
      "ktx.kt": ["class KtBox {", "  fun ktHelper() {}", "  fun ktRun() { this.ktHelper() }", "}"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-kt-", files);
    const helper = nodeIn(graph, "ktx.kt", "ktHelper");
    const run = nodeIn(graph, "ktx.kt", "ktRun");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["ktHelper"]);
  });

  it("records calls edges for Swift self receivers", async () => {
    const files: Record<string, string> = {
      "swx.swift": ["class SwBox {", "  func swHelper() {}", "  func swRun() { self.swHelper() }", "}"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-", files);
    const helper = nodeIn(graph, "swx.swift", "swHelper");
    const run = nodeIn(graph, "swx.swift", "swRun");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["swHelper"]);
  });

  it("does not record a deeper unique member when the shallowest overloads stay ambiguous", async () => {
    const files: Record<string, string> = {
      "amb.java": [
        "class GrandAmb { void shared() {} }",
        "class MidAmb extends GrandAmb { void shared(String value) {} void shared(int value) {} }",
        "class LeafAmb extends MidAmb { void go() { this.shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-java-amb-", files);
    const go = nodeIn(graph, "amb.java", "go");
    const midShared = membersOwnedBy(graph, "MidAmb", "shared");
    const grandShared = membersOwnedBy(graph, "GrandAmb", "shared");
    expect(midShared.length).toBeGreaterThan(1);
    expect(grandShared).toHaveLength(1);
    for (const memberId of [...midShared, ...grandShared]) {
      expect(callsiteTexts(graph, memberId, go, files)).toBeNull();
    }
  });

  it("records the arity-unique overload at the shallowest type instead of a deeper unique member", async () => {
    const files: Record<string, string> = {
      "uni.java": [
        "class GrandUni { void shared() {} }",
        "class MidUni extends GrandUni { void shared() {} void shared(int value) {} }",
        "class LeafUni extends MidUni { void go() { this.shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-java-uni-", files);
    const go = nodeIn(graph, "uni.java", "go");
    const midShared = membersOwnedBy(graph, "MidUni", "shared");
    const grandShared = membersOwnedBy(graph, "GrandUni", "shared");
    const zeroArity = midShared.filter((id) => graph.nodes.get(id)?.memberArity === 0);
    expect(zeroArity).toHaveLength(1);
    expect(grandShared).toHaveLength(1);
    expect(callsiteTexts(graph, zeroArity[0]!, go, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, grandShared[0]!, go, files)).toBeNull();
  });

  it("records a Java super call on the class ancestor when an interface declares the same name", async () => {
    const files: Record<string, string> = {
      "sup.java": [
        "interface SupFace { void shared(); }",
        "class SupBase { void shared() {} }",
        "class SupLeaf extends SupBase implements SupFace { void go() { super.shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-java-super-", files);
    const go = nodeIn(graph, "sup.java", "go");
    const baseShared = membersOwnedBy(graph, "SupBase", "shared");
    const faceShared = membersOwnedBy(graph, "SupFace", "shared");
    expect(baseShared).toHaveLength(1);
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, go, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toBeNull();
  });

  it("records this through an implemented interface but not super when there is no class ancestor", async () => {
    const files: Record<string, string> = {
      "only.java": [
        "interface OnlyFace { void shared(); }",
        "class OnlyLeaf implements OnlyFace { void go() { super.shared(); this.shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-java-iface-only-", files);
    const go = nodeIn(graph, "only.java", "go");
    const faceShared = membersOwnedBy(graph, "OnlyFace", "shared");
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toEqual(["shared"]);
  });
});

describe("emitReceiverCallEdges hierarchy walk", () => {
  const site = {
    file: "leaf.ts",
    range: { start: { line: 1, column: 1, index: 0 }, end: { line: 1, column: 4, index: 3 } },
  };

  function node(id: string, name: string, extra: Partial<SymbolNode> = {}): SymbolNode {
    return { id, file: "leaf.ts", name, kind: extra.kind ?? "function", ...extra };
  }

  function recordedCalls(graph: SymbolGraph, candidate: ReceiverCallCandidate): Array<{ from: string; to: string }> {
    const recorded: Array<{ from: string; to: string }> = [];
    emitReceiverCallEdges(graph, [candidate], (from, to, label) => {
      if (label === "calls") recorded.push({ from, to });
      return true;
    });
    return recorded;
  }

  function childExtendsBaseImplementsIface(): SymbolGraph {
    return {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["Iface", node("Iface", "Iface", { kind: "interface" })],
        ["leaf.go", node("leaf.go", "go")],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
        ["iface.run", node("iface.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "iface.run", to: "Iface", label: "member_of" },
        { from: "Child", to: "Base", label: "extends" },
        { from: "Child", to: "Iface", label: "implements" },
      ],
    };
  }

  function candidate(overrides: Partial<ReceiverCallCandidate> = {}): ReceiverCallCandidate {
    return {
      callerId: "leaf.go",
      ownerId: "Mid",
      viaSupertypes: false,
      memberName: "run",
      argumentCount: 0,
      site,
      ...overrides,
    };
  }

  it("does not record a deeper unique member when the shallowest level is ambiguous", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Mid", node("Mid", "Mid", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["mid.run.a", node("mid.run.a", "run", { memberArity: 0 })],
        ["mid.run.b", node("mid.run.b", "run", { memberArity: 0 })],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Mid", label: "member_of" },
        { from: "mid.run.a", to: "Mid", label: "member_of" },
        { from: "mid.run.b", to: "Mid", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "Mid", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate())).toEqual([]);
  });

  it("does not walk past same-named members whose arity does not single one out", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Mid", node("Mid", "Mid", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["mid.run.1", node("mid.run.1", "run", { memberArity: 1 })],
        ["mid.run.2", node("mid.run.2", "run", { memberArity: 2 })],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Mid", label: "member_of" },
        { from: "mid.run.1", to: "Mid", label: "member_of" },
        { from: "mid.run.2", to: "Mid", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "Mid", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate())).toEqual([]);
  });

  it("records the arity-unique member at the shallowest level instead of a deeper unique member", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Mid", node("Mid", "Mid", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["mid.run.0", node("mid.run.0", "run", { memberArity: 0 })],
        ["mid.run.1", node("mid.run.1", "run", { memberArity: 1 })],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Mid", label: "member_of" },
        { from: "mid.run.0", to: "Mid", label: "member_of" },
        { from: "mid.run.1", to: "Mid", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "Mid", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate())).toEqual([{ from: "leaf.go", to: "mid.run.0" }]);
  });

  it("still records a unique inherited member when the declaring type has no match", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Mid", node("Mid", "Mid", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Mid", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "Mid", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate())).toEqual([{ from: "leaf.go", to: "base.run" }]);
  });

  it("leaves a diamond of same-named members unresolved", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Left", node("Left", "Left", { kind: "interface" })],
        ["Right", node("Right", "Right", { kind: "interface" })],
        ["leaf.go", node("leaf.go", "go")],
        ["left.run", node("left.run", "run", { memberArity: 0 })],
        ["right.run", node("right.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "left.run", to: "Left", label: "member_of" },
        { from: "right.run", to: "Right", label: "member_of" },
        { from: "Child", to: "Left", label: "implements" },
        { from: "Child", to: "Right", label: "implements" },
      ],
    };
    expect(recordedCalls(graph, candidate({ ownerId: "Child" }))).toEqual([]);
  });

  it("starts a parent-qualified call at the supertype and ignores own-type members", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["child.run", node("child.run", "run", { memberArity: 0 })],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "child.run", to: "Child", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "Child", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate({ ownerId: "Child", viaSupertypes: true }))).toEqual([
      { from: "leaf.go", to: "base.run" },
    ]);
  });

  it("records super/base/parent calls on the class ancestor when an interface declares the same name", () => {
    expect(
      recordedCalls(childExtendsBaseImplementsIface(), candidate({ ownerId: "Child", viaSupertypes: true })),
    ).toEqual([{ from: "leaf.go", to: "base.run" }]);
  });

  it("still treats this-receiver inheritance as ambiguous when a class and interface both match", () => {
    expect(recordedCalls(childExtendsBaseImplementsIface(), candidate({ ownerId: "Child" }))).toEqual([]);
  });

  it("ignores implements, trait, and mixin targets for super/base/parent even when those nodes are classes", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["Iface", node("Iface", "Iface", { kind: "class" })],
        ["Mixin", node("Mixin", "Mixin", { kind: "class" })],
        ["leaf.go", node("leaf.go", "go")],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
        ["iface.run", node("iface.run", "run", { memberArity: 0 })],
        ["mixin.run", node("mixin.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "iface.run", to: "Iface", label: "member_of" },
        { from: "mixin.run", to: "Mixin", label: "member_of" },
        { from: "Child", to: "Base", label: "extends" },
        { from: "Child", to: "Iface", label: "implements" },
        { from: "Child", to: "Mixin", label: "trait" },
      ],
    };
    expect(recordedCalls(graph, candidate({ ownerId: "Child", viaSupertypes: true }))).toEqual([
      { from: "leaf.go", to: "base.run" },
    ]);
  });

  it("does not record super/base/parent calls when only a non-extends hierarchy exists", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Iface", node("Iface", "Iface", { kind: "interface" })],
        ["leaf.go", node("leaf.go", "go")],
        ["iface.run", node("iface.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "iface.run", to: "Iface", label: "member_of" },
        { from: "Child", to: "Iface", label: "implements" },
      ],
    };
    expect(recordedCalls(graph, candidate({ ownerId: "Child", viaSupertypes: true }))).toEqual([]);
  });

  it("continues a super walk to a class ancestor past an implemented interface", () => {
    const graph: SymbolGraph = {
      nodes: new Map([
        ["Child", node("Child", "Child", { kind: "class" })],
        ["Mid", node("Mid", "Mid", { kind: "class" })],
        ["Base", node("Base", "Base", { kind: "class" })],
        ["Iface", node("Iface", "Iface", { kind: "interface" })],
        ["leaf.go", node("leaf.go", "go")],
        ["base.run", node("base.run", "run", { memberArity: 0 })],
        ["iface.run", node("iface.run", "run", { memberArity: 0 })],
      ]),
      edges: [
        { from: "leaf.go", to: "Child", label: "member_of" },
        { from: "base.run", to: "Base", label: "member_of" },
        { from: "iface.run", to: "Iface", label: "member_of" },
        { from: "Child", to: "Mid", label: "extends" },
        { from: "Child", to: "Iface", label: "implements" },
        { from: "Mid", to: "Base", label: "extends" },
      ],
    };
    expect(recordedCalls(graph, candidate({ ownerId: "Child", viaSupertypes: true }))).toEqual([
      { from: "leaf.go", to: "base.run" },
    ]);
  });
});
