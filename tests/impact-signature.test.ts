import { describe, it, expect } from "vitest";
import {
  buildProjectIndex,
  analyzeImpactFromDiff,
} from "../src/index.js";
import type { CompactImpactReport, ImpactReport } from "../src/impact/types.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

describe("impact signature hint", () => {
  const expectImpactReport = (
    report: ImpactReport | CompactImpactReport,
  ): ImpactReport => {
    if ("files" in report) {
      throw new Error("Expected non-compact impact report");
    }
    return report;
  };

  it("should identify signature changes using AST", async () => {
    const root = path.resolve("temp-impact-signature-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    
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
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
