import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { buildSymbolGraph, defNodeId } from "../../src/graphs/symbol-graph.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../../src/index.js";
import { findCallHierarchy } from "../../src/indexer/call-hierarchy.js";
import { findReferencesById, goToDefinitionById, listSymbols } from "../../src/indexer/symbols.js";
import { findImplementations } from "../../src/indexer/type-hierarchy.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

const definition: LanguageTestDefinition = {
  id: "php",
  samples: [
    {
      name: "chunks PHP structures",
      sourceFile: "php.sample.php",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "namespace", name: "App\\Core", startLine: 3, endLine: 4 },
        { type: "const", name: "APP_MODE", startLine: 5, endLine: 6 },
        { type: "enum", name: "AppMode", startLine: 7, endLine: 12 },
        { type: "class", name: "UtilityClass", startLine: 13, endLine: 19 },
        { type: "method", name: "run", startLine: 15, endLine: 18 },
        { type: "misc", startLine: 19, endLine: 20 },
        { type: "function", name: "helper_function", startLine: 21, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "php",
    exact: {
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
          from: "composer-excluded-psr4-consumer.php",
          to: { type: "file", path: "classmap/Excluded/PsrMapped.php" },
        },
        {
          from: "composer-excluded-psr4-consumer.php",
          to: { type: "file", path: "classmap/Excluded/psr_helper.php" },
        },
        {
          from: "composer-excluded-classmap-consumer.php",
          to: { type: "external", name: "ClassMap\\Excluded\\Hidden" },
        },
        {
          from: "main.php",
          to: { type: "external", name: "App\\Utils\\UtilityClass" },
        },
        {
          from: "main.php",
          to: { type: "external", name: "App\\Utils\\helper_function" },
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
        {
          from: "src/Collision/unicode_consumer.php",
          to: { type: "file", path: "src/Collision/unicode_def.php" },
        },
      ],
      references: [
        {
          name: "find references for PHP helper class",
          file: "utils.php",
          line: 5,
          column: 7,
          references: [
            { file: "utils.php", line: 5 },
            { file: "main.php", line: 6 },
            { file: "main.php", line: 10 },
          ],
        },
        {
          name: "find references for PHP grouped use class alias",
          file: "src/Support/Toolbox.php",
          line: 5,
          column: 7,
          references: [
            { file: "src/Support/Toolbox.php", line: 5 },
            { file: "grouped-consumer.php", line: 6 },
            { file: "grouped-consumer.php", line: 8 },
          ],
        },
        {
          name: "find references for PHP grouped use function import",
          file: "src/Support/support_helper.php",
          line: 5,
          column: 10,
          references: [
            { file: "src/Support/support_helper.php", line: 5 },
            { file: "grouped-consumer.php", line: 6 },
            { file: "grouped-consumer.php", line: 9 },
          ],
        },
        {
          name: "find references for PHP function imports with colliding class names",
          file: "src/Collision/ThingFunction.php",
          line: 5,
          column: 10,
          references: [
            { file: "src/Collision/ThingFunction.php", line: 5 },
            { file: "function-import-consumer.php", line: 3 },
            { file: "function-import-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for Composer-mapped fully-qualified PHP classes",
          file: "src/Domain/Service.php",
          line: 5,
          column: 7,
          references: [
            { file: "src/Domain/Service.php", line: 5 },
            { file: "composer-consumer.php", line: 3 },
            { file: "composer-consumer.php", line: 5 },
            { file: "composer-qualified-consumer.php", line: 3 },
            { file: "composer-static-qualified-consumer.php", line: 3 },
            { file: "composer-static-constant-consumer.php", line: 3 },
            { file: "composer-static-property-consumer.php", line: 3 },
            { file: "composer-type-qualified-consumer.php", line: 3 },
          ],
        },
        {
          name: "find references for Composer PSR-0 classes",
          file: "legacy/Tools/Box.php",
          line: 5,
          column: 7,
          references: [
            { file: "legacy/Tools/Box.php", line: 5 },
            { file: "composer-psr0-consumer.php", line: 3 },
            { file: "composer-psr0-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for Composer autoload-dev PSR-4 classes",
          file: "dev-src/Tool.php",
          line: 5,
          column: 7,
          references: [
            { file: "dev-src/Tool.php", line: 5 },
            { file: "composer-dev-psr4-consumer.php", line: 3 },
            { file: "composer-dev-psr4-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for Composer autoload-dev PSR-0 classes",
          file: "dev-legacy/Tools/Box.php",
          line: 5,
          column: 7,
          references: [
            { file: "dev-legacy/Tools/Box.php", line: 5 },
            { file: "composer-dev-psr0-consumer.php", line: 3 },
            { file: "composer-dev-psr0-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for Composer classmap classes",
          file: "classmap/Specific.php",
          line: 5,
          column: 7,
          references: [
            { file: "classmap/Specific.php", line: 5 },
            { file: "composer-classmap-consumer.php", line: 3 },
            { file: "composer-classmap-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for Composer autoload-dev classmap classes",
          file: "dev-classmap/DevSpecific.php",
          line: 5,
          column: 7,
          references: [
            { file: "dev-classmap/DevSpecific.php", line: 5 },
            { file: "composer-dev-classmap-consumer.php", line: 3 },
            { file: "composer-dev-classmap-consumer.php", line: 5 },
          ],
        },
        {
          name: "find references for PSR-4 classes inside Composer excluded classmap paths",
          file: "classmap/Excluded/PsrMapped.php",
          line: 5,
          column: 7,
          references: [
            { file: "classmap/Excluded/PsrMapped.php", line: 5 },
            { file: "composer-excluded-psr4-consumer.php", line: 3 },
            { file: "composer-excluded-psr4-consumer.php", line: 6 },
          ],
        },
        {
          name: "find references for PSR-4 functions inside Composer excluded classmap paths",
          file: "classmap/Excluded/psr_helper.php",
          line: 5,
          column: 10,
          references: [
            { file: "classmap/Excluded/psr_helper.php", line: 5 },
            { file: "composer-excluded-psr4-consumer.php", line: 4 },
            { file: "composer-excluded-psr4-consumer.php", line: 7 },
          ],
        },
        {
          name: "find references for Composer files autoload functions",
          file: "autoload/global_helper.php",
          line: 3,
          column: 10,
          references: [
            { file: "autoload/global_helper.php", line: 3 },
            { file: "composer-files-consumer.php", line: 3 },
          ],
        },
        {
          name: "find references for Composer autoload-dev files functions",
          file: "autoload/dev_helper.php",
          line: 3,
          column: 10,
          references: [
            { file: "autoload/dev_helper.php", line: 3 },
            { file: "composer-files-consumer.php", line: 4 },
          ],
        },
        {
          name: "find references for Composer files inside excluded classmap paths",
          file: "classmap/Excluded/excluded_helper.php",
          line: 3,
          column: 10,
          references: [
            { file: "classmap/Excluded/excluded_helper.php", line: 3 },
            { file: "composer-excluded-files-consumer.php", line: 3 },
          ],
        },
        {
          name: "find references for PHP classes from bracketed namespace blocks",
          file: "multi-namespace/Library.php",
          line: 8,
          column: 11,
          references: [
            { file: "multi-namespace/Library.php", line: 8 },
            { file: "bracketed-consumer.php", line: 3 },
            { file: "bracketed-consumer.php", line: 5 },
            { file: "bracketed-qualified-consumer.php", line: 3 },
          ],
        },
      ],
      symbols: [
        {
          file: "utils.php",
          symbols: [
            { name: "UtilityClass", kind: "class" },
            { name: "create", kind: "function" },
            { name: "UtilityMode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "helper_function", kind: "function" },
          ],
        },
        {
          file: "src/Domain/Service.php",
          symbols: [
            { name: "Service", kind: "class" },
            { name: "NAME", kind: "variable" },
            { name: "$shared", kind: "variable" },
            { name: "make", kind: "function" },
            { name: "fromQualified", kind: "function" },
            { name: "run", kind: "function" },
          ],
        },
        {
          file: "src/Support/Toolbox.php",
          symbols: [
            { name: "Toolbox", kind: "class" },
            { name: "make", kind: "function" },
          ],
        },
        { file: "src/Support/support_helper.php", symbols: [{ name: "support_helper", kind: "function" }] },
        { file: "src/Support/DEFAULT_NAME.php", symbols: [{ name: "DEFAULT_NAME", kind: "variable" }] },
        { file: "src/Collision/Thing.php", symbols: [{ name: "Thing", kind: "class" }] },
        { file: "src/Collision/ThingFunction.php", symbols: [{ name: "Thing", kind: "function" }] },
        { file: "legacy/Tools/Box.php", symbols: [{ name: "Tools_Box", kind: "class" }] },
        { file: "dev-src/Tool.php", symbols: [{ name: "Tool", kind: "class" }] },
        { file: "dev-legacy/Tools/Box.php", symbols: [{ name: "Tools_Box", kind: "class" }] },
        { file: "classmap/Specific.php", symbols: [{ name: "Specific", kind: "class" }] },
        { file: "dev-classmap/DevSpecific.php", symbols: [{ name: "DevSpecific", kind: "class" }] },
        { file: "classmap/Excluded/PsrMapped.php", symbols: [{ name: "PsrMapped", kind: "class" }] },
        { file: "classmap/Excluded/psr_helper.php", symbols: [{ name: "psr_helper", kind: "function" }] },
        { file: "autoload/global_helper.php", symbols: [{ name: "global_helper", kind: "function" }] },
        { file: "autoload/dev_helper.php", symbols: [{ name: "dev_helper", kind: "function" }] },
        {
          file: "classmap/Excluded/excluded_helper.php",
          symbols: [{ name: "excluded_helper", kind: "function" }],
        },
        {
          file: "multi-namespace/Library.php",
          symbols: [
            { name: "FirstService", kind: "class" },
            { name: "SecondService", kind: "class" },
          ],
        },
        {
          file: "EnumImplementation.php",
          symbols: [
            { name: "EnumContract", kind: "interface" },
            { name: "label", kind: "function" },
            { name: "EnumStatus", kind: "type" },
            { name: "Ready", kind: "variable" },
            { name: "label", kind: "function" },
          ],
        },
        {
          file: "properties.php",
          symbols: [
            { name: "PropertyHolder", kind: "class" },
            { name: "$count", kind: "variable" },
            { name: "$label", kind: "variable" },
            { name: "$shared", kind: "variable" },
            { name: "read", kind: "function" },
          ],
        },
      ],
    },
    absentDependencyGraph: [
      {
        from: "composer-excluded-classmap-consumer.php",
        to: { type: "file", path: "classmap/Excluded/Hidden.php" },
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
        name: "go to definition resolves the Composer-mapped class used for static property access",
        file: "composer-static-property-consumer.php",
        line: 3,
        column: 25,
        expectedDefinition: { file: "src/Domain/Service.php", line: 5 },
      },
      {
        name: "go to definition resolves typed PHP properties",
        file: "properties.php",
        line: 11,
        column: 23,
        expectedDefinition: { file: "properties.php", line: 5 },
      },
      {
        name: "go to definition resolves untyped PHP properties",
        file: "properties.php",
        line: 11,
        column: 38,
        expectedDefinition: { file: "properties.php", line: 6 },
      },
      {
        name: "go to definition resolves static PHP properties",
        file: "properties.php",
        line: 11,
        column: 53,
        expectedDefinition: { file: "properties.php", line: 7 },
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
        name: "go to definition resolves PSR-4 classes inside Composer excluded classmap paths",
        file: "composer-excluded-psr4-consumer.php",
        line: 6,
        column: 6,
        expectedDefinition: { file: "classmap/Excluded/PsrMapped.php", line: 5 },
      },
      {
        name: "go to definition resolves PSR-4 functions inside Composer excluded classmap paths",
        file: "composer-excluded-psr4-consumer.php",
        line: 7,
        column: 3,
        expectedDefinition: { file: "classmap/Excluded/psr_helper.php", line: 5 },
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
        name: "go to definition resolves Composer files inside excluded classmap paths",
        file: "composer-excluded-files-consumer.php",
        line: 3,
        column: 3,
        expectedDefinition: { file: "classmap/Excluded/excluded_helper.php", line: 3 },
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
  },
};

runLanguageTests(definition);

describe("PHP import symbol namespaces", () => {
  it("resolves each same-spelled alias declaration by its import role", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-alias-role-declarations-"));
    const sourceFile = path.join(root, "source.php");
    const consumerFile = path.join(root, "consumer.php");
    const source = [
      "<?php",
      "namespace App;",
      "class Service {}",
      "function helper() { return 1; }",
      "const TOKEN = 1;",
      "",
    ].join("\n");
    const consumerLines = [
      "<?php",
      "namespace Client;",
      "use App\\Service as Alias;",
      "use function App\\helper as Alias;",
      "use const App\\TOKEN as Alias;",
      "",
    ];

    try {
      await writeFile(sourceFile, source, "utf8");
      await writeFile(consumerFile, consumerLines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

      for (const [line, expectedLine] of [
        [3, 3],
        [4, 4],
        [5, 5],
      ] as const) {
        const result = await goToDefinition(index, {
          file: consumerFile,
          line,
          column: consumerLines[line - 1]!.lastIndexOf("Alias") + 1,
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") continue;
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(sourceFile));
        expect(result.definition.range.start.line).toBe(expectedLine);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves instanceof, catch, and constructor-argument aliases by PHP import role", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-alias-type-contexts-"));
    const sourceFile = path.join(root, "source.php");
    const consumerFile = path.join(root, "consumer.php");
    const source = [
      "<?php",
      "namespace App;",
      "class Service { public $field; }",
      "function helper() { return 1; }",
      "const TOKEN = 1;",
      "",
    ].join("\n");
    const consumerLines = [
      "<?php",
      "namespace Client;",
      "use App\\Service as Alias;",
      "use function App\\helper as Alias;",
      "use const App\\TOKEN as Alias;",
      "$service = new Alias();",
      "$withArg = new Alias(Alias);",
      "$is = $service instanceof Alias;",
      "try { throw $service; } catch (Alias $e) {}",
      "$value = Alias();",
      "$constant = Alias;",
      "$service->field;",
      "$service->FIELD;",
      "",
    ];

    try {
      await writeFile(sourceFile, source, "utf8");
      await writeFile(consumerFile, consumerLines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

      const cases: Array<{ line: number; column: number; expectedLine: number }> = [
        { line: 6, column: consumerLines[5]!.indexOf("Alias") + 1, expectedLine: 3 },
        { line: 7, column: consumerLines[6]!.indexOf("Alias") + 1, expectedLine: 3 },
        { line: 7, column: consumerLines[6]!.lastIndexOf("Alias") + 1, expectedLine: 5 },
        { line: 8, column: consumerLines[7]!.indexOf("Alias") + 1, expectedLine: 3 },
        { line: 9, column: consumerLines[8]!.indexOf("Alias") + 1, expectedLine: 3 },
        { line: 10, column: consumerLines[9]!.indexOf("Alias") + 1, expectedLine: 4 },
        { line: 11, column: consumerLines[10]!.indexOf("Alias") + 1, expectedLine: 5 },
      ];
      for (const { line, column, expectedLine } of cases) {
        const result = await goToDefinition(index, { file: consumerFile, line, column });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") continue;
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(sourceFile));
        expect(result.definition.range.start.line).toBe(expectedLine);
      }

      const classRefs = await findReferences(index, {
        file: sourceFile,
        line: 3,
        column: "class Service {}".indexOf("Service") + 1,
      });
      expect(classRefs.status).toBe("ok");
      if (classRefs.status === "ok") {
        expect(
          classRefs.references.some(
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(consumerFile) && reference.range.start.line === 8,
          ),
        ).toBe(true);
        expect(
          classRefs.references.some(
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(consumerFile) &&
              reference.range.start.line === 7 &&
              reference.range.start.column === consumerLines[6]!.lastIndexOf("Alias") + 1,
          ),
        ).toBe(false);
      }
      const propertyRefs = await findReferences(index, {
        file: sourceFile,
        line: 3,
        column: "class Service { public $field; }".indexOf("field") + 1,
      });
      expect(propertyRefs.status).toBe("ok");
      if (propertyRefs.status !== "ok") throw new Error("Expected PHP property references");
      expect(
        propertyRefs.references
          .filter((ref) => fileIdentityKey(ref.file) === fileIdentityKey(consumerFile))
          .map((ref) => ref.range.start.line),
      ).toEqual([12]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps same-spelled class, function, and constant imports distinct in lists and graphs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-alias-role-ids-"));
    const sourceFile = path.join(root, "source.php");
    const consumerFile = path.join(root, "consumer.php");
    const source = [
      "<?php",
      "namespace App;",
      "class Service {}",
      "function Service() { return 1; }",
      "const Service = 2;",
      "",
    ].join("\n");
    const consumerLines = [
      "<?php",
      "namespace Client;",
      "use App\\Service as Alias;",
      "use function App\\Service as Alias;",
      "use const App\\Service as Alias;",
      "function caller() {",
      "    new Alias();",
      "    Alias();",
      "    return Alias;",
      "}",
      "function constantsOnly() {",
      "    return Alias;",
      "}",
      "function wrongCaseConstants() {",
      "    return ALIAS;",
      "    return aLiAs;",
      "}",
      "function typedOnly(ALIAS $a): aLiAs {",
      "    return $a;",
      "}",
      "function mixedCaseCalls() {",
      "    ALIAS();",
      "    new ALIAS();",
      "    return alias;",
      "}",
      "",
    ];

    try {
      await writeFile(sourceFile, source, "utf8");
      await writeFile(consumerFile, consumerLines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

      const targetIds = new Map<string, string>();
      const sourceModule = [...index.byFile.values()].find(
        (module) => fileIdentityKey(module.file) === fileIdentityKey(sourceFile),
      );
      expect(sourceModule).toBeDefined();
      for (const def of sourceModule?.locals ?? []) {
        if (
          def.localName === "Service" &&
          (def.kind === "class" || def.kind === "function" || def.kind === "variable")
        ) {
          targetIds.set(def.kind, defNodeId(def));
        }
      }
      expect([...targetIds.keys()].sort()).toEqual(["class", "function", "variable"]);

      const listEntries = listSymbols(index, { file: consumerFile, includeImports: true }).filter(
        (entry) => entry.kind === "import" && entry.name === "Alias",
      );
      expect(listEntries).toHaveLength(3);
      expect(new Set(listEntries.map((entry) => entry.id)).size).toBe(3);
      const entryByRole = new Map(
        listEntries.map((entry) => [entry.id.slice(entry.id.lastIndexOf(":") + 1), entry] as const),
      );
      expect([...entryByRole.keys()].sort()).toEqual(["class", "const", "function"]);

      for (const [role, expectedKind] of [
        ["class", "class"],
        ["function", "function"],
        ["const", "variable"],
      ] as const) {
        const entry = entryByRole.get(role);
        expect(entry, `missing ${role} list entry`).toBeDefined();
        if (!entry) continue;
        const gotoResult = goToDefinitionById(index, entry.id);
        expect(gotoResult.status, `${role} role ID should resolve`).toBe("ok");
        if (gotoResult.status === "ok") {
          expect(gotoResult.definition.kind).toBe(expectedKind);
          expect(fileIdentityKey(gotoResult.definition.file)).toBe(fileIdentityKey(sourceFile));
        }
      }

      const classEntry = entryByRole.get("class");
      expect(classEntry).toBeDefined();
      if (classEntry) {
        const unknownRoleId = `${classEntry.id.slice(0, classEntry.id.lastIndexOf(":") + 1)}unknown`;
        expect(goToDefinitionById(index, unknownRoleId).status).toBe("not_found");
      }

      for (const [role, expectedLine] of [
        ["class", 7],
        ["function", 8],
        ["const", 9],
      ] as const) {
        const entry = entryByRole.get(role);
        expect(entry, `missing ${role} list entry for references`).toBeDefined();
        if (!entry) continue;
        const refs = await findReferencesById(index, entry.id);
        expect(refs.status, `${role} role references should resolve`).toBe("ok");
        if (refs.status !== "ok") continue;
        const refLines = refs.references
          .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(consumerFile))
          .map((reference) => reference.range.start.line);
        expect(refLines, `${role} role should see its own use`).toContain(expectedLine);
        for (const otherLine of [7, 8, 9]) {
          if (otherLine !== expectedLine) expect(refLines).not.toContain(otherLine);
        }
      }

      const [compact, detailed] = await Promise.all([buildSymbolGraph(index), buildSymbolGraphDetailed(index)]);
      for (const graph of [compact, detailed]) {
        const aliasNodes = [...graph.nodes.values()].filter(
          (node) =>
            fileIdentityKey(node.file) === fileIdentityKey(consumerFile) &&
            node.kind === "import" &&
            node.name === "Alias",
        );
        expect(aliasNodes).toHaveLength(3);
        expect(new Set(aliasNodes.map((node) => node.id)).size).toBe(3);
        const aliasEdges = graph.edges.filter((edge) => aliasNodes.some((node) => node.id === edge.from));
        expect(aliasEdges).toHaveLength(3);
        expect(new Set(aliasEdges.map((edge) => edge.to))).toEqual(new Set(targetIds.values()));
        for (const edge of aliasEdges) {
          const role = edge.from.slice(edge.from.lastIndexOf(":") + 1);
          const target = graph.nodes.get(edge.to);
          expect(target, `alias ${role} edge target should exist`).toBeDefined();
          if (!target) continue;
          expect(fileIdentityKey(target.file)).toBe(fileIdentityKey(sourceFile));
          expect(target.kind).toBe(role === "const" ? "variable" : role);
        }
      }

      const functionEdges = (functionName: string): { uses: Set<string>; calls: string[] } => {
        const node = [...detailed.nodes.values()].find(
          (candidate) =>
            fileIdentityKey(candidate.file) === fileIdentityKey(consumerFile) &&
            candidate.kind === "function" &&
            candidate.name === functionName,
        );
        expect(node, `${functionName} should appear in the detailed graph`).toBeDefined();
        if (!node) return { uses: new Set<string>(), calls: [] };
        const outgoing = detailed.edges.filter((edge) => edge.from === node.id);
        return {
          uses: new Set(outgoing.filter((edge) => edge.label === "uses").map((edge) => edge.to)),
          calls: outgoing.filter((edge) => edge.label === "calls").map((edge) => edge.to),
        };
      };

      // Each occurrence resolves through its own import namespace: the instantiation
      // occurrence uses the class, the call occurrence uses the function, and the bare
      // return uses the constant.
      const caller = functionEdges("caller");
      expect(caller.uses).toEqual(
        new Set([targetIds.get("class"), targetIds.get("function"), targetIds.get("variable")]),
      );
      expect(caller.calls).toEqual([targetIds.get("function")]);

      // A constant-only function must not inherit the class or function aliases.
      expect(functionEdges("constantsOnly").uses).toEqual(new Set([targetIds.get("variable")]));

      // Constants compare exactly: folded class or function spellings satisfy no const use.
      expect(functionEdges("wrongCaseConstants").uses).toEqual(new Set<string>());

      // Type positions use the class alias, folded ASCII-case-insensitively, and nothing else.
      expect(functionEdges("typedOnly").uses).toEqual(new Set([targetIds.get("class")]));

      // Mixed-case call and instantiation occurrences resolve their own roles, while the
      // exact-case constant `alias` must not bind the function or any other role's target.
      const mixed = functionEdges("mixedCaseCalls");
      expect(mixed.uses).toEqual(new Set([targetIds.get("function"), targetIds.get("class")]));
      expect(mixed.calls).toEqual([targetIds.get("function")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP enum interface conformance", () => {
  it("emits an implements edge and returns the enum from implementation lookup", async () => {
    const sampleDir = path.resolve(process.cwd(), "tests", "samples", "php");
    const fixture = path.join(sampleDir, "EnumImplementation.php");
    const index = await createTestIndexFromFiles(sampleDir, [fixture]);
    const graph = await buildSymbolGraphDetailed(index);
    const interfaceNode = [...graph.nodes.values()].find((node) => node.name === "EnumContract");
    const enumNode = [...graph.nodes.values()].find((node) => node.name === "EnumStatus");

    expect(interfaceNode).toBeDefined();
    expect(enumNode).toBeDefined();
    if (!interfaceNode || !enumNode) return;

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: enumNode.id,
        to: interfaceNode.id,
        label: "implements",
      }),
    );

    const result = findImplementations(index, graph, interfaceNode.id);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.implementations).toEqual([
      expect.objectContaining({
        symbolId: enumNode.id,
        relation: "implements",
      }),
    ]);
  });
});

describe("PHP explicit method receivers", () => {
  it("resolves instance and static receiver calls while preserving function imports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-member-navigation-"));
    const classFile = path.join(root, "example.php");
    const helperFile = path.join(root, "helpers.php");
    const classSource = `<?php
namespace App;
use function Imported\\helper;
class Example {
    function helper() {}
    function run() {
        $this->helper();
        self::helper();
        static::helper();
        helper();
    }
}
`;

    try {
      await writeFile(classFile, classSource, "utf8");
      await writeFile(helperFile, "<?php namespace Imported; function helper() {}", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const receiverCalls = [
        { line: 7, column: 17 },
        { line: 8, column: 15 },
        { line: 9, column: 17 },
      ];

      for (const position of receiverCalls) {
        const result = await goToDefinition(index, { file: classFile, ...position });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file.replace(/\\/g, "/")).toBe(classFile.replace(/\\/g, "/"));
          expect(result.definition.range.start.line).toBe(5);
        }
      }

      const imported = await goToDefinition(index, { file: classFile, line: 10, column: 9 });
      expect(imported.status).toBe("ok");
      if (imported.status === "ok") {
        expect(imported.definition.file.replace(/\\/g, "/")).toBe(helperFile.replace(/\\/g, "/"));
        expect(imported.definition.range.start.line).toBe(1);
      }

      // The receiver calls above must also be recorded as resolved `calls` edges, so
      // `codegraph callers` reports them instead of reporting an empty caller set.
      const graph = await buildSymbolGraphDetailed(index);
      const classPath = classFile.replace(/\\/g, "/");
      const methodNode = (name: string) =>
        [...graph.nodes.values()].find(
          (node) => node.name === name && node.kind === "function" && node.file.replace(/\\/g, "/") === classPath,
        );
      const helperMethod = methodNode("helper");
      const runMethod = methodNode("run");
      expect(helperMethod).toBeDefined();
      expect(runMethod).toBeDefined();
      if (!helperMethod || !runMethod) return;

      const callers = findCallHierarchy(graph, helperMethod.id, "incoming");
      expect(callers.status).toBe("ok");
      if (callers.status !== "ok") return;
      const runEntry = callers.entries.find((entry) => entry.symbolId === runMethod.id);
      expect(runEntry).toBeDefined();
      expect(runEntry?.callsites.map((site) => site.range.start.line)).toEqual([7, 8, 9]);
      const importedHelper = [...graph.nodes.values()].find(
        (node) =>
          node.name === "helper" &&
          node.kind === "function" &&
          node.file.replace(/\\/g, "/") === helperFile.replace(/\\/g, "/"),
      );
      expect(importedHelper).toBeDefined();
      const importedCallers = importedHelper
        ? findCallHierarchy(graph, importedHelper.id, "incoming")
        : { status: "not_found" as const, reason: "missing" };
      expect(importedCallers.status).toBe("ok");
      if (importedCallers.status !== "ok") return;
      expect(importedCallers.entries.map((entry) => entry.symbolId)).toEqual([runMethod.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.php",
      source: "<?php\n// café ☕ prüfung\n/* über */ function créer() {\n\treturn 1;\n}\n",
      symbolName: "créer",
    });
  });
});

describe("PHP property_element and const_element initializer references", () => {
  it("does not create a phantom duplicate declaration for a class constant used as another constant's initializer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-const-init-"));
    const file = path.join(root, "consts.php");
    const source = ["<?php", "class C {", "  const SOME_CONST = 1;", "  const OTHER = SOME_CONST;", "}", ""].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });

      // Regression: only one declaration for SOME_CONST -- the initializer use in
      // `const OTHER = SOME_CONST;` must not create a phantom duplicate declaration.
      const module = index.byFile.get(fileIdentityKey(file));
      expect(module?.locals.filter((entry) => entry.localName === "SOME_CONST")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds a reference to a property used as another property's default value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-prop-init-"));
    const file = path.join(root, "props.php");
    const source = ["<?php", "class C {", "  public $y = 1;", "  public $x = $y;", "}", ""].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });

      // Regression: only one declaration for `$y` -- the default-value use in
      // `public $x = $y;` must not create a phantom duplicate declaration.
      const module = index.byFile.get(fileIdentityKey(file));
      expect(module?.locals.filter((entry) => entry.localName === "$y")).toHaveLength(1);

      // The default-value occurrence of `$y` must be found as a reference to the
      // `$y` property declaration, not suppressed as if it were itself a declaration.
      const references = await findReferences(index, { file, line: 3, column: 11 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((entry) => entry.range.start.line)).toContain(4);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP registered extension namespace resolution", () => {
  it("resolves a class in a .phtml file through its namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-phtml-namespace-"));
    const declaring = path.join(root, "widget.phtml");
    const importing = path.join(root, "main.php");
    try {
      await writeFile(declaring, "<?php\nnamespace App\\View;\nclass Widget {}\n", "utf8");
      await writeFile(importing, "<?php\nuse App\\View\\Widget;\n$widget = new Widget();\n", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));
      expect(fromMain.map((edge) => edge.to)).toEqual([{ type: "file", path: declaring.replace(/\\/g, "/") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP nested function export exclusion", () => {
  it("does not publish a function nested inside another function as a module export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-nested-function-"));
    const file = path.join(root, "nested.php");
    const source = [
      "<?php",
      "function outer() {",
      "  function inner() { return 1; }",
      "  return inner();",
      "}",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const module = index.byFile.get(fileIdentityKey(file));
      const exported = (module?.exports ?? []).flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));
      expect(exported).toContain("outer");
      // PHP only hoists nested function definitions to visibility when the outer function
      // runs; the nested name is not a module export.
      expect(exported).not.toContain("inner");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP parent:: member navigation", () => {
  it("resolves parent::helper() to the base declaration, not the derived override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-parent-goto-"));
    const file = path.join(root, "box.php");
    const source = [
      "<?php",
      "class Base {",
      "  function helper() { return 1; }",
      "}",
      "class Derived extends Base {",
      "  function helper() { return 2; }",
      "  function run() { return parent::helper(); }",
      "}",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const column = source.split("\n")[6]!.indexOf("helper()") + 1;
      const result = await goToDefinition(index, { file, line: 7, column });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(3);
      expect(result.definition.range.start.line).not.toBe(6);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
