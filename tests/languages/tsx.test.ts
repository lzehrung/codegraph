import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "tsx",
  samples: [
    {
      name: "chunks basic TSX structures",
      sourceFile: "tsx.sample.tsx",
      exactChunks: [
        { type: "imports", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 3 },
        { type: "function", name: "Button", startLine: 3, endLine: 5 },
        { type: "jsx", startLine: 4, endLine: 4 },
        { type: "misc", startLine: 5, endLine: 9 },
        { type: "function", name: "Fragment", startLine: 9, endLine: 16 },
        { type: "jsx", startLine: 11, endLine: 14 },
        { type: "jsx", startLine: 12, endLine: 12 },
        { type: "jsx", startLine: 13, endLine: 13 },
        { type: "misc", startLine: 16, endLine: 16 },
      ],
    },
  ],
  parity: {
    sampleDir: "tsx",
    exact: {
      dependencyGraph: [
        {
          from: "App.tsx",
          to: { type: "file", path: "components/Button.tsx" },
        },
        {
          from: "App.tsx",
          to: { type: "file", path: "utils.ts" },
        },
        {
          from: "JsxImportApp.tsx",
          to: { type: "file", path: "components/Button.tsx" },
        },
        {
          from: "utils.ts",
          to: { type: "external", name: "lodash" },
        },
        {
          from: "reexport-barrel.tsx",
          to: { type: "file", path: "reexport-source.tsx" },
        },
        {
          from: "reexport-consumer.tsx",
          to: { type: "file", path: "reexport-barrel.tsx" },
        },
      ],
      goToDefinition: [
        {
          name: "resolves aliased TSX re-export",
          file: "reexport-consumer.tsx",
          line: 3,
          column: 25,
          expectedDefinition: { file: "reexport-source.tsx", line: 1 },
        },
        {
          name: "resolves star TSX re-export",
          file: "reexport-consumer.tsx",
          line: 4,
          column: 24,
          expectedDefinition: { file: "reexport-source.tsx", line: 2 },
        },
        {
          name: "resolves namespace TSX re-export",
          file: "reexport-consumer.tsx",
          line: 5,
          column: 45,
          expectedDefinition: { file: "reexport-source.tsx", line: 3 },
        },
      ],
      references: [
        {
          name: "finds aliased TSX re-export references",
          file: "reexport-source.tsx",
          line: 1,
          column: 14,
          references: [
            { file: "reexport-source.tsx", line: 1 },
            { file: "reexport-consumer.tsx", line: 1 },
            { file: "reexport-consumer.tsx", line: 3 },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);
