import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "css",
  samples: [
    {
      name: "chunks CSS rules",
      sourceFile: "css.sample.css",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
        expect(chunks.some((c) => c.type === "media")).toBe(true);
        expect(chunks.some((c) => c.type === "keyframes")).toBe(true);
      },
    },
  ],
};

runLanguageTests(definition);

