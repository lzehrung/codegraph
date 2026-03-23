import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "swift",
  samples: [
    {
      name: "chunks Swift structures",
      sourceFile: "swift.sample.swift",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "protocol" && c.name === "MyProtocol")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "topLevel")).toBe(true);
        expect(chunks.some((c) => c.type === "type" && c.name === "Alias")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "swift",
    dependencyGraph: [
      { from: "main.swift", to: { type: "file", path: "Utils.swift" } },
      { from: "main.swift", to: { type: "file", path: "Helpers.swift" } },
    ],
    symbols: [
      {
        file: "Protocols.swift",
        includes: [
          { name: "Worker" },
          { name: "name" },
          { name: "act" },
          { name: "WorkerName" },
          { name: "WorkerImpl" },
        ],
      },
    ],
  },
};

runLanguageTests(definition);
