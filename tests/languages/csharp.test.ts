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
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 3 },
        { type: "namespace", name: "MyNamespace", startLine: 4, endLine: 19 },
        { type: "class", name: "MyClass", startLine: 5, endLine: 9 },
        { type: "method", name: "MyMethod", startLine: 6, endLine: 8 },
        { type: "interface", name: "IMyInterface", startLine: 11, endLine: 13 },
        { type: "method", name: "InterfaceMethod", startLine: 12, endLine: 12 },
        { type: "enum", name: "MyEnum", startLine: 15, endLine: 18 },
        { type: "misc", startLine: 19, endLine: 20 },
      ],
    },
  ],
  parity: {
    sampleDir: "csharp",
    exact: {
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
        {
          from: "GlobalUsings.cs",
          to: { type: "external", name: "System.Text" },
        },
        {
          from: "GlobalUsings.cs",
          to: { type: "file", path: "Shared.cs" },
        },
      ],
      symbols: [
        {
          file: "AdvancedTypes.cs",
          symbols: [
            { name: "IRunnable", kind: "interface" },
            { name: "Run", kind: "function" },
            { name: "Toolbox", kind: "class" },
            { name: "NestedTool", kind: "class" },
            { name: "Execute", kind: "function" },
            { name: "Mode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
          ],
        },
        {
          file: "RecordTypes.cs",
          symbols: [
            { name: "ISized", kind: "interface" },
            { name: "Point", kind: "class" },
            { name: "NamedShape", kind: "class" },
          ],
        },
      ],
      references: [
        {
          name: "find references for an is-pattern bound variable includes its usage site",
          file: "PatternMatching.cs",
          line: 7,
          column: 29,
          exactCount: 2,
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves an is-pattern bound variable from its usage site",
        file: "PatternMatching.cs",
        line: 9,
        column: 42,
        expectedDefinition: { file: "PatternMatching.cs", line: 7 },
      },
      {
        name: "go to definition resolves a type through a global using namespace",
        file: "GlobalUsings.cs",
        line: 10,
        column: 9,
        expectedDefinition: { file: "Shared.cs", line: 3 },
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
      moduleEntry.imports.find((binding) => binding.kind === "star" && binding.from === "Shared.TextUtilities"),
    ];
    for (const binding of sharedBindings) {
      expect(typeof binding?.resolved).toBe("string");
      if (typeof binding?.resolved !== "string") continue;
      expect(fileIdentityKey(binding.resolved)).toBe(fileIdentityKey(sharedFile));
    }
  });
});
