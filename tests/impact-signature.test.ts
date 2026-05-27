import { describe, it, expect } from "vitest";
import { buildProjectIndex, analyzeImpactFromDiff } from "../src/index.js";
import { extractCallableSignature, extractCallsiteArguments } from "../src/impact/callCompatibility.js";
import type { CallCompatibilityHint, CompactImpactReport, ImpactReport } from "../src/impact/types.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("impact signature hint", () => {
  const expectImpactReport = (report: ImpactReport | CompactImpactReport): ImpactReport => {
    if ("files" in report) {
      throw new Error("Expected non-compact impact report");
    }
    return report;
  };

  it("models conservative call compatibility hints", () => {
    const hint: CallCompatibilityHint = {
      status: "likely_mismatch",
      reason: "argument_count_below_minimum",
      changedSymbolId: "src/api.ts#helper",
      callsiteFile: "src/main.ts",
      callsiteRange: {
        start: { line: 3, column: 10, index: 42 },
        end: { line: 3, column: 21, index: 53 },
      },
      callerSymbolId: "src/main.ts#run",
      expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
      actual: { argCount: 1, confidence: "high" },
    };

    expect(hint.status).toBe("likely_mismatch");
    expect(hint.expected.maxArgs).toBe(2);
  });

  it("extracts fixed arity for simple TypeScript functions", () => {
    const source = "export function helper(a: string, b: number) { return a + b; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("does not split commas inside TypeScript parameter type arguments", () => {
    const source = "export function helper(a: Map<string, number>, b: Set<string>) { return a; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("does not split function type commas or arrows inside TypeScript parameter type arguments", () => {
    const source = "export function helper(a: Transform<(x: Array<string>) => U, V>, b: string) { return b; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("does not treat destructuring defaults as optional object parameters", () => {
    const source = "export function helper({ a = 1 }: Options, b: string) { return b; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("ignores TypeScript this parameters in callable signatures", () => {
    const source = "export function helper(this: Console, a: string) { return a; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 1, maxArgs: 1, confidence: "high" });
  });

  it("does not count trailing parameter commas as parameters", () => {
    const source = "export function helper(a: string, b: number,) { return a + b; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("extracts minimum arity for optional and defaulted parameters", () => {
    const source = "export function helper(a: string, b = 1, c?: boolean) { return a; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 1, maxArgs: 3, confidence: "high" });
  });

  it("requires arguments through the last required parameter", () => {
    const source = "export function helper(a = 1, b: string) { return b; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
  });

  it("marks rest signatures as unbounded", () => {
    const source = "export function helper(a: string, ...rest: string[]) { return rest; }";
    const signature = extractCallableSignature({
      languageId: "typescript",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toEqual({ minArgs: 1, maxArgs: null, confidence: "high" });
  });

  it("returns null for unsupported languages", () => {
    const source = "def helper(a, b):\n    return a";
    const signature = extractCallableSignature({
      languageId: "python",
      source,
      symbolStartIndex: source.indexOf("helper"),
    });

    expect(signature).toBeNull();
  });

  it("counts fixed callsite arguments", () => {
    const source = "helper(one, two, three);";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 3, confidence: "high" });
  });

  it("counts nested expressions as one argument each", () => {
    const source = "helper(fn(a, b), { x: [1, 2] });";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 2, confidence: "high" });
  });

  it("does not split commas inside TypeScript callsite type arguments", () => {
    const source = "helper(value as Map<string, number>, other);";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 2, confidence: "high" });
  });

  it("counts comparison expression callsite arguments separately", () => {
    const source = "helper(a < b, c > d);";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 2, confidence: "high" });
  });

  it("counts callsite arguments with apostrophes in comments", () => {
    const source = "helper(a /* user's value */, b);";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 2, confidence: "high" });
  });

  it("does not count trailing argument commas as arguments", () => {
    const source = 'helper("x",);';
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toEqual({ argCount: 1, confidence: "high" });
  });

  it("counts nested generic TypeScript calls with resolved callee ranges", () => {
    const source = "helper<Map<string, Array<number>>>(value);";
    const calleeStartIndex = source.indexOf("helper");
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + "helper".length,
    });

    expect(call).toEqual({ argCount: 1, confidence: "high" });
  });

  it("does not treat spaced comparison syntax as a generic call", () => {
    const source = "helper < value > (arg);";
    const calleeStartIndex = source.indexOf("helper");
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + "helper".length,
    });

    expect(call).toBeNull();
  });

  it("counts generic calls with function type constraints", () => {
    const source = "helper<T extends (x: Array<string>) => number>(value);";
    const calleeStartIndex = source.indexOf("helper");
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + "helper".length,
    });

    expect(call).toEqual({ argCount: 1, confidence: "high" });
  });

  it("counts generic TypeScript calls with resolved callee ranges", () => {
    const source = "helper<string>(value);";
    const calleeStartIndex = source.indexOf("helper");
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + "helper".length,
    });

    expect(call).toEqual({ argCount: 1, confidence: "high" });
  });

  it("returns null for spread arguments", () => {
    const source = "helper(...values);";
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex: source.indexOf("helper"),
    });

    expect(call).toBeNull();
  });

  it("does not treat a non-call reference as a later call expression", () => {
    const source = "const value = helper;\nother();";
    const calleeStartIndex = source.indexOf("helper");
    const call = extractCallsiteArguments({
      languageId: "typescript",
      source,
      calleeStartIndex,
      calleeEndIndex: calleeStartIndex + "helper".length,
    });

    expect(call).toBeNull();
  });

  it("should identify signature changes using AST", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-impact-signature-"));

    try {
      const file = path.join(root, "test.ts").replace(/\\/g, "/");
      await fsp.writeFile(file, `export function foo(a: number) { return a; }`);

      const consumer = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(consumer, `import { foo } from "./test"; console.log(foo(1));`);

      const index = await buildProjectIndex(root);

      const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-export function foo(a: number) { return a; }
+export function foo(a: number, b: string) { return a; }
`;

      const result = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
        includeTests: true,
      });

      const report = expectImpactReport(result);
      expect(report.impacted.length).toBeGreaterThan(0);
      const impact = report.impacted.find((item) => item.file === "consumer.ts");
      expect(impact).toBeDefined();
      expect(impact?.explain?.hints).toContain("signatureChanged");
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
