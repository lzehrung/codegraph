import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { findCallHierarchy } from "../src/indexer/call-hierarchy.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
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
  { file: "Calls.java", caller: "javaCaller", callee: "javaCallee" },
  { file: "Calls.cs", caller: "CsCaller", callee: "CsCallee" },
  { file: "calls.go", caller: "goCaller", callee: "goCallee" },
  { file: "calls.rs", caller: "rust_caller", callee: "rust_callee" },
  { file: "calls.rb", caller: "ruby_caller", callee: "ruby_callee" },
  { file: "Calls.svelte", caller: "svelteCaller", callee: "svelteCallee" },
];

nativeDescribe("call hierarchy language parity", () => {
  it("returns exact proven call edges for the languages covered by existing detailed extraction", async () => {
    const root = await mkTmpDir("cg-call-parity-");
    roots.push(root);
    const fixtures: Record<string, string> = {
      "calls.ts": ["function tsCallee(): void {}", "function tsCaller(): void { tsCallee(); }"].join("\n"),
      "Calls.java": ["class Calls {", "  void javaCallee() {}", "  void javaCaller() { javaCallee(); }", "}"].join(
        "\n",
      ),
      "Calls.cs": ["class Calls {", "  void CsCallee() {}", "  void CsCaller() { CsCallee(); }", "}"].join("\n"),
      "calls.go": ["package calls", "func goCallee() {}", "func goCaller() { goCallee() }"].join("\n"),
      "calls.rs": ["fn rust_callee() {}", "fn rust_caller() { rust_callee(); }"].join("\n"),
      "calls.rb": ["def ruby_callee", "end", "def ruby_caller", "  ruby_callee()", "end"].join("\n"),
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
});
