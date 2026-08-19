import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildProjectIndexFromFiles,
  extractSqlFactsFromSource,
  findReferences,
  goToDefinition,
  listSymbols,
  type ProjectIndex,
  type SqlFactKind,
} from "../src/index.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
import { withNativeRuntimeModeAsync } from "./helpers/native.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;
const sampleRoot = path.resolve(process.cwd(), "tests", "samples");
const tempDirs: string[] = [];

type SymbolExpectation = {
  file: string;
  names: string[];
};

type SqlFactExpectation = {
  file: string;
  facts: Array<{
    kind: SqlFactKind;
    objectName: string | null;
    relatedObjectName?: string | null;
  }>;
};

type SemanticExpectation = {
  root: string;
  files: string[];
  symbols?: SymbolExpectation[];
  sqlFacts?: SqlFactExpectation[];
  goto: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
  references: {
    file: string;
    line: number;
    column: number;
    expectedStatus: "ok" | "not_found";
  };
};

afterAll(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function normalizeFile(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function normalizeGraphEdges(index: ProjectIndex): string[] {
  return index.graph.edges
    .map((edge) => {
      const target = edge.to.type === "file" ? `file:${normalizeFile(edge.to.path)}` : `external:${edge.to.name}`;
      return `${normalizeFile(edge.from)}=>${target}`;
    })
    .sort();
}

function normalizeSymbols(
  index: ProjectIndex,
  expectations: SymbolExpectation[] | undefined,
): Record<string, string[]> {
  if (!expectations) {
    return {};
  }
  const normalized: Record<string, string[]> = {};
  for (const expectation of expectations) {
    const file = normalizeFile(expectation.file);
    const actualNames = listSymbols(index, { file })
      .map((symbol) => symbol.name)
      .sort();
    const actualNameSet = new Set(actualNames);
    expect(actualNames.length, `expected indexed symbols in ${file}`).toBeGreaterThan(0);
    const missingNames = expectation.names.filter((name) => !actualNameSet.has(name));
    expect(missingNames, `missing expected symbols in ${file}`).toEqual([]);
    normalized[file] = actualNames;
  }
  return normalized;
}

async function normalizeGoto(
  index: ProjectIndex,
  request: SemanticExpectation["goto"],
): Promise<
  | {
      status: "ok";
      file: string;
      line: number;
      provenance?: { resolution?: string; confidence?: string; backend?: string };
    }
  | { status: "not_found" }
> {
  const result = await goToDefinition(index, {
    file: normalizeFile(request.file),
    line: request.line,
    column: request.column,
  });
  if (result.status !== "ok") {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    file: normalizeFile(result.definition.file),
    line: result.definition.range.start.line,
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}

async function normalizeReferences(
  index: ProjectIndex,
  request: SemanticExpectation["references"],
): Promise<
  | {
      status: "ok";
      refs: string[];
      provenance?: { resolution?: string; confidence?: string; backend?: string };
    }
  | { status: "not_found" }
> {
  const result = await findReferences(index, {
    file: normalizeFile(request.file),
    line: request.line,
    column: request.column,
  });
  if (result.status !== "ok") {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    refs: result.references.map((reference) => `${normalizeFile(reference.file)}:${reference.range.start.line}`).sort(),
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}
type NormalizedGoto = Awaited<ReturnType<typeof normalizeGoto>>;
type NormalizedReferences = Awaited<ReturnType<typeof normalizeReferences>>;

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function stableGotoSnapshot(root: string, result: NormalizedGoto): NormalizedGoto {
  if (result.status !== "ok") {
    return result;
  }
  return {
    status: "ok",
    file: relativeFile(root, result.file),
    line: result.line,
  };
}

function stableReferencesSnapshot(
  root: string,
  result: NormalizedReferences,
): { status: "ok"; refs: string[] } | { status: "not_found" } {
  if (result.status !== "ok") {
    return result;
  }
  return {
    status: "ok",
    refs: result.refs
      .map((reference) => {
        const [file, line] = reference.split(/:(?=\d+$)/);
        return `${relativeFile(root, file ?? "")}:${line ?? ""}`;
      })
      .sort(),
  };
}

async function buildSemanticIndex(expectation: SemanticExpectation, mode: "native" | "reduced"): Promise<ProjectIndex> {
  return await withNativeRuntimeModeAsync(mode, async () => {
    const files = expectation.files.map(normalizeFile);
    return await buildProjectIndexFromFiles(expectation.root, files);
  });
}

function sampleExpectation(
  rootDir: string,
  files: string[],
  symbols: SymbolExpectation[] | undefined,
  goto: SemanticExpectation["goto"],
  references: SemanticExpectation["references"],
  sqlFacts?: SqlFactExpectation[],
): SemanticExpectation {
  const root = path.join(sampleRoot, rootDir);
  return {
    root,
    files: files.map((file) => path.join(root, file)),
    symbols: symbols?.map((expectation) => ({
      file: path.join(root, expectation.file),
      names: expectation.names,
    })),
    sqlFacts: sqlFacts?.map((expectation) => ({
      file: path.join(root, expectation.file),
      facts: expectation.facts,
    })),
    goto: { ...goto, file: path.join(root, goto.file) },
    references: { ...references, file: path.join(root, references.file) },
  };
}

async function normalizeSqlFacts(
  expectations: SqlFactExpectation[] | undefined,
): Promise<Record<string, Array<{ kind: SqlFactKind; objectName: string | null; relatedObjectName: string | null }>>> {
  if (!expectations?.length) {
    return {};
  }
  const normalized: Record<
    string,
    Array<{ kind: SqlFactKind; objectName: string | null; relatedObjectName: string | null }>
  > = {};
  for (const expectation of expectations) {
    const file = normalizeFile(expectation.file);
    const source = await fsp.readFile(file, "utf8");
    const facts = extractSqlFactsFromSource(file, source);
    normalized[file] = expectation.facts.map((expected) => {
      const match = facts.find(
        (fact) =>
          fact.kind === expected.kind &&
          fact.objectName === expected.objectName &&
          (expected.relatedObjectName === undefined || fact.relatedObjectName === expected.relatedObjectName),
      );
      expect(
        match,
        `missing SQL fact ${expected.kind}:${expected.objectName} in ${relativeFile(path.dirname(file), file)}`,
      ).toBeDefined();
      return {
        kind: match!.kind,
        objectName: match!.objectName,
        relatedObjectName: match!.relatedObjectName,
      };
    });
  }
  return normalized;
}

async function expectNativeSemantics(expectation: SemanticExpectation): Promise<void> {
  const nativeIndex = await buildSemanticIndex(expectation, "native");

  normalizeSymbols(nativeIndex, expectation.symbols);

  if (expectation.sqlFacts?.length) {
    const actualFacts = await normalizeSqlFacts(expectation.sqlFacts);
    expect(actualFacts).toEqual(
      Object.fromEntries(
        expectation.sqlFacts.map((entry) => [
          normalizeFile(entry.file),
          entry.facts.map((fact) => ({
            kind: fact.kind,
            objectName: fact.objectName,
            relatedObjectName: fact.relatedObjectName ?? null,
          })),
        ]),
      ),
    );

    const edgeKinds = new Set(["reads_from", "writes_to", "joins", "alters_table", "references_object"]);
    const definedObjectNames = new Set(
      expectation.sqlFacts.flatMap((entry) =>
        entry.facts
          .filter((fact) => fact.kind.startsWith("defines_") && fact.objectName)
          .map((fact) => fact.objectName as string),
      ),
    );
    const expectedEdgeFacts = expectation.sqlFacts.flatMap((entry) =>
      entry.facts
        .filter(
          (fact) =>
            edgeKinds.has(fact.kind) &&
            fact.objectName != null &&
            (definedObjectNames.has(fact.objectName) ||
              [...definedObjectNames].some(
                (defined) => defined === fact.objectName || defined.endsWith(`.${fact.objectName}`),
              )),
        )
        .map((fact) => ({
          from: normalizeFile(entry.file),
          raw: `sql:${fact.kind}:${fact.objectName}`,
        })),
    );
    for (const expectedEdge of expectedEdgeFacts) {
      expect(
        nativeIndex.graph.edges.some(
          (edge) =>
            normalizeFile(edge.from) === expectedEdge.from && edge.raw === expectedEdge.raw && edge.to.type === "file",
        ),
        `missing native SQL graph edge ${expectedEdge.raw} from ${relativeFile(expectation.root, expectedEdge.from)}`,
      ).toBe(true);
    }
  }

  const nativeGoto = await normalizeGoto(nativeIndex, expectation.goto);
  if (expectation.goto.expectedStatus === "ok") {
    expect(nativeGoto.status).toBe("ok");
    if (nativeGoto.status === "ok") {
      expect(expectation.files.map(normalizeFile)).toContain(nativeGoto.file);
      expect(nativeGoto.line).toBeGreaterThan(0);
    }
  } else {
    expect(nativeGoto).toEqual({ status: "not_found" });
  }

  const nativeReferences = await normalizeReferences(nativeIndex, expectation.references);
  expect({
    goto: stableGotoSnapshot(expectation.root, nativeGoto),
    references: stableReferencesSnapshot(expectation.root, nativeReferences),
  }).toMatchSnapshot();

  if (expectation.references.expectedStatus === "ok") {
    expect(nativeReferences.status).toBe("ok");
    if (nativeReferences.status === "ok") {
      const indexedFiles = new Set(expectation.files.map(normalizeFile));
      expect(nativeReferences.refs.length).toBeGreaterThan(0);
      for (const reference of nativeReferences.refs) {
        const [file] = reference.split(/:(?=\d+$)/);
        expect(indexedFiles.has(file ?? "")).toBeTruthy();
      }
    }
  } else {
    expect(nativeReferences).toEqual({ status: "not_found" });
  }
}

async function createTypeScriptNormalizationCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-semantic-"));
  tempDirs.push(root);
  const moduleFile = path.join(root, "module.ts");
  const consumerFile = path.join(root, "consumer.ts");

  await fsp.writeFile(
    moduleFile,
    [
      "class InternalClass {}",
      "export class ExportedClass {}",
      "const assigned = InternalClass;",
      "export = assigned;",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    consumerFile,
    ["import assigned = require('./module');", "const instance = new assigned();", "console.log(instance);"].join("\n"),
    "utf8",
  );

  return {
    root,
    files: [moduleFile, consumerFile],
    symbols: [
      {
        file: moduleFile,
        names: ["InternalClass", "ExportedClass", "assigned"],
      },
    ],
    goto: {
      file: consumerFile,
      line: 2,
      column: 22,
      expectedStatus: "ok",
    },
    references: {
      file: moduleFile,
      line: 3,
      column: 7,
      expectedStatus: "ok",
    },
  };
}

nativeDescribe("native semantic coverage", () => {
  it("keeps native semantics stable for representative language fixtures", async () => {
    const cases: SemanticExpectation[] = [
      sampleExpectation(
        "typescript",
        ["main.ts", "utils.ts", "helpers.ts"],
        [{ file: "utils.ts", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.ts", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.ts", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "javascript",
        ["main.js", "utils.js", "helpers.js"],
        [{ file: "utils.js", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.js", line: 7, column: 25, expectedStatus: "ok" },
        { file: "utils.js", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "tsx",
        ["App.tsx", "components/Button.tsx", "utils.ts"],
        [{ file: "components/Button.tsx", names: ["Button"] }],
        { file: "App.tsx", line: 6, column: 20, expectedStatus: "ok" },
        { file: "utils.ts", line: 3, column: 17, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "tsx",
        ["JsxImportApp.tsx", "components/Button.tsx"],
        [{ file: "components/Button.tsx", names: ["Button"] }],
        { file: "JsxImportApp.tsx", line: 4, column: 11, expectedStatus: "ok" },
        { file: "components/Button.tsx", line: 5, column: 17, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "tsx",
        ["reexport-source.tsx", "reexport-barrel.tsx", "reexport-consumer.tsx"],
        [{ file: "reexport-source.tsx", names: ["aliasedValue", "starValue", "namespacedValue"] }],
        { file: "reexport-consumer.tsx", line: 5, column: 45, expectedStatus: "ok" },
        { file: "reexport-source.tsx", line: 1, column: 14, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "python",
        ["main.py", "utils.py", "helpers.py"],
        [{ file: "utils.py", names: ["helper_function", "UtilityClass"] }],
        { file: "main.py", line: 11, column: 18, expectedStatus: "ok" },
        { file: "utils.py", line: 1, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "python",
        ["package_exports/__init__.py", "package_exports/values.py", "package_consumer.py"],
        [{ file: "package_exports/values.py", names: ["source_value"] }],
        { file: "package_consumer.py", line: 3, column: 10, expectedStatus: "ok" },
        { file: "package_exports/values.py", line: 1, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "php",
        [
          "main.php",
          "utils.php",
          "helpers.php",
          "dir-include-consumer.php",
          "grouped-consumer.php",
          "composer-consumer.php",
          "composer-qualified-consumer.php",
          "composer-static-qualified-consumer.php",
          "composer-static-constant-consumer.php",
          "composer-static-property-consumer.php",
          "composer-type-qualified-consumer.php",
          "function-import-consumer.php",
          "bracketed-consumer.php",
          "bracketed-qualified-consumer.php",
          "partials/shared.php",
          "multi-namespace/Library.php",
          "src/Collision/Thing.php",
          "src/Collision/ThingFunction.php",
          "src/Domain/Service.php",
          "src/Support/Toolbox.php",
          "src/Support/support_helper.php",
          "src/Support/DEFAULT_NAME.php",
        ],
        [
          { file: "utils.php", names: ["UtilityClass", "helper_function"] },
          { file: "src/Support/Toolbox.php", names: ["Toolbox"] },
          { file: "src/Support/support_helper.php", names: ["support_helper"] },
          { file: "src/Domain/Service.php", names: ["Service"] },
          { file: "multi-namespace/Library.php", names: ["FirstService", "SecondService"] },
        ],
        { file: "grouped-consumer.php", line: 8, column: 10, expectedStatus: "ok" },
        { file: "src/Support/Toolbox.php", line: 5, column: 7, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "php",
        ["bracketed-consumer.php", "bracketed-qualified-consumer.php", "multi-namespace/Library.php"],
        [{ file: "multi-namespace/Library.php", names: ["SecondService"] }],
        { file: "bracketed-consumer.php", line: 5, column: 17, expectedStatus: "ok" },
        { file: "multi-namespace/Library.php", line: 8, column: 11, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "php",
        [
          "composer-qualified-consumer.php",
          "composer-static-qualified-consumer.php",
          "composer-static-constant-consumer.php",
          "composer-static-property-consumer.php",
          "composer-type-qualified-consumer.php",
          "function-import-consumer.php",
          "helpers.php",
          "src/Collision/Thing.php",
          "src/Collision/ThingFunction.php",
          "src/Domain/Service.php",
        ],
        [
          { file: "src/Collision/ThingFunction.php", names: ["Thing"] },
          { file: "src/Domain/Service.php", names: ["Service"] },
        ],
        { file: "composer-type-qualified-consumer.php", line: 3, column: 37, expectedStatus: "ok" },
        { file: "src/Collision/ThingFunction.php", line: 5, column: 10, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "go",
        ["main.go", "utils.go", "helpers.go"],
        [{ file: "utils.go", names: ["HelperFunction", "UtilityClass"] }],
        { file: "main.go", line: 12, column: 20, expectedStatus: "ok" },
        { file: "utils.go", line: 9, column: 6, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "go",
        ["aliased-types.go", "dot-imports.go", "interfaces.go", "utils.go", "helpers.go"],
        [{ file: "utils.go", names: ["UtilityClass", "NewUtilityClass"] }],
        { file: "aliased-types.go", line: 8, column: 22, expectedStatus: "ok" },
        { file: "utils.go", line: 9, column: 6, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["main.java", "utils/Utils.java", "helpers/Helpers.java"],
        [{ file: "utils/Utils.java", names: ["Utils", "helperFunction"] }],
        { file: "main.java", line: 8, column: 11, expectedStatus: "ok" },
        { file: "utils/Utils.java", line: 4, column: 22, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["WildcardImports.java", "pkg/PackageTypes.java", "pkg/PackageService.java"],
        [
          { file: "pkg/PackageTypes.java", names: ["PackageTypes", "NestedValue", "ServiceContract"] },
          { file: "pkg/PackageService.java", names: ["PackageService"] },
        ],
        { file: "WildcardImports.java", line: 8, column: 3, expectedStatus: "ok" },
        { file: "pkg/PackageTypes.java", line: 7, column: 11, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["StaticWildcardImports.java", "utils/Utils.java"],
        [{ file: "utils/Utils.java", names: ["Utils", "helperFunction"] }],
        { file: "StaticWildcardImports.java", line: 7, column: 5, expectedStatus: "ok" },
        { file: "utils/Utils.java", line: 4, column: 22, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["ResolutionImports.java", "demo/Point.java", "demo/A.java"],
        [{ file: "demo/Point.java", names: ["Point"] }],
        { file: "ResolutionImports.java", line: 5, column: 3, expectedStatus: "ok" },
        { file: "demo/Point.java", line: 3, column: 15, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "csharp",
        ["Main.cs", "Utils.cs", "Helpers.cs"],
        [{ file: "Utils.cs", names: ["UtilsClass", "HelperFunction"] }],
        { file: "Main.cs", line: 7, column: 16, expectedStatus: "ok" },
        { file: "Utils.cs", line: 3, column: 24, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "csharp",
        ["NamespaceAlias.cs"],
        undefined,
        { file: "NamespaceAlias.cs", line: 3, column: 20, expectedStatus: "ok" },
        { file: "NamespaceAlias.cs", line: 3, column: 20, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        ["main.rs", "utils.rs", "helpers.rs"],
        [{ file: "utils.rs", names: ["helper_function", "UtilityStruct"] }],
        { file: "main.rs", line: 8, column: 5, expectedStatus: "ok" },
        { file: "utils.rs", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        ["aliased-use.rs", "utils.rs", "helpers.rs"],
        [{ file: "utils.rs", names: ["helper_function", "UtilityStruct"] }],
        { file: "aliased-use.rs", line: 9, column: 5, expectedStatus: "ok" },
        { file: "utils.rs", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        ["nested.rs", "nested_service.rs", "reexports.rs", "utils.rs", "helpers.rs"],
        [{ file: "nested_service.rs", names: ["NestedRunner"] }],
        { file: "nested.rs", line: 6, column: 18, expectedStatus: "ok" },
        { file: "nested_service.rs", line: 1, column: 12, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        ["extern-crate.rs", "utils.rs"],
        [{ file: "utils.rs", names: ["helper_function", "UtilityStruct"] }],
        { file: "extern-crate.rs", line: 6, column: 5, expectedStatus: "ok" },
        { file: "utils.rs", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "kotlin",
        ["main.kt", "utils/helperFunction.kt", "helpers/helperFromHelpers.kt"],
        [{ file: "utils/helperFunction.kt", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.kt", line: 7, column: 17, expectedStatus: "ok" },
        { file: "utils/helperFunction.kt", line: 7, column: 7, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "kotlin",
        ["Aliases.kt", "TypeConsumers.kt", "utils/MoreTypes.kt", "utils/helperFunction.kt"],
        [{ file: "utils/MoreTypes.kt", names: ["UtilityAlias", "UtilityFactory", "CompanionCarrier"] }],
        { file: "TypeConsumers.kt", line: 3, column: 21, expectedStatus: "ok" },
        { file: "utils/MoreTypes.kt", line: 3, column: 11, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "swift",
        ["main.swift", "Utils.swift", "Helpers.swift"],
        [{ file: "Utils.swift", names: ["helperFunction", "UtilityStruct"] }],
        { file: "main.swift", line: 5, column: 21, expectedStatus: "ok" },
        { file: "Utils.swift", line: 1, column: 13, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "swift",
        ["AdvancedUsage.swift", "StaticMembers.swift", "Utils.swift"],
        [{ file: "StaticMembers.swift", names: ["UtilityFactory", "build"] }],
        { file: "AdvancedUsage.swift", line: 4, column: 10, expectedStatus: "ok" },
        { file: "StaticMembers.swift", line: 6, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "zig",
        ["main.zig", "helpers.zig", "math.zig"],
        [
          { file: "helpers.zig", names: ["helper"] },
          { file: "math.zig", names: ["Number"] },
        ],
        { file: "main.zig", line: 5, column: 43, expectedStatus: "ok" },
        { file: "helpers.zig", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "c",
        ["main.c", "utils.h", "utils.c", "helpers.h", "helpers.c"],
        [{ file: "utils.h", names: ["helper_function", "Utility"] }],
        { file: "main.c", line: 5, column: 15, expectedStatus: "ok" },
        { file: "utils.h", line: 4, column: 16, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "c",
        ["advanced-use.c", "function-pointers.h", "function-pointers.c"],
        [{ file: "function-pointers.h", names: ["Comparator", "AdvancedState", "compare_values"] }],
        { file: "advanced-use.c", line: 4, column: 3, expectedStatus: "ok" },
        { file: "function-pointers.h", line: 3, column: 15, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "cpp",
        ["main.cpp", "utils.hpp", "helpers.hpp"],
        [{ file: "utils.hpp", names: ["helperFunction", "UtilityClass"] }],
        { file: "main.cpp", line: 5, column: 15, expectedStatus: "ok" },
        { file: "utils.hpp", line: 7, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "cpp",
        ["namespace-usage.cpp", "namespaces.hpp"],
        [{ file: "namespaces.hpp", names: ["toolkit", "Widget", "buildWidget"] }],
        { file: "namespace-usage.cpp", line: 4, column: 12, expectedStatus: "ok" },
        { file: "namespaces.hpp", line: 4, column: 7, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "ruby",
        ["main.rb", "utils.rb", "helpers.rb"],
        [{ file: "utils.rb", names: ["helper_function", "UtilityClass"] }],
        { file: "main.rb", line: 4, column: 7, expectedStatus: "ok" },
        { file: "utils.rb", line: 2, column: 12, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "ruby",
        ["consumer.rb", "namespaced.rb"],
        [{ file: "namespaced.rb", names: ["Outer", "Inner", "Tool"] }],
        { file: "consumer.rb", line: 3, column: 22, expectedStatus: "ok" },
        { file: "namespaced.rb", line: 5, column: 11, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "html",
        ["index.html", "about.html", "app.js", "inline-helper.js", "styles.css"],
        undefined,
        { file: "index.html", line: 10, column: 14, expectedStatus: "not_found" },
        { file: "index.html", line: 10, column: 14, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "html",
        ["modules.html", "app.js", "about.html"],
        undefined,
        { file: "modules.html", line: 3, column: 18, expectedStatus: "not_found" },
        { file: "modules.html", line: 3, column: 18, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "css",
        ["main.css", "base.css", "theme.css"],
        undefined,
        { file: "base.css", line: 1, column: 2, expectedStatus: "not_found" },
        { file: "base.css", line: 1, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "less",
        ["main.less", "variables.less", "theme.less"],
        undefined,
        { file: "variables.less", line: 1, column: 2, expectedStatus: "not_found" },
        { file: "variables.less", line: 1, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "less",
        ["secondary.less", "variables.less"],
        undefined,
        { file: "secondary.less", line: 1, column: 2, expectedStatus: "not_found" },
        { file: "secondary.less", line: 1, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "scss",
        [
          "main.scss",
          "use-partials.scss",
          "extensionless-forward.scss",
          "extensionless-import.scss",
          "_variables.scss",
          "_mixins.scss",
          "_tokens.scss",
          "_tokens.ts",
          "_icons.scss",
        ],
        undefined,
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "scss",
        ["forward.scss", "_variables.scss", "_mixins.scss"],
        undefined,
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "vue",
        ["App.vue", "ExternalScripts.vue", "Child.vue", "logic.ts", "extra.ts"],
        undefined,
        { file: "App.vue", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "App.vue", line: 2, column: 17, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "vue",
        ["TsScript.vue", "Child.vue", "logic.ts"],
        undefined,
        { file: "TsScript.vue", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "TsScript.vue", line: 2, column: 17, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "svelte",
        ["App.svelte", "ExternalScripts.svelte", "Widget.svelte", "logic.ts", "extra.ts"],
        undefined,
        { file: "App.svelte", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "App.svelte", line: 2, column: 17, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "svelte",
        ["TypeScriptWidget.svelte", "Widget.svelte", "logic.ts"],
        undefined,
        { file: "TypeScriptWidget.svelte", line: 2, column: 17, expectedStatus: "not_found" },
        { file: "TypeScriptWidget.svelte", line: 2, column: 17, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "language-regressions/python",
        ["match_bindings.py", "stubs.pyi", "stub_consumer.py"],
        [
          { file: "match_bindings.py", names: ["x", "y", "w"] },
          { file: "stubs.pyi", names: ["StubType", "stub_function"] },
        ],
        { file: "stub_consumer.py", line: 4, column: 10, expectedStatus: "ok" },
        { file: "stubs.pyi", line: 5, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "sql/graph",
        ["001_create_users.sql", "002_alter_users.sql", "report.sql"],
        [{ file: "001_create_users.sql", names: ["users"] }],
        { file: "report.sql", line: 1, column: 25, expectedStatus: "ok" },
        { file: "001_create_users.sql", line: 1, column: 16, expectedStatus: "ok" },
        [
          { file: "001_create_users.sql", facts: [{ kind: "defines_table", objectName: "users" }] },
          { file: "002_alter_users.sql", facts: [{ kind: "alters_table", objectName: "users" }] },
          { file: "report.sql", facts: [{ kind: "reads_from", objectName: "users" }] },
        ],
      ),
      sampleExpectation(
        "sql/graph",
        ["qualified_schema.sql", "qualified_report.sql"],
        [{ file: "qualified_schema.sql", names: ["public.users"] }],
        { file: "qualified_report.sql", line: 1, column: 25, expectedStatus: "ok" },
        { file: "qualified_schema.sql", line: 1, column: 22, expectedStatus: "ok" },
        [
          { file: "qualified_schema.sql", facts: [{ kind: "defines_table", objectName: "public.users" }] },
          { file: "qualified_report.sql", facts: [{ kind: "reads_from", objectName: "public.users" }] },
        ],
      ),
      sampleExpectation(
        "sql/facts",
        ["schema.sql", "nested_ctes.sql"],
        [
          {
            file: "schema.sql",
            names: ["users", "active_users", "users_org_idx"],
          },
        ],
        { file: "nested_ctes.sql", line: 7, column: 20, expectedStatus: "ok" },
        { file: "schema.sql", line: 1, column: 14, expectedStatus: "ok" },
        [
          {
            file: "schema.sql",
            facts: [
              { kind: "defines_table", objectName: "users" },
              { kind: "defines_view", objectName: "active_users" },
              { kind: "defines_index", objectName: "users_org_idx", relatedObjectName: "users" },
            ],
          },
          {
            file: "nested_ctes.sql",
            facts: [
              { kind: "reads_from", objectName: "accounts" },
              { kind: "reads_from", objectName: "users" },
            ],
          },
        ],
      ),
      sampleExpectation(
        "sql/graph",
        ["001_create_users.sql", "report.sql"],
        [{ file: "001_create_users.sql", names: ["users"] }],
        { file: "report.sql", line: 1, column: 8, expectedStatus: "not_found" },
        { file: "report.sql", line: 1, column: 8, expectedStatus: "not_found" },
      ),
      sampleExpectation(
        "rust",
        [".regressions/macros.rs"],
        [{ file: ".regressions/macros.rs", names: ["make_answer"] }],
        { file: ".regressions/macros.rs", line: 6, column: 5, expectedStatus: "ok" },
        { file: ".regressions/macros.rs", line: 1, column: 14, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "python",
        [".regressions/unicode_def.py", ".regressions/unicode_consumer.py"],
        [{ file: ".regressions/unicode_def.py", names: ["x", "créer"] }],
        { file: ".regressions/unicode_consumer.py", line: 3, column: 1, expectedStatus: "ok" },
        { file: ".regressions/unicode_def.py", line: 2, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        [".regressions/unicode_def.java", ".regressions/unicode_consumer.java"],
        [{ file: ".regressions/unicode_def.java", names: ["Café"] }],
        { file: ".regressions/unicode_consumer.java", line: 7, column: 12, expectedStatus: "ok" },
        { file: ".regressions/unicode_def.java", line: 3, column: 7, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "kotlin",
        [".regressions/unicode_def.kt", ".regressions/unicode_consumer.kt"],
        [{ file: ".regressions/unicode_def.kt", names: ["créer"] }],
        { file: ".regressions/unicode_consumer.kt", line: 6, column: 10, expectedStatus: "ok" },
        { file: ".regressions/unicode_def.kt", line: 3, column: 5, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "go",
        [".regressions/unicodepkg.go", ".regressions/unicode_consumer.go"],
        [{ file: ".regressions/unicodepkg.go", names: ["Créer"] }],
        { file: ".regressions/unicode_consumer.go", line: 6, column: 5, expectedStatus: "ok" },
        { file: ".regressions/unicodepkg.go", line: 3, column: 6, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "php",
        ["src/Collision/unicode_def.php", "src/Collision/unicode_consumer.php"],
        [{ file: "src/Collision/unicode_def.php", names: ["Créer"] }],
        { file: "src/Collision/unicode_consumer.php", line: 7, column: 1, expectedStatus: "ok" },
        { file: "src/Collision/unicode_def.php", line: 5, column: 10, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "rust",
        [".regressions/unicode_def.rs", ".regressions/unicode_consumer.rs"],
        [{ file: ".regressions/unicode_def.rs", names: ["créer"] }],
        { file: ".regressions/unicode_consumer.rs", line: 6, column: 5, expectedStatus: "ok" },
        { file: ".regressions/unicode_def.rs", line: 1, column: 8, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "java",
        ["AnnotationConsumer.java", "AnnotationTypes.java"],
        [{ file: "AnnotationTypes.java", names: ["AnnotatedMarker"] }],
        { file: "AnnotationConsumer.java", line: 5, column: 2, expectedStatus: "ok" },
        { file: "AnnotationTypes.java", line: 3, column: 19, expectedStatus: "ok" },
      ),
    ];

    for (const testCase of cases) {
      await expectNativeSemantics(testCase);
    }
  }, 60_000);

  it("keeps native semantics stable for normalization-sensitive TypeScript export assignment", async () => {
    const testCase = await createTypeScriptNormalizationCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native SQL ambiguous basename fallback as an explicit non-result", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-sql-ambiguous-"));
    tempDirs.push(root);
    const schemaFile = path.join(root, "schema.sql");
    const reportFile = path.join(root, "report.sql");
    await fsp.writeFile(
      schemaFile,
      ["CREATE TABLE schema1.users (id integer);", "CREATE TABLE schema2.users (id integer);"].join("\n"),
      "utf8",
    );
    const query = "SELECT users.id FROM schema1.users;";
    await fsp.writeFile(reportFile, query, "utf8");

    await expectNativeSemantics({
      root,
      files: [schemaFile, reportFile],
      symbols: [
        {
          file: schemaFile,
          names: ["schema1.users", "schema2.users"],
        },
      ],
      sqlFacts: [
        {
          file: schemaFile,
          facts: [
            { kind: "defines_table", objectName: "schema1.users" },
            { kind: "defines_table", objectName: "schema2.users" },
          ],
        },
        {
          file: reportFile,
          facts: [{ kind: "reads_from", objectName: "schema1.users" }],
        },
      ],
      goto: {
        file: reportFile,
        line: 1,
        column: query.indexOf("users.id") + 1,
        expectedStatus: "not_found",
      },
      references: {
        file: reportFile,
        line: 1,
        column: query.indexOf("users.id") + 1,
        expectedStatus: "not_found",
      },
    });
  });
});
