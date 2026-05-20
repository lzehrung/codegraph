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
      { from: "dir-include-consumer.php", to: { type: "file", path: "helpers.php" } },
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
      {
        from: "composer-qualified-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
      {
        from: "composer-static-qualified-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
      {
        from: "composer-static-constant-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
      {
        from: "composer-static-property-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
      {
        from: "composer-type-qualified-consumer.php",
        to: { type: "file", path: "src/Domain/Service.php" },
      },
      {
        from: "composer-psr0-consumer.php",
        to: { type: "file", path: "legacy/Tools/Box.php" },
      },
      {
        from: "composer-dev-psr4-consumer.php",
        to: { type: "file", path: "dev-src/Tool.php" },
      },
      {
        from: "composer-dev-psr0-consumer.php",
        to: { type: "file", path: "dev-legacy/Tools/Box.php" },
      },
      {
        from: "composer-classmap-consumer.php",
        to: { type: "file", path: "classmap/Specific.php" },
      },
      {
        from: "composer-dev-classmap-consumer.php",
        to: { type: "file", path: "dev-classmap/DevSpecific.php" },
      },
      {
        from: "composer-files-consumer.php",
        to: { type: "file", path: "autoload/global_helper.php" },
      },
      {
        from: "composer-files-consumer.php",
        to: { type: "file", path: "autoload/dev_helper.php" },
      },
      {
        from: "function-import-consumer.php",
        to: { type: "file", path: "src/Collision/ThingFunction.php" },
      },
      {
        from: "bracketed-consumer.php",
        to: { type: "file", path: "multi-namespace/Library.php" },
      },
      {
        from: "bracketed-qualified-consumer.php",
        to: { type: "file", path: "multi-namespace/Library.php" },
      },
    ],
    absentDependencyGraph: [
      {
        from: "composer-excluded-classmap-consumer.php",
        to: { type: "file", path: "classmap/Excluded/Hidden.php" },
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
      {
        file: "src/Collision/Thing.php",
        includes: [{ name: "Thing" }],
      },
      {
        file: "src/Collision/ThingFunction.php",
        includes: [{ name: "Thing" }],
      },
      {
        file: "legacy/Tools/Box.php",
        includes: [{ name: "Tools_Box" }],
      },
      {
        file: "dev-src/Tool.php",
        includes: [{ name: "Tool" }],
      },
      {
        file: "dev-legacy/Tools/Box.php",
        includes: [{ name: "Tools_Box" }],
      },
      {
        file: "classmap/Specific.php",
        includes: [{ name: "Specific" }],
      },
      {
        file: "dev-classmap/DevSpecific.php",
        includes: [{ name: "DevSpecific" }],
      },
      {
        file: "autoload/global_helper.php",
        includes: [{ name: "global_helper" }],
      },
      {
        file: "autoload/dev_helper.php",
        includes: [{ name: "dev_helper" }],
      },
      {
        file: "multi-namespace/Library.php",
        includes: [{ name: "FirstService" }, { name: "SecondService" }],
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
      {
        name: "go to definition resolves PHP __DIR__ includes",
        file: "dir-include-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "helpers.php", line: 3 },
      },
      {
        name: "go to definition resolves Composer-mapped fully-qualified PHP classes",
        file: "composer-qualified-consumer.php",
        line: 3,
        column: 27,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer-mapped fully-qualified PHP static class references",
        file: "composer-static-qualified-consumer.php",
        line: 3,
        column: 23,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer-mapped fully-qualified PHP static constant references",
        file: "composer-static-constant-consumer.php",
        line: 3,
        column: 23,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer-mapped fully-qualified PHP static property references",
        file: "composer-static-property-consumer.php",
        line: 3,
        column: 25,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer-mapped fully-qualified PHP type references",
        file: "composer-type-qualified-consumer.php",
        line: 3,
        column: 37,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer PSR-0 classes",
        file: "composer-psr0-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "legacy/Tools/Box.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer autoload-dev PSR-4 classes",
        file: "composer-dev-psr4-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "dev-src/Tool.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer autoload-dev PSR-0 classes",
        file: "composer-dev-psr0-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "dev-legacy/Tools/Box.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer classmap classes",
        file: "composer-classmap-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "classmap/Specific.php", line: 5 },
      },
      {
        name: "go to definition resolves Composer autoload-dev classmap classes",
        file: "composer-dev-classmap-consumer.php",
        line: 5,
        column: 6,
        expectedDefinition: { file: "dev-classmap/DevSpecific.php", line: 5 },
      },
      {
        name: "go to definition skips Composer excluded classmap classes",
        file: "composer-excluded-classmap-consumer.php",
        line: 5,
        column: 6,
        expectedStatus: "not_found",
      },
      {
        name: "go to definition resolves Composer files autoload functions",
        file: "composer-files-consumer.php",
        line: 3,
        column: 3,
        expectedDefinition: { file: "autoload/global_helper.php", line: 3 },
      },
      {
        name: "go to definition resolves Composer autoload-dev files functions",
        file: "composer-files-consumer.php",
        line: 4,
        column: 3,
        expectedDefinition: { file: "autoload/dev_helper.php", line: 3 },
      },
      {
        name: "go to definition respects PHP function import kind",
        file: "function-import-consumer.php",
        line: 5,
        column: 10,
        expectedDefinition: { file: "src/Collision/ThingFunction.php", line: 5 },
      },
      {
        name: "go to definition resolves PHP imports from bracketed namespace blocks",
        file: "bracketed-consumer.php",
        line: 5,
        column: 17,
        expectedDefinition: { file: "multi-namespace/Library.php", line: 8 },
      },
      {
        name: "go to definition resolves fully-qualified PHP references from later namespace blocks",
        file: "bracketed-qualified-consumer.php",
        line: 3,
        column: 29,
        expectedDefinition: { file: "multi-namespace/Library.php", line: 8 },
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
      {
        name: "find references for PHP function imports with colliding class names",
        file: "src/Collision/ThingFunction.php",
        line: 5,
        column: 10,
        minimumCount: 2,
      },
      {
        name: "find references for Composer-mapped fully-qualified PHP classes",
        file: "src/Domain/Service.php",
        line: 5,
        column: 7,
        minimumCount: 7,
      },
      {
        name: "find references for Composer PSR-0 classes",
        file: "legacy/Tools/Box.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for Composer autoload-dev PSR-4 classes",
        file: "dev-src/Tool.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for Composer autoload-dev PSR-0 classes",
        file: "dev-legacy/Tools/Box.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for Composer classmap classes",
        file: "classmap/Specific.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for Composer autoload-dev classmap classes",
        file: "dev-classmap/DevSpecific.php",
        line: 5,
        column: 7,
        minimumCount: 2,
      },
      {
        name: "find references for Composer files autoload functions",
        file: "autoload/global_helper.php",
        line: 3,
        column: 10,
        minimumCount: 2,
      },
      {
        name: "find references for Composer autoload-dev files functions",
        file: "autoload/dev_helper.php",
        line: 3,
        column: 10,
        minimumCount: 2,
      },
      {
        name: "find references for PHP classes from bracketed namespace blocks",
        file: "multi-namespace/Library.php",
        line: 8,
        column: 11,
        minimumCount: 3,
      },
    ],
  },
};

runLanguageTests(definition);
