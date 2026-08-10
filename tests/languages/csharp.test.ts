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
        expect(chunks.some((c) => c.type === "enum" && c.name === "MyEnum")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "csharp",
    dependencyGraph: [
      {
        from: "Main.cs",
        to: { type: "file", path: "Utils.cs" },
      },
      {
        from: "Main.cs",
        to: { type: "file", path: "Helpers.cs" },
      },
      {
        from: "AliasOnly.cs",
        to: { type: "file", path: "Utils.cs" },
      },
      {
        from: "NamespaceAlias.cs",
        to: { type: "external", name: "System.Collections.Generic" },
      },
    ],
    symbols: [
      {
        file: "AdvancedTypes.cs",
        includes: [
          { name: "IRunnable" },
          { name: "Toolbox" },
          { name: "NestedTool" },
          { name: "Execute" },
          { name: "Mode", kind: "type" },
          { name: "Fast", kind: "variable" },
          { name: "Slow", kind: "variable" },
        ],
      },
      {
        file: "RecordTypes.cs",
        includes: [
          { name: "ISized", kind: "interface" },
          { name: "Point", kind: "class" },
          { name: "NamedShape", kind: "class" },
        ],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves an is-pattern bound variable from its usage site",
        file: "PatternMatching.cs",
        line: 9,
        column: 42,
        expectedDefinition: { file: "PatternMatching.cs", line: 7 },
      },
    ],
  },
};

runLanguageTests(definition);
