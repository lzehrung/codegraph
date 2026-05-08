import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(dirname, "samples", "svelte.sample.svelte");
const source = fs.readFileSync(samplePath, "utf8");

describe("Svelte SFC chunking", () => {
  it("produces script/style/template chunks", () => {
    const chunks = chunkSFCFile({
      source,
      filePath: "svelte.sample.svelte",
      framework: "svelte",
      minTokens: 1,
      maxTokens: 1000,
    });
    expect(chunks.some((c) => c.type?.startsWith("script"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("style"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("template"))).toBe(true);
  });
});

const definition: LanguageTestDefinition = {
  id: "svelte",
  parity: {
    sampleDir: "svelte",
    dependencyGraph: [
      {
        from: "inline-script.svelte",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "reactive.svelte",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "App.svelte",
        to: { type: "file", path: "Widget.svelte" },
      },
      {
        from: "App.svelte",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "TypeScriptWidget.svelte",
        to: { type: "file", path: "Widget.svelte" },
      },
      {
        from: "TypeScriptWidget.svelte",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "file", path: "logic.ts" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "file", path: "extra.ts" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "external", name: "https://cdn.example/svelte-helper.js" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "external", name: "./missing.ts" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "ExternalScripts.svelte",
        to: { type: "external", name: "" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "file", path: "missing.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it("deduplicates and filters Svelte external script src dependencies", async () => {
  const sampleDir = path.resolve(process.cwd(), "tests", "samples", "svelte");
  const sourceFile = path.join(sampleDir, "ExternalScripts.svelte").replace(/\\/g, "/");
  const logicFile = path.join(sampleDir, "logic.ts").replace(/\\/g, "/");
  const extraFile = path.join(sampleDir, "extra.ts").replace(/\\/g, "/");
  const graph = await collectGraph(sampleDir, [sourceFile, logicFile, extraFile]);

  expect(graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === logicFile))
    .toHaveLength(1);
  expect(graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === extraFile))
    .toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) =>
        edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "https://cdn.example/svelte-helper.js",
    ),
  ).toHaveLength(1);
  expect(
    graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "./missing.ts"),
  ).toHaveLength(1);
  expect(graph.edges.some((edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === ""))
    .toBe(false);
});
