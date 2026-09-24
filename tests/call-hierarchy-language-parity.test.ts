import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { findCallHierarchy } from "../src/indexer/call-hierarchy.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import * as nativeRuntime from "../src/native/tree-sitter-native.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

type ProvenCall = {
  file: string;
  caller: string;
  callee: string;
};

const PROVEN_CALLS: ProvenCall[] = [
  { file: "calls.ts", caller: "tsCaller", callee: "tsCallee" },
  { file: "calls.tsx", caller: "tsxCaller", callee: "tsxCallee" },
  { file: "calls.js", caller: "jsCaller", callee: "jsCallee" },
  { file: "calls.py", caller: "py_caller", callee: "py_callee" },
  { file: "Calls.php", caller: "phpCaller", callee: "phpCallee" },
  { file: "Calls.java", caller: "javaCaller", callee: "javaCallee" },
  { file: "Calls.cs", caller: "CsCaller", callee: "CsCallee" },
  { file: "calls.go", caller: "goCaller", callee: "goCallee" },
  { file: "calls.rs", caller: "rust_caller", callee: "rust_callee" },
  { file: "calls.rb", caller: "ruby_caller", callee: "ruby_callee" },
  { file: "Calls.kt", caller: "ktCaller", callee: "ktCallee" },
  { file: "Calls.swift", caller: "swiftCaller", callee: "swiftCallee" },
  { file: "calls.zig", caller: "zigCaller", callee: "zigCallee" },
  { file: "calls.c", caller: "c_caller", callee: "c_callee" },
  { file: "calls.cpp", caller: "cpp_caller", callee: "cpp_callee" },
  { file: "Calls.svelte", caller: "svelteCaller", callee: "svelteCallee" },
];

nativeDescribe("call hierarchy language parity", () => {
  it("returns exact proven call edges for the languages covered by existing detailed extraction", async () => {
    const root = await mkTmpDir("cg-call-parity-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "calls.ts": ["function tsCallee(): void {}", "function tsCaller(): void { tsCallee(); }"].join("\n"),
      "calls.tsx": ["function tsxCallee(): void {}", "function tsxCaller(): void { tsxCallee(); }"].join("\n"),
      "calls.js": ["function jsCallee() {}", "function jsCaller() { jsCallee(); }"].join("\n"),
      "calls.py": ["def py_callee():", "    pass", "def py_caller():", "    py_callee()"].join("\n"),
      "Calls.php": ["<?php", "function phpCallee() {}", "function phpCaller() { phpCallee(); }"].join("\n"),
      "Calls.java": ["class Calls {", "  void javaCallee() {}", "  void javaCaller() { javaCallee(); }", "}"].join(
        "\n",
      ),
      "Calls.cs": ["class Calls {", "  void CsCallee() {}", "  void CsCaller() { CsCallee(); }", "}"].join("\n"),
      "calls.go": ["package calls", "func goCallee() {}", "func goCaller() { goCallee() }"].join("\n"),
      "calls.rs": ["fn rust_callee() {}", "fn rust_caller() { rust_callee(); }"].join("\n"),
      "calls.rb": ["def ruby_callee", "end", "def ruby_caller", "  ruby_callee()", "end"].join("\n"),
      "Calls.kt": ["fun ktCallee() {}", "fun ktCaller() { ktCallee() }"].join("\n"),
      "Calls.swift": ["func swiftCallee() {}", "func swiftCaller() { swiftCallee() }"].join("\n"),
      "calls.zig": ["fn zigCallee() void {}", "fn zigCaller() void { zigCallee(); }"].join("\n"),
      "calls.c": ["void c_callee() {}", "void c_caller() { c_callee(); }"].join("\n"),
      "calls.cpp": ["void cpp_callee() {}", "void cpp_caller() { cpp_callee(); }"].join("\n"),
      "Calls.svelte": [
        "<script>",
        "function svelteCallee() {}",
        "function svelteCaller() { svelteCallee(); }",
        "</script>",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off", native: "on" });
    const graph = await buildSymbolGraphDetailed(index);
    const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node]));

    for (const expected of PROVEN_CALLS) {
      const caller = nodesByName.get(expected.caller);
      const callee = nodesByName.get(expected.callee);
      expect(caller, `${expected.caller} was not indexed`).toBeDefined();
      expect(callee, `${expected.callee} was not indexed`).toBeDefined();
      const result = findCallHierarchy(graph, caller!.id, "outgoing");
      expect(result.status, `${expected.file} hierarchy status`).toBe("ok");
      if (result.status !== "ok") continue;
      const relation = result.entries.find((entry) => entry.symbolId === callee!.id);
      expect(relation, `${expected.caller} -> ${expected.callee} was not extracted`).toBeDefined();
      expect(relation?.depth).toBe(1);
      expect(relation?.callsites).toHaveLength(1);
      const callsite = relation?.callsites[0];
      expect(path.basename(callsite?.file ?? "")).toBe(expected.file);
      const source = fixtures[expected.file]!;
      expect(source.slice(callsite?.range.start.index, callsite?.range.end.index)).toBe(expected.callee);
    }
  });

  it("returns accepted-arity receiver calls through call hierarchy and keeps over-arity calls out", async () => {
    const root = await mkTmpDir("cg-call-arity-parity-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "arity.ts": [
        "class Box {",
        "  tsTarget(value = 1) { return value; }",
        "  tsCaller() { return this.tsTarget(); }",
        "  tsBad() { return this.tsTarget(1, 2); }",
        "}",
      ].join("\n"),
      "arity.tsx": [
        "class Box {",
        "  tsxTarget(value = 1) { return value; }",
        "  tsxCaller() { return this.tsxTarget(); }",
        "}",
      ].join("\n"),
      "Arity.cs": [
        "class Box {",
        "  int CsTarget(int value = 1) { return value; }",
        "  int CsCaller() { return this.CsTarget(); }",
        "}",
      ].join("\n"),
      "Arity.java": [
        "class Box {",
        "  int javaTarget(int... values) { return 1; }",
        "  int javaCaller() { return this.javaTarget(1, 2); }",
        "}",
      ].join("\n"),
      "ArityRecv.java": [
        "class Box {",
        "  int recvTarget(Box this, int value) { return value; }",
        "  int recvCaller() { return this.recvTarget(1); }",
        "}",
      ].join("\n"),
      "arity.kt": [
        "class Box {",
        "  fun ktTarget(value: Int = 1): Int { return value }",
        "  fun ktCaller(): Int { return this.ktTarget() }",
        "  fun ktBad(): Int { return this.ktTarget(1, 2) }",
        "}",
      ].join("\n"),
      "arity.swift": [
        "class Box {",
        "  func swiftTarget(_ value: Int = 1) -> Int { return value }",
        "  func swiftCaller() -> Int { return self.swiftTarget() }",
        "}",
      ].join("\n"),
      "arity.py": [
        "class Box:",
        "    @staticmethod",
        "    def py_target(self):",
        "        return self",
        "    def py_caller(self):",
        "        return Box.py_target(1)",
      ].join("\n"),
    };
    for (const [file, source] of Object.entries(fixtures)) await fs.writeFile(path.join(root, file), source);

    const index = await buildProjectIndex(root, { cache: "off", native: "on" });
    const graph = await buildSymbolGraphDetailed(index);
    const nodesByName = new Map([...graph.nodes.values()].map((node) => [node.name, node]));

    const proven: ProvenCall[] = [
      { file: "arity.ts", caller: "tsCaller", callee: "tsTarget" },
      { file: "arity.tsx", caller: "tsxCaller", callee: "tsxTarget" },
      { file: "Arity.cs", caller: "CsCaller", callee: "CsTarget" },
      { file: "Arity.java", caller: "javaCaller", callee: "javaTarget" },
      { file: "ArityRecv.java", caller: "recvCaller", callee: "recvTarget" },
      { file: "arity.kt", caller: "ktCaller", callee: "ktTarget" },
      { file: "arity.swift", caller: "swiftCaller", callee: "swiftTarget" },
      { file: "arity.py", caller: "py_caller", callee: "py_target" },
    ];
    for (const expected of proven) {
      const caller = nodesByName.get(expected.caller);
      const callee = nodesByName.get(expected.callee);
      expect(caller, `${expected.caller} was not indexed`).toBeDefined();
      expect(callee, `${expected.callee} was not indexed`).toBeDefined();
      const result = findCallHierarchy(graph, caller!.id, "outgoing");
      expect(result.status, `${expected.file} hierarchy status`).toBe("ok");
      if (result.status !== "ok") continue;
      const relation = result.entries.find((entry) => entry.symbolId === callee!.id);
      expect(relation, `${expected.caller} -> ${expected.callee} was not extracted`).toBeDefined();
      expect(relation?.depth).toBe(1);
    }

    const invalid: ProvenCall[] = [
      { file: "arity.ts", caller: "tsBad", callee: "tsTarget" },
      { file: "arity.kt", caller: "ktBad", callee: "ktTarget" },
    ];
    for (const expected of invalid) {
      const caller = nodesByName.get(expected.caller);
      const callee = nodesByName.get(expected.callee);
      const result = findCallHierarchy(graph, caller!.id, "outgoing");
      expect(result.status, `${expected.file} invalid-arity hierarchy status`).toBe("ok");
      if (result.status !== "ok") continue;
      const relation = result.entries.find((entry) => entry.symbolId === callee!.id);
      expect(relation, `${expected.caller} must not resolve an over-arity ${expected.callee}`).toBeUndefined();
    }
  });
});
