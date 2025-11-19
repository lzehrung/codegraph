import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "javascript",
  samples: [
    {
      name: "chunks basic JavaScript structures",
      sourceFile: "javascript.sample.js",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "module_var" && c.name === "API_BASE_URL")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "Foo")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "bar")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "baz")).toBe(true);
      },
    },
  ],
};

runLanguageTests(definition);
