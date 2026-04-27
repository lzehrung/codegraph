import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "tsx",
  samples: [
    {
      name: "chunks basic TSX structures",
      sourceFile: "tsx.sample.tsx",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "Button")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "tsx",
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
    ],
  },
};

runLanguageTests(definition);
