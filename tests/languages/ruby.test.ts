import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "ruby",
  samples: [
    {
      name: "chunks Ruby structures",
      sourceFile: "ruby.sample.rb",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "module" && c.name === "MyModule")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "my_method")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "ruby",
    dependencyGraph: [
      {
        from: "main.rb",
        to: { type: "file", path: "utils.rb" },
      },
      {
        from: "main.rb",
        to: { type: "file", path: "helpers.rb" },
      },
      {
        from: "consumer.rb",
        to: { type: "file", path: "namespaced.rb" },
      },
    ],
    symbols: [
      {
        file: "namespaced.rb",
        includes: [{ name: "Outer" }, { name: "Inner" }, { name: "Tool" }],
      },
    ],
  },
};

runLanguageTests(definition);
