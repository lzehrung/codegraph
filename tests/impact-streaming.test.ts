import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  analyzeImpactFromDiff,
  analyzeImpactStreaming,
  type ImpactStreamChunk,
  type ImpactStreamSummaryReport,
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
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "Hello from utils";
+  return "Hello from updated utils";
 }
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

  it("streams a final structured report summary for deterministic review-pack consumers", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const index = await buildProjectIndex(root);
    const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "Hello from utils";
+  return "Hello from updated utils";
 }
`;

    const chunks: ImpactStreamChunk[] = [];
    for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
      chunks.push(chunk);
    }

    const complete = chunks.find((chunk) => chunk.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.report).toBeDefined();
      expect(complete.report.schemaVersion).toBe(1);
      expect(complete.report.format).toBe("stream-summary");
      expect(complete.report.changedFiles.length).toBeGreaterThan(0);
      expect(complete.report.changedSymbols.length).toBeGreaterThan(0);
      expect(complete.report.impacted.length).toBeGreaterThan(0);
      expect(complete.report.diagnostics.changedFilesTotal).toBeGreaterThan(0);
      expect(Array.isArray(complete.report.topImpacts)).toBe(true);
      expect(Array.isArray(complete.report.surfaceArea.files)).toBe(true);
      expect(Array.isArray(complete.report.clusters)).toBe(true);
    }
  });

  it("keeps streaming final summary aligned with batch impact reports", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const index = await buildProjectIndex(root);
    const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "Hello from utils";
+  return "Hello from updated utils";
 }
`;

    const batch = await analyzeImpactFromDiff(root, index, { provider: "raw", diffText });
    expect(batch.format).toBe("full");

    let streamed: ImpactStreamSummaryReport | undefined;
    for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
      if (chunk.type === "complete") streamed = chunk.report;
    }

    expect(streamed).toBeDefined();
    if (batch.format === "full" && streamed) {
      expect(streamed.changedFiles).toEqual(batch.changedFiles);
      expect(streamed.changedSymbols).toEqual(batch.changedSymbols);
      expect(streamed.impacted).toEqual(batch.impacted);
      expect(streamed.topImpacts).toEqual(batch.topImpacts ?? []);
      expect(streamed.surfaceArea).toEqual(batch.surfaceArea);
      expect(streamed.clusters).toEqual(batch.clusters);
      expect(streamed.cycles).toEqual(batch.cycles ?? []);
      expect(streamed.diagnostics).toEqual(batch.diagnostics);
    }
  });

  it("keeps streaming final extras aligned with batch impact reports", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "impact-suggestions");
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
    const options = {
      provider: "raw" as const,
      diffText,
      detectBreakingChanges: true,
      verifyReferences: false,
    };

    const batch = await analyzeImpactFromDiff(root, index, options);
    expect(batch.format).toBe("full");

    let streamed: ImpactStreamSummaryReport | undefined;
    for await (const chunk of analyzeImpactStreaming(root, index, options)) {
      if (chunk.type === "complete") streamed = chunk.report;
    }

    expect(streamed).toBeDefined();
    if (batch.format === "full" && streamed) {
      expect(streamed.suggestions).toEqual(batch.suggestions);
      expect(streamed.exportSummary).toEqual(batch.exportSummary);
      expect(streamed.reexportChains).toEqual(batch.reexportChains);
      expect(streamed.graph).toEqual(batch.graph);
    }
  });

  it("emits error chunk when diff provider fails", async () => {
    const root = await mkTmpDir("dg-stream-error-");
    await fsp.writeFile(path.join(root, "index.ts"), "export const a = 1;\n", "utf8");
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
    await fsp.writeFile(path.join(root, "setup.ts"), "export const setup = () => 1;\n", "utf8");
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

      expect(impactedFiles.some((file) => file.endsWith("consumer.ts"))).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("filters changedSymbol events before emission when scope=imported", async () => {
    const root = await mkTmpDir("dg-stream-scope-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      `function helper() { return 1; }
export function run() { return helper(); }
`,
      "utf8",
    );
    const index = await buildProjectIndex(root);

    try {
      const diffText = `diff --git a/a.ts b/a.ts
index 1234567..abcdef0 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-function helper() { return 1; }
+function helper() { return 2; }
 export function run() { return helper(); }
`;

      const changedSymbols: string[] = [];
      let completeSummary: { totalChanged: number; totalImpacted: number } | undefined;

      for await (const chunk of analyzeImpactStreaming(root, index, {
        provider: "raw",
        diffText,
        scope: "imported",
      })) {
        if (chunk.type === "changedSymbol") {
          changedSymbols.push(chunk.symbol.name);
        }
        if (chunk.type === "complete") {
          completeSummary = chunk.summary;
        }
      }

      expect(changedSymbols).toEqual([]);
      expect(completeSummary?.totalChanged).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes absolute raw diff paths before applying ignoreGlobs in streaming mode", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const index = await buildProjectIndex(root);
    const absoluteMain = path.join(root, "main.ts").replace(/\\/g, "/");
    const diffText = `diff --git a/${absoluteMain} b/${absoluteMain}
index 1234567..abcdef0 100644
--- a/${absoluteMain}
+++ b/${absoluteMain}
@@ -1,1 +1,2 @@
 import { helperFunction } from './utils';
+console.log("ignored");
`;

    const chunkTypes: string[] = [];
    const changedSymbols: string[] = [];
    const impactedFiles: string[] = [];

    for await (const chunk of analyzeImpactStreaming(root, index, {
      provider: "raw",
      diffText,
      ignoreGlobs: ["main.ts"],
    })) {
      chunkTypes.push(chunk.type);
      if (chunk.type === "changedSymbol") {
        changedSymbols.push(chunk.symbol.file);
      }
      if (chunk.type === "impactItem") {
        impactedFiles.push(chunk.item.file);
      }
    }

    expect(changedSymbols).toEqual([]);
    expect(impactedFiles).toEqual([]);
    expect(chunkTypes[chunkTypes.length - 1]).toBe("complete");
  });

  it("emits progressive impact items before completion", async () => {
    const root = await mkTmpDir("dg-stream-progressive-");
    await fsp.writeFile(
      path.join(root, "feature.ts"),
      `export function helper() { return 1; }
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "consumer.ts"),
      `import { helper } from "./feature";
export function run() { return helper(); }
`,
      "utf8",
    );
    const index = await buildProjectIndex(root);

    try {
      const diffText = `diff --git a/feature.ts b/feature.ts
index 1234567..abcdef0 100644
--- a/feature.ts
+++ b/feature.ts
@@ -1 +1 @@
-export function helper() { return 1; }
+export function helper() { return 2; }
`;

      const chunkTypes: string[] = [];
      const impactItems: Array<{ file: string; partial: boolean }> = [];

      for await (const chunk of analyzeImpactStreaming(root, index, {
        provider: "raw",
        diffText,
      })) {
        chunkTypes.push(chunk.type);
        if (chunk.type === "impactItem") {
          impactItems.push({
            file: chunk.item.file,
            partial: chunk.partial ?? false,
          });
        }
      }

      expect(impactItems.some((item) => item.partial)).toBe(true);
      expect(impactItems.some((item) => item.file.endsWith("consumer.ts"))).toBe(true);
      const firstImpactIndex = chunkTypes.indexOf("impactItem");
      const completeIndex = chunkTypes.lastIndexOf("complete");
      expect(firstImpactIndex).toBeGreaterThan(-1);
      expect(completeIndex).toBeGreaterThan(firstImpactIndex);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
