import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSymbols } from "../../src/index.js";
import { createTestIndex } from "../test-utils.js";
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
          typeOnly: true,
        },
        {
          from: "main.ts",
          to: { type: "file", path: "utils.ts" },
        },
        {
          from: "utils.ts",
          to: { type: "file", path: "helpers.ts" },
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
      references: [
        {
          name: "find references for UtilityClass resolves namespace and named import constructions",
          file: "utils.ts",
          line: 5,
          column: 14,
          references: [
            { file: "main.ts", line: 8 },
            { file: "main.ts", line: 12 },
            { file: "utils.ts", line: 5 },
          ],
        },
        {
          name: "find references for UtilityClass.getValue resolves through the receiver",
          file: "utils.ts",
          line: 12,
          column: 3,
          references: [
            { file: "main.ts", line: 13 },
            { file: "utils.ts", line: 12 },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);

describe("TypeScript symbol extraction", () => {
  it("extracts type aliases with the type kind", async () => {
    const index = await createTestIndex("typescript");
    const file = path.resolve(process.cwd(), "tests", "samples", "typescript", "utils.ts");
    const utilityType = listSymbols(index, { file }).find((symbol) => symbol.name === "UtilityType");

    expect(utilityType).toMatchObject({ name: "UtilityType", kind: "type" });
  });
});
