import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "kotlin",
  samples: [
    {
      name: "chunks Kotlin structures",
      sourceFile: "kotlin.sample.kt",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "object" && c.name === "MyObject")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "topLevel")).toBe(true);
        expect(chunks.some((c) => c.type === "type" && c.name === "Alias")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "kotlin",
    dependencyGraph: [
      { from: "main.kt", to: { type: "file", path: "utils/helperFunction.kt" } },
      {
        from: "main.kt",
        to: { type: "file", path: "helpers/helperFromHelpers.kt" },
      },
    ],
    symbols: [
      {
        file: "Models.kt",
        includes: [
          { name: "Mode" },
          { name: "Fast" },
          { name: "Slow" },
          { name: "UserId" },
          { name: "topLevelValue" },
          { name: "Service" },
        ],
      },
    ],
  },
};

runLanguageTests(definition);
