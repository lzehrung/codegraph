import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunkSFC.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string) =>
  fs.readFileSync(path.join(dirname, "samples", name), "utf8");

describe("chunkSFCFile", () => {
  it("chunks Vue single-file components across template/script/style blocks", async () => {
    const chunks = await chunkSFCFile({
      source: sample("vue.sample.vue"),
      filePath: "Component.vue",
      framework: "vue",
      minTokens: 1,
      maxTokens: 50,
    });
    expect(chunks.some((c) => c.type.startsWith("template"))).toBe(true);
    expect(chunks.some((c) => c.type.startsWith("script"))).toBe(true);
    expect(chunks.some((c) => c.type.startsWith("style"))).toBe(true);
  });

  it("chunks Svelte components with script and template segments", async () => {
    const chunks = await chunkSFCFile({
      source: sample("svelte.sample.svelte"),
      filePath: "Component.svelte",
      framework: "svelte",
      minTokens: 1,
      maxTokens: 50,
    });
    expect(chunks.some((c) => c.type.startsWith("script"))).toBe(true);
    expect(chunks.some((c) => c.type.startsWith("template"))).toBe(true);
  });
});
