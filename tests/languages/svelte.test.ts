import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";
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
    ],
  },
};

runLanguageTests(definition);
