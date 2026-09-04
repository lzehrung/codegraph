import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
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
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
  return await buildSymbolGraphDetailed(index);
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

describe("receiver method call edges", () => {
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
      "dynamic.ts": [
        "export function callDynamic(value: { run(): number }): number { return value.run(); }",
      ].join("\n"),
    };
    const graph = await buildFixture("cg-receiver-ts-dynamic-", files);
    const svcRun = nodeIn(graph, "svc.ts", "run");
    const callDynamic = nodeIn(graph, "dynamic.ts", "callDynamic");
    expect(callsiteTexts(graph, svcRun, callDynamic, files)).toBeNull();
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
});
