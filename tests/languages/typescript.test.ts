import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "typescript",
  samples: [
    {
      name: "chunks basic TypeScript structures",
      sourceFile: "typescript.sample.ts",
      exactChunks: [
        { type: "imports", startLine: 1, endLine: 2 },
        { type: "interface", name: "User", startLine: 3, endLine: 7 },
        { type: "enum", name: "Role", startLine: 8, endLine: 12 },
        { type: "type_alias", name: "UserId", startLine: 13, endLine: 14 },
        { type: "class", name: "Service", startLine: 15, endLine: 21 },
        { type: "method", name: "constructor", startLine: 16, endLine: 16 },
        { type: "method", name: "getRole", startLine: 18, endLine: 20 },
        { type: "misc", startLine: 21, endLine: 22 },
        { type: "function", name: "helper", startLine: 23, endLine: 25 },
      ],
    },
  ],
  parity: {
    sampleDir: "typescript",
    exact: {
      dependencyGraph: [
        {
          from: "dynamic-import.ts",
          to: { type: "file", path: "helpers.ts" },
        },
        {
          from: "triple-slash-reference.ts",
          to: { type: "file", path: "triple-slash-globals.d.ts" },
        },
      ],
      symbols: [
        {
          file: "abstract-implementation.ts",
          symbols: [
            { name: "AbstractJob", kind: "class" },
            { name: "ConcreteJob", kind: "class" },
            { name: "execute", kind: "function" },
            { name: "execute", kind: "function" },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);
