import { describe, it, expect } from "vitest";
import { buildProjectIndex, analyzeImpactFromDiff } from "../src/index.js";
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
