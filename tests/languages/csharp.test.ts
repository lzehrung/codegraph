import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
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
      {
        from: "GlobalUsings.cs",
        to: { type: "external", name: "System.Text" },
      },
      {
        from: "GlobalUsings.cs",
        to: { type: "file", path: "Shared.cs" },
      },
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
      {
        name: "go to definition resolves a type through a global using namespace",
        file: "GlobalUsings.cs",
        line: 10,
        column: 9,
        expectedDefinition: { file: "Shared.cs", line: 3 },
      },
    references: [
      {
        name: "find references for an is-pattern bound variable includes its usage site",
        file: "PatternMatching.cs",
        line: 7,
        column: 29,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);

describe("C# global using directives", () => {
  it("keeps global, alias, and static forms as resolved import bindings", async () => {
    const sampleDir = path.resolve(process.cwd(), "tests", "samples", "csharp");
    const globalUsingFile = path.join(sampleDir, "GlobalUsings.cs");
    const sharedFile = path.join(sampleDir, "Shared.cs");
    const index = await createTestIndexFromFiles(sampleDir, [globalUsingFile, sharedFile]);
    const moduleEntry = [...index.byFile.values()].find(
      (entry) => fileIdentityKey(entry.file) === fileIdentityKey(globalUsingFile),
    );

    expect(moduleEntry).toBeDefined();
    if (!moduleEntry) return;

    const systemTextBinding = moduleEntry.imports.find(
      (binding) => binding.kind === "star" && binding.from === "System.Text",
    );
    expect(systemTextBinding).toBeDefined();
    expect(systemTextBinding?.resolved).toEqual({ external: "System.Text" });

    const sharedBindings = [
      moduleEntry.imports.find((binding) => binding.kind === "star" && binding.from === "Shared"),
      moduleEntry.imports.find(
        (binding) => binding.kind === "named" && binding.local === "TextBuilder" && binding.from === "Shared",
      ),
      moduleEntry.imports.find(
        (binding) => binding.kind === "star" && binding.from === "Shared.TextUtilities",
      ),
    ];
    for (const binding of sharedBindings) {
      expect(typeof binding?.resolved).toBe("string");
      if (typeof binding?.resolved !== "string") continue;
      expect(fileIdentityKey(binding.resolved)).toBe(fileIdentityKey(sharedFile));
    }
  });
});
