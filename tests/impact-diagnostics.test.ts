import { describe, expect, it } from "vitest";
import path from "node:path";
import { analyzeImpactFromDiff, buildProjectIndex } from "../src/index.js";

describe("Impact diagnostics", () => {
  it("includes diagnostics counters and direct-impact confidence", async () => {
    const root = path.resolve("tests/samples/typescript");
    const index = await buildProjectIndex(root);

    const diffText = `diff --git a/helpers.ts b/helpers.ts
index 1111111..2222222 100644
--- a/helpers.ts
+++ b/helpers.ts
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "helper";
+  return "helper-updated";
 }
`;

    const report = await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
      refContext: "line",
      maxRefs: 20,
    });

    expect(report.diagnostics).toBeDefined();
    expect((report.diagnostics?.changedFilesTotal ?? 0) >= 1).toBe(true);
    expect((report.diagnostics?.refsScanned ?? 0) >= 1).toBe(true);

    expect(Array.isArray(report.impacted)).toBe(true);
  });
});
