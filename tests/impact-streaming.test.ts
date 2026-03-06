import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  analyzeImpactFromDiff,
  analyzeImpactStreaming,
  type ImpactStreamChunk,
} from "../src/impact/index.js";
import { buildProjectIndex } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Impact streaming", () => {
  it("matches analyzeImpactFromDiff results", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const index = await buildProjectIndex(root);

    const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,4 @@
 export function helperFunction() {
   return 42;
 }
+export const added = 1;
`;

    const report = await analyzeImpactFromDiff(root, index, {
      provider: "raw",
      diffText,
    });

    const streamedItems: string[] = [];
    const streamedChangedSymbols: string[] = [];
    const chunkTypes: string[] = [];
    const errorChunks: string[] = [];

    for await (const chunk of analyzeImpactStreaming(root, index, {
      provider: "raw",
      diffText,
    })) {
      chunkTypes.push(chunk.type);
      if (chunk.type === "impactItem") {
        streamedItems.push(chunk.item.file);
      }
      if (chunk.type === "changedSymbol") {
        streamedChangedSymbols.push(chunk.symbol.id);
      }
      if (chunk.type === "error") {
        errorChunks.push(chunk.error);
      }
    }

    const streamedSet = new Set(streamedItems);
    const reportSet = new Set(report.impacted.map((item) => item.file));

    expect(streamedSet).toEqual(reportSet);
    expect(streamedChangedSymbols.length).toBe(report.changedSymbols.length);
    const firstNonMeta = chunkTypes.find((type) => type !== "projectFiles");
    expect(firstNonMeta).toBe("progress");
    expect(errorChunks).toEqual([]);
    expect(chunkTypes[chunkTypes.length - 1]).toBe("complete");
  });

  it("emits error chunk when diff provider fails", async () => {
    const root = await mkTmpDir("dg-stream-error-");
    await fsp.writeFile(
      path.join(root, "index.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    const index = await buildProjectIndex(root);

    try {
      const chunks: ImpactStreamChunk[] = [];
      for await (const chunk of analyzeImpactStreaming(root, index, {
        provider: "git",
        base: "main",
        head: "HEAD",
        cwd: root,
      })) {
        chunks.push(chunk);
      }

      expect(chunks.some((chunk) => chunk.type === "progress")).toBe(true);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("includes rename impacts that rely on oldPath normalization", async () => {
    const root = await mkTmpDir("dg-stream-rename-");
    await fsp.writeFile(
      path.join(root, "consumer.ts"),
      `import { setup } from "./setup";
export const run = () => setup();
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "setup.ts"),
      "export const setup = () => 1;\n",
      "utf8",
    );
    const index = await buildProjectIndex(root);

    try {
      const diffText = `diff --git a/setup.ts b/setup-renamed.ts
similarity index 100%
rename from setup.ts
rename to setup-renamed.ts
--- a/setup.ts
+++ b/setup-renamed.ts
@@ -1 +1 @@
-export const setup = () => 1;
+export const setup = () => 2;
`;

      const impactedFiles: string[] = [];
      for await (const chunk of analyzeImpactStreaming(root, index, {
        provider: "raw",
        diffText,
      })) {
        if (chunk.type === "impactItem") {
          impactedFiles.push(chunk.item.file);
        }
      }

      expect(impactedFiles.some((file) => file.endsWith("consumer.ts"))).toBe(
        true,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
