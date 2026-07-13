import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "typescript",
  samples: [
    {
      name: "chunks basic TypeScript structures",
      sourceFile: "typescript.sample.ts",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "interface" && c.name === "User")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "Role")).toBe(true);
        expect(chunks.some((c) => c.type === "type_alias" && c.name === "UserId")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "Service")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "helper")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "typescript",
    dependencyGraph: [
      {
        from: "dynamic-import.ts",
        to: { type: "file", path: "helpers.ts" },
      },
    ],
    symbols: [
      {
        file: "abstract-implementation.ts",
        includes: [
          { name: "AbstractJob", kind: "class" },
          { name: "execute", kind: "function" },
          { name: "ConcreteJob", kind: "class" },
        ],
      },
    ],
  },
};

runLanguageTests(definition);
