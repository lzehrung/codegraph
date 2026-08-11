import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { findImplementations } from "../../src/indexer/type-hierarchy.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

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
      ],
      references: [
        {
          name: "find references for PHP helper class",
          file: "utils.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for PHP grouped use class alias",
          file: "src/Support/Toolbox.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for PHP grouped use function import",
          file: "src/Support/support_helper.php",
          line: 5,
          column: 10,
          exactCount: 3,
        },
        {
          name: "find references for PHP function imports with colliding class names",
          file: "src/Collision/ThingFunction.php",
          line: 5,
          column: 10,
          exactCount: 3,
        },
        {
          name: "find references for Composer-mapped fully-qualified PHP classes",
          file: "src/Domain/Service.php",
          line: 5,
          column: 7,
          exactCount: 9,
        },
        {
          name: "find references for Composer PSR-0 classes",
          file: "legacy/Tools/Box.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for Composer autoload-dev PSR-4 classes",
          file: "dev-src/Tool.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for Composer autoload-dev PSR-0 classes",
          file: "dev-legacy/Tools/Box.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for Composer classmap classes",
          file: "classmap/Specific.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for Composer autoload-dev classmap classes",
          file: "dev-classmap/DevSpecific.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for PSR-4 classes inside Composer excluded classmap paths",
          file: "classmap/Excluded/PsrMapped.php",
          line: 5,
          column: 7,
          exactCount: 3,
        },
        {
          name: "find references for PSR-4 functions inside Composer excluded classmap paths",
          file: "classmap/Excluded/psr_helper.php",
          line: 5,
          column: 10,
          exactCount: 3,
        },
        {
          name: "find references for Composer files autoload functions",
          file: "autoload/global_helper.php",
          line: 3,
          column: 10,
          exactCount: 2,
        },
        {
          name: "find references for Composer autoload-dev files functions",
          file: "autoload/dev_helper.php",
          line: 3,
          column: 10,
          exactCount: 2,
        },
        {
          name: "find references for Composer files inside excluded classmap paths",
          file: "classmap/Excluded/excluded_helper.php",
          line: 3,
          column: 10,
          exactCount: 2,
        },
        {
          name: "find references for PHP classes from bracketed namespace blocks",
          file: "multi-namespace/Library.php",
          line: 8,
          column: 11,
          exactCount: 5,
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
