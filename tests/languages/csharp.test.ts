import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "csharp",
  samples: [
    {
      name: "chunks C# structures",
      sourceFile: "csharp.sample.cs",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "namespace" && c.name === "MyNamespace")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "MyMethod")).toBe(true);
        expect(chunks.some((c) => c.type === "interface" && c.name === "IMyInterface")).toBe(true);
      },
    },
  ],
};

runLanguageTests(definition);

