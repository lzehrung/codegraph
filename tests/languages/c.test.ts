import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "c",
  samples: [
    {
      name: "chunks C structures",
      sourceFile: "c.sample.c",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "function" && c.name === "add")).toBe(true);
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "Status")).toBe(true);
        expect(chunks.some((c) => c.type === "macro" && c.name === "MAX_VALUE")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "c",
    dependencyGraph: [
      { from: "main.c", to: { type: "file", path: "utils.h" } },
      { from: "main.c", to: { type: "file", path: "helpers.h" } },
    ],
  },
};

runLanguageTests(definition);
