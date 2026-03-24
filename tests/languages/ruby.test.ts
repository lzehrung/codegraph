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
    goToDefinition: [
      {
        name: "go to definition resolves namespaced class use",
        file: "consumer.rb",
        line: 3,
        column: 22,
        expectedDefinition: { file: "namespaced.rb", line: 5 },
      },
    ],
    references: [
      {
        name: "find references for namespaced class",
        file: "namespaced.rb",
        line: 5,
        column: 11,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
