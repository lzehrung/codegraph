import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "rust",
  samples: [
    {
      name: "chunks Rust structures",
      sourceFile: "rust.sample.rs",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "impl" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "function")).toBe(true);
        expect(chunks.some((c) => c.type === "module" && c.name === "my_mod")).toBe(true);
      },
    },
  ],
};

runLanguageTests(definition);

