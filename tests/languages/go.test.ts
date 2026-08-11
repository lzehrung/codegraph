import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "go",
  samples: [
    {
      name: "chunks Go structures",
      sourceFile: "go.sample.go",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 7 },
        { type: "type", name: "MyStruct", startLine: 8, endLine: 11 },
        { type: "method", name: "Method", startLine: 12, endLine: 15 },
        { type: "function", name: "Function", startLine: 16, endLine: 19 },
      ],
    },
  ],
  parity: {
    sampleDir: "go",
    exact: {
      dependencyGraph: [
        {
          from: "aliased-imports.go",
          to: { type: "file", path: "helpers.go" },
        },
        {
          from: "aliased-imports.go",
          to: { type: "file", path: "utils.go" },
        },
        {
          from: "aliased-types.go",
          to: { type: "file", path: "helpers.go" },
        },
        {
          from: "aliased-types.go",
          to: { type: "file", path: "utils.go" },
        },
        {
          from: "dot-imports.go",
          to: { type: "file", path: "helpers.go" },
        },
        {
          from: "dot-imports.go",
          to: { type: "file", path: "utils.go" },
        },
        {
          from: "interfaces.go",
          to: { type: "file", path: "utils.go" },
        },
        {
          from: "main.go",
          to: { type: "file", path: "helpers.go" },
        },
        {
          from: "main.go",
          to: { type: "file", path: "utils.go" },
        },
        {
          from: "utils.go",
          to: { type: "file", path: "helpers.go" },
        },
      ],
      symbols: [
        {
          file: "contracts.go",
          symbols: [
            { name: "Runner", kind: "type" },
            { name: "Service", kind: "type" },
            { name: "Value", kind: "variable" },
            { name: "BuildService", kind: "function" },
            { name: "value", kind: "variable" },
          ],
        },
        {
          file: "utils.go",
          symbols: [
            { name: "HelperFunction", kind: "function" },
            { name: "UtilityClass", kind: "type" },
            { name: "value", kind: "variable" },
            { name: "NewUtilityClass", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "u", kind: "variable" },
            { name: "GetValue", kind: "function" },
            { name: "u", kind: "variable" },
            { name: "SetValue", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "ConstantValue", kind: "variable" },
            { name: "ReExportedHelper", kind: "function" },
          ],
        },
        {
          file: "interfaces.go",
          symbols: [
            { name: "ValueReader", kind: "type" },
            { name: "useValueReader", kind: "function" },
            { name: "input", kind: "variable" },
          ],
        },
        {
          file: "embedding.go",
          symbols: [
            { name: "EmbeddedInner", kind: "type" },
            { name: "Name", kind: "variable" },
            { name: "i", kind: "variable" },
            { name: "GetName", kind: "function" },
            { name: "EmbeddingOuter", kind: "type" },
            { name: "Extra", kind: "variable" },
            { name: "o", kind: "variable" },
            { name: "ValueReceiverMethod", kind: "function" },
            { name: "useEmbedding", kind: "function" },
            { name: "o", kind: "variable" },
          ],
        },
        {
          file: "aliased-types.go",
          symbols: [
            { name: "aliasTypeExample", kind: "function" },
            { name: "direct", kind: "variable" },
          ],
        },
        {
          file: "dot-imports.go",
          symbols: [
            { name: "dotImportExample", kind: "function" },
            { name: "instance", kind: "variable" },
          ],
        },
        {
          file: "helpers.go",
          symbols: [
            { name: "HelperFromHelpers", kind: "function" },
            { name: "AnotherHelper", kind: "function" },
          ],
        },
        {
          file: "main.go",
          symbols: [
            { name: "main", kind: "function" },
            { name: "u", kind: "variable" },
            { name: "direct", kind: "variable" },
            { name: "another", kind: "variable" },
          ],
        },
        {
          file: "aliased-imports.go",
          symbols: [{ name: "aliasExample", kind: "function" }],
        },
      ],
      references: [
        {
          name: "find references for an embedded struct field includes promoted use",
          file: "embedding.go",
          line: 4,
          column: 2,
          exactCount: 4,
        },
        {
          name: "find references for UtilityClass includes aliased type use",
          file: "utils.go",
          line: 9,
          column: 6,
          exactCount: 8,
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves aliased UtilityClass type",
        file: "aliased-types.go",
        line: 9,
        column: 24,
        expectedDefinition: { file: "utils.go", line: 9 },
      },
      {
        name: "go to definition resolves dot-imported constructor",
        file: "dot-imports.go",
        line: 9,
        column: 15,
        expectedDefinition: { file: "utils.go", line: 13 },
      },
      {
        name: "go to definition resolves a promoted method through struct embedding",
        file: "embedding.go",
        line: 23,
        column: 8,
        expectedDefinition: { file: "embedding.go", line: 7 },
      },
      {
        name: "go to definition resolves a value-receiver method",
        file: "embedding.go",
        line: 24,
        column: 11,
        expectedDefinition: { file: "embedding.go", line: 16 },
      },
      {
        name: "go to definition resolves a promoted struct field through embedding",
        file: "embedding.go",
        line: 22,
        column: 8,
        expectedDefinition: { file: "embedding.go", line: 4 },
      },
    ],
  },
};

runLanguageTests(definition);
