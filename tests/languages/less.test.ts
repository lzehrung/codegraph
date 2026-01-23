import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "less",
  samples: [
    {
      name: "chunks LESS structures",
      sourceFile: "less.sample.less",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "less",
    dependencyGraph: [
      {
        from: "main.less",
        to: { type: "file", path: "variables.less" },
      },
      {
        from: "main.less",
        to: { type: "file", path: "theme.less" },
      },
    ],
  },
};

runLanguageTests(definition);
