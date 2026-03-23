import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "cpp",
  samples: [
    {
      name: "chunks C++ structures",
      sourceFile: "cpp.sample.cpp",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "add")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "cpp",
    dependencyGraph: [
      { from: "main.cpp", to: { type: "file", path: "utils.hpp" } },
      { from: "main.cpp", to: { type: "file", path: "helpers.hpp" } },
    ],
    symbols: [
      {
        file: "advanced.hpp",
        includes: [
          { name: "demo" },
          { name: "Mode" },
          { name: "Count" },
          { name: "Engine" },
          { name: "combine" },
        ],
      },
    ],
  },
};

runLanguageTests(definition);
