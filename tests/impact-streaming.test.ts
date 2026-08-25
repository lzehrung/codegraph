import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  analyzeImpactFromDiff,
  analyzeImpactStreaming,
  type ImpactStreamChunk,
  type ImpactStreamSummaryReport,
} from "../src/impact/index.js";
import { impactItemEmissionKey } from "../src/impact/streaming.js";
import { buildProjectIndex } from "../src/index.js";
import * as navigation from "../src/indexer/navigation.js";
import { runGit as git } from "./helpers/git.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function firstStreamError(stream: AsyncGenerator<ImpactStreamChunk>): Promise<string | undefined> {
  for await (const chunk of stream) {
    if (chunk.type === "error") {
      return chunk.error;
    }
  }
  return undefined;
}

describe("Impact streaming", () => {
  it("keeps type-only status in impact item emission dedupe keys", () => {
    const baseItem = {
      file: "src/consumer.ts",
      symbols: ["helper"],
      reasons: ["transitive" as const],
      severity: 0.3,
      depth: 1,
      confidence: 0.5,
    };

    const runtimeKey = impactItemEmissionKey(
      {
        ...baseItem,
        typeOnly: false,
        explain: { reason: "transitive", depth: 1, typeOnly: false },
      },
      true,
    );
    const typeOnlyKey = impactItemEmissionKey(
      {
        ...baseItem,
        typeOnly: true,
        explain: { reason: "transitive", depth: 1, typeOnly: true },
      },
      true,
    );

    expect(typeOnlyKey).not.toBe(runtimeKey);
  });

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
    expect(report.analysis?.label).toBeTruthy();

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
      expect(complete.report.analysis?.label).toBeTruthy();
      expect(complete.report.changedFiles.length).toBeGreaterThan(0);
      expect("oldFile" in complete.report.changedFiles[0]!).toBe(false);
      expect(complete.report.changedSymbols.length).toBeGreaterThan(0);
      expect(complete.report.impacted.length).toBeGreaterThan(0);
      expect(complete.report.diagnostics.changedFilesTotal).toBeGreaterThan(0);
      expect(Array.isArray(complete.report.topImpacts)).toBe(true);
      expect(Array.isArray(complete.report.surfaceArea.files)).toBe(true);
      expect(Array.isArray(complete.report.clusters)).toBe(true);
    }
  });

  it("keeps completion progress after terminal summary construction", async () => {
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

    const progress = chunks.filter((chunk) => chunk.type === "progress");
    expect(progress.map((chunk) => `${chunk.current}/${chunk.total}:${chunk.message}`)).toContain(
      "3/4:Building summary",
    );
    expect(chunks[chunks.length - 2]).toMatchObject({
      type: "progress",
      message: "Analysis complete",
      current: 4,
      total: 4,
    });
    expect(chunks[chunks.length - 1]?.type).toBe("complete");
  });

  it("can emit a light terminal report for incremental-only streaming consumers", async () => {
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

    let complete: Extract<ImpactStreamChunk, { type: "complete" }> | undefined;
    for await (const chunk of analyzeImpactStreaming(root, index, {
      provider: "raw",
      diffText,
      streamSummary: "light",
    })) {
      if (chunk.type === "complete") complete = chunk;
    }

    expect(complete).toBeDefined();
    if (batch.format === "full" && complete) {
      expect(complete.report.changedFiles).toEqual(batch.changedFiles);
      expect(complete.report.changedSymbols).toEqual(batch.changedSymbols);
      expect(complete.report.impacted).toEqual(batch.impacted);
      expect(complete.report.diagnostics).toEqual(batch.diagnostics);
      expect(complete.summary.totalChanged).toBe(complete.report.changedSymbols.length);
      expect(complete.summary.totalImpacted).toBe(complete.report.impacted.length);
      expect(complete.report.suggestions).toBeUndefined();
      expect(complete.report.exportSummary).toBeUndefined();
      expect(complete.report.reexportChains).toBeUndefined();
      expect(complete.report.topImpacts).toEqual([]);
      expect(complete.report.surfaceArea).toEqual({ files: [], topFanIn: [], topFanOut: [] });
      expect(complete.report.clusters).toEqual([]);
      expect(complete.report.cycles).toEqual([]);
      expect(complete.report.graph).toEqual({ fileEdges: [], symbolEdges: [] });
    }
  });

  it("rejects invalid stream summary modes", async () => {
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
    const misspelledSummaryOptions = {
      provider: "raw",
      diffText,
      streamSummary: "lite",
    };
    const misspelledSummaryStream = Reflect.apply(analyzeImpactStreaming, undefined, [
      root,
      index,
      misspelledSummaryOptions,
    ]) as AsyncGenerator<ImpactStreamChunk>;

    await expect(firstStreamError(misspelledSummaryStream)).resolves.toContain(
      'streamSummary must be "full" or "light"',
    );
  });

  it("preserves diff provider warnings in light terminal reports", async () => {
    const root = await mkTmpDir("dg-stream-warning-");

    try {
      git(root, ["init"]);
      git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      git(root, ["config", "core.autocrlf", "false"]);
      await fsp.writeFile(path.join(root, "README.md"), "initial\n", "utf8");
      git(root, ["add", "README.md"]);
      git(root, ["commit", "-m", "initial"]);

      const index = await buildProjectIndex(root);
      const largeChange = Array.from({ length: 50001 }, (_value, line) => `line ${line}`).join("\n");
      await fsp.writeFile(path.join(root, "README.md"), `${largeChange}\n`, "utf8");

      let complete: Extract<ImpactStreamChunk, { type: "complete" }> | undefined;
      for await (const chunk of analyzeImpactStreaming(root, index, {
        provider: "git",
        cwd: root,
        base: "HEAD",
        head: "WORKTREE",
        streamSummary: "light",
      })) {
        if (chunk.type === "complete") complete = chunk;
      }

      expect(complete?.report.warning).toContain("Large diff detected");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
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

  it("keeps broken Markdown links in the streaming completion report", async () => {
    const root = await mkTmpDir("dg-stream-markdown-links-");
    try {
      const readme = path.join(root, "README.md");
      await fsp.writeFile(readme, "[Missing](./missing.md)\n", "utf8");
      const index = await buildProjectIndex(root);
      const diffText = [
        "diff --git a/README.md b/README.md",
        "index 1234567..abcdef0 100644",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -0,0 +1 @@",
        "+[Missing](./missing.md)",
        "",
      ].join("\n");

      const batch = await analyzeImpactFromDiff(root, index, { provider: "raw", diffText });
      let streamed: ImpactStreamSummaryReport | undefined;
      for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
        if (chunk.type === "complete") streamed = chunk.report;
      }

      expect(batch.format).toBe("full");
      expect(streamed).toBeDefined();
      if (batch.format === "full" && streamed) {
        expect(batch.markdownLinks?.summary.failures).toBe(1);
        expect(streamed.markdownLinks).toEqual(batch.markdownLinks);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
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

/** Builds `symbolCount` distinct top-level exported functions in one file, plus a raw
 * unified diff with one hunk per function so `mapChangedFileSymbols` reports
 * `symbolCount` distinct changed symbols. */
async function writeManySymbolFixture(root: string, symbolCount: number): Promise<{ diffText: string }> {
  const lines = Array.from({ length: symbolCount }, (_, i) => `export function fn${i}() { return ${i}; }`);
  await fsp.writeFile(path.join(root, "feature.ts"), `${lines.join("\n")}\n`, "utf8");
  const hunks = lines
    .map((line, i) => {
      const updated = line.replace(`return ${i};`, `return ${i + 1000};`);
      return `@@ -${i + 1} +${i + 1} @@\n-${line}\n+${updated}\n`;
    })
    .join("");
  const diffText = `diff --git a/feature.ts b/feature.ts
index 1234567..abcdef0 100644
--- a/feature.ts
+++ b/feature.ts
${hunks}`;
  return { diffText };
}

describe("Impact streaming resource bounds", () => {
  it("surfaces a bounded overflow error instead of silently truncating when a producer burst outruns the queue cap", async () => {
    const root = await mkTmpDir("dg-stream-overflow-");
    await fsp.writeFile(path.join(root, "feature.ts"), "export function helper() { return 1; }\n", "utf8");
    const consumerCount = 6;
    for (let i = 0; i < consumerCount; i += 1) {
      await fsp.writeFile(
        path.join(root, `consumer${i}.ts`),
        `import { helper } from "./feature";\nexport function run${i}() { return helper(); }\n`,
        "utf8",
      );
    }
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

      // All 6 references to `helper` are emitted inside one synchronous loop in
      // direct.ts (no `await` between them), so a cap of 2 overflows deterministically
      // on every run regardless of machine speed: the consumer cannot possibly dequeue
      // mid-burst.
      const chunkTypes: string[] = [];
      const errors: string[] = [];
      const impactFiles: string[] = [];
      for await (const chunk of analyzeImpactStreaming(
        root,
        index,
        { provider: "raw", diffText },
        { maxQueuedChunks: 2 },
      )) {
        chunkTypes.push(chunk.type);
        if (chunk.type === "impactItem") impactFiles.push(chunk.item.file);
        if (chunk.type === "error") errors.push(chunk.error);
      }

      expect(chunkTypes).toContain("error");
      expect(chunkTypes).not.toContain("complete");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/fell behind the producer/);
      expect(errors[0]).toMatch(/more than 2 chunks/);
      // The consumer learns exactly how far the stream got before it failed, not nothing.
      expect(impactFiles.length).toBeGreaterThan(0);
      expect(impactFiles.length).toBeLessThan(consumerCount);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not overflow the same fixture under the default buffered-chunk cap", async () => {
    const root = await mkTmpDir("dg-stream-no-overflow-");
    await fsp.writeFile(path.join(root, "feature.ts"), "export function helper() { return 1; }\n", "utf8");
    const consumerCount = 6;
    for (let i = 0; i < consumerCount; i += 1) {
      await fsp.writeFile(
        path.join(root, `consumer${i}.ts`),
        `import { helper } from "./feature";\nexport function run${i}() { return helper(); }\n`,
        "utf8",
      );
    }
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
      const impactFiles: string[] = [];
      for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
        chunkTypes.push(chunk.type);
        if (chunk.type === "impactItem") impactFiles.push(chunk.item.file);
      }

      expect(chunkTypes).toContain("complete");
      expect(chunkTypes).not.toContain("error");
      const impactedFileSet = new Set(impactFiles);
      for (let i = 0; i < consumerCount; i += 1) {
        expect(impactedFileSet.has(`consumer${i}.ts`)).toBe(true);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("stops the background analyzer once the consumer abandons the stream mid-analysis", async () => {
    const root = await mkTmpDir("dg-stream-cancel-");
    const symbolCount = 40;
    const { diffText } = await writeManySymbolFixture(root, symbolCount);
    const index = await buildProjectIndex(root);

    try {
      const findReferencesSpy = vi.spyOn(navigation, "findReferences");

      let sawImpactItem = false;
      for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
        if (chunk.type === "impactItem") {
          sawImpactItem = true;
          break;
        }
      }
      expect(sawImpactItem).toBe(true);

      const settledCalls = findReferencesSpy.mock.calls.length;
      // The iterator return waits for the producer's cancellation acknowledgement, so no
      // wall-clock polling or threshold is needed to observe the stopped batch.
      expect(settledCalls).toBeGreaterThan(0);
      expect(settledCalls).toBeLessThan(symbolCount / 2);
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("analyzes every changed symbol when the same stream is consumed to completion", async () => {
    const root = await mkTmpDir("dg-stream-nocancel-");
    const symbolCount = 40;
    const { diffText } = await writeManySymbolFixture(root, symbolCount);
    const index = await buildProjectIndex(root);

    try {
      const findReferencesSpy = vi.spyOn(navigation, "findReferences");

      const chunkTypes: string[] = [];
      for await (const chunk of analyzeImpactStreaming(root, index, { provider: "raw", diffText })) {
        chunkTypes.push(chunk.type);
      }

      expect(chunkTypes).toContain("complete");
      expect(findReferencesSpy).toHaveBeenCalledTimes(symbolCount);
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
