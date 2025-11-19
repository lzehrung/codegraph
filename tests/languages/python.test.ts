import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "python",
  samples: [
    {
      name: "chunks Python with docstrings",
      sourceFile: "python.sample.py",
      expectedChunks: (chunks) => {
        // expect(chunks.some((c) => c.type === "docstring")).toBe(true);
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "module_var" && c.name === "CONFIG_PATH")).toBe(true);

        const classChunk = chunks.find((c) => c.type === "class" && c.name === "Foo");
        expect(classChunk).toBeDefined();

        const methodChunk = chunks.find((c) => c.type === "function" && c.name === "method");
        expect(methodChunk).toBeDefined(); // Method is inside class, but might be split if large enough or configured

        const topLevelFunc = chunks.find((c) => c.type === "function" && c.name === "top_level");
        expect(topLevelFunc).toBeDefined();

        // We expect only the top-level docstring to be a standalone chunk
        // Note: In the previous turn, we fixed the Python definition to only capture top-level docstrings.
        // However, the sample file has a top-level docstring.
        // Let's verify that we get exactly 1 docstring chunk.
        const docstringChunks = chunks.filter((c) => c.type === "docstring");
        expect(docstringChunks.length).toBe(1);
        expect(docstringChunks[0]?.text).toBe('"""Module docstring explaining the purpose of this file."""');
      },
    },
  ],
};

runLanguageTests(definition);
