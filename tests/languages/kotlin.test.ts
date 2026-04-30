import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "kotlin",
  samples: [
    {
      name: "chunks Kotlin structures",
      sourceFile: "kotlin.sample.kt",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "object" && c.name === "MyObject")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "topLevel")).toBe(true);
        expect(chunks.some((c) => c.type === "type" && c.name === "Alias")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "kotlin",
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
        includes: [
          { name: "Mode" },
          { name: "Fast" },
          { name: "Slow" },
          { name: "UserId" },
          { name: "topLevelValue" },
          { name: "Service" },
        ],
      },
      {
        file: "utils/MoreTypes.kt",
        includes: [{ name: "UtilityAlias" }, { name: "UtilityFactory" }, { name: "CompanionCarrier" }],
      },
      {
        file: "Objects.kt",
        includes: [{ name: "AppConfig" }, { name: "Builder" }],
      },
    ],
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
    references: [
      {
        name: "find references for wildcard-imported type alias",
        file: "utils/MoreTypes.kt",
        line: 3,
        column: 11,
        minimumCount: 2,
      },
      {
        name: "find references for wildcard-imported helper functions",
        file: "utils/helperFunction.kt",
        line: 3,
        column: 5,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
