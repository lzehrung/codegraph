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
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "SampleMode")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "swift",
    dependencyGraph: [
      { from: "main.swift", to: { type: "file", path: "Utils.swift" } },
      { from: "main.swift", to: { type: "file", path: "Helpers.swift" } },
      { from: "AdvancedUsage.swift", to: { type: "file", path: "StaticMembers.swift" } },
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
      {
        file: "Extensions.swift",
        includes: [{ name: "makeDefault" }],
      },
      {
        file: "StaticMembers.swift",
        includes: [
          { name: "Status", kind: "type" },
          { name: "ready", kind: "variable" },
          { name: "done", kind: "variable" },
          { name: "UtilityFactory", kind: "class" },
          { name: "build" },
        ],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves UtilityFactory from imported static members file",
        file: "AdvancedUsage.swift",
        line: 4,
        column: 10,
        expectedDefinition: { file: "StaticMembers.swift", line: 6 },
      },
    ],
  },
};

runLanguageTests(definition);
