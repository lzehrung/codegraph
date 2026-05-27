import { describe, expect, it } from "vitest";
import { supportForFile } from "../../src/languages.js";
import { ProjectedSyntaxTree } from "../../src/native/projectedTree.js";
import { getNativeSyntaxTreeExecution } from "../../src/native/treeSitterNative.js";
import { extractCallableSignature, extractCallsiteArguments } from "../../src/impact/callCompatibility.js";
import type { SyntaxTreeLike } from "../../src/languages/types.js";

function parseFixture(fileName: string, source: string): { languageId: string; tree: SyntaxTreeLike } {
  const support = supportForFile(fileName);
  if (!support) {
    throw new Error(`No language support for ${fileName}`);
  }

  const execution = getNativeSyntaxTreeExecution(source, support, "auto");
  if (!execution.tree) {
    throw new Error(`Native parse failed for ${fileName}: ${execution.error ?? "unknown error"}`);
  }

  return {
    languageId: support.id,
    tree: new ProjectedSyntaxTree(source, execution.tree),
  };
}

describe("cross-language call compatibility extraction", () => {
  it.each([
    ["helper.ts", "export function helper(a: string, b = 1, ...rest: string[]) { return a; }", 1, null],
    ["helper.py", "def helper(self, a, b):\n    return a\n", 3, 3],
    ["helper.py", "class Helper:\n    def helper(self, a, b=1, *args, **kwargs):\n        return a\n", 1, null],
    ["helper.go", "package main\nfunc helper(a string, b int, rest ...string) {}\n", 2, null],
    ["helper.rs", "fn helper(&self, a: i32, b: String) {}\n", 2, 2],
    ["Helper.java", "class Helper { void helper(String a, int b) {} }\n", 2, 2],
    ["Helper.cs", "class Helper { void helper(string a, int b = 1, params string[] rest) {} }\n", 1, null],
    ["helper.kt", "fun helper(a: String, b: Int = 1, vararg rest: String) {}\n", 1, null],
    ["helper.swift", "func helper(_ a: String, b: Int = 1, rest: String...) {}\n", 1, null],
    ["helper.php", "<?php function helper($a, $b = 1, ...$rest) { }\n", 1, null],
    ["helper.rb", "def helper(a, b = 1, *rest, c:, d: 2, **kw)\nend\n", 2, null],
    ["helper.c", "void helper(char *a, int b, ...);\n", 2, null],
    ["helper.cpp", "void helper(const char* a, int b = 1) {}\n", 1, 2],
    ["helper.zig", "fn helper(a: []const u8, b: i32) void {}\n", 2, 2],
  ])("extracts callable signatures for %s", (fileName, source, minArgs, maxArgs) => {
    const parsed = parseFixture(fileName, source);
    const signature = extractCallableSignature({
      languageId: parsed.languageId,
      source,
      symbolStartIndex: source.indexOf("helper"),
      tree: parsed.tree,
    });

    expect(signature).toEqual({ minArgs, maxArgs, confidence: "high" });
  });

  it.each([
    ["call.ts", "helper(one, two);", "helper", 2],
    ["call.py", "helper(1, b=2)\n", "helper", 2],
    ["call.go", "package main\nfunc run(){ helper(\"x\", 1) }\n", "helper", 2],
    ["call.rs", "fn run(){ helper(1, String::new()); }\n", "helper", 2],
    ["Call.java", "class Call { void run(){ helper(\"x\", 1); } }\n", "helper", 2],
    ["Call.cs", "class Call { void Run(){ Helper(\"x\", b: 2); } }\n", "Helper", 2],
    ["call.kt", "fun run(){ helper(\"x\", b = 2) }\n", "helper", 2],
    ["call.swift", "func run(){ helper(\"x\", b: 2) }\n", "helper", 2],
    ["call.php", "<?php helper(\"x\", b: 2);\n", "helper", 2],
    ["call.rb", "helper(1, c: 2)\n", "helper", 2],
    ["call.c", "void run(){ helper(\"x\", 1); }\n", "helper", 2],
    ["call.cpp", "void run(){ helper<int>(\"x\"); }\n", "helper", 1],
    ["call.zig", "fn run() void { helper(\"x\", 1); }\n", "helper", 2],
  ])("extracts callsite arguments for %s", (fileName, source, calleeName, argCount) => {
    const parsed = parseFixture(fileName, source);
    const calleeStartIndex = source.indexOf(calleeName);
    const call = extractCallsiteArguments({
      languageId: parsed.languageId,
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + calleeName.length,
      tree: parsed.tree,
    });

    expect(call).toEqual({ argCount, confidence: "high" });
  });

  it.each([
    ["call.py", "helper(*values)\n"],
    ["call.php", "<?php helper(...$values);\n"],
    ["call.rb", "helper(*values)\n"],
    ["call.ts", "helper(...values);\n"],
  ])("returns null for uncountable spread callsites in %s", (fileName, source) => {
    const parsed = parseFixture(fileName, source);
    const call = extractCallsiteArguments({
      languageId: parsed.languageId,
      source,
      calleeStartIndex: source.indexOf("helper"),
      calleeEndIndex: source.indexOf("helper") + "helper".length,
      tree: parsed.tree,
    });

    expect(call).toBeNull();
  });
});
