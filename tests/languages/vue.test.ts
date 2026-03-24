import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";
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
        from: "TsScript.vue",
        to: { type: "file", path: "Child.vue" },
      },
      {
        from: "TsScript.vue",
        to: { type: "file", path: "logic.ts" },
      },
    ],
  },
};

runLanguageTests(definition);
