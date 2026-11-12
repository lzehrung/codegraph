import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { buildSymbolGraph, defNodeId } from "../../src/graphs/symbol-graph.js";
import {
  type BuildReport,
  buildProjectIndex,
  buildProjectIndexIncremental,
  collectLocalsAndExportsFromSource,
  findReferences,
  goToDefinition,
  parseFile,
} from "../../src/index.js";
import { findCallHierarchy } from "../../src/indexer/call-hierarchy.js";
import { findReferencesById, goToDefinitionById, listSymbols } from "../../src/indexer/symbols.js";
import { findImplementations } from "../../src/indexer/type-hierarchy.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";
import {
  RESTORED_DECLARATION_FIXTURES,
  declarationImportTargets,
  withRestoredDeclarationImport,
} from "../helpers/restored-declaration-import-fixture.js";
import {
  DUPLICATE_DECLARATION_CASES,
  expectDuplicateRemovalMatchesColdBuilds,
  withDuplicateDeclarations,
} from "../helpers/duplicate-declaration-import-fixture.js";
import {
  PHP_PATH_IMPORT_FORMS,
  PHP_PATH_MAPPINGS,
  phpPathFallbackFixture,
  PHP_INCOMPLETE_DECLARATION_SOURCES,
} from "../helpers/php-path-fallback-fixture.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../../src/native/source-limits.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../../src/native/tree-sitter-native.js";
import { loadBinding } from "../../src/native/runtime.js";
import { collectPhpModuleImportNames, phpNamespaceSymbolIndexFor } from "../../src/indexer/php-namespace-symbols.js";
import * as phpNavigation from "../../src/indexer/navigation-php.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import { findUnusedExports } from "../../src/indexer/unused-exports.js";
import { workspaceSymbols } from "../../src/indexer/workspace-symbols.js";
import {
  expectPhpTraitCompositionGoto,
  expectPhpTraitCompositionReferences,
  expectPhpTraitCompositionGraph,
  withPhpTraitComposition,
} from "../helpers/php-trait-composition-fixture.js";

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

describe("PHP-only index work", () => {
  it.each([false, true])("keeps TypeScript consumers unchanged with PHP present: %s", async (includePhp) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-language-guards-"));
    const promotionParameter = vi.spyOn(phpNavigation, "phpPropertyPromotionParameter");
    const promotedVariable = vi.spyOn(phpNavigation, "phpConstructorPromotedVariable");
    try {
      const sources: Record<string, string> = {
        "box.ts": ["export class Box {", "  run() { return this.helper(); }", "  helper() { return 1; }", "}"].join(
          "\n",
        ),
      };
      if (includePhp) {
        sources["traits.php"] = [
          "<?php",
          "trait Helper { public function WORK() { return 1; } }",
          "class Uses { use Helper; public function run() { return $this->work(); } }",
        ].join("\n");
      }
      const files = await writeFixtureFiles(root, sources);
      const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
      const graph = await buildSymbolGraphDetailed(index);
      const tsFile = files["box.ts"]!;
      const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "run");
      expect(
        calls
          .filter((edge) => graph.nodes.get(edge.from)?.file === normalizePath(tsFile))
          .map((edge) => graph.nodes.get(edge.to)?.name),
      ).toEqual(["helper"]);
      const target = await goToDefinition(index, { file: tsFile, line: 2, column: 23 });
      expect(target.status).toBe("ok");
      if (target.status !== "ok") throw new Error("Expected TypeScript member target");
      expect(target.definition.range.start.line).toBe(3);
      const references = await findReferences(index, { def: target.definition });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected TypeScript member references");
      expect(references.references.some((site) => site.file === tsFile && site.range.start.line === 2)).toBe(true);
      if (includePhp) {
        expect(phpNamespaceSymbolIndexFor(index)).not.toBeNull();
        expect(calls.filter((edge) => graph.nodes.get(edge.to)?.name === "WORK")).toHaveLength(1);
      } else {
        expect(phpNamespaceSymbolIndexFor(index)).toBeNull();
        expect(promotionParameter).not.toHaveBeenCalled();
        expect(promotedVariable).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

describe("PHP interface inheritance", () => {
  it("finds conformers of a refining interface as implementations of the inherited interface, never the interface", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-interface-extends-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Contracts.php":
          "<?php\ninterface Contract { public function run(): void; }\ninterface Refined extends Contract {}\ninterface Lonely extends Contract {}\n",
        "Worker.php": "<?php\nclass Worker implements Refined { public function run(): void {} }\n",
        "Direct.php": "<?php\nclass Direct implements Contract { public function run(): void {} }\n",
      });
      const index = await createTestIndexFromFiles(root, Object.values(paths));
      const graph = await buildSymbolGraphDetailed(index);
      const contract = [...graph.nodes.values()].find((node) => node.name === "Contract");
      expect(contract).toBeDefined();
      const implementations = findImplementations(index, graph, contract!.id);
      if (implementations.status !== "ok") throw new Error("Expected PHP interface implementations");
      expect(implementations.implementations.map((match) => graph.nodes.get(match.symbolId)?.name).sort()).toEqual([
        "Direct",
        "Worker",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

describe("PHP full sample use declarations", () => {
  it("keeps imported class and function declaration sites in navigation and complete references", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "php");
    const mainFile = path.join(root, "main.php");
    const utilsFile = path.join(root, "utils.php");
    const index = await buildProjectIndex(root, { cache: "off" });
    for (const [line, column, definitionLine, definitionColumn, sites] of [
      [6, 15, 5, 7, ["main.php:6:15", "main.php:10:12", "utils.php:5:7"]],
      [7, 24, 19, 10, ["main.php:7:24", "main.php:9:11", "utils.php:19:10"]],
    ] as const) {
      const result = await goToDefinition(index, { file: mainFile, line, column });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected imported PHP declaration");
      expect(normalizePath(result.definition.file)).toBe(normalizePath(utilsFile));
      expect(result.definition.range.start.line).toBe(definitionLine);
      const references = await findReferences(index, {
        file: utilsFile,
        line: definitionLine,
        column: definitionColumn,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected imported PHP references");
      expect(references.referenceCoverage?.state).toBe("complete");
      expect(
        references.references
          .map(
            (reference) =>
              `${path.basename(reference.file)}:${reference.range.start.line}:${reference.range.start.column}`,
          )
          .sort(),
      ).toEqual([...sites].sort());
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

describe("PHP fully qualified function calls", () => {
  it("records the namespaced call edge without taking a same-named function elsewhere", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-qualified-call-"));
    try {
      const useLines = ["<?php", "namespace Client;", "function call() { return \\App\\Math\\sum(1, 2); }"];
      const paths = await writeFixtureFiles(root, {
        "app.php": "<?php namespace App\\Math; function sum(int $a, int $b): int { return $a + $b; }",
        "decoy.php": "<?php namespace Other; function sum(int $a, int $b): int { return -1; }",
        "use.php": useLines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["use.php"]!,
        line: 3,
        column: columnOf(useLines, 3, "sum"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected fully qualified PHP function");
      expect(normalizePath(result.definition.file)).toBe(paths["app.php"]);
      const references = await findReferences(index, {
        file: result.definition.file,
        line: result.definition.range.start.line,
        column: result.definition.range.start.column,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected qualified function references");
      expect(new Set(references.references.map((ref) => normalizePath(ref.file)))).toEqual(
        new Set([paths["app.php"], paths["use.php"]]),
      );
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "call")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["app.php"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP inherited member lookup", () => {
  it("reaches a grandparent method through memberless subclasses without taking a decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-grandparent-"));
    try {
      const lines = ["<?php", "namespace App;", "function call() { $object = new Derived(); return $object->run(); }"];
      const paths = await writeFixtureFiles(root, {
        "Grand.php": "<?php namespace App; class Grand { public function run(): int { return 1; } }",
        "Base.php": "<?php namespace App; class Base extends Grand {}",
        "Derived.php": "<?php namespace App; class Derived extends Base {}",
        "Decoy.php": "<?php namespace App; class Decoy { public function run(): int { return -1; } }",
        "Use.php": lines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["Use.php"]!,
        line: 3,
        column: columnOf(lines, 3, "run"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected inherited PHP method");
      expect(normalizePath(result.definition.file)).toBe(paths["Grand.php"]);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "call")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["Grand.php"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP trait composition", () => {
  it.each([false, true])("keeps trait members out of bare lookup and file exports (globals: %s)", async (globals) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-trait-bare-"));
    const diskOptions = { cache: "disk", cacheDir: path.join(root, "cache") } as const;
    try {
      const traitLines = [
        "<?php",
        "trait A {",
        "  public function helper() { return 'trait'; }",
        "  public $conf = 'property';",
        "}",
      ];
      const useLines = [
        "<?php",
        "function f() { return helper(); }",
        "function constantValue() { return conf; }",
        "class K {",
        "  use A;",
        "  public function run() { return helper(); }",
        "  public function read() { return conf; }",
        "  public function method() { return $this->helper(); }",
        "  public function property() { return $this->conf; }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "trait.php": traitLines.join("\n"),
        "use.php": useLines.join("\n"),
        "globals.php": globals
          ? "<?php\nfunction helper() { return 'global'; }\nconst conf = 'constant';\nfunction orphan() {}\n"
          : "<?php\nfunction orphan() {}\n",
      });
      const traitFile = paths["trait.php"]!;
      const useFile = paths["use.php"]!;
      for (const cache of ["off", "disk", "disk"] as const) {
        closeDiskCacheDatabase(root, diskOptions);
        const index = await buildProjectIndex(root, { ...diskOptions, cache, threads: 1 });
        expect(index.byFile.get(fileIdentityKey(traitFile))?.nativeOutcome).toBe("used");
        for (const line of [2, 6]) {
          const result = await goToDefinition(index, {
            file: useFile,
            line,
            column: columnOf(useLines, line, "helper"),
          });
          expect(result.status).toBe(globals ? "ok" : "not_found");
          if (result.status === "ok") expect(normalizePath(result.definition.file)).toBe(paths["globals.php"]);
        }
        for (const line of [3, 7]) {
          const result = await goToDefinition(index, { file: useFile, line, column: columnOf(useLines, line, "conf") });
          // Bare constants can stay unresolved, but a property is never their declaration.
          if (result.status === "ok") expect(normalizePath(result.definition.file)).toBe(paths["globals.php"]);
          else expect(result.status).toBe("not_found");
        }
        for (const [name, declarationLine, callLine] of [
          ["helper", 3, 8],
          ["$conf", 4, 9],
        ] as const) {
          const declaration = {
            file: traitFile,
            line: declarationLine,
            column: columnOf(traitLines, declarationLine, name),
          };
          const token = name.replace("$", "");
          const member = { file: useFile, line: callLine, column: columnOf(useLines, callLine, token) };
          const result = await goToDefinition(index, member);
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error("Expected the explicit trait member");
          expect(normalizePath(result.definition.file)).toBe(traitFile);
          expect(result.definition.range.start.line).toBe(declarationLine);
          const references = await findReferences(index, declaration);
          expect(references.status).toBe("ok");
          if (references.status !== "ok") throw new Error("Expected trait member references");
          expect(references.referenceCoverage.state).toBe("complete");
          expect(
            references.references
              .map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
              .sort(),
          ).toEqual([`trait.php:${declarationLine}`, `use.php:${callLine}`]);
        }
        if (globals) {
          const references = await findReferences(index, { file: paths["globals.php"]!, line: 2, column: 10 });
          expect(references.status).toBe("ok");
          if (references.status !== "ok") throw new Error("Expected the global function");
          expect(references.referenceCoverage.state).toBe("complete");
          expect(
            references.references
              .map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
              .sort(),
          ).toEqual(["globals.php:2", "use.php:2", "use.php:6"]);
        }
        const symbols = await workspaceSymbols(index, { query: "", fileGlob: "**/trait.php" });
        expect(symbols.symbols.map((symbol) => [symbol.name, !!symbol.def.isMember, symbol.exported]).sort()).toEqual([
          ["$conf", true, false],
          ["A", false, true],
          ["helper", true, false],
        ]);
        const exported = await workspaceSymbols(index, { query: "", fileGlob: "**/trait.php", exportedOnly: true });
        expect(exported.symbols.map((symbol) => symbol.name)).toEqual(["A"]);
        const unused = await findUnusedExports(index);
        expect(unused.some((candidate) => candidate.name === "orphan")).toBe(true);
        expect(unused.filter((candidate) => normalizePath(candidate.file) === traitFile)).toEqual([]);
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges
            .filter((edge) => edge.label === "calls")
            .map((edge) => `${edge.site!.range.start.line}->${path.basename(graph.nodes.get(edge.to)!.file)}`)
            .sort(),
        ).toEqual(globals ? ["2->globals.php", "6->globals.php", "8->trait.php"] : ["8->trait.php"]);
      }
    } finally {
      closeDiskCacheDatabase(root, diskOptions);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves adapted-use hierarchy and ordinary members across cold and reopened caches", async () => {
    await withPhpTraitComposition(async (index, files) => {
      await expectPhpTraitCompositionGoto(index, files);
      await expectPhpTraitCompositionGraph(index, files);
    });
  });

  it("preserves trait reference inclusions and exclusions with partial adapted-name coverage after cache reload", async () => {
    await withPhpTraitComposition(async (index, files, root) => {
      await expectPhpTraitCompositionReferences(index, files, root);
    });
  });

  it("selects concrete inherited and own implementations over abstract trait requirements", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-abstract-trait-"));
    try {
      const lines = [
        "<?php",
        "trait Requirement { abstract public function shared(): string; }",
        "class Base { public function shared(): string { return 'base'; } }",
        "class Child extends Base {",
        "  use Requirement;",
        "  public function run(): string { return $this->shared(); }",
        "}",
        "class Own extends Base {",
        "  use Requirement;",
        "  public function shared(): string { return 'own'; }",
        "  public function run(): string { return $this->shared(); }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, { "model.php": lines.join("\n") });
      const file = paths["model.php"]!;
      const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const firstDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      const reopenedDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      for (const index of [cold, firstDisk, reopenedDisk]) {
        for (const [callLine, targetLine] of [
          [6, 3],
          [11, 10],
        ] as const) {
          const result = await goToDefinition(index, {
            file,
            line: callLine,
            column: columnOf(lines, callLine, "shared"),
          });
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error("Expected concrete PHP method implementation");
          expect(result.definition.range.start.line).toBe(targetLine);
          const references = await findReferences(index, {
            file,
            line: targetLine,
            column: columnOf(lines, targetLine, "shared"),
          });
          expect(references.status).toBe("ok");
          if (references.status !== "ok") throw new Error("Expected concrete PHP method references");
          expect(references.referenceCoverage?.state).toBe("complete");
          expect(references.references.map((reference) => reference.range.start.line).sort()).toEqual(
            [targetLine, callLine].sort(),
          );
        }
        const graph = await buildSymbolGraphDetailed(index);
        const owners = new Map(
          graph.edges
            .filter((edge) => edge.label === "member_of")
            .map((edge) => [edge.from, graph.nodes.get(edge.to)?.name] as const),
        );
        const calls = graph.edges
          .filter((edge) => edge.label === "calls" && [6, 11].includes(edge.site?.range.start.line ?? -1))
          .map((edge) => `${edge.site?.range.start.line}->${owners.get(edge.to)}`)
          .sort();
        expect(calls).toEqual(["11->Own", "6->Base"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds a trait property read to the sole using class's promoted property, not a same-named decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-trait-property-"));
    try {
      const traitLines = [
        "<?php",
        "namespace App;",
        "trait HasLabel {",
        "  public function label(): string { return $this->name; }",
        "}",
      ];
      const recordLines = [
        "<?php",
        "namespace App;",
        "class Record {",
        "  use HasLabel;",
        "  public function __construct(public string $name) {}",
        "  public function describe(): string { $obj = new Record('ok'); return $this->label() . $obj->label() . $this->name; }",
        "}",
      ];
      const decoyLines = [
        "<?php",
        "namespace Other;",
        "class Ghost { public function __construct(public string $name) {} }",
      ];
      const paths = await writeFixtureFiles(root, {
        "trait.php": traitLines.join("\n"),
        "record.php": recordLines.join("\n"),
        "decoy.php": decoyLines.join("\n"),
      });
      const traitProperty = { file: paths["trait.php"]!, line: 4, column: columnOf(traitLines, 4, "name") };
      const property = { file: paths["record.php"]!, line: 5, column: columnOf(recordLines, 5, "$name") };
      const decoyProperty = { file: paths["decoy.php"]!, line: 3, column: columnOf(decoyLines, 3, "$name") };
      const objectProperty = { file: paths["record.php"]!, line: 6, column: columnOf(recordLines, 6, "name") };
      const referenceSites = [
        `${normalizePath(paths["trait.php"]!)}:4:${traitProperty.column}`,
        `${normalizePath(paths["record.php"]!)}:5:${property.column}`,
        `${normalizePath(paths["record.php"]!)}:6:${objectProperty.column}`,
      ].sort();
      const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const firstDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      const reopenedDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      for (const index of [cold, firstDisk, reopenedDisk]) {
        const target = await goToDefinition(index, traitProperty);
        expect(target.status).toBe("ok");
        if (target.status !== "ok") throw new Error("Expected trait property to bind to using class");
        expect(normalizePath(target.definition.file)).toBe(normalizePath(property.file));
        expect(target.definition.range.start.line).toBe(property.line);
        const references = await findReferences(index, property);
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected promoted property references");
        expect(references.referenceCoverage?.state).toBe("complete");
        expect(
          references.references
            .map((reference) => {
              const start = reference.range.start;
              return `${normalizePath(reference.file)}:${start.line}:${start.column}`;
            })
            .sort(),
        ).toEqual(referenceSites);
        const decoyReferences = await findReferences(index, decoyProperty);
        expect(decoyReferences.status).toBe("ok");
        if (decoyReferences.status !== "ok") throw new Error("Expected decoy property's declaration");
        expect(
          decoyReferences.references.every(
            (reference) => normalizePath(reference.file) === normalizePath(decoyProperty.file),
          ),
        ).toBe(true);
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "describe")
          .map(
            (edge) =>
              `${graph.nodes.get(edge.to)?.name}:${normalizePath(graph.nodes.get(edge.to)!.file)}:${edge.site?.range.start.line}`,
          );
        expect(calls).toEqual([
          `label:${normalizePath(paths["trait.php"]!)}:6`,
          `label:${normalizePath(paths["trait.php"]!)}:6`,
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not guess a promoted property when two classes use the same trait", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-trait-ambiguous-"));
    try {
      const traitLines = ["<?php", "trait Label {", "  public function label(): string { return $this->name; }", "}"];
      const firstLines = [
        "<?php",
        "class First {",
        "  use Label;",
        "  public function __construct(public string $name) {}",
        "}",
      ];
      const secondLines = [
        "<?php",
        "class Second {",
        "  use Label;",
        "  public function __construct(public string $name) {}",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "trait.php": traitLines.join("\n"),
        "first.php": firstLines.join("\n"),
        "second.php": secondLines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const traitProperty = { file: paths["trait.php"]!, line: 3, column: columnOf(traitLines, 3, "name") };
      expect((await goToDefinition(index, traitProperty)).status).toBe("not_found");
      for (const [file, lines] of [
        [paths["first.php"]!, firstLines],
        [paths["second.php"]!, secondLines],
      ] as const) {
        const references = await findReferences(index, {
          file,
          line: 4,
          column: columnOf(lines, 4, "$name"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected each promoted property declaration");
        expect(references.referenceCoverage?.state).toBe("partial");
        expect(references.references.map((reference) => normalizePath(reference.file))).toEqual([normalizePath(file)]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps adapted trait method aliases unresolved rather than inventing a call target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-trait-adapted-"));
    try {
      const traitLines = [
        "<?php",
        "trait A { public function label(): string { return 'A'; } }",
        "trait B { public function label(): string { return 'B'; } }",
      ];
      const recordLines = [
        "<?php",
        "class Record {",
        "  use A, B { A::label insteadof B; B::label as alternate; }",
        "  public function call(): string { return $this->alternate(); }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "traits.php": traitLines.join("\n"),
        "record.php": recordLines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      expect(
        (
          await goToDefinition(index, {
            file: paths["record.php"]!,
            line: 4,
            column: columnOf(recordLines, 4, "alternate"),
          })
        ).status,
      ).toBe("not_found");
      const references = await findReferences(index, {
        file: paths["traits.php"]!,
        line: 3,
        column: columnOf(traitLines, 3, "label"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected the trait method's declaration");
      expect(references.referenceCoverage?.state).toBe("partial");
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges.some((edge) => {
          if (edge.label !== "calls") return false;
          return graph.nodes.get(edge.from)?.name === "call";
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not bind adapted trait calls to an inherited same-name decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-trait-adapted-parent-"));
    try {
      const traitLines = [
        "<?php",
        "trait A { public function shared(): string { return 'A'; } }",
        "trait B { public function shared(): string { return 'B'; } }",
      ];
      const baseLines = ["<?php", "class Base { public function shared(): string { return 'base'; } }"];
      const recordLines = [
        "<?php",
        "class Record extends Base {",
        "  use A, B { A::shared insteadof B; B::shared as alternate; }",
        "  public function run(): string {",
        "    $one = $this->shared();",
        "    $two = $this->alternate();",
        "    return $one . $two . parent::shared();",
        "  }",
        "}",
      ];
      const paths = await writeFixtureFiles(root, {
        "traits.php": traitLines.join("\n"),
        "base.php": baseLines.join("\n"),
        "record.php": recordLines.join("\n"),
      });
      const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const firstDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      const reopenedDisk = await buildProjectIndex(root, { cache: "disk", threads: 1 });
      for (const index of [cold, firstDisk, reopenedDisk]) {
        for (const line of [5, 6]) {
          const member = line === 5 ? "shared" : "alternate";
          const target = await goToDefinition(index, {
            file: paths["record.php"]!,
            line,
            column: columnOf(recordLines, line, member),
          });
          expect(target.status).toBe("not_found");
        }
        const parent = await goToDefinition(index, {
          file: paths["record.php"]!,
          line: 7,
          column: columnOf(recordLines, 7, "shared"),
        });
        expect(parent.status).toBe("ok");
        if (parent.status !== "ok") throw new Error("Expected PHP parent method");
        expect(parent.definition.range.start.line).toBe(2);
        expect(normalizePath(parent.definition.file)).toBe(normalizePath(paths["base.php"]!));
        const references = await findReferences(index, {
          file: paths["base.php"]!,
          line: 2,
          column: columnOf(baseLines, 2, "shared"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected PHP inherited method references");
        expect(references.referenceCoverage?.state).toBe("partial");
        expect(
          references.references
            .map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
            .sort(),
        ).toEqual(["base.php:2", "record.php:7"]);
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "run")
          .map((edge) => `${edge.site?.range.start.line}:${path.basename(graph.nodes.get(edge.to)?.file ?? "")}`);
        expect(calls).toEqual(["7:base.php"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP removed duplicate declarations", () => {
  it.each(DUPLICATE_DECLARATION_CASES.filter((candidate) => candidate.languageId === "php"))(
    "follows the first declaring file after the $declarer duplicate is removed by $mutation, then restores it",
    async ({ fixture, mutation, declarer }) => {
      await withDuplicateDeclarations(fixture, { cache: "disk", mutation, declarer }, async (project) => {
        expectDuplicateRemovalMatchesColdBuilds(fixture, project);
      });
    },
  );
});

describe("PHP restored declaration imports", () => {
  it.each(RESTORED_DECLARATION_FIXTURES.filter((fixture) => fixture.languageId === "php"))(
    "restores a namespace import when its class returns in a non-path-matching file",
    async (fixture) => {
      await withRestoredDeclarationImport(fixture, "disk", async ({ restored, cold, owner, consumer, decoy }) => {
        expect(declarationImportTargets(restored, consumer)).toEqual(declarationImportTargets(cold, consumer));
        expect(declarationImportTargets(restored, consumer)).toEqual([`file:${fileIdentityKey(owner)}`]);
        expect(declarationImportTargets(restored, consumer)).not.toContain(`file:${fileIdentityKey(decoy)}`);
      });
    },
  );
});

describe("PHP namespace-only declaration moves", () => {
  it.each([
    ["a sibling namespace", "Lib2"],
    ["a deeper namespace", "Lib\\Sub"],
  ])(
    "binds a class import after the class moves from %s into the imported namespace, and unbinds it on the way back",
    async (_name, from) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-namespace-move-"));
      try {
        const declaration = (namespace: string): string => `<?php\nnamespace ${namespace};\nclass Gadget {}\n`;
        const consumerLines = [
          "<?php",
          "namespace App;",
          "use Lib\\Gadget;",
          "function consume(Gadget $value): Gadget { return $value; }",
          "",
        ];
        const files = await writeFixtureFiles(root, {
          "lib/Gadget.php": declaration(from),
          "app/Use.php": consumerLines.join("\n"),
          "other/Decoy.php": declaration("Decoy"),
        });
        const declarer = files["lib/Gadget.php"]!;
        const consumer = files["app/Use.php"]!;
        const decoy = files["other/Decoy.php"]!;
        const options = { cache: "disk", threads: 1 } as const;
        await buildProjectIndex(root, options);
        const query = { file: consumer, line: 4, column: columnOf(consumerLines, 4, "Gadget") };
        const declarationSite = {
          file: declarer,
          line: 3,
          column: columnOf(declaration("Lib").split("\n"), 3, "Gadget"),
        };

        await writeFile(declarer, declaration("Lib"), "utf8");
        const moved = await buildProjectIndexIncremental(root, options);
        const movedCold = await buildProjectIndex(root, { cache: "off", threads: 1 });
        expect(declarationImportTargets(moved, consumer)).toEqual([`file:${fileIdentityKey(declarer)}`]);
        expect(declarationImportTargets(moved, consumer)).toEqual(declarationImportTargets(movedCold, consumer));
        expect(declarationImportTargets(moved, consumer)).not.toContain(`file:${fileIdentityKey(decoy)}`);
        const definition = await goToDefinition(moved, query);
        expect(definition).toEqual(await goToDefinition(movedCold, query));
        expect(definition.status).toBe("ok");
        if (definition.status !== "ok") throw new Error("expected the moved class to be navigable");
        expect(fileIdentityKey(definition.definition.file)).toBe(fileIdentityKey(declarer));
        const references = await findReferences(moved, declarationSite);
        expect(references).toEqual(await findReferences(movedCold, declarationSite));
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("expected references to the moved class");
        expect(
          references.references.some(
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(consumer) && reference.range.start.line === 4,
          ),
        ).toBe(true);
        expect(
          references.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(decoy)),
        ).toBe(false);

        await writeFile(declarer, declaration(from), "utf8");
        const back = await buildProjectIndexIncremental(root, options);
        const backCold = await buildProjectIndex(root, { cache: "off", threads: 1 });
        expect(declarationImportTargets(back, consumer)).toEqual(["external:Lib\\Gadget"]);
        expect(declarationImportTargets(back, consumer)).toEqual(declarationImportTargets(backCold, consumer));
        expect(await goToDefinition(back, query)).toEqual(await goToDefinition(backCold, query));
        expect((await goToDefinition(back, query)).status).toBe("not_found");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("PHP path-fallback declaration proof", () => {
  for (const mapping of PHP_PATH_MAPPINGS) {
    it.each(PHP_PATH_IMPORT_FORMS)(
      `checks the qualified $name declaration before binding a ${mapping} path`,
      async (form) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-path-proof-"));
        try {
          const fixture = phpPathFallbackFixture(mapping, form, true);
          const files = await writeFixtureFiles(root, { ...fixture.files, [fixture.owner]: fixture.missingSource });
          const consumer = files["Use.php"]!;
          const missing = await buildProjectIndex(root, { cache: "off", threads: 1 });
          expect(declarationImportTargets(missing, consumer)).toEqual(["external:App\\Gadget"]);
          expect(missing.byFile.get(fileIdentityKey(consumer))?.imports[0]?.resolved).toEqual({
            external: "App\\Gadget",
          });

          await writeFile(files[fixture.owner]!, fixture.ownerSource, "utf8");
          const present = await buildProjectIndex(root, { cache: "off", threads: 1 });
          expect(declarationImportTargets(present, consumer)).toEqual([
            `file:${fileIdentityKey(files[fixture.owner]!)}`,
          ]);
          expect(declarationImportTargets(present, consumer)).not.toContain(
            `file:${fileIdentityKey(files["Decoy.php"]!)}`,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    it(`preserves namespace-prefix aliases beside a misleading ${mapping} filename`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-prefix-proof-"));
      try {
        const fixture = phpPathFallbackFixture(mapping);
        const prefixOwner = mapping === "plain" ? "App/Models.php" : "src/Models.php";
        const userOwner = mapping === "plain" ? "App/Models/User.php" : "src/Models/User.php";
        const lines = [
          "<?php",
          "namespace Client;",
          "use App\\Models;",
          "function consume() { return new Models\\User(); }",
        ];
        const files = await writeFixtureFiles(root, {
          ...fixture.files,
          [prefixOwner]: "<?php namespace Wrong; class Models {}",
          [userOwner]: "<?php namespace App\\Models; class User {}",
          "Other.php": "<?php namespace Other; class User {}",
          "Use.php": lines.join("\n"),
          "Function.php": "<?php\nuse function App\\Models;\n",
        });
        const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
        expect(declarationImportTargets(index, files["Use.php"]!)).toContain(
          `file:${fileIdentityKey(files[userOwner]!)}`,
        );
        expect(declarationImportTargets(index, files["Use.php"]!)).not.toContain(
          `file:${fileIdentityKey(files[prefixOwner]!)}`,
        );
        expect(declarationImportTargets(index, files["Function.php"]!)).toEqual(["external:App\\Models"]);
        const binding = index.byFile.get(fileIdentityKey(files["Use.php"]!))?.imports[0];
        expect(binding?.from).toBe("App\\Models");
        expect(typeof binding?.resolved === "string" && fileIdentityKey(binding.resolved)).toBe(
          fileIdentityKey(files[userOwner]!),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`retains the ${mapping} path when the candidate cannot be parsed`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-unparsed-proof-"));
      try {
        const fixture = phpPathFallbackFixture(mapping);
        const files = await writeFixtureFiles(root, {
          ...fixture.files,
          [fixture.owner]: `<?php\n/*${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}*/\n`,
        });
        const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
        expect(declarationImportTargets(index, files["Use.php"]!)).toEqual([
          `file:${fileIdentityKey(files[fixture.owner]!)}`,
        ]);
        expect(index.byFile.get(fileIdentityKey(files[fixture.owner]!))?.locals).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("keeps file includes independent of the declarations they contain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-include-proof-"));
    try {
      const files = await writeFixtureFiles(root, {
        "App/Gadget.php": "<?php namespace App; class Different {}",
        "Use.php": "<?php\nrequire_once 'App/Gadget.php';\n",
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      expect(declarationImportTargets(index, files["Use.php"]!)).toEqual([
        `file:${fileIdentityKey(files["App/Gadget.php"]!)}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP path-proof native extraction reuse", () => {
  it("extracts each indexed file once and refreshes memory-cached proofs after a declaration changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-proof-extraction-"));
    try {
      const fixture = phpPathFallbackFixture("psr4");
      const files = await writeFixtureFiles(root, fixture.files);
      const state = loadBinding();
      if (!state.loaded || !state.binding.extractLanguage) throw new Error("Native addon required for PHP extraction");
      const extractLanguage = state.binding.extractLanguage;
      const extractedSources: string[] = [];
      __setNativeTreeSitterBindingForTests({
        ...state,
        binding: {
          ...state.binding,
          extractLanguage: (source, querySetId) => {
            extractedSources.push(source);
            return extractLanguage(source, querySetId);
          },
        },
      });
      const options = { cache: "memory" as const, useNativeWorkers: false, threads: 1 };
      const initial = await buildProjectIndex(root, options);
      const owner = files[fixture.owner]!;
      const consumer = files["Use.php"]!;
      expect(declarationImportTargets(initial, consumer)).toEqual([`file:${fileIdentityKey(owner)}`]);
      const expectedSources = Object.entries(fixture.files)
        .filter(([name]) => name.endsWith(".php"))
        .map(([, source]) => source);
      expect(extractedSources.sort()).toEqual(expectedSources.sort());

      for (const [source, expected] of [
        [fixture.missingSource, ["external:App\\Gadget"]],
        [fixture.ownerSource, [`file:${fileIdentityKey(owner)}`]],
      ] as const) {
        extractedSources.length = 0;
        await writeFile(owner, source, "utf8");
        const updated = await buildProjectIndexIncremental(root, options);
        expect(declarationImportTargets(updated, consumer)).toEqual(expected);
        expect(extractedSources.sort()).toEqual([source, fixture.files["Use.php"]!].sort());
      }
    } finally {
      __resetNativeTreeSitterBindingForTests();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts each indexed PHP file once through native workers with the serial import results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-worker-extraction-"));
    try {
      const fixture = phpPathFallbackFixture("psr4");
      const files = await writeFixtureFiles(root, fixture.files);
      const serial = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false, threads: 1 });
      const report: BuildReport = { timings: {} };
      const workers = await buildProjectIndex(root, {
        cache: "off",
        useNativeWorkers: true,
        nativeThreads: 1,
        threads: 1,
        report,
      });
      const phpFileCount = Object.keys(fixture.files).filter((name) => name.endsWith(".php")).length;
      expect(report.workerPool?.enabled).toBe(true);
      expect(report.workerPool?.tasksFailed).toBe(0);
      expect(report.workerPool?.tasksSubmitted).toBe(phpFileCount);
      expect(declarationImportTargets(workers, files["Use.php"]!)).toEqual([
        `file:${fileIdentityKey(files[fixture.owner]!)}`,
      ]);
      for (const file of Object.values(files)) {
        expect(declarationImportTargets(workers, file)).toEqual(declarationImportTargets(serial, file));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PHP incomplete path-candidate proof", () => {
  for (const mapping of PHP_PATH_MAPPINGS) {
    for (const form of PHP_PATH_IMPORT_FORMS.filter((entry) => entry.name === entry.role)) {
      it.each(PHP_INCOMPLETE_DECLARATION_SOURCES)(
        `preserves ${mapping} ${form.role} resolution for $name`,
        async ({ source }) => {
          const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-incomplete-proof-"));
          try {
            const fixture = phpPathFallbackFixture(mapping, form);
            const files = await writeFixtureFiles(root, { ...fixture.files, [fixture.owner]: source });
            const owner = files[fixture.owner]!;
            const consumer = files["Use.php"]!;
            // Composer filename mappings are class-only; plain paths also serve function and const imports.
            const hasPathFallback = mapping === "plain" || form.role === "class";
            const expectedTargets = hasPathFallback ? [`file:${fileIdentityKey(owner)}`] : ["external:App\\Gadget"];
            const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
            expect(index.byFile.get(fileIdentityKey(owner))?.parseErrorRanges?.length).toBeGreaterThan(0);
            expect(declarationImportTargets(index, consumer)).toEqual(expectedTargets);
            expect(declarationImportTargets(index, consumer)).not.toContain(
              `file:${fileIdentityKey(files["Decoy.php"]!)}`,
            );
            const result = await goToDefinition(index, {
              file: consumer,
              line: 4,
              column: columnOf(fixture.lines, 4, "Gadget"),
            });
            expect(result.status).toBe("not_found");
            const graph = await buildSymbolGraphDetailed(index);
            expect(graph.edges.filter((edge) => graph.nodes.get(edge.from)?.name === "consume")).toEqual([]);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

describe("PHP namespace region collection", () => {
  it.each(["semicolon", "braced"] as const)(
    "maps %s namespaces in one root pass, including reversed declaration order",
    async (style) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cg-php-namespace-regions-"));
      try {
        const lines = ["<?php"];
        if (style === "braced") lines.push("namespace { function globalFn() { return -1; } }");
        const decoyLines: number[] = [];
        for (let namespace = 0; namespace < 4; namespace += 1) {
          lines.push(`namespace N${namespace}${style === "braced" ? " {" : ";"}`);
          lines.push("class Box {}", `const TOKEN = ${namespace};`);
          for (let fn = 0; fn < 64; fn += 1) {
            lines.push(`function f${fn}() { return ${namespace * 1000 + fn}; }`);
            if (fn === 63) decoyLines.push(lines.length);
          }
          if (style === "braced") lines.push("}");
        }
        const useLines = [
          "<?php",
          "namespace Client;",
          "use function N3\\f63;",
          "function consume() { return f63(); }",
        ];
        const files = await writeFixtureFiles(root, {
          "Functions.php": lines.join("\n"),
          "Use.php": useLines.join("\n"),
        });
        const parsed = await parseFile(files["Functions.php"]!);
        if (!parsed.nativeQueries) throw new Error("Expected native PHP extraction queries");
        const module = collectLocalsAndExportsFromSource(files["Functions.php"]!, parsed.source, parsed.sup, [], {
          tree: parsed.tree,
          nativeQueries: parsed.nativeQueries,
        });
        const rootChildren = parsed.tree.rootNode.namedChildren.length;
        const childReads = vi.spyOn(parsed.tree.rootNode, "child");
        const positionLookups = vi.spyOn(parsed.tree.rootNode, "descendantForPosition");
        const names = collectPhpModuleImportNames({ ...module, locals: [...module.locals].reverse() }, parsed);
        expect(names.incomplete).toBe(false);
        expect(names.functions.size).toBe(style === "braced" ? 257 : 256);
        expect(names.functions.has("globalfn")).toBe(style === "braced");
        expect(names.classes.size).toBe(4);
        expect(names.consts.size).toBe(4);
        for (let namespace = 0; namespace < 4; namespace += 1) {
          expect(names.functions.has(`n${namespace}\\f0`)).toBe(true);
          expect(names.functions.has(`n${namespace}\\f63`)).toBe(true);
          expect(names.classes.has(`n${namespace}\\box`)).toBe(true);
          expect(names.consts.has(`n${namespace}\\TOKEN`)).toBe(true);
          expect(names.consts.has(`n${namespace}\\token`)).toBe(false);
        }
        expect(childReads.mock.calls.length).toBeLessThanOrEqual(rootChildren + 1);
        expect(positionLookups).not.toHaveBeenCalled();
        childReads.mockRestore();
        positionLookups.mockRestore();

        const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
        const result = await goToDefinition(index, {
          file: files["Use.php"]!,
          line: 4,
          column: columnOf(useLines, 4, "f63"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected exact PHP namespace function");
        expect(result.definition.range.start.line).toBe(decoyLines[3]);
        const references = await findReferences(index, {
          file: result.definition.file,
          line: result.definition.range.start.line,
          column: result.definition.range.start.column,
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected namespaced PHP function references");
        expect(
          references.references.some((site) => site.file === files["Use.php"] && site.range.start.line === 4),
        ).toBe(true);
        expect(
          references.references.some(
            (site) => site.file === files["Functions.php"] && decoyLines.slice(0, 3).includes(site.range.start.line),
          ),
        ).toBe(false);
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter(
          (edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "consume",
        );
        expect(calls.map((edge) => edge.to)).toEqual([defNodeId(result.definition)]);
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
