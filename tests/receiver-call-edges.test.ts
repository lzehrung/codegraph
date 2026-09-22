import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
import {
  emitReceiverCallEdges,
  type ReceiverCallCandidate,
} from "../src/graphs/symbol-graph-detailed/receiver-calls.js";
import type { SymbolGraph, SymbolNode } from "../src/graphs/symbol-graph.js";
import { findCallHierarchy } from "../src/indexer/call-hierarchy.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { extractCallableSignature } from "../src/impact/call-compatibility.js";
import { prepareSourceInput } from "../src/languages/file-prep.js";
import { ProjectedSyntaxTree } from "../src/native/projected-tree.js";
import { getNativeSyntaxTreeExecution, isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;
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

/** Package-level function that is not a `member_of` any type. */
function freeFunctionIn(graph: DetailedSymbolGraph, file: string, name: string): string {
  const owned = new Set(graph.edges.filter((edge) => edge.label === "member_of").map((edge) => edge.from));
  const matches = [...graph.nodes.values()].filter(
    (node) =>
      node.name === name && path.basename(node.file) === file && node.kind === "function" && !owned.has(node.id),
  );
  expect(matches, `expected exactly one free ${name} function in ${file}`).toHaveLength(1);
  return matches[0]!.id;
}

function outgoingCallCount(graph: DetailedSymbolGraph, callerId: string): number {
  return graph.edges.filter((edge) => edge.label === "calls" && edge.from === callerId).length;
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

  it("leaves a local whose name collides with a class in the same module unresolved", async () => {
    const files: Record<string, string> = {
      "collide.ts": [
        "export class Lib { libTarget(): number { return 1; } }",
        "export class Other { otherTarget(): number { return 2; } }",
        "export function makeOther(): Other { return new Other(); }",
        "export function run(): number { const Lib = makeOther(); return Lib.libTarget(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-name-collision-", files);
    const run = nodeIn(graph, "collide.ts", "run");
    const libTarget = nodeIn(graph, "collide.ts", "libTarget");
    expect(callsiteTexts(graph, libTarget, run, files)).toBeNull();
  });

  it("leaves a parameter whose name collides with a class in the same module unresolved", async () => {
    const files: Record<string, string> = {
      "param.ts": [
        "export class Lib { libTarget(): number { return 1; } }",
        "export class Registry { registryTarget(): number { return 2; } }",
        "export function run(Lib: Registry): number { return Lib.libTarget(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-param-collision-", files);
    const run = nodeIn(graph, "param.ts", "run");
    const libTarget = nodeIn(graph, "param.ts", "libTarget");
    expect(callsiteTexts(graph, libTarget, run, files)).toBeNull();
  });

  it("leaves a TypeScript dotted static call unresolved because a dotted identifier is not type proof", async () => {
    const files: Record<string, string> = {
      "cfg.ts": "export class Cfg { static load(): number { return 1; } }\n",
      "boot.ts": ['import { Cfg } from "./cfg";', "export function boot(): number { return Cfg.load(); }"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-static-", files);
    const load = nodeIn(graph, "cfg.ts", "load");
    const boot = nodeIn(graph, "boot.ts", "boot");
    expect(callsiteTexts(graph, load, boot, files)).toBeNull();
  });

  it("records type-scoped static calls that use :: syntax", async () => {
    const cases: { prefix: string; file: string; source: string; member: string; caller: string }[] = [
      {
        prefix: "cg-static-cpp-",
        file: "boot.cpp",
        member: "load",
        caller: "boot",
        source: ["class Cfg { public: static int load() { return 1; } };", "int boot() { return Cfg::load(); }"].join(
          "\n",
        ),
      },
      {
        prefix: "cg-static-rb-",
        file: "boot.rb",
        member: "load",
        caller: "boot",
        source: ["class Cfg", "  def self.load", "    1", "  end", "end", "def boot", "  Cfg::load()", "end"].join(
          "\n",
        ),
      },
    ];
    const missing: string[] = [];
    for (const testCase of cases) {
      const files: Record<string, string> = { [testCase.file]: testCase.source };
      const graph = await buildFixture(testCase.prefix, files);
      const caller = nodeIn(graph, testCase.file, testCase.caller);
      const member = nodeIn(graph, testCase.file, testCase.member);
      if (!callsiteTexts(graph, member, caller, files)) missing.push(testCase.file);
    }
    expect(missing, "type-scoped :: static calls must resolve").toEqual([]);
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

  it("records PHP nullsafe receiver calls", async () => {
    const files: Record<string, string> = {
      "ns.php": [
        "<?php",
        "class Box {",
        "    function helper() {}",
        "    function run() { $this?->helper(); }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-nullsafe-", files);
    const helper = nodeIn(graph, "ns.php", "helper");
    const run = nodeIn(graph, "ns.php", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("records a PHP class-qualified call when a function import uses the same name", async () => {
    const files: Record<string, string> = {
      "lib.php": ["<?php", "namespace Imported;", "function Example() {}"].join("\n"),
      "host.php": [
        "<?php",
        "use function Imported\\Example;",
        "class Example {",
        "    static function shared() {}",
        "    function run() { Example::shared(); }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-type-ns-", files);
    const shared = nodeIn(graph, "host.php", "shared");
    const run = nodeIn(graph, "host.php", "run");
    expect(callsiteTexts(graph, shared, run, files)).toEqual(["shared"]);
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

  it("records calls edges for Go value-receiver calls while keeping free Go calls resolved", async () => {
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
    const helper = membersOwnedBy(graph, "GoBox", "GoHelper");
    expect(helper).toHaveLength(1);
    const free = nodeIn(graph, "gox.go", "goFree");
    const run = nodeIn(graph, "gox.go", "GoRun");
    expect(callsiteTexts(graph, helper[0]!, run, files)).toEqual(["GoHelper"]);
    expect(callsiteTexts(graph, free, run, files)).toEqual(["goFree"]);
    expect(outgoingCallCount(graph, run)).toBe(2);
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

  it("records calls edges for JavaScript this receivers", async () => {
    const files: Record<string, string> = {
      "box.js": ["class JsBox {", "  helper() {}", "  run() { this.helper(); }", "}"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-js-", files);
    const helper = nodeIn(graph, "box.js", "helper");
    const run = nodeIn(graph, "box.js", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("records a TypeScript super call on the class ancestor when an interface declares the same name", async () => {
    const files: Record<string, string> = {
      "sup.ts": [
        "interface SupFace { shared(): void }",
        "class SupBase { shared(): void {} }",
        "class SupLeaf extends SupBase implements SupFace { go(): void { super.shared(); } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-super-", files);
    const go = nodeIn(graph, "sup.ts", "go");
    const baseShared = membersOwnedBy(graph, "SupBase", "shared");
    const faceShared = membersOwnedBy(graph, "SupFace", "shared");
    expect(baseShared).toHaveLength(1);
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, go, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toBeNull();
  });

  it("records Python inherited self and cls receivers", async () => {
    const files: Record<string, string> = {
      "pyinherit.py": [
        "class PyBase:",
        "    def py_helper(self):",
        "        return 1",
        "    @classmethod",
        "    def py_shared(cls):",
        "        return 2",
        "class PyChild(PyBase):",
        "    def py_run(self):",
        "        return self.py_helper()",
        "    @classmethod",
        "    def py_cls_run(cls):",
        "        return cls.py_shared()",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-py-inherit-", files);
    const helper = nodeIn(graph, "pyinherit.py", "py_helper");
    const shared = nodeIn(graph, "pyinherit.py", "py_shared");
    const run = nodeIn(graph, "pyinherit.py", "py_run");
    const clsRun = nodeIn(graph, "pyinherit.py", "py_cls_run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["py_helper"]);
    expect(callsiteTexts(graph, shared, clsRun, files)).toEqual(["py_shared"]);
  });

  it("leaves Python super() receivers unresolved", async () => {
    const files: Record<string, string> = {
      "pysuper.py": [
        "class PyBase:",
        "    def py_helper(self):",
        "        return 1",
        "class PyChild(PyBase):",
        "    def py_run(self):",
        "        return super().py_helper()",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-py-super-", files);
    const helper = nodeIn(graph, "pysuper.py", "py_helper");
    const run = nodeIn(graph, "pysuper.py", "py_run");
    expect(callsiteTexts(graph, helper, run, files)).toBeNull();
  });

  it("records calls edges for C++ this receivers, including inherited members", async () => {
    const files: Record<string, string> = {
      "box.cpp": [
        "class CppBase { public: void cpp_helper() {} };",
        "class CppChild : public CppBase { public: void cpp_run() { this->cpp_helper(); } };",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-cpp-", files);
    const helper = nodeIn(graph, "box.cpp", "cpp_helper");
    const run = nodeIn(graph, "box.cpp", "cpp_run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["cpp_helper"]);
  });

  it("records calls edges for Ruby self receivers, including unique mixins", async () => {
    const files: Record<string, string> = {
      "box.rb": [
        "module RbGreets",
        "  def greet",
        "  end",
        "end",
        "class RbHost",
        "  include RbGreets",
        "  def helper",
        "  end",
        "  def run",
        "    self.helper",
        "    self.greet",
        "  end",
        "end",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-rb-", files);
    const helper = nodeIn(graph, "box.rb", "helper");
    const greet = nodeIn(graph, "box.rb", "greet");
    const run = nodeIn(graph, "box.rb", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
    expect(callsiteTexts(graph, greet, run, files)).toEqual(["greet"]);
  });

  it("leaves Ruby super unresolved because it is a same-name keyword, not a receiver", async () => {
    const files: Record<string, string> = {
      "base.rb": ["class RbBase", "  def helper", "  end", "end"].join("\n"),
      "child.rb": ["class RbChild < RbBase", "  def helper", "    super", "  end", "end"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-rb-super-", files);
    const childHelper = membersOwnedBy(graph, "RbChild", "helper");
    const baseHelper = membersOwnedBy(graph, "RbBase", "helper");
    expect(childHelper).toHaveLength(1);
    expect(baseHelper).toHaveLength(1);
    expect(callsiteTexts(graph, baseHelper[0]!, childHelper[0]!, files)).toBeNull();
  });

  it("records a Kotlin super call on the class ancestor when an interface declares the same name", async () => {
    const files: Record<string, string> = {
      "sup.kt": [
        "interface KtFace {",
        "  fun shared()",
        "}",
        "open class KtBase {",
        "  open fun shared() {}",
        "}",
        "class KtLeaf : KtBase(), KtFace {",
        "  fun go() { super.shared() }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-kt-super-", files);
    const go = nodeIn(graph, "sup.kt", "go");
    const baseShared = membersOwnedBy(graph, "KtBase", "shared");
    const faceShared = membersOwnedBy(graph, "KtFace", "shared");
    expect(baseShared).toHaveLength(1);
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, go, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toBeNull();
  });

  it("records a Swift super call on the class ancestor when a protocol declares the same name", async () => {
    const files: Record<string, string> = {
      "sup.swift": [
        "protocol SwFace { func shared() }",
        "class SwBase { func shared() {} }",
        "class SwLeaf: SwBase, SwFace { func go() { super.shared() } }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-sw-super-", files);
    const go = nodeIn(graph, "sup.swift", "go");
    const baseShared = membersOwnedBy(graph, "SwBase", "shared");
    const faceShared = membersOwnedBy(graph, "SwFace", "shared");
    expect(baseShared).toHaveLength(1);
    expect(faceShared).toHaveLength(1);
    expect(callsiteTexts(graph, baseShared[0]!, go, files)).toEqual(["shared"]);
    expect(callsiteTexts(graph, faceShared[0]!, go, files)).toBeNull();
  });

  it("leaves colliding local and parameter receivers unresolved in every language with methods", async () => {
    const cases: { prefix: string; file: string; source: string; member: string; caller: string }[] = [
      {
        prefix: "cg-collide-cs-",
        file: "Host.cs",
        member: "LibTarget",
        caller: "Run",
        source: [
          "class Lib { public void LibTarget() {} }",
          "class Registry { public void RegistryTarget() {} }",
          "class Host { void Run(Registry Lib) { Lib.LibTarget(); } }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-kt-",
        file: "host.kt",
        member: "libTarget",
        caller: "run",
        source: [
          "class Lib {",
          "  fun libTarget() {}",
          "}",
          "class Registry {",
          "  fun registryTarget() {}",
          "}",
          "fun run(Lib: Registry) {",
          "  Lib.libTarget()",
          "}",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-sw-",
        file: "host.swift",
        member: "libTarget",
        caller: "run",
        source: [
          "class Lib { func libTarget() {} }",
          "class Registry { func registryTarget() {} }",
          "func run(Lib: Registry) { Lib.libTarget() }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-rs-",
        file: "host.rs",
        member: "lib_target",
        caller: "run",
        source: [
          "struct Lib;",
          "impl Lib { fn lib_target(&self) {} }",
          "struct Registry;",
          "impl Registry { fn registry_target(&self) {} }",
          "fn run(Lib: Registry) { Lib.lib_target(); }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-py-",
        file: "host.py",
        member: "lib_target",
        caller: "run",
        source: [
          "class Lib:",
          "    def lib_target(self):",
          "        return 1",
          "class Registry:",
          "    def registry_target(self):",
          "        return 2",
          "def run():",
          "    Lib = Registry()",
          "    return Lib.lib_target()",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-go-",
        file: "host.go",
        member: "LibTarget",
        caller: "run",
        source: [
          "package main",
          "type Lib struct{}",
          "func (l Lib) LibTarget() int { return 1 }",
          "type Registry struct{}",
          "func (r Registry) RegistryTarget() int { return 2 }",
          "func run() int {",
          "\tLib := Registry{}",
          "\treturn Lib.LibTarget()",
          "}",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-cpp-",
        file: "host.cpp",
        member: "libTarget",
        caller: "run",
        source: [
          "class Lib { public: void libTarget() {} };",
          "class Registry { public: void registryTarget() {} };",
          "void run(Registry Lib) { Lib.libTarget(); }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-cpp-scope-",
        file: "scoped.cpp",
        member: "libTarget",
        caller: "run",
        source: [
          "class Lib { public: static void libTarget() {} };",
          "class Registry { public: static void registryTarget() {} };",
          "void run(Registry Lib) { Lib::libTarget(); }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-rb-",
        file: "host.rb",
        member: "lib_target",
        caller: "run",
        source: [
          "class Lib",
          "  def lib_target",
          "  end",
          "end",
          "class Registry",
          "  def registry_target",
          "  end",
          "end",
          "def run(Lib)",
          "  Lib.lib_target",
          "end",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-rb-scope-",
        file: "scoped.rb",
        member: "lib_target",
        caller: "run",
        source: [
          "class Lib",
          "  def self.lib_target",
          "  end",
          "end",
          "class Registry",
          "  def self.registry_target",
          "  end",
          "end",
          "def run(Lib)",
          "  Lib::lib_target",
          "end",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-java-",
        file: "Host.java",
        member: "libTarget",
        caller: "run",
        source: [
          "class Lib { void libTarget() {} }",
          "class Registry { void registryTarget() {} }",
          "class Host { void run(Registry Lib) { Lib.libTarget(); } }",
        ].join("\n"),
      },
      {
        prefix: "cg-collide-js-",
        file: "host.js",
        member: "target",
        caller: "run",
        source: [
          "class Lib { target() { return 1; } }",
          "class Registry { registryTarget() { return 2; } }",
          "function makeRegistry() { return new Registry(); }",
          "function run() { Lib = makeRegistry(); return Lib.target(); }",
        ].join("\n"),
      },
    ];

    const invented: string[] = [];
    for (const testCase of cases) {
      const files: Record<string, string> = { [testCase.file]: testCase.source };
      const graph = await buildFixture(testCase.prefix, files);
      const caller = nodeIn(graph, testCase.file, testCase.caller);
      const member = nodeIn(graph, testCase.file, testCase.member);
      if (callsiteTexts(graph, member, caller, files)) invented.push(testCase.file);
    }
    expect(invented, "a colliding receiver name must never resolve to the same-named type").toEqual([]);
  });

  it("records calls edges for Zig self receivers", async () => {
    const files: Record<string, string> = {
      "box.zig": [
        "const Box = struct {",
        "    fn helper(self: Box) void {}",
        "    fn run(self: Box) void { self.helper(); }",
        "};",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-zig-", files);
    const helper = nodeIn(graph, "box.zig", "helper");
    const run = nodeIn(graph, "box.zig", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("records calls edges for Go pointer-receiver calls", async () => {
    const files: Record<string, string> = {
      "ptr.go": [
        "package ptr",
        "type GoBox struct{}",
        "func (b *GoBox) GoHelper() {}",
        "func GoRun() { b := &GoBox{}; b.GoHelper() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-ptr-", files);
    const helper = membersOwnedBy(graph, "GoBox", "GoHelper");
    expect(helper).toHaveLength(1);
    const run = nodeIn(graph, "ptr.go", "GoRun");
    expect(callsiteTexts(graph, helper[0]!, run, files)).toEqual(["GoHelper"]);
    expect(outgoingCallCount(graph, run)).toBe(1);
  });

  it("records calls edges for Go var-declared receivers", async () => {
    const files: Record<string, string> = {
      "var.go": [
        "package vargo",
        "type GoBox struct{}",
        "func (b GoBox) GoHelper() {}",
        "func GoRun() { var b GoBox; b.GoHelper() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-var-", files);
    const helper = membersOwnedBy(graph, "GoBox", "GoHelper");
    expect(helper).toHaveLength(1);
    const run = nodeIn(graph, "var.go", "GoRun");
    expect(callsiteTexts(graph, helper[0]!, run, files)).toEqual(["GoHelper"]);
    expect(outgoingCallCount(graph, run)).toBe(1);
  });

  it("does not attribute a Go package-level function to a same-named method", async () => {
    const files: Record<string, string> = {
      "same.go": [
        "package same",
        "type GoBox struct{}",
        "func (b *GoBox) GoHelper() {}",
        "func GoHelper() {}",
        "func CallMethod() { b := &GoBox{}; b.GoHelper() }",
        "func CallFree() { GoHelper() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-free-name-", files);
    const method = membersOwnedBy(graph, "GoBox", "GoHelper");
    expect(method).toHaveLength(1);
    const free = freeFunctionIn(graph, "same.go", "GoHelper");
    const callMethod = nodeIn(graph, "same.go", "CallMethod");
    const callFree = nodeIn(graph, "same.go", "CallFree");
    expect(callsiteTexts(graph, method[0]!, callMethod, files)).toEqual(["GoHelper"]);
    expect(callsiteTexts(graph, free, callMethod, files)).toBeNull();
    expect(callsiteTexts(graph, free, callFree, files)).toEqual(["GoHelper"]);
    expect(callsiteTexts(graph, method[0]!, callFree, files)).toBeNull();
  });

  it("resolves same-named Go methods to the receiver's own type", async () => {
    const files: Record<string, string> = {
      "own.go": [
        "package own",
        "type BoxA struct{}",
        "func (b BoxA) Shared() {}",
        "type BoxB struct{}",
        "func (b BoxB) Shared() {}",
        "func RunA() { a := BoxA{}; a.Shared() }",
        "func RunB() { b := BoxB{}; b.Shared() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-own-", files);
    const aShared = membersOwnedBy(graph, "BoxA", "Shared");
    const bShared = membersOwnedBy(graph, "BoxB", "Shared");
    expect(aShared).toHaveLength(1);
    expect(bShared).toHaveLength(1);
    const runA = nodeIn(graph, "own.go", "RunA");
    const runB = nodeIn(graph, "own.go", "RunB");
    expect(callsiteTexts(graph, aShared[0]!, runA, files)).toEqual(["Shared"]);
    expect(callsiteTexts(graph, aShared[0]!, runB, files)).toBeNull();
    expect(callsiteTexts(graph, bShared[0]!, runB, files)).toEqual(["Shared"]);
    expect(callsiteTexts(graph, bShared[0]!, runA, files)).toBeNull();
  });

  it("leaves an unproven Go receiver call unresolved", async () => {
    const files: Record<string, string> = {
      "unproven.go": [
        "package unproven",
        "type GoBox struct{}",
        "func (b GoBox) GoHelper() {}",
        "type Face interface { GoHelper() }",
        "func makeBox() GoBox { return GoBox{} }",
        "func CallFactory() { b := makeBox(); b.GoHelper() }",
        "func CallIface(b Face) { b.GoHelper() }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-go-unproven-", files);
    const helper = membersOwnedBy(graph, "GoBox", "GoHelper");
    expect(helper).toHaveLength(1);
    const makeBox = nodeIn(graph, "unproven.go", "makeBox");
    const callFactory = nodeIn(graph, "unproven.go", "CallFactory");
    const callIface = nodeIn(graph, "unproven.go", "CallIface");
    expect(callsiteTexts(graph, helper[0]!, callFactory, files)).toBeNull();
    expect(callsiteTexts(graph, helper[0]!, callIface, files)).toBeNull();
    expect(callsiteTexts(graph, makeBox, callFactory, files)).toEqual(["makeBox"]);
    expect(outgoingCallCount(graph, callIface)).toBe(0);
  });

  it("emits no receiver calls edges for C struct-field function pointer calls", async () => {
    const files: Record<string, string> = {
      "ops.c": [
        "void run(void) {}",
        "struct Ops { void (*run)(void); };",
        "void go(struct Ops ops) { ops.run(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-c-ops-", files);
    const caller = nodeIn(graph, "ops.c", "go");
    const freeRun = nodeIn(graph, "ops.c", "run");
    expect(callsiteTexts(graph, freeRun, caller, files)).toBeNull();
    expect(outgoingCallCount(graph, caller)).toBe(0);
  });
});

nativeDescribe("receiver construction, reassignment, typed parameters, and static scope", () => {
  it("records a PHP named receiver assigned from new", async () => {
    const files: Record<string, string> = {
      "box.php": [
        "<?php",
        "class Box { function helper() {} }",
        "function run() { $box = new Box(); $box->helper(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-named-", files);
    const helper = nodeIn(graph, "box.php", "helper");
    const run = nodeIn(graph, "box.php", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("does not attribute an unproven PHP receiver to an imported function of the same name", async () => {
    const files: Record<string, string> = {
      "lib.php": ["<?php", "namespace Imported;", "function helper() {}"].join("\n"),
      "host.php": [
        "<?php",
        "use function Imported\\helper;",
        "class Box { function helper() {} }",
        "function run() { $unknown->helper(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-php-misattr-", files);
    const imported = nodeIn(graph, "lib.php", "helper");
    const method = nodeIn(graph, "host.php", "helper");
    const run = nodeIn(graph, "host.php", "run");
    expect(callsiteTexts(graph, imported, run, files)).toBeNull();
    expect(callsiteTexts(graph, method, run, files)).toBeNull();
    expect(outgoingCallCount(graph, run)).toBe(0);
  });

  it("records a Zig struct-literal receiver", async () => {
    const files: Record<string, string> = {
      "box.zig": [
        "const Box = struct {",
        "    fn helper(self: Box) void {}",
        "};",
        "fn run() void { var box = Box{}; box.helper(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-zig-literal-", files);
    const helper = nodeIn(graph, "box.zig", "helper");
    const run = nodeIn(graph, "box.zig", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("records a Ruby instance-variable receiver assigned from .new", async () => {
    const files: Record<string, string> = {
      "box.rb": [
        "class Box",
        "  def helper",
        "  end",
        "end",
        "def run",
        "  @box = Box.new",
        "  @box.helper",
        "end",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-rb-ivar-", files);
    const helper = nodeIn(graph, "box.rb", "helper");
    const run = nodeIn(graph, "box.rb", "run");
    expect(callsiteTexts(graph, helper, run, files)).toEqual(["helper"]);
  });

  it("records typed-parameter receivers in languages that expose a parameter type", async () => {
    const cases: { prefix: string; file: string; source: string; member: string; caller: string }[] = [
      {
        prefix: "cg-typed-ts-",
        file: "run.ts",
        member: "target",
        caller: "run",
        source: [
          "export class Lib { target(): number { return 1; } }",
          "export function run(box: Lib): number { return box.target(); }",
        ].join("\n"),
      },
      {
        prefix: "cg-typed-java-",
        file: "Run.java",
        member: "target",
        caller: "run",
        source: ["class Lib { void target() {} }", "class Host { void run(Lib box) { box.target(); } }"].join("\n"),
      },
      {
        prefix: "cg-typed-php-",
        file: "run.php",
        member: "helper",
        caller: "run",
        source: ["<?php", "class Box { function helper() {} }", "function run(Box $box) { $box->helper(); }"].join(
          "\n",
        ),
      },
    ];
    const missing: string[] = [];
    for (const testCase of cases) {
      const files: Record<string, string> = { [testCase.file]: testCase.source };
      const graph = await buildFixture(testCase.prefix, files);
      const caller = nodeIn(graph, testCase.file, testCase.caller);
      const member = nodeIn(graph, testCase.file, testCase.member);
      if (!callsiteTexts(graph, member, caller, files)) missing.push(testCase.file);
    }
    expect(missing, "typed-parameter receivers must resolve").toEqual([]);
  });

  it("leaves a reassigned receiver unresolved in JS, Java, and Go", async () => {
    const cases: { prefix: string; file: string; source: string; member: string; caller: string }[] = [
      {
        prefix: "cg-reassign-ts-",
        file: "run.ts",
        member: "target",
        caller: "run",
        source: [
          "export class Lib { target(): number { return 1; } }",
          "export function other(): Lib { return new Lib(); }",
          "export function run(): number { let l = new Lib(); l = other(); return l.target(); }",
        ].join("\n"),
      },
      {
        prefix: "cg-reassign-java-",
        file: "Run.java",
        member: "target",
        caller: "run",
        source: [
          "class Lib { void target() {} }",
          "class Host {",
          "  Lib other() { return new Lib(); }",
          "  void run() { Lib l = new Lib(); l = other(); l.target(); }",
          "}",
        ].join("\n"),
      },
      {
        prefix: "cg-reassign-go-",
        file: "run.go",
        member: "Target",
        caller: "Run",
        source: [
          "package run",
          "type Lib struct{}",
          "func (l Lib) Target() {}",
          "func other() Lib { return Lib{} }",
          "func Run() { l := Lib{}; l = other(); l.Target() }",
        ].join("\n"),
      },
    ];
    const invented: string[] = [];
    for (const testCase of cases) {
      const files: Record<string, string> = { [testCase.file]: testCase.source };
      const graph = await buildFixture(testCase.prefix, files);
      const caller = nodeIn(graph, testCase.file, testCase.caller);
      const member = nodeIn(graph, testCase.file, testCase.member);
      if (callsiteTexts(graph, member, caller, files)) invented.push(testCase.file);
    }
    expect(invented, "a reassigned receiver must resolve nothing").toEqual([]);
  });

  it("emits nothing for static and instance mismatches in C#, Java, and PHP", async () => {
    const cases: {
      prefix: string;
      file: string;
      source: string;
      staticMember: string;
      instanceMember: string;
      caller: string;
    }[] = [
      {
        prefix: "cg-static-cs-",
        file: "Cfg.cs",
        staticMember: "StaticMethod",
        instanceMember: "InstanceMethod",
        caller: "Run",
        source: [
          "class Cfg {",
          "  public void InstanceMethod() {}",
          "  public static void StaticMethod() {}",
          "  public void Run() { var c = new Cfg(); c.StaticMethod(); Cfg.InstanceMethod(); }",
          "}",
        ].join("\n"),
      },
      {
        prefix: "cg-static-java-",
        file: "Cfg.java",
        staticMember: "staticMethod",
        instanceMember: "instanceMethod",
        caller: "run",
        source: [
          "class Cfg {",
          "  void instanceMethod() {}",
          "  static void staticMethod() {}",
          "  void run() { Cfg c = new Cfg(); c.staticMethod(); }",
          "}",
        ].join("\n"),
      },
      {
        prefix: "cg-static-php-",
        file: "cfg.php",
        staticMember: "staticMethod",
        instanceMember: "instanceMethod",
        caller: "run",
        source: [
          "<?php",
          "class Cfg {",
          "    function instanceMethod() {}",
          "    static function staticMethod() {}",
          "    function run() { $c = new Cfg(); $c->staticMethod(); Cfg::instanceMethod(); }",
          "}",
        ].join("\n"),
      },
    ];
    const leaked: string[] = [];
    for (const testCase of cases) {
      const files: Record<string, string> = { [testCase.file]: testCase.source };
      const graph = await buildFixture(testCase.prefix, files);
      const caller = nodeIn(graph, testCase.file, testCase.caller);
      const staticMember = nodeIn(graph, testCase.file, testCase.staticMember);
      const instanceMember = nodeIn(graph, testCase.file, testCase.instanceMember);
      if (callsiteTexts(graph, staticMember, caller, files)) leaked.push(`${testCase.file}:static`);
      if (callsiteTexts(graph, instanceMember, caller, files)) leaked.push(`${testCase.file}:instance`);
    }
    expect(leaked, "static and instance members must not cross-resolve").toEqual([]);
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

nativeDescribe("receiver call arity and callable metadata regressions", () => {
  /** Every function node named `name` in `file`, ordered by member arity. */
  const overloadMembers = (graph: DetailedSymbolGraph, file: string, name: string) =>
    [...graph.nodes.values()]
      .filter((node) => node.name === name && path.basename(node.file) === file && node.kind === "function")
      .sort((left, right) => (left.memberArity ?? -1) - (right.memberArity ?? -1));

  /** The single graph node named `name` in `file`, whatever its kind. */
  const anyNodeIn = (graph: DetailedSymbolGraph, file: string, name: string): string => {
    const matches = [...graph.nodes.values()].filter((node) => node.name === name && path.basename(node.file) === file);
    expect(matches, `expected exactly one ${name} node in ${file}`).toHaveLength(1);
    return matches[0]!.id;
  };

  it("records the two-parameter Kotlin overload for a this-receiver call", async () => {
    const files: Record<string, string> = {
      "ktover.kt": [
        "class KtOver {",
        "  fun pick(a: Int): Int = a",
        "  fun pick(a: Int, b: Int): Int = a + b",
        "  fun caller(): Int { return this.pick(1, 2) }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-kt-overload-", files);
    const caller = nodeIn(graph, "ktover.kt", "caller");
    const overloads = overloadMembers(graph, "ktover.kt", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([1, 2]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
  });

  it("records the two-parameter Swift overload for a self-receiver call", async () => {
    const files: Record<string, string> = {
      "swover.swift": [
        "class SwOver {",
        "  func pick(_ a: Int) -> Int { return a }",
        "  func pick(_ a: Int, _ b: Int) -> Int { return a + b }",
        "  func caller() -> Int { self.pick(1, 2) }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-overload-", files);
    const caller = nodeIn(graph, "swover.swift", "caller");
    const overloads = overloadMembers(graph, "swover.swift", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([1, 2]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
  });

  it("records the zero-parameter Swift overload for a self-receiver call", async () => {
    const files: Record<string, string> = {
      "swzero.swift": [
        "class SwZero {",
        "  func pick() -> Int { return 0 }",
        "  func pick(_ value: Int) -> Int { return value }",
        "  func caller() -> Int { return self.pick() }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-zero-overload-", files);
    const caller = nodeIn(graph, "swzero.swift", "caller");
    const overloads = overloadMembers(graph, "swzero.swift", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([0, 1]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toBeNull();
  });

  it("counts a Swift trailing closure as a call argument", async () => {
    const files: Record<string, string> = {
      "swtrail.swift": [
        "class SwTrail {",
        "  func pick(_ a: Int) -> Int { return a }",
        "  func pick(_ a: Int, _ b: Int) -> Int { return a + b }",
        "  func caller() -> Int { self.pick(1) { x in x } }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-trailing-", files);
    const caller = nodeIn(graph, "swtrail.swift", "caller");
    const overloads = overloadMembers(graph, "swtrail.swift", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([1, 2]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
  });

  it("counts labeled Swift trailing closures as call arguments", async () => {
    const files: Record<string, string> = {
      "swtrail-labeled.swift": [
        "class SwTrailLabeled {",
        "  func pick(_ value: Int, _ first: () -> Int) -> Int { return value }",
        "  func pick(_ value: Int, _ first: () -> Int, second: () -> Int) -> Int { return value }",
        "  func caller() -> Int { return self.pick(1) { 2 } second: { 3 } }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-labeled-trailing-", files);
    const caller = nodeIn(graph, "swtrail-labeled.swift", "caller");
    const overloads = overloadMembers(graph, "swtrail-labeled.swift", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([2, 3]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
  });

  it("counts a Kotlin trailing lambda as a call argument", async () => {
    const files: Record<string, string> = {
      "kttrail.kt": [
        "class KtTrail {",
        "  fun pick(a: Int): Int = a",
        "  fun pick(a: Int, b: Int): Int = a + b",
        "  fun caller(): Int { return this.pick(1) { it } }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-kt-trailing-", files);
    const caller = nodeIn(graph, "kttrail.kt", "caller");
    const overloads = overloadMembers(graph, "kttrail.kt", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([1, 2]);
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toEqual(["pick"]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
  });

  it("omits arity resolution when the trailing-closure count is unknown", async () => {
    // The comment between the labeled trailing closures makes the shared scanner
    // return null: the call shape is unknown, so no arity may be fabricated. A
    // fabricated parenthesized-only count of 1 would wrongly pick the arity-1 member.
    const files: Record<string, string> = {
      "swtrail-unknown.swift": [
        "class SwTrailUnknown {",
        "  func pick(_ value: Int) -> Int { return value }",
        "  func pick(_ value: Int, _ first: () -> Int, second: () -> Int) -> Int { return value }",
        "  func caller() -> Int { return self.pick(1) { 2 } /* mid */ second: { 3 } }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-swift-unknown-trailing-", files);
    const caller = nodeIn(graph, "swtrail-unknown.swift", "caller");
    const overloads = overloadMembers(graph, "swtrail-unknown.swift", "pick");
    expect(overloads.map((node) => node.memberArity)).toEqual([1, 3]);
    expect(callsiteTexts(graph, overloads[0]!.id, caller, files)).toBeNull();
    expect(callsiteTexts(graph, overloads[1]!.id, caller, files)).toBeNull();
  });

  it("records union member ownership and receiver calls in C++", async () => {
    const files: Record<string, string> = {
      "union.cpp": [
        "union Packet {",
        "    int read(int offset) { return offset; }",
        "};",
        "int use(Packet p) { return p.read(1); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-cpp-union-", files);
    const read = nodeIn(graph, "union.cpp", "read");
    expect(graph.nodes.get(read)?.memberArity).toBe(1);
    expect(membersOwnedBy(graph, "Packet", "read")).toEqual([read]);
    const use = nodeIn(graph, "union.cpp", "use");
    expect(callsiteTexts(graph, read, use, files)).toEqual(["read"]);
  });

  it("signs C# local functions with their own arity and keeps them out of the class", async () => {
    const root = await mkTmpDir("cg-receiver-cs-local-");
    roots.push(root);
    const source = [
      "class Local {",
      "    public int Outer() {",
      "        int Inner(int a) { return a; }",
      "        return Inner(1);",
      "    }",
      "}",
    ].join("\n");
    await fs.writeFile(path.join(root, "Local.cs"), source);
    const index = await buildProjectIndex(root, { cache: "off", native: "on" });
    const prep = await prepareSourceInput(path.join(root, "Local.cs"), {});
    const nativeExecution = getNativeSyntaxTreeExecution(prep.source, prep.sup, "on");
    expect(nativeExecution.tree).toBeDefined();
    const tree = new ProjectedSyntaxTree(prep.source, nativeExecution.tree!);

    const signature = extractCallableSignature({
      languageId: "csharp",
      source,
      symbolStartIndex: source.indexOf("Inner"),
      tree,
    });
    expect(signature).toEqual({ minArgs: 1, maxArgs: 1, confidence: "high" });

    const graph = await buildSymbolGraphDetailed(index);
    const inner = nodeIn(graph, "Local.cs", "Inner");
    const memberOfTargets = graph.edges.filter((edge) => edge.label === "member_of" && edge.from === inner);
    expect(memberOfTargets).toEqual([]);
  });

  it("resolves a C# this receiver to a member instead of a same-named local function", async () => {
    const files: Record<string, string> = {
      "LocalMember.cs": [
        "class LocalMember {",
        "    public int Inner() { return 0; }",
        "    public int Outer() {",
        "        int Inner(int value) { return value; }",
        "        return this.Inner();",
        "    }",
        "    public int Invalid() {",
        "        int OnlyLocal() { return 0; }",
        "        return this.OnlyLocal();",
        "    }",
        "}",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-cs-local-member-", files);
    const outer = nodeIn(graph, "LocalMember.cs", "Outer");
    const invalid = nodeIn(graph, "LocalMember.cs", "Invalid");
    const members = membersOwnedBy(graph, "LocalMember", "Inner");
    expect(members).toHaveLength(1);
    const member = members[0]!;
    const local = overloadMembers(graph, "LocalMember.cs", "Inner").find((node) => node.id !== member);
    expect(local).toBeDefined();
    expect(graph.edges.filter((edge) => edge.label === "member_of" && edge.from === local?.id)).toEqual([]);
    expect(callsiteTexts(graph, member, outer, files)).toEqual(["Inner"]);
    expect(callsiteTexts(graph, local!.id, outer, files)).toBeNull();
    expect(outgoingCallCount(graph, invalid)).toBe(0);
  });

  it("treats function-valued variables as callable targets in call hierarchy", async () => {
    const files: Record<string, string> = {
      "arrow.js": ["const helper = () => 1;", "function caller() { return helper(); }"].join("\n"),
      "arrow.ts": ["const helper = (): number => 1;", "function caller(): number { return helper(); }"].join("\n"),
      "arrow.tsx": ["const helper = (): number => 1;", "export function Caller(): number { return helper(); }"].join(
        "\n",
      ),
      "plain.js": ["const data = 1;", "function reader() { return data; }"].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-arrow-", files);
    for (const file of ["arrow.js", "arrow.ts", "arrow.tsx"]) {
      const helper = anyNodeIn(graph, file, "helper");
      expect(graph.nodes.get(helper)?.kind).toBe("variable");
      expect(graph.nodes.get(helper)?.callable).toBe(true);
      const caller = nodeIn(graph, file, path.basename(file) === "arrow.tsx" ? "Caller" : "caller");
      expect(callsiteTexts(graph, helper, caller, files)).toEqual(["helper"]);
    }
    const data = anyNodeIn(graph, "plain.js", "data");
    expect(graph.nodes.get(data)?.callable).toBeUndefined();
    expect(findCallHierarchy(graph, data, "incoming").status).toBe("invalid_target");
    expect(findCallHierarchy(graph, data, "outgoing").status).toBe("invalid_target");
  });
});
