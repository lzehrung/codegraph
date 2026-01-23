import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "java",
  samples: [
    {
      name: "chunks Java structures",
      sourceFile: "java.sample.java",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "myMethod")).toBe(true);
        expect(chunks.some((c) => c.type === "interface" && c.name === "MyInterface")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "java",
    dependencyGraph: [
      {
        from: "static-imports.java",
        to: { type: "file", path: "utils/Utils.java" },
      },
      {
        from: "static-imports.java",
        to: { type: "file", path: "helpers/Helpers.java" },
      },
    ],
  },
};

runLanguageTests(definition);
