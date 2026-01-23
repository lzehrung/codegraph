import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "scss",
  samples: [
    {
      name: "chunks SCSS structures",
      sourceFile: "scss.sample.scss",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "rule")).toBe(true);
        expect(chunks.some((c) => c.type === "mixin")).toBe(true);
        expect(chunks.some((c) => c.type === "function")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "scss",
    dependencyGraph: [
      {
        from: "use-partials.scss",
        to: { type: "file", path: "_variables.scss" },
      },
      {
        from: "use-partials.scss",
        to: { type: "file", path: "_mixins.scss" },
      },
    ],
  },
};

runLanguageTests(definition);
