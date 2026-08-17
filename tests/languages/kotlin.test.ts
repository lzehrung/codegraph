import { describe, it } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicodeSymbolRange.js";

const definition: LanguageTestDefinition = {
  id: "kotlin",
  samples: [
    {
      name: "chunks Kotlin structures",
      sourceFile: "kotlin.sample.kt",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 5 },
        { type: "class", name: "MyClass", startLine: 6, endLine: 10 },
        { type: "function", name: "method", startLine: 7, endLine: 9 },
        { type: "misc", startLine: 10, endLine: 11 },
        { type: "object", name: "MyObject", startLine: 12, endLine: 14 },
        { type: "function", name: "run", startLine: 13, endLine: 13 },
        { type: "misc", startLine: 14, endLine: 15 },
        { type: "class", name: "MyInterface", startLine: 16, endLine: 18 },
        { type: "function", name: "act", startLine: 17, endLine: 17 },
        { type: "misc", startLine: 18, endLine: 19 },
        { type: "function", name: "topLevel", startLine: 20, endLine: 21 },
        { type: "property", name: "topValue", startLine: 22, endLine: 23 },
        { type: "type", name: "Alias", startLine: 24, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "kotlin",
    exact: {
      dependencyGraph: [
        { from: "main.kt", to: { type: "file", path: "utils/helperFunction.kt" } },
        {
          from: "main.kt",
          to: { type: "file", path: "helpers/helperFromHelpers.kt" },
        },
        {
          from: "Aliases.kt",
          to: { type: "file", path: "utils/helperFunction.kt" },
        },
        {
          from: "TypeConsumers.kt",
          to: { type: "file", path: "utils/helperFunction.kt" },
        },
        {
          from: "TypeConsumers.kt",
          to: { type: "file", path: "utils/MoreTypes.kt" },
        },
      ],
      symbols: [
        {
          file: "Models.kt",
          symbols: [
            { name: "Mode", kind: "class" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "UserId", kind: "type" },
            { name: "topLevelValue", kind: "variable" },
            { name: "Service", kind: "class" },
            { name: "T", kind: "variable" },
            { name: "value", kind: "variable" },
          ],
        },
        {
          file: "utils/MoreTypes.kt",
          symbols: [
            { name: "UtilityAlias", kind: "type" },
            { name: "UtilityFactory", kind: "class" },
            { name: "create", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "CompanionCarrier", kind: "class" },
            { name: "build", kind: "function" },
            { name: "value", kind: "variable" },
          ],
        },
        {
          file: "Objects.kt",
          symbols: [
            { name: "AppConfig", kind: "class" },
            { name: "name", kind: "variable" },
            { name: "Builder", kind: "class" },
            { name: "create", kind: "function" },
          ],
        },
      ],
      references: [
        {
          name: "find references for wildcard-imported type alias",
          file: "utils/MoreTypes.kt",
          line: 3,
          column: 11,
          references: [
            { file: "utils/MoreTypes.kt", line: 3 },
            { file: "TypeConsumers.kt", line: 3 },
          ],
        },
        {
          name: "find references for wildcard-imported helper functions",
          file: "utils/helperFunction.kt",
          line: 3,
          column: 5,
          references: [
            { file: "utils/helperFunction.kt", line: 3 },
            { file: "main.kt", line: 1 },
            { file: "main.kt", line: 6 },
            { file: "TypeConsumers.kt", line: 12 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves aliased UtilityClass import",
        file: "Aliases.kt",
        line: 3,
        column: 24,
        expectedDefinition: { file: "utils/helperFunction.kt", line: 7 },
      },
      {
        name: "go to definition resolves wildcard-imported type alias",
        file: "TypeConsumers.kt",
        line: 3,
        column: 21,
        expectedDefinition: { file: "utils/MoreTypes.kt", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported helper functions",
        file: "TypeConsumers.kt",
        line: 12,
        column: 10,
        expectedDefinition: { file: "utils/helperFunction.kt", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Kotlin Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.kt",
      source: "// café ☕ prüfung\n/* über */ fun créer(): Int {\n\treturn 1\n}\n",
      symbolName: "créer",
    });
  });
});
