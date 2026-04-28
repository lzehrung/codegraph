import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "php",
  samples: [
    {
      name: "chunks PHP structures",
      sourceFile: "php.sample.php",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "namespace" && c.name === "App\\Core")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "UtilityClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "run")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "helper_function")).toBe(true);
        expect(chunks.some((c) => c.type === "const" && c.name === "APP_MODE")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "php",
    dependencyGraph: [
      { from: "main.php", to: { type: "file", path: "utils.php" } },
      { from: "main.php", to: { type: "file", path: "helpers.php" } },
      { from: "grouped-consumer.php", to: { type: "file", path: "helpers.php" } },
      { from: "grouped-consumer.php", to: { type: "file", path: "partials/shared.php" } },
      {
        from: "grouped-consumer.php",
        to: { type: "file", path: "src/Support/Toolbox.php" },
      },
      {
        from: "grouped-consumer.php",
        to: { type: "file", path: "src/Support/support_helper.php" },
      },
      {
        from: "grouped-consumer.php",
        to: { type: "file", path: "src/Support/DEFAULT_NAME.php" },
      },
      {
        from: "composer-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
    ],
    symbols: [
      {
        file: "utils.php",
        includes: [{ name: "UtilityClass" }, { name: "helper_function" }],
      },
      {
        file: "src/Domain/Service.php",
        includes: [{ name: "Service" }],
      },
      {
        file: "src/Support/Toolbox.php",
        includes: [{ name: "Toolbox" }],
      },
      {
        file: "src/Support/support_helper.php",
        includes: [{ name: "support_helper" }],
      },
      {
        file: "src/Support/DEFAULT_NAME.php",
        includes: [{ name: "DEFAULT_NAME" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves PHP use-imported class",
        file: "main.php",
        line: 10,
        column: 12,
        expectedDefinition: { file: "utils.php", line: 5 },
      },
      {
        name: "go to definition resolves PHP grouped use alias",
        file: "grouped-consumer.php",
        line: 8,
        column: 10,
        expectedDefinition: { file: "src/Support/Toolbox.php", line: 5 },
      },
      {
        name: "go to definition resolves PHP grouped function import",
        file: "grouped-consumer.php",
        line: 9,
        column: 12,
        expectedDefinition: { file: "src/Support/support_helper.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer-mapped class",
        file: "composer-consumer.php",
        line: 5,
        column: 16,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
    ],
    references: [
      {
        name: "find references for PHP helper class",
        file: "utils.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for PHP grouped use class alias",
        file: "src/Support/Toolbox.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for PHP grouped use function import",
        file: "src/Support/support_helper.php",
        line: 5,
        column: 10,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);
