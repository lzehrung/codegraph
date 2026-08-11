import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { prepareSourceInput } from "../../src/languages/filePrep.js";
import { parseSFC } from "../../src/languages/sfc.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(dirname, "samples", "vue.sample.vue");
const source = fs.readFileSync(samplePath, "utf8");

describe("Vue SFC chunking", () => {
  it("produces template/script/style chunks", () => {
    const chunks = chunkSFCFile({
      source,
      filePath: "vue.sample.vue",
      framework: "vue",
      minTokens: 1,
      maxTokens: 1000,
    });
    expect(chunks.some((c) => c.type?.startsWith("template"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("script"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("style"))).toBe(true);
    const templateChunks = chunks.filter((chunk) => chunk.type?.startsWith("template"));
    expect(templateChunks.every((chunk) => chunk.languageId === "html")).toBe(true);
  });
});

const definition: LanguageTestDefinition = {
  id: "vue",
  parity: {
    sampleDir: "vue",
    dependencyGraph: [
      {
        from: "inline-script.vue",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "script-setup.vue",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "App.vue",
        to: { type: "file", path: "Child.vue" },
      },
      {
        from: "App.vue",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "TsScript.vue",
        to: { type: "file", path: "Child.vue" },
      },
      {
        from: "TsScript.vue",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "ExternalScripts.vue",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "ExternalScripts.vue",
        to: { type: "file", path: "extra.ts" },
      },
      {
        from: "ExternalScripts.vue",
        to: { type: "external", name: "https://cdn.example/vue-helper.js" },
      },
      {
        from: "ExternalScripts.vue",
        to: { type: "external", name: "./missing.ts" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "ExternalScripts.vue",
        to: { type: "external", name: "" },
      },
      {
        from: "ExternalScripts.vue",
        to: { type: "file", path: "missing.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it("deduplicates and filters Vue external script src dependencies", async () => {
  const sampleDir = path.resolve(process.cwd(), "tests", "samples", "vue");
  const sourceFile = path.join(sampleDir, "ExternalScripts.vue").replace(/\\/g, "/");
  const logicFile = path.join(sampleDir, "logic.ts").replace(/\\/g, "/");
  const extraFile = path.join(sampleDir, "extra.ts").replace(/\\/g, "/");
  const graph = await collectGraph(sampleDir, [sourceFile, logicFile, extraFile]);

  expect(
    graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === logicFile),
  ).toHaveLength(1);
  expect(
    graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === extraFile),
  ).toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) =>
        edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "https://cdn.example/vue-helper.js",
    ),
  ).toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "./missing.ts",
    ),
  ).toHaveLength(1);
  expect(
    graph.edges.some((edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === ""),
  ).toBe(false);
});

it("preserves Vue block content and original coordinates while extracting embedded dependencies", async () => {
  const sampleDir = path.resolve(process.cwd(), "tests", "samples", "vue");
  const sourceFile = path.join(sampleDir, "sfc-blocks.vue").replace(/\\/g, "/");
  const source = fs.readFileSync(sourceFile, "utf8");
  const scriptFile = path.join(sampleDir, "sfc-block-script.ts").replace(/\\/g, "/");
  const styleFile = path.join(sampleDir, "sfc-block-theme.scss").replace(/\\/g, "/");
  const templateFile = path.join(sampleDir, "sfc-block-target.html").replace(/\\/g, "/");

  const script = parseSFC(source).find((block) => block.type === "script");
  expect(script).toMatchObject({ startLine: 5, endLine: 9 });
  expect(script?.content).toContain('<!-- </script> -->');
  expect(script?.content).toContain('const embeddedClose = "</script>";');
  expect(script?.content).toContain('import { scriptValue } from "./sfc-block-script.ts";');

  const prepared = await prepareSourceInput(sourceFile, { source });
  const templateBlock = prepared.embeddedBlocks?.find((block) => block.sup.id === "html");
  const styleBlock = prepared.embeddedBlocks?.find((block) => block.sup.id === "scss");
  expect(templateBlock).toBeDefined();
  expect(styleBlock).toBeDefined();
  expect(lineAndColumnAt(source, templateBlock!.block.startOffset)).toEqual({ line: 1, column: 11 });
  expect(lineAndColumnAt(source, styleBlock!.block.startOffset)).toEqual({ line: 12, column: 20 });

  const templateOffset = templateBlock!.source.indexOf("./sfc-block-target.html");
  const styleOffset = styleBlock!.source.indexOf("@import");
  expect(templateOffset).toBe(source.indexOf("./sfc-block-target.html"));
  expect(styleOffset).toBe(source.indexOf("@import"));
  expect(lineAndColumnAt(templateBlock!.source, templateOffset)).toEqual({ line: 2, column: 12 });
  expect(lineAndColumnAt(styleBlock!.source, styleOffset)).toEqual({ line: 13, column: 3 });

  const graph = await collectGraph(sampleDir, [sourceFile, scriptFile, styleFile, templateFile]);
  const localTargets = graph.edges
    .filter((edge) => edge.from === sourceFile && edge.to.type === "file")
    .map((edge) => edge.to.path)
    .filter((target) => target === scriptFile || target === styleFile || target === templateFile)
    .sort();
  expect(localTargets).toEqual([scriptFile, styleFile, templateFile].sort());
  const index = await createTestIndexFromFiles(sampleDir, [sourceFile, scriptFile, styleFile, templateFile]);
  const indexedTargets = (index.byFile.get(fileIdentityKey(sourceFile))?.imports ?? [])
    .flatMap((entry) => (typeof entry.resolved === "string" ? [entry.resolved] : []))
    .filter((target) => target === scriptFile || target === styleFile || target === templateFile)
    .sort();
  expect(indexedTargets).toEqual([scriptFile, styleFile, templateFile].sort());
});

function lineAndColumnAt(source: string, offset: number): { line: number; column: number } {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return {
    line: source.slice(0, offset).split("\n").length,
    column: offset - lineStart + 1,
  };
}
