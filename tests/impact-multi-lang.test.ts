import { describe, it, expect } from "vitest";
import {
  buildProjectIndex,
  analyzeImpactFromDiff,
} from "../src/index.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

describe("multi-language impact", () => {
  it("should identify signature changes in both TS and Python", async () => {
    const root = path.resolve("temp-impact-multi-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    
    try {
      const tsFile = path.join(root, "lib.ts").replace(/\\/g, "/");
      const pyFile = path.join(root, "lib.py").replace(/\\/g, "/");
      const tsConsumer = path.join(root, "consumer.ts").replace(/\\/g, "/");
      const pyConsumer = path.join(root, "consumer.py").replace(/\\/g, "/");

      await fsp.writeFile(tsFile, `export function foo(a: number) { return a; }`);
      await fsp.writeFile(tsConsumer, `import { foo } from "./lib"; console.log(foo(1));`);
      
      await fsp.writeFile(pyFile, `def bar(a): return a`);
      await fsp.writeFile(pyConsumer, `from lib import bar\nprint(bar(1))`);

      const index = await buildProjectIndex(root);
      
      const diffText = `diff --git a/lib.ts b/lib.ts
--- a/lib.ts
+++ b/lib.ts
@@ -1,1 +1,1 @@
-export function foo(a: number) { return a; }
+export function foo(a: number, b: string) { return a; }
diff --git a/lib.py b/lib.py
--- a/lib.py
+++ b/lib.py
@@ -1,1 +1,1 @@
-def bar(a): return a
+def bar(a, b): return a
`;

      const result = await analyzeImpactFromDiff(root, index, {
        provider: "raw",
        diffText,
        includeTests: true,
      });

      const report = result as any;
      
      // Check TS impact
      const tsImpact = report.impacted.find((i: any) => i.file === tsConsumer);
      expect(tsImpact).toBeDefined();
      expect(tsImpact.explain.hints).toContain("signatureChanged");

      // Check Python impact
      const pyImpact = report.impacted.find((i: any) => i.file === pyConsumer);
      expect(pyImpact).toBeDefined();
      expect(pyImpact.explain.hints).toContain("signatureChanged");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
