import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";
import { collectGraph } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

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

  expect(graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === logicFile))
    .toHaveLength(1);
  expect(graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === extraFile))
    .toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "https://cdn.example/vue-helper.js",
    ),
  ).toHaveLength(1);
  expect(graph.edges.some((edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === ""))
    .toBe(false);
});
