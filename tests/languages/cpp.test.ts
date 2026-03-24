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
      { from: "namespace-usage.cpp", to: { type: "file", path: "namespaces.hpp" } },
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
      {
        file: "namespaces.hpp",
        includes: [{ name: "toolkit" }, { name: "Widget" }, { name: "buildWidget" }],
      },
      {
        file: "templates.hpp",
        includes: [{ name: "Holder" }, { name: "compute" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves namespace-qualified Widget alias target",
        file: "namespace-usage.cpp",
        line: 4,
        column: 12,
        expectedDefinition: { file: "namespaces.hpp", line: 4 },
      },
    ],
    references: [
      {
        name: "find references for Widget includes namespace alias usage",
        file: "namespaces.hpp",
        line: 4,
        column: 7,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
