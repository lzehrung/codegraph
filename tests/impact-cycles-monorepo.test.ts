import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import { analyzeImpactFromDiff } from "../src/impact/index.js";
import type { ImpactReport } from "../src/impact/types.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("impact cycles and monorepo manifest modeling", () => {
  it("surfaces relevant dependency cycles in impact reports", async () => {
    const root = await mkTmpDir("dg-impact-cycles-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      'import { b } from "./b";\nexport const a = () => b();\n',
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "b.ts"),
      'import { a } from "./a";\nexport const b = () => a();\n',
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const diffText = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 import { b } from "./b";
-export const a = () => b();
+export const a = () => b() + 1;
`;

    const report = (await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
    })) as ImpactReport;

    expect(report.cycles?.length ?? 0).toBeGreaterThan(0);
    const cycle = report.cycles?.find((entry) =>
      entry.files.some((file) => file.endsWith("/a.ts")),
    );
    expect(cycle).toBeDefined();
    expect(cycle?.touchesChangedFile).toBe(true);
    expect(cycle?.severity).toBe("high");
    expect(cycle?.entryEdges.length ?? 0).toBeGreaterThan(0);
    expect(cycle?.priorityScore ?? 0).toBeGreaterThan(0);
    expect(cycle?.remediationHint.length ?? 0).toBeGreaterThan(0);
  });

  it("models workspace package dependencies as graph edges", async () => {
    const root = await mkTmpDir("dg-monorepo-edges-");
    await fsp.mkdir(path.join(root, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(root, "packages", "shared"), {
      recursive: true,
    });

    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "workspace-root",
        private: true,
        workspaces: ["packages/*"],
      }),
      "utf8",
    );

    await fsp.writeFile(
      path.join(root, "packages", "app", "package.json"),
      JSON.stringify({
        name: "@repo/app",
        dependencies: {
          "@repo/shared": "workspace:*",
        },
      }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "packages", "shared", "package.json"),
      JSON.stringify({ name: "@repo/shared" }),
      "utf8",
    );

    await fsp.writeFile(
      path.join(root, "packages", "app", "main.ts"),
      'export const app = "app";\n',
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "packages", "shared", "lib.py"),
      "def helper():\n    return 'ok'\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const edge = index.graph.edges.find(
      (entry) =>
        entry.from.endsWith("/packages/app/package.json") &&
        entry.to.type === "file" &&
        entry.to.path.endsWith("/packages/shared/package.json") &&
        entry.raw === "@repo/shared",
    );

    expect(edge).toBeDefined();
  });
});
