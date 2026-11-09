import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  extractSqlFactsFromSource,
  findReferences,
  goToDefinition,
  listSymbols,
  SymbolKind,
  type ProjectIndex,
  type SqlFactKind,
} from "../src/index.js";
import { resolveExport } from "../src/indexer/navigation-resolve.js";
import { defNodeId } from "../src/graphs/symbol-graph.js";
import * as nativeRuntime from "../src/native/tree-sitter-native.js";
import { findImplementations } from "../src/indexer/type-hierarchy.js";
import { KOTLIN_UNICODE_FILES, KOTLIN_UNICODE_LINES, KOTLIN_UNICODE_NAMES } from "./helpers/kotlin-unicode-fixture.js";
import { INTERFACE_INHERITANCE_FIXTURES, expectInterfaceInheritance } from "./helpers/interface-inheritance-fixture.js";
import { QUALIFIED_BASE_FIXTURES, expectQualifiedBases } from "./helpers/qualified-base-fixture.js";
import { PYTHON_DOTTED_IMPORT_FILES, expectPythonDottedImports } from "./helpers/python-dotted-import-fixture.js";
import {
  KOTLIN_SECONDARY_CONSTRUCTOR_FILES,
  expectKotlinSecondaryConstructorHierarchy,
} from "./helpers/kotlin-secondary-constructor-fixture.js";
import {
  KOTLIN_QUOTED_BOUNDARY_FILES,
  KOTLIN_QUOTED_BOUNDARY_LINES,
  KOTLIN_QUOTED_FILES,
  KOTLIN_QUOTED_LINES,
  KOTLIN_QUOTED_SCOPE_FILES,
  KOTLIN_QUOTED_SCOPE_LINES,
} from "./helpers/kotlin-quoted-fixture.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import { JVM_PACKAGE_IMPORT_CASES, JVM_PACKAGE_IMPORT_SOURCES } from "./helpers/jvm-package-import-fixture.js";
import { KOTLIN_DEFAULT_PACKAGE_SOURCES } from "./helpers/kotlin-default-package-fixture.js";
import {
  JVM_QUALIFIED_REVIEW_CASES,
  JVM_VALUE_SHADOW_CASES,
  QUALIFIED_TYPE_CASES,
} from "./helpers/qualified-type-import-fixture.js";
import {
  jvmIncompleteWildcardSources,
  JVM_INCOMPLETE_WILDCARD_CALLS,
  JVM_INCOMPLETE_WILDCARD_CALLABLE_REFERENCES,
  JVM_INCOMPLETE_WILDCARD_REFERENCES,
} from "./helpers/jvm-incomplete-wildcard-fixture.js";
import {
  expectTypeParameterReceiverRow,
  TYPE_PARAMETER_RECEIVER_ROWS,
} from "./helpers/type-parameter-receiver-fixture.js";
import {
  CSHARP_ALIAS_SHADOW_FILES,
  CSHARP_ALIAS_BOUNDARIES,
  csharpAliasBoundaryFixture,
} from "./helpers/csharp-alias-shadow-fixture.js";
import {
  CSHARP_INHERITED_ALIAS_CASES,
  CSHARP_INHERITED_ALIAS_CALL_CASES,
  CSHARP_INHERITED_TYPE_CASES,
} from "./helpers/csharp-inherited-alias-fixture.js";
import {
  expectInheritedAliasConsumers,
  expectInheritedAliasCallConsumers,
  expectInheritedTypeConsumers,
} from "./helpers/csharp-inherited-alias-assertions.js";
import { CSHARP_DOTTED_USING_CASES, expectDottedUsingConsumers } from "./helpers/csharp-dotted-using-fixture.js";
import {
  CSHARP_INSTANTIATED_RECEIVER_SCOPES,
  csharpInstantiatedReceiverFixture,
  expectInstantiatedReceiverConsumers,
} from "./helpers/csharp-instantiated-receiver-fixture.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import {
  CSHARP_NEARER_RECEIVER_CASES,
  csharpNearerReceiverFixture,
  CSHARP_QUALIFIED_RECEIVER_TYPES,
  csharpQualifiedReceiverFixture,
} from "./helpers/csharp-qualified-receiver-fixture.js";
import {
  CSHARP_ALIAS_CALL_SPELLINGS,
  CSHARP_GENERIC_ALIAS_CASES,
  csharpAliasCallFixture,
  csharpGenericAliasReceiverFixture,
} from "./helpers/csharp-alias-call-fixture.js";
import {
  RESTORED_DECLARATION_FIXTURES,
  withRestoredDeclarationImport,
} from "./helpers/restored-declaration-import-fixture.js";
import {
  DUPLICATE_DECLARATION_CASES,
  withDuplicateDeclarations,
} from "./helpers/duplicate-declaration-import-fixture.js";
import { SWIFT_QUOTED_SOURCES, swiftQuotedSite } from "./helpers/swift-quoted-fixture.js";
import {
  PHP_PATH_IMPORT_FORMS,
  PHP_PATH_MAPPINGS,
  phpPathFallbackFixture,
} from "./helpers/php-path-fallback-fixture.js";
import {
  CSHARP_SCOPE_READ_FILES,
  CSHARP_SCOPE_READ_LINES,
  KOTLIN_TYPE_PARAMETER_FILES,
  KOTLIN_TYPE_VALUE_FILES,
  KOTLIN_TYPE_VALUE_LINES,
  KOTLIN_TYPE_VALUE_TYPE_LINES,
  kotlinTypeParameterSites,
} from "./helpers/scope-binding-read-fixtures.js";

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

async function buildSemanticIndex(expectation: SemanticExpectation): Promise<ProjectIndex> {
  return await buildProjectIndexFromFiles(expectation.root, expectation.files.map(normalizeFile));
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
    ...(symbols
      ? {
          symbols: symbols.map((expectation) => ({
            file: path.join(root, expectation.file),
            names: expectation.names,
          })),
        }
      : {}),
    ...(sqlFacts
      ? {
          sqlFacts: sqlFacts.map((expectation) => ({
            file: path.join(root, expectation.file),
            facts: expectation.facts,
          })),
        }
      : {}),
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

async function expectNativeSemantics(expectation: SemanticExpectation): Promise<ProjectIndex> {
  const nativeIndex = await buildSemanticIndex(expectation);

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
  return nativeIndex;
}

async function createRustPathAttributeCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "native-rust-path"\nversion = "0.1.0"\n');
  const libFile = path.join(src, "lib.rs");
  const customFile = path.join(src, "custom.rs");
  const decoyFile = path.join(src, "external.rs");
  const consumerFile = path.join(src, "consumer.rs");
  const importerDecoy = path.join(src, "decoy.rs");
  await fsp.writeFile(libFile, '#[path = "custom.rs"]\nmod external;\npub mod consumer;\n');
  await fsp.writeFile(customFile, "pub struct Thing;\n");
  await fsp.writeFile(decoyFile, "pub struct Decoy;\n");
  await fsp.writeFile(importerDecoy, "pub struct Thing;\n");
  await fsp.writeFile(
    consumerFile,
    [
      "use crate::external::Thing;",
      '#[path = "decoy.rs"]',
      "mod external;",
      "pub fn consume() {",
      "    let _t = Thing;",
      "}",
      "",
    ].join("\n"),
  );

  return {
    root,
    files: [libFile, customFile, decoyFile, consumerFile, importerDecoy],
    symbols: [
      {
        file: customFile,
        names: ["Thing"],
      },
    ],
    goto: {
      file: consumerFile,
      line: 5,
      column: "    let _t = Thing;".indexOf("Thing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: customFile,
      line: 1,
      column: 12,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner"\nversion = "0.1.0"\n');
  const libFile = path.join(src, "lib.rs");
  const realFile = path.join(src, "real.rs");
  const orphanFile = path.join(src, "aaa_orphan.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(libFile, "mod real;\npub struct RootThing;\n");
  await fsp.writeFile(realFile, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
  await fsp.writeFile(orphanFile, '#[path = "shared.rs"]\nmod shared;\npub struct OrphanThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::RealThing;", "pub fn take() -> RealThing {", "    RealThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [libFile, realFile, orphanFile, sharedFile],
    symbols: [
      {
        file: realFile,
        names: ["RealThing"],
      },
    ],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    RealThing".indexOf("RealThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: realFile,
      line: 3,
      column: "pub struct RealThing;".indexOf("RealThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerAmbiguousCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-ambiguous-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner-ambiguous"\nversion = "0.1.0"\n');
  const libFile = path.join(src, "lib.rs");
  const oneFile = path.join(src, "one.rs");
  const twoFile = path.join(src, "two.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(libFile, "mod one;\nmod two;\n");
  await fsp.writeFile(oneFile, '#[path = "shared.rs"]\nmod shared;\npub struct OneThing;\n');
  await fsp.writeFile(twoFile, '#[path = "shared.rs"]\nmod shared;\npub struct TwoThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::OneThing;", "pub fn take() -> OneThing {", "    OneThing", "}", ""].join("\n"),
  );
  const usageColumn = "    OneThing".indexOf("OneThing") + 1;

  return {
    root,
    files: [libFile, oneFile, twoFile, sharedFile],
    symbols: [
      {
        file: oneFile,
        names: ["OneThing"],
      },
    ],
    goto: {
      file: sharedFile,
      line: 3,
      column: usageColumn,
      expectedStatus: "not_found",
    },
    references: {
      file: sharedFile,
      line: 3,
      column: usageColumn,
      expectedStatus: "not_found",
    },
  };
}

async function createRustPathOwnerCustomLibCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-custom-lib-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  const customDir = path.join(root, "custom");
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(customDir, { recursive: true });
  await fsp.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "path-owner-custom-lib"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
  );
  const customFile = path.join(customDir, "root.rs");
  const strayLib = path.join(src, "lib.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(customFile, '#[path = "../src/shared.rs"]\nmod shared;\npub struct CustomThing;\n');
  await fsp.writeFile(strayLib, '#[path = "shared.rs"]\nmod shared;\npub struct StrayThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::CustomThing;", "pub fn take() -> CustomThing {", "    CustomThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [customFile, strayLib, sharedFile],
    symbols: [
      {
        file: customFile,
        names: ["CustomThing"],
      },
    ],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    CustomThing".indexOf("CustomThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: customFile,
      line: 3,
      column: "pub struct CustomThing;".indexOf("CustomThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerAutobinsCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-autobins-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "path-owner-autobins"\nversion = "0.1.0"\nautobins = false\n',
  );
  const libFile = path.join(src, "lib.rs");
  const realFile = path.join(src, "real.rs");
  const mainFile = path.join(src, "main.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(libFile, "mod real;\n");
  await fsp.writeFile(realFile, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
  await fsp.writeFile(mainFile, '#[path = "shared.rs"]\nmod shared;\nfn main() {}\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::RealThing;", "pub fn take() -> RealThing {", "    RealThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [libFile, realFile, mainFile, sharedFile],
    symbols: [
      {
        file: realFile,
        names: ["RealThing"],
      },
    ],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    RealThing".indexOf("RealThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: realFile,
      line: 3,
      column: "pub struct RealThing;".indexOf("RealThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerNamedBinCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-named-bin-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  const binDir = path.join(src, "bin");
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "named-bin"\nversion = "0.1.0"\nautobins = false\nautolib = false\n\n[[bin]]\nname = "tool"\n',
  );
  const ownerFile = path.join(binDir, "tool.rs");
  const decoyFile = path.join(src, "aaa_decoy.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(ownerFile, '#[path = "../shared.rs"]\nmod shared;\npub struct NamedThing;\n');
  await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::NamedThing;", "pub fn take() -> NamedThing {", "    NamedThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [ownerFile, decoyFile, sharedFile],
    symbols: [{ file: ownerFile, names: ["NamedThing"] }],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    NamedThing".indexOf("NamedThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: ownerFile,
      line: 3,
      column: "pub struct NamedThing;".indexOf("NamedThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerExplicitLibCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-explicit-lib-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "explicit-lib"\nversion = "0.1.0"\nautolib = false\n\n[lib]\n',
  );
  const libFile = path.join(src, "lib.rs");
  const decoyFile = path.join(src, "aaa_decoy.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(libFile, '#[path = "shared.rs"]\nmod shared;\npub struct LibThing;\n');
  await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::LibThing;", "pub fn take() -> LibThing {", "    LibThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [libFile, decoyFile, sharedFile],
    symbols: [{ file: libFile, names: ["LibThing"] }],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    LibThing".indexOf("LibThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: libFile,
      line: 3,
      column: "pub struct LibThing;".indexOf("LibThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerVirtualWorkspaceCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-virtual-ws-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  const pkgSrc = path.join(root, "pkg", "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(pkgSrc, { recursive: true });
  await fsp.writeFile(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["pkg"]\n');
  await fsp.writeFile(path.join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\nversion = "0.1.0"\n');
  await fsp.writeFile(path.join(pkgSrc, "lib.rs"), "");
  const strayBuild = path.join(root, "build.rs");
  const ownerFile = path.join(src, "aaa_owner.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(strayBuild, '#[path = "src/shared.rs"]\nmod shared;\npub struct WorkspaceThing;\n');
  await fsp.writeFile(ownerFile, '#[path = "shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::OwnerThing;", "pub fn take() -> OwnerThing {", "    OwnerThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [strayBuild, ownerFile, sharedFile],
    symbols: [{ file: ownerFile, names: ["OwnerThing"] }],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    OwnerThing".indexOf("OwnerThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: ownerFile,
      line: 3,
      column: "pub struct OwnerThing;".indexOf("OwnerThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerCustomChildCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-custom-child-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  const customDir = path.join(root, "custom");
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(path.join(customDir, "root"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "custom-child"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
  );
  const customRoot = path.join(customDir, "root.rs");
  const ownerFile = path.join(customDir, "owner.rs");
  const nestedDecoy = path.join(customDir, "root", "owner.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(customRoot, "mod owner;\n");
  await fsp.writeFile(ownerFile, '#[path = "../src/shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
  await fsp.writeFile(nestedDecoy, '#[path = "../../src/shared.rs"]\nmod shared;\npub struct NestedThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::OwnerThing;", "pub fn take() -> OwnerThing {", "    OwnerThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [customRoot, ownerFile, nestedDecoy, sharedFile],
    symbols: [{ file: ownerFile, names: ["OwnerThing"] }],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    OwnerThing".indexOf("OwnerThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: ownerFile,
      line: 3,
      column: "pub struct OwnerThing;".indexOf("OwnerThing") + 1,
      expectedStatus: "ok",
    },
  };
}

async function createRustPathOwnerRawIdentCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-rust-path-owner-raw-ident-"));
  tempDirs.push(root);
  const src = path.join(root, "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "raw-ident"\nversion = "0.1.0"\n');
  const libFile = path.join(src, "lib.rs");
  const typeFile = path.join(src, "type.rs");
  const decoyFile = path.join(src, "aaa_decoy.rs");
  const sharedFile = path.join(src, "shared.rs");
  await fsp.writeFile(libFile, "mod r#type;\n");
  await fsp.writeFile(typeFile, '#[path = "shared.rs"]\nmod shared;\npub struct TypeThing;\n');
  await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
  await fsp.writeFile(
    sharedFile,
    ["use super::TypeThing;", "pub fn take() -> TypeThing {", "    TypeThing", "}", ""].join("\n"),
  );

  return {
    root,
    files: [libFile, typeFile, decoyFile, sharedFile],
    symbols: [{ file: typeFile, names: ["TypeThing"] }],
    goto: {
      file: sharedFile,
      line: 3,
      column: "    TypeThing".indexOf("TypeThing") + 1,
      expectedStatus: "ok",
    },
    references: {
      file: typeFile,
      line: 3,
      column: "pub struct TypeThing;".indexOf("TypeThing") + 1,
      expectedStatus: "ok",
    },
  };
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

async function createImportedSuperclassMemberCase(kind: "ts" | "js"): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${kind}-super-imported-`));
  tempDirs.push(root);
  const baseFile = path.join(root, `base.${kind}`);
  const derivedFile = path.join(root, `derived.${kind}`);
  const typed = kind === "ts";
  const base = [
    "export default class Base {",
    typed ? "  helper(): number { return 1; }" : "  helper() { return 1; }",
    "}",
    "",
  ].join("\n");
  const derived = [
    'import Base from "./base";',
    "class Derived extends Base {",
    typed ? "  helper(): number { return 2; }" : "  helper() { return 2; }",
    typed ? "  run(): number { return super.helper(); }" : "  run() { return super.helper(); }",
    "}",
    "",
  ].join("\n");
  await fsp.writeFile(baseFile, base, "utf8");
  await fsp.writeFile(derivedFile, derived, "utf8");
  const callColumn = derived.split("\n")[3]!.indexOf("helper()") + 1;
  const defColumn = base.split("\n")[1]!.indexOf("helper()") + 1;
  return {
    root,
    files: [baseFile, derivedFile],
    goto: {
      file: derivedFile,
      line: 4,
      column: callColumn,
      expectedStatus: "ok",
    },
    references: {
      file: baseFile,
      line: 2,
      column: defColumn,
      expectedStatus: "ok",
    },
  };
}

async function createCppCallableRedeclarationCase(): Promise<SemanticExpectation> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-cpp-callable-redeclaration-"));
  tempDirs.push(root);
  const headerFile = path.join(root, "api.h");
  const implementationFile = path.join(root, "api.cpp");
  const consumerFile = path.join(root, "consumer.cpp");
  await fsp.writeFile(
    headerFile,
    [
      "namespace left { int run(int values[]);",
      "int pick();",
      "int pick(int);",
      "}",
      "namespace alias { inline namespace v1 { using left::pick; } }",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    implementationFile,
    ['#include "api.h"', "int left::run(int* value) { return *value; }", ""].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    consumerFile,
    [
      '#include "api.h"',
      "int call() { return left::run(nullptr); }",
      "int invalid() { return run(nullptr); }",
      "int missing() { return left::run(); }",
      "int extra() { return left::run(nullptr, nullptr); }",
      "int zero() { return alias::pick(); }",
      "int one() { return alias::pick(1); }",
      "int two() { return alias::pick(1, 2); }",
      "using left::pick;",
      "int direct_zero() { return pick(); }",
      "int direct_one() { return pick(1); }",
      "int direct_invalid() { return pick(1, 2); }",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    root,
    files: [headerFile, implementationFile, consumerFile],
    symbols: [{ file: headerFile, names: ["left", "run"] }],
    goto: { file: consumerFile, line: 2, column: 27, expectedStatus: "ok" },
    references: { file: headerFile, line: 1, column: 22, expectedStatus: "ok" },
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
        ["WildcardImports.java", "pkg/PackageTypes.java", "pkg/PackageService.java", "pkg/ServiceContract.java"],
        [
          { file: "pkg/PackageTypes.java", names: ["PackageTypes", "NestedValue"] },
          { file: "pkg/ServiceContract.java", names: ["ServiceContract"] },
          { file: "pkg/PackageService.java", names: ["PackageService"] },
        ],
        { file: "WildcardImports.java", line: 8, column: 3, expectedStatus: "ok" },
        { file: "pkg/ServiceContract.java", line: 3, column: 18, expectedStatus: "ok" },
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
        { file: "utils.h", line: 6, column: 3, expectedStatus: "ok" },
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
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
        // `.primary` is now a navigable SCSS selector local: the symbol queries used to be
        // blanked wholesale for the native runtime, so nothing in a stylesheet had references.
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
      ),
      sampleExpectation(
        "scss",
        ["forward.scss", "_variables.scss", "_mixins.scss"],
        undefined,
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
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
      sampleExpectation(
        "terraform",
        [
          "main.tf",
          "variables.tf",
          "outputs.tf",
          "modules/network/main.tf",
          "modules/network/variables.tf",
          "modules/network/outputs.tf",
          "modules/storage/main.tf",
        ],
        [
          { file: "main.tf", names: ["web", "logs", "ubuntu", "network", "name_prefix"] },
          { file: "modules/network/outputs.tf", names: ["vpc_id", "subnet_id"] },
        ],
        { file: "outputs.tf", line: 6, column: 26, expectedStatus: "ok" },
        { file: "modules/network/variables.tf", line: 5, column: 11, expectedStatus: "ok" },
      ),
    ];

    for (const testCase of cases) {
      await expectNativeSemantics(testCase);
    }
    // This serial fixture matrix is CPU-bound. Under parallel native CI on Windows,
    // deterministic assertions can exceed 60 seconds, so retain headroom for host variance.
  }, 120_000);

  it("keeps native C# alias calls off dynamic bindings while retaining visible aliases and typed receivers", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-alias-shadow-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, CSHARP_ALIAS_SHADOW_FILES);
    const index = await buildProjectIndexFromFiles(root, Object.values(files), { cache: "off" });
    for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
    const graph = await buildSymbolGraphDetailed(index);
    const edges = graph.edges.flatMap((edge) => {
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      if (from?.file !== files["Use.cs"] || !to) return [];
      if (to.file !== files["Second.cs"] && to.file !== files["Plain.cs"]) return [];
      if (edge.label !== "calls" && edge.label !== "uses") return [];
      return [`${from.name} ${edge.label} ${path.basename(to.file)}::${to.name}`];
    });
    for (const site of [
      "Visible calls Second.cs::Run",
      "Local calls Second.cs::Run",
      "Outer calls Plain.cs::Run",
      "Outside calls Plain.cs::Run",
      "Typed calls Second.cs::Act",
    ]) {
      expect(edges).toContain(site);
    }
    expect(edges.filter((edge) => edge.startsWith("Parameter ") || edge.startsWith("Unused "))).toEqual([]);
    expect(edges.filter((edge) => edge === "Local calls Second.cs::Run")).toHaveLength(1);
  });

  it.each(CSHARP_INSTANTIATED_RECEIVER_SCOPES)(
    "keeps native C# generic receiver arities on disk reload (%s)",
    async (scope) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-instantiated-"));
      tempDirs.push(root);
      const fixture = csharpInstantiatedReceiverFixture(scope);
      const files = await writeFixtureFiles(root, fixture.files);
      for (let build = 0; build < 2; build += 1) {
        const index = await buildProjectIndex(root, { cache: "disk" });
        await expectInstantiatedReceiverConsumers(index, files, fixture);
        clearMemoryCache();
      }
    },
  );

  it.each(CSHARP_DOTTED_USING_CASES)("keeps native C# dotted roots on $name after disk reload", async (testCase) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-dotted-using-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, testCase.files);
    for (let build = 0; build < 2; build += 1) {
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) {
        expect(module.nativeOutcome).toBe("used");
        expect(module.parseErrorRanges).toEqual([]);
      }
      await expectDottedUsingConsumers(index, files, testCase);
      clearMemoryCache();
    }
  });

  it.each(CSHARP_INHERITED_ALIAS_CASES)(
    "keeps native C# $name before a using alias on disk reload ($outcome)",
    async (testCase) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-inherited-alias-"));
      tempDirs.push(root);
      const files = await writeFixtureFiles(root, testCase.files);
      for (let build = 0; build < 2; build += 1) {
        const index = await buildProjectIndex(root, { cache: "disk" });
        for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
        await expectInheritedAliasConsumers(index, files, testCase);
      }
    },
  );

  it.each(CSHARP_INHERITED_TYPE_CASES)("keeps native C# type positions beside an inherited $name", async (testCase) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-inherited-types-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, testCase.files);
    for (let build = 0; build < 2; build += 1) {
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) {
        expect(module.nativeOutcome).toBe("used");
        expect(module.parseErrorRanges).toEqual([]);
      }
      await expectInheritedTypeConsumers(index, files, testCase);
    }
  });

  it.each(CSHARP_INHERITED_ALIAS_CALL_CASES)("keeps native C# $name on disk reload", async (testCase) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-inherited-overload-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, testCase.files);
    for (let build = 0; build < 2; build += 1) {
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      await expectInheritedAliasCallConsumers(index, files, testCase);
    }
  });

  it("keeps native C# scope-header reads and alias scope exits consistent after cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-header-reads-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, CSHARP_SCOPE_READ_FILES);
    for (const cache of ["off", "disk", "disk"] as const) {
      const index = await buildProjectIndex(root, { cache });
      for (const module of index.byFile.values()) {
        expect(module.nativeOutcome).toBe("used");
        expect(module.parseErrorRanges).toEqual([]);
      }
      for (const [line, token, target] of [
        [8, "Ping", "Second.cs"],
        [12, "Ping", "Second.cs"],
        [14, "K", "Use.cs"],
        [15, "Match", "Use.cs"],
      ] as const) {
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line,
          column: columnOf(CSHARP_SCOPE_READ_LINES, line, token),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.file).toBe(files[target]);
      }
      const references = await findReferences(index, {
        file: files["Second.cs"]!,
        line: 1,
        column: CSHARP_SCOPE_READ_FILES["Second.cs"].indexOf("Run") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
          affectedFiles: [files["Use.cs"]],
        });
        expect(
          references.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual([18, 22, 26]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "Run");
      expect(calls.map((edge) => [graph.nodes.get(edge.to)?.file, edge.site?.range.start.line])).toEqual([
        [files["Second.cs"], 18],
        [files["Second.cs"], 22],
        [files["Second.cs"], 26],
      ]);
      expect(
        graph.edges.filter(
          (edge) =>
            graph.nodes.get(edge.from)?.file === files["Use.cs"] &&
            graph.nodes.get(edge.to)?.file === files["Decoy.cs"],
        ),
      ).toEqual([]);
    }
  });

  it("keeps native Kotlin type and value namespaces separate after cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-type-values-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, KOTLIN_TYPE_VALUE_FILES);
    for (const cache of ["off", "disk", "disk"] as const) {
      const index = await buildProjectIndex(root, { cache });
      for (const module of index.byFile.values()) {
        expect(module.nativeOutcome).toBe("used");
        expect(module.parseErrorRanges).toEqual([]);
      }
      for (const line of KOTLIN_TYPE_VALUE_TYPE_LINES) {
        const result = await goToDefinition(index, {
          file: files["Use.kt"]!,
          line,
          column: KOTLIN_TYPE_VALUE_LINES[line - 1]!.lastIndexOf("Widget") + 1,
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.file).toBe(files["Api.kt"]);
      }
      const references = await findReferences(index, { file: files["Api.kt"]!, line: 2, column: 7 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.referenceCoverage.state).toBe("complete");
        expect(
          references.references.filter((site) => site.file === files["Use.kt"]).map((site) => site.range.start.line),
        ).toEqual([2, ...KOTLIN_TYPE_VALUE_TYPE_LINES]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      for (const caller of ["use", "local", "later"]) {
        expect(
          graph.edges.some(
            (edge) =>
              edge.label === "uses" &&
              graph.nodes.get(edge.from)?.name === caller &&
              graph.nodes.get(edge.to)?.file === files["Api.kt"],
          ),
        ).toBe(true);
      }
      expect(
        graph.edges.filter(
          (edge) =>
            graph.nodes.get(edge.from)?.file === files["Use.kt"] &&
            graph.nodes.get(edge.to)?.file === files["Decoy.kt"],
        ),
      ).toEqual([]);
    }
  });

  it("keeps native Kotlin type parameters ahead of a same-named import alias after cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-type-parameters-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, KOTLIN_TYPE_PARAMETER_FILES);
    for (const cache of ["off", "disk", "disk"] as const) {
      const index = await buildProjectIndex(root, { cache });
      for (const module of index.byFile.values()) {
        expect(module.nativeOutcome).toBe("used");
        expect(module.parseErrorRanges).toEqual([]);
      }
      for (const site of kotlinTypeParameterSites()) {
        const result = await goToDefinition(index, { file: files[site.file]!, line: site.line, column: site.column });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(files[site.file]);
          expect(result.definition.range.start.line).toBe(site.declaration.line);
          expect(result.definition.range.start.column).toBe(site.declaration.column);
        }
      }
      const references = await findReferences(index, { file: files["Api.kt"]!, line: 2, column: 7 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.referenceCoverage.state).toBe("complete");
        const referencedFiles = new Set(references.references.map((site) => site.file));
        expect(referencedFiles).toEqual(new Set([files["Api.kt"], files["Use.kt"], files["Alias.kt"]]));
        expect(
          references.references.filter((site) => site.file === files["Use.kt"]).map((site) => site.range.start.line),
        ).toEqual([2, 2]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const usesInto = (file: string) =>
        graph.edges.filter(
          (edge) =>
            edge.label === "uses" &&
            graph.nodes.get(edge.from)?.file === file &&
            graph.nodes.get(edge.to)?.file === files["Api.kt"],
        );
      // The import itself still reaches Widget; only type-parameter uses must not.
      expect(usesInto(files["Use.kt"]!)).toEqual([]);
      expect(usesInto(files["Plain.kt"]!)).toEqual([]);
      expect(usesInto(files["Alias.kt"]!)).toHaveLength(1);
    }
  });

  it.each(CSHARP_ALIAS_BOUNDARIES)("keeps native C# $name shadowing on disk reload", async (boundary) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-alias-boundary-"));
    tempDirs.push(root);
    const fixture = csharpAliasBoundaryFixture(boundary);
    const files = await writeFixtureFiles(root, fixture.files);
    for (let build = 0; build < 2; build += 1) {
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      const graph = await buildSymbolGraphDetailed(index);
      const aliasCalls = graph.edges.filter(
        (edge) =>
          edge.label === "calls" &&
          graph.nodes.get(edge.from)?.file === files["Use.cs"] &&
          graph.nodes.get(edge.to)?.file === files["Second.cs"],
      );
      expect(aliasCalls.map((edge) => edge.site?.range.start.line)).toEqual([fixture.visible]);
      const visible = await goToDefinition(index, {
        file: files["Use.cs"]!,
        line: fixture.visible,
        column: columnOf(fixture.lines, fixture.visible, "Run"),
      });
      expect(visible.status).toBe("ok");
      if (visible.status === "ok") expect(visible.definition.file).toBe(files["Second.cs"]);
      const references = await findReferences(index, {
        file: files["Second.cs"]!,
        line: 1,
        column: fixture.files["Second.cs"].indexOf("Run") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual([fixture.visible]);
      }
    }
  });

  it.each(["ts", "js", "tsx"])("keeps %s cycle calls separate from a shadowed parameter", async (extension) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-star-cycle-"));
    tempDirs.push(root);
    const files = await writeFixtureFiles(root, {
      [`a.${extension}`]: "export * from './b';\n",
      [`b.${extension}`]: "export * from './a';\nexport * from './def';\n",
      [`def.${extension}`]: "export function target() { return 1; }\n",
      [`consumer.${extension}`]:
        "import { target } from './a';\nexport function accepted() { return target(); }\nexport function rejected(target) { return target(); }\n",
    });
    const index = await buildProjectIndexFromFiles(
      root,
      ["consumer", "def", "b", "a"].map((name) => files[`${name}.${extension}`]!),
      { cache: "off" },
    );
    for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
    const graph = await buildSymbolGraphDetailed(index);
    const consumer = files[`consumer.${extension}`]!;
    for (const name of ["accepted", "rejected"]) {
      expect([...graph.nodes.values()].some((node) => node.file === consumer && node.name === name)).toBe(true);
    }
    expect(
      graph.edges
        .filter(
          (edge) =>
            edge.label === "calls" &&
            graph.nodes.get(edge.from)?.file === consumer &&
            graph.nodes.get(edge.to)?.file === files[`def.${extension}`],
        )
        .map((edge) => [
          graph.nodes.get(edge.from)?.name,
          graph.nodes.get(edge.to)?.file,
          graph.nodes.get(edge.to)?.name,
        ]),
    ).toEqual([["accepted", files[`def.${extension}`], "target"]]);
  });

  it("keeps native Python re-exports and C includes aligned with navigation and references", async () => {
    const cases: Array<{
      files: Record<string, string>;
      consumer: string;
      target: string;
      decoy: string;
      line: number;
      text: string;
      referenceLines: number[];
    }> = [
      {
        files: {
          "pkg/__init__.py": "# package\n",
          "pkg/left.py": "def target():\n    return 1\n",
          "pkg/right.py": "def target():\n    return 2\n",
          "pkg/inner.py": "from .left import *\nfrom .right import *\n",
          "pkg/outer.py": "from .inner import *\nfrom .right import *\n",
          "pkg/use.py": "from .outer import target\ndef run():\n    return target()\n",
        },
        consumer: "pkg/use.py",
        target: "pkg/right.py",
        decoy: "pkg/left.py",
        line: 3,
        text: "    return target()",
        referenceLines: [1, 3],
      },
      {
        files: {
          "one.h": "int target(void);\n",
          "two.h": "int target(void);\n",
          "mixed.h": '#include "one.h"\n#include "two.h"\n',
          "def.h": "int target(void) { return 1; }\n",
          "outer.h": '#include "mixed.h"\n#include "def.h"\n',
          "decoy.c": "int target(void) { return 2; }\n",
          "main.c": '#include "outer.h"\nint run(void) { return target(); }\n',
        },
        consumer: "main.c",
        target: "def.h",
        decoy: "decoy.c",
        line: 2,
        text: "int run(void) { return target(); }",
        referenceLines: [2],
      },
    ];
    for (const fixture of cases) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-nested-exports-"));
      tempDirs.push(root);
      const files = await writeFixtureFiles(root, fixture.files);
      const index = await buildProjectIndexFromFiles(root, Object.values(files), { cache: "off" });
      expect(index.byFile.size).toBe(Object.keys(files).length);
      for (const file of Object.values(files)) {
        expect(index.byFile.get(fileIdentityKey(file))?.nativeOutcome, file).toBe("used");
      }
      const goto = await goToDefinition(index, {
        file: files[fixture.consumer]!,
        line: fixture.line,
        column: fixture.text.indexOf("target") + 1,
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.file).toBe(files[fixture.target]);
      for (const [name, expected] of [
        [fixture.target, fixture.referenceLines],
        [fixture.decoy, []],
      ] as const) {
        const references = await findReferences(index, { file: files[name]!, line: 1, column: 5 });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error(`Expected references for ${name}`);
        expect(
          references.references
            .filter((reference) => reference.file === files[fixture.consumer])
            .map((reference) => reference.range.start.line)
            .sort(),
        ).toEqual(expected);
      }
    }
  });

  it("keeps qualified C++ ancestry and empty pack expansions in native graphs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-qualified-base-"));
    tempDirs.push(root);
    const header = normalizeFile(path.join(root, "base.hpp"));
    const consumer = normalizeFile(path.join(root, "main.cpp"));
    await fsp.writeFile(
      header,
      [
        "namespace ns { struct Base { int run() { return 1; } }; }",
        "template<class... Args> int packed(int first, Args... rest) { return first; }",
      ].join("\n"),
    );
    await fsp.writeFile(
      consumer,
      [
        '#include "base.hpp"',
        "struct Derived : public ns::Base { int relay() { return this->run(); } };",
        "struct Missing : public absent::Base { int reject() { return this->run(); } };",
        "int pack_min() { return packed(1); }",
        "int pack_bad() { return packed(); }",
      ].join("\n"),
    );
    await (async () => {
      const index = await buildProjectIndexFromFiles(root, [header, consumer]);
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges
          .filter((edge) => edge.label === "extends")
          .map((edge) => [
            graph.nodes.get(edge.from)?.name,
            graph.nodes.get(edge.to)?.name,
            graph.nodes.get(edge.to)?.file,
          ]),
      ).toEqual([["Derived", "Base", header]]);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => [
            graph.nodes.get(edge.from)?.name,
            graph.nodes.get(edge.to)?.name,
            graph.nodes.get(edge.to)?.file,
          ])
          .sort(),
      ).toEqual([
        ["pack_min", "packed", header],
        ["relay", "run", header],
      ]);
    })();
  });

  it("keeps C++ callable redeclarations connected across files", async () => {
    const fixture = await createCppCallableRedeclarationCase();
    const index = await expectNativeSemantics(fixture);
    const consumerFile = normalizeFile(fixture.files[2]!);
    const consumerLines = (await fsp.readFile(consumerFile, "utf8")).split("\n");
    for (const line of [3, 4, 5, 8, 12]) {
      const text = consumerLines[line - 1]!;
      const token = line >= 8 ? "pick" : "run";
      expect(
        await normalizeGoto(index, {
          file: consumerFile,
          line,
          column: text.indexOf(token) + 1,
          expectedStatus: "not_found",
        }),
      ).toEqual({ status: "not_found" });
    }
    for (const [line, targetLine] of [
      [6, 2],
      [7, 3],
      [10, 2],
      [11, 3],
    ] as const) {
      const result = await goToDefinition(index, {
        file: consumerFile,
        line,
        column: consumerLines[line - 1]!.indexOf("pick") + 1,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected a unique C++ using overload");
      expect(normalizeFile(result.definition.file)).toBe(normalizeFile(fixture.files[0]!));
      expect(result.definition.range.start.line).toBe(targetLine);
      const references = await findReferences(index, {
        file: fixture.files[0]!,
        line: targetLine,
        column: 5,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected C++ using overload references");
      expect(
        references.references
          .filter((reference) => normalizeFile(reference.file) === consumerFile)
          .map((reference) => reference.range.start.line),
      ).toEqual(targetLine === 2 ? [6, 10] : [7, 11]);
    }
  });

  it("keeps native C tag and typedef export identities distinct", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-c-tag-typedef-"));
    tempDirs.push(root);
    const header = normalizeFile(path.join(root, "api.h"));
    const consumer = normalizeFile(path.join(root, "main.c"));
    await fsp.writeFile(header, "struct Item { int value; };\ntypedef struct Item *Item;\n", "utf8");
    await fsp.writeFile(consumer, '#include "api.h"\nstruct Item item;\nItem alias;\n', "utf8");
    const index = await (() => buildProjectIndexFromFiles(root, [header, consumer], { cache: "off" }))();
    for (const [kind, line] of [
      [SymbolKind.Class, 1],
      [SymbolKind.TypeAlias, 2],
    ] as const) {
      const resolved = resolveExport(index, header, "Item", { preferredKind: kind, allowLocalFallback: false });
      expect(resolved?.kind).toBe("resolved");
      if (resolved?.kind !== "resolved") throw new Error("Expected a distinct C export");
      expect(resolved.def.kind).toBe(kind);
      expect(resolved.def.range.start.line).toBe(line);
    }
  });

  it("keeps native C tag and typedef navigation in separate namespaces", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-c-tag-namespace-"));
    tempDirs.push(root);
    const header = normalizeFile(path.join(root, "api.h"));
    const consumer = normalizeFile(path.join(root, "main.c"));
    // Same spellings for struct/union/enum tags and ordinary typedefs, each on its own line, plus
    // a local ordinary shadow that must not hide the tag.
    const headerLines = [
      "struct Item { int value; };",
      "typedef struct Item Item;",
      "union Value { int raw; };",
      "typedef union Value Value;",
      "enum Color { COLOR_RED };",
      "typedef enum Color Color;",
      "",
      "struct Item header_item_tag;",
      "Item header_item_alias;",
      "union Value header_value_tag;",
      "Value header_value_alias;",
      "enum Color header_color_tag;",
      "Color header_color_alias;",
      "",
    ];
    const consumerLines = [
      '#include "api.h"',
      "struct Item consumer_item_tag;",
      "Item consumer_item_alias;",
      "union Value consumer_value_tag;",
      "Value consumer_value_alias;",
      "enum Color consumer_color_tag;",
      "Color consumer_color_alias;",
      "int touch(void) {",
      "  int Item = 0;",
      "  struct Item shadow_item_tag;",
      "  return Item;",
      "}",
      "struct Item; union Value; enum Color;",
    ];
    await fsp.writeFile(header, headerLines.join("\n"), "utf8");
    await fsp.writeFile(consumer, consumerLines.join("\n"), "utf8");
    const index = await (() => buildProjectIndexFromFiles(root, [header, consumer], { cache: "off" }))();

    const tokenColumn = (lines: readonly string[], line: number, token: string, occurrence = 0): number => {
      const text = lines[line - 1]!;
      let at = -1;
      for (let seen = 0; seen <= occurrence; seen += 1) {
        at = text.indexOf(token, at + 1);
      }
      return at + 1;
    };
    const names: ReadonlyArray<{
      name: string;
      tagLine: number;
      typedefLine: number;
      headerTagUseLine: number;
      headerAliasUseLine: number;
      consumerTagLine: number;
      consumerAliasLine: number;
      shadowTagLine?: number;
    }> = [
      {
        name: "Item",
        tagLine: 1,
        typedefLine: 2,
        headerTagUseLine: 8,
        headerAliasUseLine: 9,
        consumerTagLine: 2,
        consumerAliasLine: 3,
        shadowTagLine: 10,
      },
      {
        name: "Value",
        tagLine: 3,
        typedefLine: 4,
        headerTagUseLine: 10,
        headerAliasUseLine: 11,
        consumerTagLine: 4,
        consumerAliasLine: 5,
      },
      {
        name: "Color",
        tagLine: 5,
        typedefLine: 6,
        headerTagUseLine: 12,
        headerAliasUseLine: 13,
        consumerTagLine: 6,
        consumerAliasLine: 7,
      },
    ];

    const expectDefinitionAt = async (
      file: string,
      lines: readonly string[],
      line: number,
      token: string,
      occurrence: number,
      expectedFile: string,
      expectedLine: number,
      expectedColumn: number,
    ): Promise<void> => {
      const result = await goToDefinition(index, {
        file,
        line,
        column: tokenColumn(lines, line, token, occurrence),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected a definition");
      expect(normalizeFile(result.definition.file)).toBe(normalizeFile(expectedFile));
      expect(result.definition.range.start.line).toBe(expectedLine);
      expect(result.definition.range.start.column).toBe(expectedColumn);
    };

    // Tag syntax targets the tag declaration and a bare name targets the typedef, in the header
    // itself and through the include alike, including the enum tag/typedef same-kind pair.
    for (const kind of names) {
      const tagColumn = tokenColumn(headerLines, kind.tagLine, kind.name);
      const typedefColumn = tokenColumn(headerLines, kind.typedefLine, kind.name, 1);
      for (const [file, lines, tagUseLine, aliasUseLine] of [
        [header, headerLines, kind.headerTagUseLine, kind.headerAliasUseLine],
        [consumer, consumerLines, kind.consumerTagLine, kind.consumerAliasLine],
      ] as const) {
        await expectDefinitionAt(file, lines, tagUseLine, kind.name, 0, header, kind.tagLine, tagColumn);
        await expectDefinitionAt(file, lines, aliasUseLine, kind.name, 0, header, kind.typedefLine, typedefColumn);
      }
      await expectDefinitionAt(header, headerLines, kind.typedefLine, kind.name, 0, header, kind.tagLine, tagColumn);
    }

    // The local ordinary shadow hides the typedef inside the function but never the tag.
    const item = names[0]!;
    await expectDefinitionAt(
      consumer,
      consumerLines,
      item.shadowTagLine!,
      item.name,
      0,
      header,
      item.tagLine,
      tokenColumn(headerLines, item.tagLine, item.name),
    );
    await expectDefinitionAt(
      consumer,
      consumerLines,
      item.shadowTagLine! + 1,
      item.name,
      0,
      consumer,
      9,
      tokenColumn(consumerLines, 9, item.name),
    );

    const referenceSites = async (file: string, line: number, column: number) => {
      const result = await findReferences(index, { file, line, column });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected references");
      return result.references.map((reference) => ({
        file: normalizeFile(reference.file),
        line: reference.range.start.line,
        column: reference.range.start.column,
      }));
    };
    const consumerKey = normalizeFile(consumer);

    // Exact disjoint consumer sets: tag-form uses (including the shadowed one) belong to the tag,
    // bare uses to the typedef, and the shadowed local occurrences belong to neither.
    for (const kind of names) {
      const tagReferences = await referenceSites(
        header,
        kind.tagLine,
        tokenColumn(headerLines, kind.tagLine, kind.name),
      );
      const aliasReferences = await referenceSites(
        header,
        kind.typedefLine,
        tokenColumn(headerLines, kind.typedefLine, kind.name, 1),
      );
      expect(tagReferences.filter((site) => site.file === consumerKey)).toEqual([
        {
          file: consumerKey,
          line: kind.consumerTagLine,
          column: tokenColumn(consumerLines, kind.consumerTagLine, kind.name),
        },
        ...(kind.shadowTagLine === undefined
          ? []
          : [
              {
                file: consumerKey,
                line: kind.shadowTagLine,
                column: tokenColumn(consumerLines, kind.shadowTagLine, kind.name),
              },
            ]),
        {
          file: consumerKey,
          line: 13,
          column: tokenColumn(consumerLines, 13, kind.name),
        },
      ]);
      expect(aliasReferences.filter((site) => site.file === consumerKey)).toEqual([
        {
          file: consumerKey,
          line: kind.consumerAliasLine,
          column: tokenColumn(consumerLines, kind.consumerAliasLine, kind.name),
        },
      ]);
    }
  });

  it("keeps PHP type operands separate from same-spelled argument aliases", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-php-alias-roles-"));
    tempDirs.push(root);
    const source = normalizeFile(path.join(root, "source.php"));
    const consumer = normalizeFile(path.join(root, "consumer.php"));
    await fsp.writeFile(
      source,
      ["<?php namespace App;", "class Service { public $field; }", "function helper() {}", "const TOKEN = 1;"].join(
        "\n",
      ),
    );
    const lines = [
      "<?php namespace Client;",
      "use App\\Service as Alias;",
      "use function App\\helper as Alias;",
      "use const App\\TOKEN as Alias;",
      "$value = new Alias(Alias);",
      "$is = $value instanceof Alias;",
      "try {} catch (Alias $error) {}",
      "Alias();",
      "$value->field;",
      "$value->FIELD;",
    ];
    await fsp.writeFile(consumer, lines.join("\n"));
    await (async () => {
      const index = await buildProjectIndexFromFiles(root, [source, consumer]);
      const imports = listSymbols(index, { file: consumer, includeImports: true }).filter(
        (symbol) => symbol.kind === "import" && symbol.name === "Alias",
      );
      expect(new Set(imports.map((symbol) => symbol.id)).size).toBe(3);
      for (const buildGraph of [buildSymbolGraph, buildSymbolGraphDetailed]) {
        const graph = await buildGraph(index);
        const aliasEdges = graph.edges.filter((edge) => {
          const from = graph.nodes.get(edge.from);
          return from?.file === consumer && from.kind === "import" && from.name === "Alias";
        });
        expect(aliasEdges.map((edge) => graph.nodes.get(edge.to)?.name).sort()).toEqual(
          ["Service", "helper", "TOKEN"].sort(),
        );
        expect(aliasEdges.map((edge) => edge.from).sort()).toEqual(imports.map((symbol) => symbol.id).sort());
      }
      for (const [line, fromEnd, targetLine] of [
        [5, false, 2],
        [5, true, 4],
        [6, false, 2],
        [7, false, 2],
        [8, false, 3],
      ] as const) {
        const text = lines[line - 1]!;
        const column = (fromEnd ? text.lastIndexOf("Alias") : text.indexOf("Alias")) + 1;
        const result = await goToDefinition(index, { file: consumer, line, column });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected a PHP alias definition");
        expect(normalizeFile(result.definition.file)).toBe(source);
        expect(result.definition.range.start.line).toBe(targetLine);
      }
      const refs = await findReferences(index, { file: source, line: 4, column: 7 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected PHP constant references");
      expect(
        refs.references
          .filter((ref) => normalizeFile(ref.file) === consumer)
          .map((ref) => [ref.range.start.line, ref.range.start.column]),
      ).toEqual([
        [4, lines[3]!.indexOf("TOKEN") + 1],
        [4, lines[3]!.indexOf("Alias") + 1],
        [5, lines[4]!.lastIndexOf("Alias") + 1],
      ]);
      const propertyRefs = await findReferences(index, {
        file: source,
        line: 2,
        column: "class Service { public $field; }".indexOf("field") + 1,
      });
      expect(propertyRefs.status).toBe("ok");
      if (propertyRefs.status !== "ok") throw new Error("Expected PHP property references");
      expect(
        propertyRefs.references
          .filter((ref) => normalizeFile(ref.file) === consumer)
          .map((ref) => ref.range.start.line),
      ).toEqual([9]);
    })();
  });

  it("scss go-to-definition resolves indexed declaration locals", async () => {
    await expectNativeSemantics(
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
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
      ),
    );
    await expectNativeSemantics(
      sampleExpectation(
        "scss",
        ["forward.scss", "_variables.scss", "_mixins.scss"],
        undefined,
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
        { file: "_variables.scss", line: 3, column: 2, expectedStatus: "ok" },
      ),
    );
  });

  it("keeps native semantics stable for normalization-sensitive TypeScript export assignment", async () => {
    const testCase = await createTypeScriptNormalizationCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native TypeScript and JavaScript semantics aligned for an imported superclass member", async () => {
    const tsCase = await createImportedSuperclassMemberCase("ts");
    const jsCase = await createImportedSuperclassMemberCase("js");
    const snapshots: Array<{ gotoLine: number | undefined; refLines: string[] }> = [];
    for (const [kind, testCase] of [
      ["ts", tsCase],
      ["js", jsCase],
    ] as const) {
      const nativeIndex = await buildSemanticIndex(testCase);
      const nativeGoto = await normalizeGoto(nativeIndex, testCase.goto);
      const nativeRefs = await normalizeReferences(nativeIndex, testCase.references);
      const gotoSnapshot = stableGotoSnapshot(testCase.root, nativeGoto);
      const refsSnapshot = stableReferencesSnapshot(testCase.root, nativeRefs);
      expect(gotoSnapshot).toEqual({ status: "ok", file: `base.${kind}`, line: 2 });
      expect(refsSnapshot).toEqual({
        status: "ok",
        refs: [`base.${kind}:2`, `derived.${kind}:4`].sort(),
      });
      snapshots.push({
        gotoLine: gotoSnapshot.status === "ok" ? gotoSnapshot.line : undefined,
        refLines: refsSnapshot.status === "ok" ? refsSnapshot.refs.map((ref) => ref.replace(/^[^:]+:/, "")).sort() : [],
      });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  it("keeps native semantics stable for Rust path-attribute crate resolution", async () => {
    const testCase = await createRustPathAttributeCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for Rust #[path] module owner resolution from the crate tree", async () => {
    const testCase = await createRustPathOwnerCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable when a Rust #[path] target has two reachable owners", async () => {
    const testCase = await createRustPathOwnerAmbiguousCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for a custom Rust library path over a stray src/lib.rs", async () => {
    const testCase = await createRustPathOwnerCustomLibCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable when Rust autobins is false", async () => {
    const testCase = await createRustPathOwnerAutobinsCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for an explicit named Rust bin without path", async () => {
    const testCase = await createRustPathOwnerNamedBinCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for an explicit [lib] table when autolib is false", async () => {
    const testCase = await createRustPathOwnerExplicitLibCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable without treating a virtual workspace root as a package", async () => {
    const testCase = await createRustPathOwnerVirtualWorkspaceCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for a conventional child of a custom crate-root filename", async () => {
    const testCase = await createRustPathOwnerCustomChildCase();
    await expectNativeSemantics(testCase);
  });

  it("keeps native semantics stable for a raw-identifier conventional module", async () => {
    const testCase = await createRustPathOwnerRawIdentCase();
    await expectNativeSemantics(testCase);
  });

  it("resolves a schema-qualified SQL source when another schema shares the basename", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-sql-qualified-basename-"));
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
    const column = query.indexOf("users.id") + 1;

    const index = await expectNativeSemantics({
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
        column,
        expectedStatus: "ok",
      },
      references: {
        file: reportFile,
        line: 1,
        column,
        expectedStatus: "ok",
      },
    });
    const result = await goToDefinition(index, { file: normalizeFile(reportFile), line: 1, column });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(normalizeFile(result.definition.file)).toBe(normalizeFile(schemaFile));
    expect(result.definition.localName).toBe("schema1.users");
    expect(result.definition.range.start.line).toBe(1);
  });

  it("keeps a genuinely ambiguous SQL basename as an explicit non-result", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-sql-ambiguous-"));
    tempDirs.push(root);
    const schemaFile = path.join(root, "schema.sql");
    const reportFile = path.join(root, "report.sql");
    await fsp.writeFile(
      schemaFile,
      ["CREATE TABLE schema1.users (id integer);", "CREATE TABLE schema2.users (id integer);"].join("\n"),
      "utf8",
    );
    const queries = ["SELECT users.id FROM schema1.users, schema2.users;", "SELECT users.id FROM schema1.orders;"];
    await fsp.writeFile(reportFile, queries.join("\n"), "utf8");
    const sharedColumn = queries[0]!.indexOf("users.id") + 1;

    const index = await expectNativeSemantics({
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
          facts: [
            { kind: "reads_from", objectName: "schema1.users" },
            { kind: "reads_from", objectName: "schema2.users" },
          ],
        },
      ],
      goto: {
        file: reportFile,
        line: 1,
        column: sharedColumn,
        expectedStatus: "not_found",
      },
      references: {
        file: reportFile,
        line: 1,
        column: sharedColumn,
        expectedStatus: "not_found",
      },
    });
    // `users` does not name the FROM source `schema1.orders`, so it is not schema1.users either.
    const unmatched = await goToDefinition(index, {
      file: normalizeFile(reportFile),
      line: 2,
      column: queries[1]!.indexOf("users.id") + 1,
    });
    expect(unmatched.status).toBe("not_found");
  });

  it("keeps authoritative JVM package imports consistent across a disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-authoritative-jvm-package-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-authoritative-jvm-cache-"));
    tempDirs.push(root, cacheDir);
    const paths = await writeFixtureFiles(root, JVM_PACKAGE_IMPORT_SOURCES);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      for (const row of JVM_PACKAGE_IMPORT_CASES) {
        const label = `${phase}: ${row.file}`;
        const file = paths[row.file]!;
        const module = index.byFile.get(fileIdentityKey(file));
        expect(module?.imports, label).toHaveLength(1);
        if (row.target) {
          expect(module?.imports[0]?.resolved, label).toBe(paths[row.target.file]);
        } else {
          expect(module?.imports[0]?.resolved, label).toEqual({ external: row.specifier });
        }
        expect(module?.parserDegraded, label).toBeUndefined();
        expect(module?.importLookupIncomplete, label).toBeUndefined();
        const expectedFiles = row.target ? [paths[row.target.file]] : [];
        const fileEdges = index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
          .flatMap((edge) => (edge.to.type === "file" ? [normalizeFile(edge.to.path)] : []));
        expect(fileEdges, label).toEqual(expectedFiles);
        const result = await goToDefinition(index, {
          file,
          line: 3,
          column: columnOf(JVM_PACKAGE_IMPORT_SOURCES[row.file]!.split("\n"), 3, row.name),
        });
        expect(result.status, label).toBe(row.target ? "ok" : "not_found");
        if (row.target && result.status === "ok") {
          expect(result.definition.file, label).toBe(paths[row.target.file]);
          expect(result.definition.range.start.line, label).toBe(row.target.line);
        }
        const importNode = nodes.find((node) => node.file === file && node.name === row.name && node.kind === "import");
        if (row.target) expect(importNode, label).toBeDefined();
        const bindingTargets = graph.edges
          .filter((edge) => edge.from === importNode?.id)
          .flatMap((edge) => {
            const target = graph.nodes.get(edge.to);
            if (!target || target.file === file || !index.byFile.has(fileIdentityKey(target.file))) return [];
            return [normalizeFile(target.file)];
          });
        expect([...new Set(bindingTargets)], label).toEqual(expectedFiles);
        if (!row.target) continue;
        const targetLines = JVM_PACKAGE_IMPORT_SOURCES[row.target.file]!.split("\n");
        const references = await findReferences(index, {
          file: paths[row.target.file]!,
          line: row.target.line,
          column: columnOf(targetLines, row.target.line, row.name),
        });
        expect(references.status, label).toBe("ok");
        if (references.status !== "ok") continue;
        expect(references.referenceCoverage.state, label).toBe("complete");
        expect(
          references.references.some((reference) => reference.file === file && reference.range.start.line === 3),
          label,
        ).toBe(true);
        for (const other of JVM_PACKAGE_IMPORT_CASES) {
          if (other.target?.file === row.target.file) continue;
          expect(
            references.references.some((reference) => reference.file === paths[other.file]),
            `${label}: excludes ${other.file}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps cross-unit peers and shared owners consistent across a disk-cache reload", async () => {
    // #378: implicit package/module peers (Go, Java-like, C#, Swift, Zig) and shared owners
    // (C# partial classes, Swift extensions) must resolve, be referenced, and produce the same
    // detailed call edges before and after a persisted index reload.
    type PeerCase = {
      name: string;
      files: Record<string, string[]>;
      goto: { file: string; line: number; token: string; expectedFile: string; expectedLine: number };
      references: {
        file: string;
        line: number;
        token: string;
        expectedSites: string[];
        decoyFile?: string;
        decoyDeclaration?: { file: string; line: number; token: string; absentSites: string[] };
      };
      edge: {
        caller: string;
        callerFile: string;
        expectedTarget: string;
        label?: "calls" | "instantiates";
        /** Targets with the same label that the caller must not reach, such as a same-named decoy. */
        absentTargets?: string[];
      };
    };
    const { cls, fn, astral } = KOTLIN_UNICODE_NAMES;
    const { defs, use, decoy } = KOTLIN_UNICODE_FILES;
    const peerCases: PeerCase[] = [
      ...[2, 3].map(
        (line): PeerCase => ({
          name: `Kotlin quoted/plain receiver binding on line ${line}`,
          files: KOTLIN_QUOTED_SCOPE_LINES,
          goto: {
            file: KOTLIN_QUOTED_SCOPE_FILES.receivers,
            line,
            token: "work",
            expectedFile: KOTLIN_QUOTED_SCOPE_FILES.value,
            expectedLine: 2,
          },
          references: {
            file: KOTLIN_QUOTED_SCOPE_FILES.value,
            line: 2,
            token: "work",
            expectedSites: [2, 3, 6, 10, 13, 14].map(
              (siteLine) => `${KOTLIN_QUOTED_SCOPE_FILES.receivers}:${siteLine}`,
            ),
            decoyFile: KOTLIN_QUOTED_SCOPE_FILES.gadget,
            decoyDeclaration: {
              file: KOTLIN_QUOTED_SCOPE_FILES.gadget,
              line: 2,
              token: "work",
              absentSites: [2, 3, 6, 10, 13, 14].map(
                (siteLine) => `${KOTLIN_QUOTED_SCOPE_FILES.receivers}:${siteLine}`,
              ),
            },
          },
          edge: {
            caller: line === 2 ? "quotedParameter" : "plainParameter",
            callerFile: KOTLIN_QUOTED_SCOPE_FILES.receivers,
            expectedTarget: `${KOTLIN_QUOTED_SCOPE_FILES.value}::work`,
            absentTargets: [`${KOTLIN_QUOTED_SCOPE_FILES.gadget}::work`],
          },
        }),
      ),
      {
        name: "Kotlin inherited member before an explicit function alias",
        files: KOTLIN_QUOTED_SCOPE_LINES,
        goto: {
          file: KOTLIN_QUOTED_SCOPE_FILES.aliases,
          line: 5,
          token: "mark()",
          expectedFile: KOTLIN_QUOTED_SCOPE_FILES.aliases,
          expectedLine: 4,
        },
        references: {
          file: KOTLIN_QUOTED_SCOPE_FILES.aliases,
          line: 4,
          token: "mark",
          expectedSites: [`${KOTLIN_QUOTED_SCOPE_FILES.aliases}:5`],
          decoyDeclaration: {
            file: KOTLIN_QUOTED_SCOPE_FILES.api,
            line: 3,
            token: "go",
            absentSites: [`${KOTLIN_QUOTED_SCOPE_FILES.aliases}:5`],
          },
        },
        edge: {
          caller: "inherited",
          callerFile: KOTLIN_QUOTED_SCOPE_FILES.aliases,
          expectedTarget: `${KOTLIN_QUOTED_SCOPE_FILES.aliases}::mark`,
          absentTargets: [`${KOTLIN_QUOTED_SCOPE_FILES.api}::go`],
        },
      },
      {
        name: "Kotlin quoted keyword through a package wildcard",
        files: KOTLIN_QUOTED_BOUNDARY_LINES,
        goto: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.star,
          line: 3,
          token: "`is`",
          expectedFile: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          expectedLine: 8,
        },
        references: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          line: 8,
          token: "`is`",
          expectedSites: [
            `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}:8`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.use}:18`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.star}:3`,
          ],
          decoyFile: KOTLIN_QUOTED_BOUNDARY_FILES.decoy,
        },
        edge: {
          caller: "star",
          callerFile: KOTLIN_QUOTED_BOUNDARY_FILES.star,
          expectedTarget: `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}::\`is\``,
          absentTargets: [`${KOTLIN_QUOTED_BOUNDARY_FILES.decoy}::\`is\``],
        },
      },
      {
        name: "Kotlin nested class through a quoted type wildcard",
        files: KOTLIN_QUOTED_BOUNDARY_LINES,
        goto: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.nestedStar,
          line: 4,
          token: "`Inner`",
          expectedFile: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          expectedLine: 15,
        },
        references: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          line: 15,
          token: "Inner",
          expectedSites: [
            `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}:15`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.nestedStar}:3`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.nestedStar}:4`,
          ],
          decoyFile: KOTLIN_QUOTED_BOUNDARY_FILES.decoy,
        },
        edge: {
          caller: "makeNested",
          callerFile: KOTLIN_QUOTED_BOUNDARY_FILES.nestedStar,
          expectedTarget: `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}::Inner`,
          absentTargets: [`${KOTLIN_QUOTED_BOUNDARY_FILES.decoy}::Inner`],
        },
      },
      {
        name: "Kotlin quoted nested declaration through a plain type wildcard",
        files: KOTLIN_QUOTED_BOUNDARY_LINES,
        goto: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.nestedReverse,
          line: 4,
          token: "QuotedInner",
          expectedFile: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          expectedLine: 20,
        },
        references: {
          file: KOTLIN_QUOTED_BOUNDARY_FILES.defs,
          line: 20,
          token: "`QuotedInner`",
          expectedSites: [
            `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}:20`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.nestedReverse}:3`,
            `${KOTLIN_QUOTED_BOUNDARY_FILES.nestedReverse}:4`,
          ],
          decoyFile: KOTLIN_QUOTED_BOUNDARY_FILES.decoy,
        },
        edge: {
          caller: "createReverse",
          callerFile: KOTLIN_QUOTED_BOUNDARY_FILES.nestedReverse,
          expectedTarget: `${KOTLIN_QUOTED_BOUNDARY_FILES.defs}::\`QuotedInner\``,
          absentTargets: [`${KOTLIN_QUOTED_BOUNDARY_FILES.decoy}::\`QuotedInner\``],
        },
      },
      {
        name: "Kotlin backtick-quoted function imported quoted and called quoted",
        files: KOTLIN_QUOTED_LINES,
        goto: {
          file: KOTLIN_QUOTED_FILES.use,
          line: 13,
          token: "`quoted name`",
          expectedFile: KOTLIN_QUOTED_FILES.defs,
          expectedLine: 5,
        },
        references: {
          file: KOTLIN_QUOTED_FILES.defs,
          line: 5,
          token: "`quoted name`",
          expectedSites: [
            `${KOTLIN_QUOTED_FILES.defs}:5`,
            `${KOTLIN_QUOTED_FILES.use}:4`,
            `${KOTLIN_QUOTED_FILES.use}:13`,
          ],
          decoyFile: KOTLIN_QUOTED_FILES.decoy,
        },
        edge: {
          caller: "useNames",
          callerFile: KOTLIN_QUOTED_FILES.use,
          expectedTarget: `${KOTLIN_QUOTED_FILES.defs}::\`quoted name\``,
          absentTargets: [`${KOTLIN_QUOTED_FILES.decoy}::\`quoted name\``],
          label: "calls",
        },
      },
      {
        name: "Kotlin plain function imported with a quoted spelling and called plainly",
        files: KOTLIN_QUOTED_LINES,
        goto: {
          file: KOTLIN_QUOTED_FILES.use,
          line: 13,
          token: "plainName",
          expectedFile: KOTLIN_QUOTED_FILES.defs,
          expectedLine: 7,
        },
        references: {
          file: KOTLIN_QUOTED_FILES.defs,
          line: 7,
          token: "plainName",
          expectedSites: [
            `${KOTLIN_QUOTED_FILES.defs}:7`,
            `${KOTLIN_QUOTED_FILES.use}:5`,
            `${KOTLIN_QUOTED_FILES.use}:13`,
          ],
          decoyFile: KOTLIN_QUOTED_FILES.decoy,
        },
        edge: {
          caller: "useNames",
          callerFile: KOTLIN_QUOTED_FILES.use,
          expectedTarget: `${KOTLIN_QUOTED_FILES.defs}::plainName`,
          absentTargets: [`${KOTLIN_QUOTED_FILES.decoy}::plainName`],
          label: "calls",
        },
      },
      {
        name: "Go same-package sibling function",
        files: {
          "go/a.go": ["package p", "", "func Shared() int { return 1 }"],
          "go/b.go": ["package p", "", "func Use() int { return Shared() }"],
          "go/decoy/decoy.go": [
            "package q",
            "",
            "func Shared() int { return 2 }",
            "",
            "func UseDecoy() int { return Shared() }",
          ],
        },
        goto: { file: "go/b.go", line: 3, token: "Shared", expectedFile: "go/a.go", expectedLine: 3 },
        references: {
          file: "go/a.go",
          line: 3,
          token: "Shared",
          expectedSites: ["go/a.go:3", "go/b.go:3"],
          decoyFile: "go/decoy/decoy.go",
        },
        edge: { caller: "Use", callerFile: "go/b.go", expectedTarget: "go/a.go::Shared" },
      },
      {
        name: "C# partial class members in two files",
        files: {
          "csharp/A.cs": ["namespace P;", "public partial class Box {", "  public void Helper() {}", "}"],
          "csharp/B.cs": [
            "namespace P;",
            "public partial class Box {",
            "  void Use() {",
            "    this.Helper();",
            "  }",
            "}",
          ],
          "csharp/C.cs": [
            "namespace P;",
            "class Consumer {",
            "  void ThirdUse() {",
            "    new Box().Helper();",
            "  }",
            "}",
          ],
          "csharp/decoy/Box.cs": ["namespace Q;", "public partial class Box {", "  public void Helper() {}", "}"],
        },
        goto: { file: "csharp/C.cs", line: 4, token: "Box", expectedFile: "csharp/A.cs", expectedLine: 2 },
        references: {
          file: "csharp/A.cs",
          line: 3,
          token: "Helper",
          expectedSites: ["csharp/A.cs:3", "csharp/B.cs:4", "csharp/C.cs:4"],
          decoyFile: "csharp/decoy/Box.cs",
        },
        edge: { caller: "ThirdUse", callerFile: "csharp/C.cs", expectedTarget: "csharp/A.cs::Helper" },
      },
      {
        name: "C# alias-qualified constructor",
        files: {
          "alias/Api.cs": ["namespace Api;", "public class Target {}"],
          "alias/Use.cs": ["using X = Api;", "class Use {", "  X::Target Make() => new X::Target();", "}"],
          "alias/decoy/Target.cs": ["namespace Other;", "public class Target {}"],
        },
        goto: { file: "alias/Use.cs", line: 3, token: "Target", expectedFile: "alias/Api.cs", expectedLine: 2 },
        references: {
          file: "alias/Api.cs",
          line: 2,
          token: "Target",
          expectedSites: ["alias/Api.cs:2", "alias/Use.cs:3"],
          decoyFile: "alias/decoy/Target.cs",
        },
        edge: {
          caller: "Make",
          callerFile: "alias/Use.cs",
          expectedTarget: "alias/Api.cs::Target",
          label: "instantiates",
        },
      },
      {
        name: "C# verbatim type alias with a plain use",
        files: {
          "verbatim/Api.cs": ["namespace VerbatimApi;", "public class Target { public static void Run() {} }"],
          "verbatim/Use.cs": [
            "using @B = VerbatimApi.Target;",
            "using VerbatimOther;",
            "class UseVerbatim { void M() { B.Run(); } }",
          ],
          "verbatim/decoy/B.cs": ["namespace VerbatimOther;", "public class B { public static void Run() {} }"],
        },
        goto: { file: "verbatim/Use.cs", line: 3, token: "Run", expectedFile: "verbatim/Api.cs", expectedLine: 2 },
        references: {
          file: "verbatim/Api.cs",
          line: 2,
          token: "Run",
          expectedSites: ["verbatim/Api.cs:2", "verbatim/Use.cs:3"],
          decoyFile: "verbatim/decoy/B.cs",
          decoyDeclaration: {
            file: "verbatim/decoy/B.cs",
            line: 2,
            token: "Run",
            absentSites: ["verbatim/Use.cs:3"],
          },
        },
        edge: {
          caller: "M",
          callerFile: "verbatim/Use.cs",
          expectedTarget: "verbatim/Api.cs::Run",
          absentTargets: ["verbatim/decoy/B.cs::Run"],
        },
      },
      {
        name: "C# plain type alias with a verbatim use after a file-scoped namespace",
        files: {
          "reverse/Api.cs": ["namespace ReverseApi;", "public class Target { public static void Run() {} }"],
          "reverse/Use.cs": [
            "namespace ReverseUse;",
            "using B = global::ReverseApi.Target;",
            "using ReverseOther;",
            "class UseReverse { void M() { @B.Run(); } }",
          ],
          "reverse/decoy/B.cs": ["namespace ReverseOther;", "public class B { public static void Run() {} }"],
        },
        goto: { file: "reverse/Use.cs", line: 4, token: "Run", expectedFile: "reverse/Api.cs", expectedLine: 2 },
        references: {
          file: "reverse/Api.cs",
          line: 2,
          token: "Run",
          expectedSites: ["reverse/Api.cs:2", "reverse/Use.cs:4"],
          decoyFile: "reverse/decoy/B.cs",
          decoyDeclaration: {
            file: "reverse/decoy/B.cs",
            line: 2,
            token: "Run",
            absentSites: ["reverse/Use.cs:4"],
          },
        },
        edge: {
          caller: "M",
          callerFile: "reverse/Use.cs",
          expectedTarget: "reverse/Api.cs::Run",
          absentTargets: ["reverse/decoy/B.cs::Run"],
        },
      },
      {
        name: "Swift extension member over a base type in another file",
        files: {
          "swift/A.swift": ["struct Box {", "  func helper() {}", "}"],
          "swift/B.swift": ["extension Box {", "  func use() { self.helper() }", "}"],
          "swift/Decoy.swift": ["struct Other {", "  func helper() {}", "}"],
        },
        goto: { file: "swift/B.swift", line: 2, token: "helper", expectedFile: "swift/A.swift", expectedLine: 2 },
        references: {
          file: "swift/A.swift",
          line: 2,
          token: "helper",
          expectedSites: ["swift/A.swift:2", "swift/B.swift:2"],
          decoyFile: "swift/Decoy.swift",
        },
        edge: { caller: "use", callerFile: "swift/B.swift", expectedTarget: "swift/A.swift::helper" },
      },
      {
        name: "Swift backtick keyword receiver member",
        files: {
          "swiftquoted/Demo.swift": ["struct Demo {", "  func `class`() {}", "  func run() { self.`class`() }", "}"],
          "swiftquoted/Decoy.swift": [
            "struct Other {",
            "  func `class`() {}",
            "  func runOther() { self.`class`() }",
            "}",
          ],
        },
        goto: {
          file: "swiftquoted/Demo.swift",
          line: 3,
          token: "`class`",
          expectedFile: "swiftquoted/Demo.swift",
          expectedLine: 2,
        },
        references: {
          file: "swiftquoted/Demo.swift",
          line: 2,
          token: "`class`",
          expectedSites: ["swiftquoted/Demo.swift:2", "swiftquoted/Demo.swift:3"],
          decoyFile: "swiftquoted/Decoy.swift",
        },
        edge: {
          caller: "run",
          callerFile: "swiftquoted/Demo.swift",
          expectedTarget: "swiftquoted/Demo.swift::`class`",
          absentTargets: ["swiftquoted/Decoy.swift::`class`"],
        },
      },
      {
        name: "Java inherited method over a single static import",
        files: {
          "jinherit/j/Base.java": ["package j;", "", "class Base {", "  int hit() { return 4; }", "}"],
          "jinherit/j/Use.java": [
            "package j;",
            "",
            "import static j.Util.hit;",
            "",
            "class Derived extends Base {",
            "  int viaBase() { return hit(); }",
            "}",
          ],
          "jinherit/j/Util.java": ["package j;", "", "class Util {", "  static int hit() { return 1; }", "}"],
        },
        goto: {
          file: "jinherit/j/Use.java",
          line: 6,
          token: "hit()",
          expectedFile: "jinherit/j/Base.java",
          expectedLine: 4,
        },
        references: {
          file: "jinherit/j/Base.java",
          line: 4,
          token: "hit",
          expectedSites: ["jinherit/j/Base.java:4", "jinherit/j/Use.java:6"],
          decoyFile: "jinherit/j/Util.java",
        },
        edge: { caller: "viaBase", callerFile: "jinherit/j/Use.java", expectedTarget: "jinherit/j/Base.java::hit" },
      },
      {
        name: "Kotlin inherited member over a same-package function",
        files: {
          "kinherit/p/Base.kt": ["package p", "", "open class Base {", "    fun hit(): Int = 4", "}"],
          "kinherit/p/Use.kt": ["package p", "", "class Derived : Base() {", "    fun viaBase(): Int = hit()", "}"],
          "kinherit/p/Peer.kt": ["package p", "", "fun hit(): Int = 1"],
        },
        goto: {
          file: "kinherit/p/Use.kt",
          line: 4,
          token: "hit()",
          expectedFile: "kinherit/p/Base.kt",
          expectedLine: 4,
        },
        references: {
          file: "kinherit/p/Base.kt",
          line: 4,
          token: "hit",
          expectedSites: ["kinherit/p/Base.kt:4", "kinherit/p/Use.kt:4"],
          decoyFile: "kinherit/p/Peer.kt",
        },
        edge: { caller: "viaBase", callerFile: "kinherit/p/Use.kt", expectedTarget: "kinherit/p/Base.kt::hit" },
      },
      // Names written with CJK ideographs, Hangul syllables, and a supplementary-plane ideograph: one fixture, three
      // names, each declared again in a package the client does not import.
      {
        name: "Kotlin CJK class imported from another package",
        files: KOTLIN_UNICODE_LINES,
        goto: { file: use, line: 8, token: cls, expectedFile: defs, expectedLine: 3 },
        references: {
          file: defs,
          line: 3,
          token: cls,
          expectedSites: [`${defs}:3`, `${use}:3`, `${use}:8`],
          decoyFile: decoy,
        },
        edge: {
          caller: "useNames",
          callerFile: use,
          expectedTarget: `${defs}::${cls}`,
          absentTargets: [`${decoy}::${cls}`],
        },
      },
      {
        name: "Kotlin Hangul function imported from another package",
        files: KOTLIN_UNICODE_LINES,
        goto: { file: use, line: 9, token: fn, expectedFile: defs, expectedLine: 5 },
        references: {
          file: defs,
          line: 5,
          token: fn,
          expectedSites: [`${defs}:5`, `${use}:4`, `${use}:9`],
          decoyFile: decoy,
        },
        edge: {
          caller: "useNames",
          callerFile: use,
          expectedTarget: `${defs}::${fn}`,
          absentTargets: [`${decoy}::${fn}`],
        },
      },
      {
        name: "Kotlin supplementary-plane function imported from another package",
        files: KOTLIN_UNICODE_LINES,
        goto: { file: use, line: 9, token: astral, expectedFile: defs, expectedLine: 7 },
        references: {
          file: defs,
          line: 7,
          token: astral,
          expectedSites: [`${defs}:7`, `${use}:5`, `${use}:9`],
          decoyFile: decoy,
        },
        edge: {
          caller: "useNames",
          callerFile: use,
          expectedTarget: `${defs}::${astral}`,
          absentTargets: [`${decoy}::${astral}`],
        },
      },
      {
        name: "C# inherited method over a using static import",
        files: {
          "csinherit/Base.cs": ["namespace P;", "public class Base {", "  public int Hit() { return 4; }", "}"],
          "csinherit/Util.cs": [
            "namespace P;",
            "public static class Util {",
            "  public static int Hit() { return 1; }",
            "}",
          ],
          "csinherit/Use.cs": [
            "using static P.Util;",
            "namespace P;",
            "public class Derived : Base {",
            "  public int ViaBase() { return Hit(); }",
            "}",
          ],
        },
        goto: { file: "csinherit/Use.cs", line: 4, token: "Hit()", expectedFile: "csinherit/Base.cs", expectedLine: 3 },
        references: {
          file: "csinherit/Base.cs",
          line: 3,
          token: "Hit",
          expectedSites: ["csinherit/Base.cs:3", "csinherit/Use.cs:4"],
          decoyFile: "csinherit/Util.cs",
        },
        edge: { caller: "ViaBase", callerFile: "csinherit/Use.cs", expectedTarget: "csinherit/Base.cs::Hit" },
      },
      {
        name: "C# using static member over a same-named type in another namespace",
        files: {
          "csstatic/Util.cs": [
            "namespace StaticTarget;",
            "public static class Util {",
            "  public static int Go() { return 1; }",
            "}",
          ],
          "csstatic/Decoy.cs": [
            "namespace StaticDecoy;",
            "public static class Util {",
            "  public static int Go() { return 2; }",
            "  public static int UseDecoy() { return Go(); }",
            "}",
          ],
          "csstatic/Use.cs": [
            "using static StaticTarget.Util;",
            "namespace StaticUse;",
            "public class Use {",
            "  public int Call() { return Go(); }",
            "}",
          ],
        },
        goto: { file: "csstatic/Use.cs", line: 4, token: "Go()", expectedFile: "csstatic/Util.cs", expectedLine: 3 },
        references: {
          file: "csstatic/Util.cs",
          line: 3,
          token: "Go",
          expectedSites: ["csstatic/Util.cs:3", "csstatic/Use.cs:4"],
          decoyFile: "csstatic/Decoy.cs",
        },
        edge: { caller: "Call", callerFile: "csstatic/Use.cs", expectedTarget: "csstatic/Util.cs::Go" },
      },
      {
        name: "C# using namespace declared in several files",
        files: {
          "csnsfiles/lib/Mix.cs": [
            "namespace SplitNs;",
            "public class Mix {",
            "  public static int M(int a) { return a; }",
            "}",
          ],
          "csnsfiles/Other.cs": ["namespace SplitNs;", "public class Other { }"],
          "csnsfiles/Decoy.cs": [
            "namespace SplitDecoy;",
            "public class Mix {",
            "  public static int M(int a) { return 2; }",
            "  public static int UseDecoy() { return Mix.M(1); }",
            "}",
          ],
          "csnsfiles/Use.cs": [
            "using SplitNs;",
            "namespace SplitUse;",
            "public class Use {",
            "  public int Call() { return Mix.M(1); }",
            "}",
          ],
        },
        goto: { file: "csnsfiles/Use.cs", line: 4, token: "M(", expectedFile: "csnsfiles/lib/Mix.cs", expectedLine: 3 },
        references: {
          file: "csnsfiles/lib/Mix.cs",
          line: 3,
          token: "M",
          expectedSites: ["csnsfiles/lib/Mix.cs:3", "csnsfiles/Use.cs:4"],
          decoyFile: "csnsfiles/Decoy.cs",
        },
        edge: { caller: "Call", callerFile: "csnsfiles/Use.cs", expectedTarget: "csnsfiles/lib/Mix.cs::M" },
      },
      {
        name: "Zig imported function through @import",
        files: {
          "zig/api.zig": ["pub fn target(value: i32) i32 {", "    return value;", "}"],
          "zig/decoy.zig": ["pub fn target(value: i32) i32 {", "    return value;", "}"],
          "zig/use.zig": [
            'const api = @import("api.zig");',
            "",
            "pub fn caller() i32 {",
            "    return api.target(1);",
            "}",
          ],
        },
        goto: { file: "zig/use.zig", line: 4, token: "target", expectedFile: "zig/api.zig", expectedLine: 1 },
        references: {
          file: "zig/api.zig",
          line: 1,
          token: "target",
          expectedSites: ["zig/api.zig:1", "zig/use.zig:4"],
          decoyFile: "zig/decoy.zig",
        },
        edge: { caller: "caller", callerFile: "zig/use.zig", expectedTarget: "zig/api.zig::target" },
      },
      {
        name: "Python function-body call rebound by a later module-level import",
        files: {
          "pyrebind/other.py": ["def helper():", "    return 2"],
          "pyrebind/main.py": [
            "def helper():",
            "    return 1",
            "def run():",
            "    return helper()",
            "from other import helper",
          ],
        },
        goto: {
          file: "pyrebind/main.py",
          line: 4,
          token: "helper",
          expectedFile: "pyrebind/other.py",
          expectedLine: 1,
        },
        references: {
          file: "pyrebind/other.py",
          line: 1,
          token: "helper",
          expectedSites: ["pyrebind/other.py:1", "pyrebind/main.py:4", "pyrebind/main.py:5"],
          decoyDeclaration: {
            file: "pyrebind/main.py",
            line: 1,
            token: "helper",
            absentSites: ["pyrebind/main.py:4", "pyrebind/main.py:5"],
          },
        },
        edge: {
          caller: "run",
          callerFile: "pyrebind/main.py",
          expectedTarget: "pyrebind/other.py::helper",
          absentTargets: ["pyrebind/main.py::helper"],
        },
      },
      {
        name: "Python module-level call before a later star import and local declaration",
        files: {
          "pylater/other.py": ["def helper():", "    return 2"],
          "pylater/decoy.py": ["def helper():", "    return 99"],
          "pylater/main.py": [
            "from other import helper",
            "print(helper())",
            "from decoy import *",
            "def run():",
            "    return helper()",
            "def helper():",
            "    return 3",
          ],
        },
        goto: {
          file: "pylater/main.py",
          line: 2,
          token: "helper",
          expectedFile: "pylater/other.py",
          expectedLine: 1,
        },
        references: {
          file: "pylater/other.py",
          line: 1,
          token: "helper",
          expectedSites: ["pylater/other.py:1", "pylater/main.py:1", "pylater/main.py:2"],
          decoyDeclaration: {
            file: "pylater/main.py",
            line: 6,
            token: "helper",
            absentSites: ["pylater/main.py:1", "pylater/main.py:2"],
          },
        },
        edge: {
          caller: "run",
          callerFile: "pylater/main.py",
          expectedTarget: "pylater/main.py::helper",
          absentTargets: ["pylater/other.py::helper", "pylater/decoy.py::helper"],
        },
      },
    ];

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-cross-unit-reload-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-cross-unit-cache-"));
    tempDirs.push(root, cacheDir);
    for (const peerCase of peerCases) {
      for (const [relative, lines] of Object.entries(peerCase.files)) {
        const absolute = path.join(root, relative);
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, `${lines.join("\n")}\n`, "utf8");
      }
    }
    const buildOptions = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, buildOptions);
    const warm = await buildProjectIndexIncremental(root, buildOptions);
    for (const index of [cold, warm]) {
      const main = index.byFile.get(fileIdentityKey(path.join(root, "pylater/main.py")));
      const star = main?.imports.find((binding) => binding.kind === "star" && binding.from === "decoy");
      expect(star?.kind).toBe("star");
      if (star?.kind !== "star") throw new Error("Expected the Python star import");
      expect(star.pythonStatementStartIndex).toBe("from other import helper\nprint(helper())\n".length);
      const graph = await buildSymbolGraphDetailed(index);
      const aliasFile = normalizeFile(path.join(root, KOTLIN_QUOTED_SCOPE_FILES.aliases));
      const aliasUses = graph.edges.flatMap((edge) => {
        if (edge.label !== "uses") return [];
        const caller = graph.nodes.get(edge.from);
        if (caller?.file !== aliasFile) return [];
        const target = graph.nodes.get(edge.to);
        return target ? [`${caller.name}->${relativeFile(root, target.file)}::${target.name}`] : [];
      });
      expect(aliasUses.sort()).toEqual([
        `imported->${KOTLIN_QUOTED_SCOPE_FILES.api}::go`,
        `localType->${KOTLIN_QUOTED_SCOPE_FILES.api}::Widget`,
        `parameterType->${KOTLIN_QUOTED_SCOPE_FILES.api}::Widget`,
      ]);
    }

    const columnAt = (lines: readonly string[], line: number, token: string): number => {
      const text = lines[line - 1] ?? "";
      const at = text.indexOf(token);
      if (at < 0) throw new Error(`token ${token} not found on line ${line}: ${text}`);
      return at + 1;
    };
    const callTargetsOf = async (
      index: ProjectIndex,
      caller: string,
      callerFile: string,
      label = "calls",
    ): Promise<string[]> => {
      const graph = await buildSymbolGraphDetailed(index);
      const callerPath = normalizeFile(path.join(root, callerFile));
      const callerNode = [...graph.nodes.values()].find(
        (node) => node.name === caller && normalizeFile(node.file) === callerPath,
      );
      expect(callerNode, `${caller} must be indexed`).toBeDefined();
      const targets: string[] = [];
      for (const edge of graph.edges) {
        if (edge.label !== label || edge.from !== callerNode!.id) continue;
        const node = graph.nodes.get(edge.to);
        if (node) {
          targets.push(`${relativeFile(root, node.file)}::${node.name}`);
        }
      }
      return targets.sort();
    };

    for (const peerCase of peerCases) {
      const gotoLines = peerCase.files[peerCase.goto.file]!;
      const gotoRequest = {
        file: normalizeFile(path.join(root, peerCase.goto.file)),
        line: peerCase.goto.line,
        column: columnAt(gotoLines, peerCase.goto.line, peerCase.goto.token),
      };
      for (const [phase, index] of [
        ["cold", cold],
        ["warm", warm],
      ] as const) {
        const goto = await goToDefinition(index, gotoRequest);
        expect(goto.status, `${peerCase.name}: ${phase} navigation`).toBe("ok");
        if (goto.status !== "ok") throw new Error(`${peerCase.name}: ${phase} navigation did not resolve`);
        expect(relativeFile(root, goto.definition.file), `${peerCase.name}: ${phase} navigation target file`).toBe(
          peerCase.goto.expectedFile,
        );
        expect(goto.definition.range.start.line, `${peerCase.name}: ${phase} navigation target line`).toBe(
          peerCase.goto.expectedLine,
        );
      }

      const referenceLines = peerCase.files[peerCase.references.file]!;
      const referenceRequest = {
        file: normalizeFile(path.join(root, peerCase.references.file)),
        line: peerCase.references.line,
        column: columnAt(referenceLines, peerCase.references.line, peerCase.references.token),
        expectedStatus: "ok" as const,
      };
      const coldReferences = stableReferencesSnapshot(root, await normalizeReferences(cold, referenceRequest));
      expect(coldReferences.status, `${peerCase.name}: references`).toBe("ok");
      if (coldReferences.status !== "ok") throw new Error(`${peerCase.name}: references did not resolve`);
      for (const site of peerCase.references.expectedSites) {
        expect(coldReferences.refs, `${peerCase.name}: missing reference ${site}`).toContain(site);
      }
      if (peerCase.references.decoyFile) {
        expect(
          coldReferences.refs.some((site) => site.startsWith(`${peerCase.references.decoyFile}:`)),
          `${peerCase.name}: decoy must stay out of the reference set`,
        ).toBe(false);
      }
      if (peerCase.references.decoyDeclaration) {
        const decoyDecl = peerCase.references.decoyDeclaration;
        const decoyLines = peerCase.files[decoyDecl.file]!;
        const decoyRequest = {
          file: normalizeFile(path.join(root, decoyDecl.file)),
          line: decoyDecl.line,
          column: columnAt(decoyLines, decoyDecl.line, decoyDecl.token),
          expectedStatus: "ok" as const,
        };
        const coldDecoyReferences = stableReferencesSnapshot(root, await normalizeReferences(cold, decoyRequest));
        expect(coldDecoyReferences.status, `${peerCase.name}: decoy references`).toBe("ok");
        if (coldDecoyReferences.status !== "ok") throw new Error(`${peerCase.name}: decoy references did not resolve`);
        for (const site of decoyDecl.absentSites) {
          expect(coldDecoyReferences.refs, `${peerCase.name}: decoy must omit ${site}`).not.toContain(site);
        }
        const warmDecoyReferences = stableReferencesSnapshot(root, await normalizeReferences(warm, decoyRequest));
        expect(warmDecoyReferences, `${peerCase.name}: warm reload decoy references`).toEqual(coldDecoyReferences);
      }

      const warmReferences = stableReferencesSnapshot(root, await normalizeReferences(warm, referenceRequest));
      expect(warmReferences, `${peerCase.name}: warm reload references`).toEqual(coldReferences);

      const coldTargets = await callTargetsOf(
        cold,
        peerCase.edge.caller,
        peerCase.edge.callerFile,
        peerCase.edge.label,
      );
      expect(coldTargets, `${peerCase.name}: cold call edge`).toContain(peerCase.edge.expectedTarget);
      for (const absent of peerCase.edge.absentTargets ?? []) {
        expect(coldTargets, `${peerCase.name}: cold call edge to ${absent}`).not.toContain(absent);
      }
      const warmTargets = await callTargetsOf(
        warm,
        peerCase.edge.caller,
        peerCase.edge.callerFile,
        peerCase.edge.label,
      );
      expect(warmTargets, `${peerCase.name}: warm call edge`).toEqual(coldTargets);
    }
  });
  it("reopens Swift extension type uses from disk without reviving extension exports", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-extension-header-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-extension-header-cache-"));
    tempDirs.push(root, cacheDir);
    const models = ["protocol Proto {}", "struct Widget {}", "extension Widget { func own() {} }"];
    const extensions = [
      "import Models",
      "extension Widget: Proto { func added() {} }",
      "extension String { func builtIn() {} }",
    ];
    const paths = await writeFixtureFiles(root, {
      "Models.swift": `${models.join("\n")}\n`,
      "Extensions.swift": `${extensions.join("\n")}\n`,
      "Decoy.swift": "private struct Widget {}\n",
    });
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    clearMemoryCache();
    const warm = await buildProjectIndex(root, options);
    const header = { file: paths["Extensions.swift"]!, line: 2, column: columnOf(extensions, 2, "Widget") };
    const declaration = { file: paths["Models.swift"]!, line: 2, column: columnOf(models, 2, "Widget") };
    const expectedReferences = [
      `${paths["Models.swift"]}:2`,
      `${paths["Models.swift"]}:3`,
      `${paths["Extensions.swift"]}:2`,
    ].sort();
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
      const extensionModule = index.byFile.get(fileIdentityKey(header.file));
      expect(
        extensionModule?.locals.map((local) => local.localName),
        phase,
      ).toContain("Widget");
      expect(extensionModule?.locals.find((local) => local.localName === "Widget")?.swiftExtensionOwner, phase).toBe(
        true,
      );
      expect(
        index.byFile
          .get(fileIdentityKey(declaration.file))
          ?.locals.filter((local) => local.localName === "Widget")
          .map((local) => local.swiftExtensionOwner ?? false)
          .sort(),
        phase,
      ).toEqual([false, true]);
      expect(
        extensionModule?.exports.some((entry) => entry.type === "local" && entry.exportedAs === "Widget"),
        phase,
      ).toBe(false);
      const target = await goToDefinition(index, header);
      expect(target.status, phase).toBe("ok");
      if (target.status !== "ok") throw new Error("Expected indexed Swift type on an extension header");
      expect(target.definition.file, phase).toBe(declaration.file);
      expect(target.definition.range.start.line, phase).toBe(declaration.line);
      const missing = await goToDefinition(index, {
        file: header.file,
        line: 3,
        column: columnOf(extensions, 3, "String"),
      });
      expect(missing.status, phase).toBe("not_found");
      const refs = await findReferences(index, declaration);
      expect(refs.status, phase).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected complete Swift extension type references");
      expect(refs.referenceCoverage, phase).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(
        refs.references.map((reference) => `${reference.file}:${reference.range.start.line}`).sort(),
        phase,
      ).toEqual(expectedReferences);
      expect(
        refs.references.some((reference) => reference.file === paths["Decoy.swift"]),
        phase,
      ).toBe(false);
      const graph = await buildSymbolGraphDetailed(index);
      const owner = [...graph.nodes.values()].find((node) => node.file === header.file && node.name === "Widget");
      expect(owner, phase).toBeDefined();
      const targetEdges = graph.edges
        .filter((edge) => edge.from === owner?.id && edge.label === "uses")
        .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(targetEdges, phase).toEqual([declaration.file]);
      const nominal = [...graph.nodes.values()].find(
        (node) => node.file === declaration.file && node.name === "Widget",
      );
      expect(nominal, phase).toBeDefined();
      const protocolEdges = graph.edges
        .filter((edge) => edge.from === nominal?.id && edge.label === "implements")
        .map((edge) => `${graph.nodes.get(edge.to)?.file}:${graph.nodes.get(edge.to)?.name}`);
      expect(protocolEdges, phase).toEqual([`${declaration.file}:Proto`]);
      expect(
        graph.edges.some((edge) => edge.from === owner?.id && edge.label === "implements"),
        phase,
      ).toBe(false);
    }
  });

  it("keeps Swift protocol refinement and typealias bases identical across a native disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-bases-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-bases-cache-"));
    tempDirs.push(root, cacheDir);
    const models = [
      "struct Widget: Child {}",
      "struct Other {}",
      "class Base { func helper() {} }",
      "class Decoy { func helper() {} }",
      "typealias Alias = Base",
      "typealias ParentAlias = Parent",
      "extension Other: ParentAlias {}",
    ];
    const derived = ["class Derived: Alias {", "  func run() { super.helper() }", "}"];
    const paths = await writeFixtureFiles(root, {
      "Parent.swift": "protocol Parent {}\n",
      "Child.swift": "protocol Child: Parent {}\n",
      "Models.swift": `${models.join("\n")}\n`,
      "Derived.swift": `${derived.join("\n")}\n`,
    });
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    clearMemoryCache();
    const warm = await buildProjectIndex(root, options);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
      const graph = await buildSymbolGraphDetailed(index);
      const hierarchy = graph.edges
        .filter((edge) => edge.label === "extends" || edge.label === "implements")
        .map((edge) => `${graph.nodes.get(edge.from)?.name}-${edge.label}->${graph.nodes.get(edge.to)?.name}`)
        .sort();
      expect(hierarchy, phase).toEqual([
        "Child-extends->Parent",
        "Derived-extends->Base",
        "Other-implements->Parent",
        "Widget-implements->Child",
      ]);
      const parent = [...graph.nodes.values()].find((node) => node.name === "Parent");
      expect(parent, phase).toBeDefined();
      const implementations = findImplementations(index, graph, parent!.id);
      if (implementations.status !== "ok") throw new Error(`Expected Swift implementations in the ${phase} index`);
      expect(
        implementations.implementations.map((match) => graph.nodes.get(match.symbolId)?.name).sort(),
        phase,
      ).toEqual(["Other", "Widget"]);
      const call = await goToDefinition(index, {
        file: paths["Derived.swift"]!,
        line: 2,
        column: columnOf(derived, 2, "helper"),
      });
      if (call.status !== "ok") throw new Error(`Expected super.helper() to resolve in the ${phase} index`);
      expect(call.definition.file, phase).toBe(paths["Models.swift"]);
      expect(call.definition.range.start.line, phase).toBe(3);
    }
  });

  it.each(INTERFACE_INHERITANCE_FIXTURES)(
    "keeps $language interface inheritance identical across a native disk-cache reload",
    async (fixture) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-interface-inheritance-"));
      const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-interface-inheritance-cache-"));
      tempDirs.push(root, cacheDir);
      await writeFixtureFiles(root, fixture.files);
      const options = { cache: "disk", cacheDir, threads: 1 } as const;
      const cold = await buildProjectIndex(root, options);
      clearMemoryCache();
      const warm = await buildProjectIndex(root, options);
      for (const [phase, index] of [
        ["cold", cold],
        ["warm", warm],
      ] as const) {
        for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
        const graph = await buildSymbolGraphDetailed(index);
        expectInterfaceInheritance(root, index, graph, fixture, phase);
      }
    },
  );

  it("keeps Kotlin secondary-constructor base classes identical across a native disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-secondary-constructor-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-secondary-constructor-cache-"));
    tempDirs.push(root, cacheDir);
    await writeFixtureFiles(root, KOTLIN_SECONDARY_CONSTRUCTOR_FILES);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    clearMemoryCache();
    const warm = await buildProjectIndex(root, options);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
      expectKotlinSecondaryConstructorHierarchy(root, index, await buildSymbolGraphDetailed(index), phase);
    }
  });

  it.each(QUALIFIED_BASE_FIXTURES)(
    "keeps $language qualified bases identical across a native disk-cache reload",
    async (fixture) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-qualified-base-"));
      const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-qualified-base-cache-"));
      tempDirs.push(root, cacheDir);
      await writeFixtureFiles(root, fixture.files);
      const options = { cache: "disk", cacheDir, threads: 1 } as const;
      const cold = await buildProjectIndex(root, options);
      clearMemoryCache();
      const warm = await buildProjectIndex(root, options);
      for (const [phase, index] of [
        ["cold", cold],
        ["warm", warm],
      ] as const) {
        // `go.mod` is a manifest, not a parsed source file, so it carries no native outcome.
        for (const module of index.byFile.values()) {
          if (!module.file.endsWith("go.mod")) expect(module.nativeOutcome, phase).toBe("used");
        }
        const graph = await buildSymbolGraphDetailed(index);
        await expectQualifiedBases(root, index, graph, fixture, phase);
      }
    },
  );

  it("keeps Python dotted import packages identical across a native disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-python-dotted-import-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-python-dotted-import-cache-"));
    tempDirs.push(root, cacheDir);
    const typedSource = [
      "class LocalBox:",
      "    def target(self):",
      "        return 1",
      "def call(box: LocalBox):",
      "    return box.target()",
      "",
    ].join("\n");
    await writeFixtureFiles(root, { ...PYTHON_DOTTED_IMPORT_FILES, "typed_parameter.py": typedSource });
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    clearMemoryCache();
    const warm = await buildProjectIndex(root, options);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
      const graph = await buildSymbolGraphDetailed(index);
      await expectPythonDottedImports(root, index, graph, phase);
      const typedFile = path.join(root, "typed_parameter.py");
      const target = await goToDefinition(index, { file: typedFile, line: 5, column: 16 });
      expect(target.status, phase).toBe("ok");
      if (target.status !== "ok") continue;
      expect(fileIdentityKey(target.definition.file), phase).toBe(fileIdentityKey(typedFile));
      expect(target.definition.range.start.line, phase).toBe(2);
      const refs = await findReferences(index, { file: typedFile, line: 2, column: 9 });
      expect(refs.status, phase).toBe("ok");
      if (refs.status === "ok") {
        expect(
          refs.references.some(
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(typedFile) && reference.range.start.line === 5,
          ),
          phase,
        ).toBe(true);
      }
      const caller = [...graph.nodes.values()].find(
        (node) => node.name === "call" && fileIdentityKey(node.file) === fileIdentityKey(typedFile),
      );
      expect(caller, phase).toBeDefined();
      expect(
        graph.edges.some(
          (edge) => edge.label === "calls" && edge.from === caller?.id && edge.to === defNodeId(target.definition),
        ),
        phase,
      ).toBe(true);
    }
  });

  it("keeps quoted Swift names and source ranges stable across a native disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-quoted-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-swift-quoted-cache-"));
    tempDirs.push(root, cacheDir);
    const paths = await writeFixtureFiles(root, SWIFT_QUOTED_SOURCES);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    const site = (name: string, line: number, token: string, occurrence = 0) =>
      swiftQuotedSite(paths, name, line, token, occurrence);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      for (const module of index.byFile.values()) expect(module.nativeOutcome, phase).toBe("used");
      const api = index.byFile.get(fileIdentityKey(paths["Api.swift"]!));
      const names = api?.locals.map((local) => local.localName);
      expect(names, phase).toContain("`helper`");
      expect(names, phase).toContain("helper");
      expect(names, phase).toContain("`Widget`");
      const declaration = site("Api.swift", 4, "`helper`");
      const uses = [
        site("Api.swift", 5, "helper"),
        site("Api.swift", 5, "helper", 1),
        site("Api.swift", 5, "`helper`"),
        site("Use.swift", 11, "helper"),
        site("Use.swift", 12, "`helper`"),
        site("Use.swift", 14, "helper"),
        site("Imports.swift", 3, "helper"),
        site("Extension.swift", 2, "`helper`"),
      ];
      for (const use of uses) {
        const result = await goToDefinition(index, use);
        expect(result.status, `${phase}: ${use.file}:${use.line}`).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file, phase).toBe(declaration.file);
          expect(result.definition.range.start.line, phase).toBe(declaration.line);
          expect(result.definition.localName, phase).toBe("`helper`");
          expect(result.definition.range.end.column - result.definition.range.start.column, phase).toBe(
            "`helper`".length,
          );
        }
      }
      const refs = await findReferences(index, declaration);
      expect(refs.status, phase).toBe("ok");
      if (refs.status !== "ok") continue;
      expect(refs.referenceCoverage, phase).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(
        refs.references
          .map((reference) => `${reference.file}:${reference.range.start.line}:${reference.range.start.column}`)
          .sort(),
        phase,
      ).toEqual(
        [declaration, ...uses].map((location) => `${location.file}:${location.line}:${location.column}`).sort(),
      );
      for (const [use, spelling] of [
        [site("Use.swift", 11, "helper"), "helper"],
        [site("Use.swift", 12, "`helper`"), "`helper`"],
      ] as const) {
        const range = refs.references.find(
          (reference) =>
            reference.file === use.file &&
            reference.range.start.line === use.line &&
            reference.range.start.column === use.column,
        )?.range;
        expect(range, `${phase}: source spelling of ${spelling}`).toBeDefined();
        if (range) expect(range.end.column - range.start.column, phase).toBe(spelling.length);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const extensionCaller = [...graph.nodes.values()].find(
        (node) => node.file === paths["Extension.swift"] && node.name === "extensionUse",
      );
      expect(extensionCaller, phase).toBeDefined();
      const extensionTargets = graph.edges
        .filter((edge) => edge.label === "calls" && edge.from === extensionCaller?.id)
        .map((edge) => graph.nodes.get(edge.to));
      expect(
        extensionTargets.map((node) => `${node?.file}:${node?.name}`),
        phase,
      ).toEqual([`${paths["Api.swift"]}:\`helper\``]);
      const plainUse = site("Extension.swift", 5, "helper");
      const plainGoto = await goToDefinition(index, plainUse);
      expect(plainGoto.status, phase).toBe("ok");
      if (plainGoto.status === "ok") {
        expect(plainGoto.definition.file, phase).toBe(paths["Api.swift"]);
        expect(plainGoto.definition.range.start.line, phase).toBe(8);
      }
      const plainRefs = await findReferences(index, site("Api.swift", 8, "helper"));
      expect(plainRefs.status, phase).toBe("ok");
      if (plainRefs.status === "ok") {
        expect(plainRefs.referenceCoverage, phase).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(
          plainRefs.references.map((reference) => `${reference.file}:${reference.range.start.line}`).sort(),
          phase,
        ).toEqual(
          [
            `${paths["Api.swift"]}:8`,
            `${paths["Api.swift"]}:9`,
            `${paths["Use.swift"]}:16`,
            `${paths["Extension.swift"]}:5`,
          ].sort(),
        );
      }
      const plainCaller = [...graph.nodes.values()].find(
        (node) => node.file === paths["Extension.swift"] && node.name === "extensionPlain",
      );
      expect(
        graph.edges
          .filter((edge) => edge.from === plainCaller?.id && edge.label === "calls")
          .map((edge) => `${graph.nodes.get(edge.to)?.file}:${graph.nodes.get(edge.to)?.name}`),
        phase,
      ).toEqual([`${paths["Api.swift"]}:helper`]);
      const soloDeclaration = site("Api.swift", 18, "plainOnly");
      const soloUses = [site("Api.swift", 19, "`plainOnly`"), site("Use.swift", 18, "`plainOnly`")];
      for (const use of soloUses) {
        const target = await goToDefinition(index, use);
        expect(target.status, `${phase}: ${use.file}:${use.line}`).toBe("ok");
        if (target.status === "ok") {
          expect(target.definition.file, phase).toBe(soloDeclaration.file);
          expect(target.definition.range.start.line, phase).toBe(soloDeclaration.line);
          expect(target.definition.localName, phase).toBe("plainOnly");
        }
      }
      const soloRefs = await findReferences(index, soloDeclaration);
      expect(soloRefs.status, phase).toBe("ok");
      if (soloRefs.status === "ok") {
        expect(soloRefs.referenceCoverage, phase).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(
          soloRefs.references
            .map((reference) => `${reference.file}:${reference.range.start.line}:${reference.range.start.column}`)
            .sort(),
          phase,
        ).toEqual(
          [soloDeclaration, ...soloUses]
            .map((location) => `${location.file}:${location.line}:${location.column}`)
            .sort(),
        );
        for (const use of soloUses) {
          const match = soloRefs.references.find(
            (reference) =>
              reference.file === use.file &&
              reference.range.start.line === use.line &&
              reference.range.start.column === use.column,
          );
          expect(match, phase).toBeDefined();
          if (match) expect(match.range.end.column - match.range.start.column, phase).toBe("`plainOnly`".length);
        }
      }
      for (const [callerName, callerFile] of [
        ["invokeSolo", "Api.swift"],
        ["useSolo", "Use.swift"],
      ] as const) {
        const caller = [...graph.nodes.values()].find(
          (node) => node.file === paths[callerFile] && node.name === callerName,
        );
        expect(caller, phase).toBeDefined();
        expect(
          graph.edges
            .filter((edge) => edge.from === caller?.id && edge.label === "calls")
            .map((edge) => `${graph.nodes.get(edge.to)?.file}:${graph.nodes.get(edge.to)?.name}`),
          phase,
        ).toEqual([`${paths["Api.swift"]}:plainOnly`]);
      }
    }
  });

  it("keeps unread wildcard calls and references conservative on a native disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-unread-wildcards-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-unread-wildcards-cache-"));
    tempDirs.push(root, cacheDir);
    const sources = jvmIncompleteWildcardSources();
    const paths = await writeFixtureFiles(root, sources);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    for (const [phase, index] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      const graph = await buildSymbolGraphDetailed(index);
      for (const row of [...JVM_INCOMPLETE_WILDCARD_CALLS, ...JVM_INCOMPLETE_WILDCARD_CALLABLE_REFERENCES]) {
        const result = await goToDefinition(index, {
          file: paths[row.file]!,
          line: row.line,
          column: sources[row.file]!.split("\n")[row.line - 1]!.lastIndexOf(row.name) + 1,
        });
        expect(result.status, `${phase}: ${row.caller}`).toBe(row.target ? "ok" : "not_found");
        if (row.target && result.status === "ok") expect(result.definition.file).toBe(paths[row.target.file]);
        const caller = [...graph.nodes.values()].find(
          (node) => node.name === row.caller && fileIdentityKey(node.file) === fileIdentityKey(paths[row.file]!),
        );
        expect(caller, `${phase}: ${row.caller}`).toBeDefined();
        const label = "reference" in row ? "uses" : "calls";
        const targets = graph.edges
          .filter((edge) => edge.from === caller!.id && edge.label === label)
          .map((edge) => graph.nodes.get(edge.to)?.file);
        expect(targets, `${phase}: ${row.caller}`).toEqual(row.target ? [paths[row.target.file]] : []);
      }
      for (const row of JVM_INCOMPLETE_WILDCARD_REFERENCES) {
        const result = await findReferences(index, {
          file: paths[row.file]!,
          line: row.line,
          column: columnOf(sources[row.file]!.split("\n"), row.line, row.name),
        });
        expect(result.status, `${phase}: ${row.file}`).toBe("ok");
        if (result.status !== "ok") throw new Error(`missing native reference definition: ${row.file}`);
        expect(
          result.references
            .filter((ref) => fileIdentityKey(ref.file) === fileIdentityKey(paths[row.consumer]!))
            .map((ref) => ref.range.start.line)
            .sort(),
          `${phase}: ${row.file}`,
        ).toEqual([...row.lines]);
      }
    }
  });
  it("keeps Kotlin default-package imports and graph edges across a disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-default-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-default-cache-"));
    tempDirs.push(root, cacheDir);
    const files = await writeFixtureFiles(root, KOTLIN_DEFAULT_PACKAGE_SOURCES);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    const lines = KOTLIN_DEFAULT_PACKAGE_SOURCES["app/Use.kt"].split("\n");
    for (const index of [cold, warm]) {
      const result = await goToDefinition(index, {
        file: files["app/Use.kt"]!,
        line: 6,
        column: columnOf(lines, 6, "chosen"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected default-package function");
      expect(result.definition.file).toBe(files["Default.kt"]);
      const refs = await findReferences(index, { file: files["Default.kt"]!, line: 2, column: 5 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected default-package function references");
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.some((ref) => ref.file === files["app/Use.kt"] && ref.range.start.line === 6)).toBe(true);
      expect(refs.references.some((ref) => ref.file === files["Named.kt"])).toBe(false);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "make")
        .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(targets).toContain(files["Default.kt"]);
      expect(targets).not.toContain(files["Named.kt"]);
    }
  });
  it("keeps unread default-package imports unresolved on a disk-cache reload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-default-unread-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-kotlin-default-unread-cache-"));
    tempDirs.push(root, cacheDir);
    const files = await writeFixtureFiles(root, {
      ...KOTLIN_DEFAULT_PACKAGE_SOURCES,
      "Unread.kt": "class Before\n)\nfun defaultFn() = 0\n",
    });
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    for (const index of [cold, warm]) {
      const module = index.byFile.get(fileIdentityKey(files["app/Use.kt"]!));
      expect(module).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      expect(module?.imports.map((entry) => entry.resolved)).toEqual([
        { external: "DefaultThing" },
        { external: "defaultFn" },
      ]);
      const result = await goToDefinition(index, { file: files["app/Use.kt"]!, line: 6, column: 5 });
      expect(result.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges.some(
          (edge) =>
            graph.nodes.get(edge.from)?.name === "make" && graph.nodes.get(edge.to)?.file === files["Default.kt"],
        ),
      ).toBe(false);
    }
  });
  it.each(QUALIFIED_TYPE_CASES)("keeps $language qualified-type answers across disk reloads", async (row) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-`));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-cache-`));
    tempDirs.push(root, cacheDir);
    const sources: Readonly<Record<string, string>> = row.sources;
    const files = await writeFixtureFiles(root, sources);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    const lines = sources[row.consumer]!.split("\n");
    for (const index of [cold, warm]) {
      const qualified = await goToDefinition(index, {
        file: files[row.consumer]!,
        line: row.qualifiedLine,
        column: columnOf(lines, row.qualifiedLine, "Widget"),
      });
      expect(qualified.status).toBe(row.qualifiedStatus);
      if (qualified.status === "ok") expect(qualified.definition.file).toBe(files[row.qualified]);
      const bare = await goToDefinition(index, {
        file: files[row.consumer]!,
        line: row.bareLine,
        column: columnOf(lines, row.bareLine, "Widget"),
      });
      expect(bare.status).toBe("ok");
      if (bare.status !== "ok") throw new Error("Expected bare imported type");
      expect(bare.definition.file).toBe(files[row.imported]);
      const declaration = sources[row.imported]!.split("\n");
      const references = await findReferences(index, {
        file: files[row.imported]!,
        line: row.declarationLine,
        column: columnOf(declaration, row.declarationLine, "Widget"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected imported-type references");
      expect(references.referenceCoverage.state).toBe(row.coverage);
      const linesUsed = references.references
        .filter((reference) => reference.file === files[row.consumer])
        .map((reference) => reference.range.start.line);
      expect(linesUsed).toContain(row.bareLine);
      expect(linesUsed).not.toContain(row.qualifiedLine);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = (caller: string) =>
        graph.edges
          .filter((edge) => graph.nodes.get(edge.from)?.name === caller && edge.label === "uses")
          .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(targets("qualified")).not.toContain(files[row.imported]);
      if (row.qualifiedStatus === "ok") expect(targets("qualified")).toContain(files[row.qualified]);
      expect(targets("bare")).toContain(files[row.imported]);
    }
  });
  it.each(JVM_VALUE_SHADOW_CASES)("retains $language type lookup past values after disk reload", async (row) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-jvm-value-shadow-"));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-jvm-value-shadow-cache-"));
    tempDirs.push(root, cacheDir);
    const files = await writeFixtureFiles(root, row.sources);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    const sources: Readonly<Record<string, string>> = row.sources;
    const column = sources[row.consumer]!.split("\n")[1]!.indexOf("Widget") + 1;
    for (const index of [cold, warm]) {
      const result = await goToDefinition(index, { file: files[row.consumer]!, line: 2, column });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected qualified type");
      expect(result.definition.file).toBe(files[row.target]);
      expect(result.definition.file).not.toBe(files[row.decoy]);
    }
  });
  it.each(JVM_QUALIFIED_REVIEW_CASES)("keeps $language qualified package identities on disk reload", async (row) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-review-`));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-review-cache-`));
    tempDirs.push(root, cacheDir);
    const sources: Readonly<Record<string, string>> = row.sources;
    const files = await writeFixtureFiles(root, sources);
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const cold = await buildProjectIndex(root, options);
    const warm = await buildProjectIndexIncremental(root, options);
    const lines = sources[row.consumer]!.split("\n");
    for (const index of [cold, warm]) {
      const graph = await buildSymbolGraphDetailed(index);
      for (const [caller, line, name, target] of [
        ["a", 5, "Widget", row.other],
        ["b", 6, "Widget", row.imported],
        ["c", 7, "Inner", row.nested],
        ["d", 8, "Inner", row.nested],
        ["e", 9, "Widget", row.other],
      ] as const) {
        const result = await goToDefinition(index, {
          file: files[row.consumer]!,
          line,
          column: columnOf(lines, line, name),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected qualified JVM declaration");
        expect(result.definition.file).toBe(files[target]);
        const uses = graph.edges
          .filter((edge) => edge.label === "uses" && graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => `${graph.nodes.get(edge.to)?.file}::${graph.nodes.get(edge.to)?.name}`);
        expect(uses).toContain(`${files[target]}::${name}`);
        if (caller === "a" || caller === "e") expect(uses).not.toContain(`${files[row.imported]}::Widget`);
      }
      const declaration = sources[row.other]!.split("\n");
      const references = await findReferences(index, {
        file: files[row.other]!,
        line: 2,
        column: columnOf(declaration, 2, "Widget"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected qualified JVM references");
      expect(references.referenceCoverage.state).toBe("complete");
      const sites = references.references
        .filter((reference) => reference.file === files[row.consumer])
        .map((reference) => reference.range.start.line);
      expect(sites).toContain(5);
      expect(sites).toContain(9);
      expect(sites).not.toContain(6);
    }
  });
  it.each(JVM_QUALIFIED_REVIEW_CASES)(
    "refreshes $language qualified targets after an incremental edit",
    async (row) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-edit-`));
      const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-native-${row.language}-qualified-edit-cache-`));
      tempDirs.push(root, cacheDir);
      const sources: Readonly<Record<string, string>> = row.sources;
      const files = await writeFixtureFiles(root, sources);
      const options = { cache: "disk", cacheDir, threads: 1 } as const;
      const cold = await buildProjectIndex(root, options);
      await buildSymbolGraphDetailed(cold);
      await fsp.writeFile(files[row.other]!, sources[row.other]!.replace("class Widget", "class Removed"));
      const changed = await buildProjectIndexIncremental(root, options);
      const lines = sources[row.consumer]!.split("\n");
      const request = { file: files[row.consumer]!, line: 5, column: columnOf(lines, 5, "Widget") };
      const missing = await goToDefinition(changed, request);
      expect(missing.status).toBe("not_found");
      const changedGraph = await buildSymbolGraphDetailed(changed);
      expect(
        changedGraph.edges.some(
          (edge) =>
            changedGraph.nodes.get(edge.from)?.name === "a" &&
            changedGraph.nodes.get(edge.to)?.file === files[row.imported],
        ),
      ).toBe(false);
      await fsp.writeFile(files[row.other]!, sources[row.other]!);
      const restored = await buildProjectIndexIncremental(root, options);
      const result = await goToDefinition(restored, request);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected the restored qualified type");
      expect(result.definition.file).toBe(files[row.other]);
      const graph = await buildSymbolGraphDetailed(restored);
      expect(
        graph.edges.some(
          (edge) => graph.nodes.get(edge.from)?.name === "a" && graph.nodes.get(edge.to)?.file === files[row.other],
        ),
      ).toBe(true);
    },
  );
});
nativeDescribe("removed duplicate declarations retain native semantic parity", () => {
  it.each(DUPLICATE_DECLARATION_CASES)(
    "matches cold $languageId graphs after the $declarer duplicate is removed by $mutation and restored",
    async ({ fixture, mutation, declarer }) => {
      await withDuplicateDeclarations(fixture, { cache: "disk", mutation, declarer }, async (project) => {
        const { removed, removedCold, restored, restoredCold, consumer, decoy, survivor, query, declaration } = project;
        const graphEdges = async (index: ProjectIndex): Promise<string[]> =>
          (await buildSymbolGraphDetailed(index)).edges.map((edge) => JSON.stringify(edge)).sort();
        expect(await graphEdges(removed)).toEqual(await graphEdges(removedCold));
        expect(await graphEdges(restored)).toEqual(await graphEdges(restoredCold));
        const graph = await buildSymbolGraphDetailed(removed);
        const target = [...graph.nodes.values()].find(
          (node) => fileIdentityKey(node.file) === fileIdentityKey(survivor) && node.name === "Gadget",
        );
        expect(target).toBeDefined();
        expect(
          graph.edges.some(
            (edge) =>
              edge.to === target!.id && fileIdentityKey(graph.nodes.get(edge.from)!.file) === fileIdentityKey(consumer),
          ),
        ).toBe(true);
        expect(
          graph.edges.some(
            (edge) =>
              fileIdentityKey(graph.nodes.get(edge.from)!.file) === fileIdentityKey(consumer) &&
              fileIdentityKey(graph.nodes.get(edge.to)!.file) === fileIdentityKey(decoy),
          ),
        ).toBe(false);
        for (const [actual, expected] of [
          [removed, removedCold],
          [restored, restoredCold],
        ] as const) {
          expect(await goToDefinition(actual, query)).toEqual(await goToDefinition(expected, query));
          expect(await findReferences(actual, declaration)).toEqual(await findReferences(expected, declaration));
        }
      });
    },
  );
});

nativeDescribe("restored declaration imports retain native semantic parity", () => {
  it.each(RESTORED_DECLARATION_FIXTURES)(
    "restores $languageId symbol edges across incremental and disk snapshot builds",
    async (fixture) => {
      await withRestoredDeclarationImport(fixture, "disk", async (project) => {
        const { root, restored, cold, owner, consumer, decoy, query, declaration } = project;
        const reopened = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
        const coldGraph = await buildSymbolGraphDetailed(cold);
        const expectedEdges = coldGraph.edges.map((edge) => JSON.stringify(edge)).sort();
        for (const index of [restored, reopened]) {
          const graph = await buildSymbolGraphDetailed(index);
          expect(graph.edges.map((edge) => JSON.stringify(edge)).sort()).toEqual(expectedEdges);
          const target = [...graph.nodes.values()].find(
            (node) => fileIdentityKey(node.file) === fileIdentityKey(owner) && node.name === "Gadget",
          );
          expect(target).toBeDefined();
          expect(
            graph.edges.some(
              (edge) =>
                edge.to === target!.id &&
                fileIdentityKey(graph.nodes.get(edge.from)!.file) === fileIdentityKey(consumer),
            ),
          ).toBe(true);
          expect(
            graph.edges.some(
              (edge) =>
                fileIdentityKey(graph.nodes.get(edge.from)!.file) === fileIdentityKey(consumer) &&
                fileIdentityKey(graph.nodes.get(edge.to)!.file) === fileIdentityKey(decoy),
            ),
          ).toBe(false);
          expect(await goToDefinition(index, query)).toEqual(await goToDefinition(cold, query));
          expect(await findReferences(index, declaration)).toEqual(await findReferences(cold, declaration));
        }
      });
    },
  );
});
nativeDescribe("native C# qualified receiver cache parity", () => {
  it.each(CSHARP_QUALIFIED_RECEIVER_TYPES)("retains %s targets and references on disk reload", async (type) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-qualified-receiver-"));
    tempDirs.push(root);
    const fixture = csharpQualifiedReceiverFixture(type);
    const files = await writeFixtureFiles(root, fixture.files);
    for (let build = 0; build < 2; build += 1) {
      clearMemoryCache();
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      const graph = await buildSymbolGraphDetailed(index);
      for (const file of ["Value.cs", "Other.cs"] as const) {
        const expected = file === "Value.cs" ? fixture.calls : [fixture.decoyCall];
        expect(
          graph.edges
            .filter(
              (edge) =>
                edge.label === "calls" &&
                graph.nodes.get(edge.to)?.file === files[file] &&
                graph.nodes.get(edge.to)?.name === "Run",
            )
            .map((edge) => edge.site?.range.start.line),
        ).toEqual(expected);
        const refs = await findReferences(index, {
          file: files[file]!,
          line: 1,
          column: fixture.files[file].indexOf("Run") + 1,
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Expected cached qualified receiver references");
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(
          refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual(expected);
        for (const line of expected) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(fixture.lines, line, "Run"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files[file]);
        }
      }
    }
  });

  it.each(CSHARP_NEARER_RECEIVER_CASES)("retains $root $scope-root proofs on disk reload", async ({ root, scope }) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-nearer-receiver-"));
    tempDirs.push(dir);
    const fixture = csharpNearerReceiverFixture(root, scope);
    const files = await writeFixtureFiles(dir, fixture.files);
    for (let build = 0; build < 2; build += 1) {
      clearMemoryCache();
      const index = await buildProjectIndex(dir, { cache: "disk" });
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      const line = fixture.calls[0]!;
      const result = await goToDefinition(index, {
        file: files["Use.cs"]!,
        line,
        column: columnOf(fixture.lines, line, "Run"),
      });
      expect(result.status).toBe(fixture.target ? "ok" : "not_found");
      if (fixture.target && result.status === "ok") expect(result.definition.file).toBe(files[fixture.target]);
      const refs = await findReferences(index, {
        file: files["Global.cs"]!,
        line: 1,
        column: fixture.files["Global.cs"].indexOf("Run") + 1,
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected cached nearer receiver references");
      expect(refs.referenceCoverage.state).toBe(fixture.target ? "complete" : "partial");
      expect(
        refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
      ).toEqual([fixture.globalCall]);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && edge.site?.range.start.line === line)
        .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(targets).toEqual(fixture.target ? [files[fixture.target]] : []);
    }
  });
});
nativeDescribe("native C# lowercase alias call cache parity", () => {
  it.each(CSHARP_ALIAS_CALL_SPELLINGS)("retains %s static and value targets on disk reload", async (alias) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-alias-calls-"));
    tempDirs.push(root);
    const fixture = csharpAliasCallFixture(alias);
    const files = await writeFixtureFiles(root, fixture.files);
    for (let build = 0; build < 2; build += 1) {
      clearMemoryCache();
      const index = await buildProjectIndex(root, { cache: "disk" });
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      const graph = await buildSymbolGraphDetailed(index);
      for (const site of fixture.sites) {
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: site.line,
          column: columnOf(fixture.lines, site.line, "Run"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.file).toBe(files[site.target]);
        const calls = graph.edges.filter((edge) => edge.label === "calls" && edge.site?.range.start.line === site.line);
        expect(calls.map((edge) => graph.nodes.get(edge.to)?.file)).toEqual([files[site.target]]);
      }
      for (const file of ["Target.cs", "Decoy.cs"] as const) {
        const result = await findReferences(index, {
          file: files[file]!,
          line: 1,
          column: fixture.files[file].indexOf("Run") + 1,
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected native alias call references");
        expect(result.referenceCoverage.state).toBe("complete");
        expect(
          result.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual(fixture.sites.filter((site) => site.target === file).map((site) => site.line));
      }
    }
  });

  it.each(CSHARP_GENERIC_ALIAS_CASES)(
    "retains $scope parameter $parameter shadowing alias $alias on disk reload",
    async ({ alias, parameter, scope }) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-csharp-generic-alias-"));
      tempDirs.push(root);
      const fixture = csharpGenericAliasReceiverFixture(alias, parameter, scope);
      const files = await writeFixtureFiles(root, fixture.files);
      for (let build = 0; build < 2; build += 1) {
        clearMemoryCache();
        const index = await buildProjectIndex(root, { cache: "disk" });
        for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
        for (const line of fixture.shadowedCalls) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(fixture.lines, line, "Run"),
          });
          expect(result.status).toBe("not_found");
        }
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter((edge) => edge.label === "calls");
        expect(calls.map((edge) => [edge.site?.range.start.line, graph.nodes.get(edge.to)?.file])).toEqual([
          [fixture.restoredCall, files["Target.cs"]],
        ]);
        const refs = await findReferences(index, {
          file: files["Target.cs"]!,
          line: 1,
          column: fixture.files["Target.cs"].indexOf("Run") + 1,
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Expected cached generic alias references");
        expect(refs.referenceCoverage.state).toBe("partial");
        expect(
          refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual([fixture.restoredCall]);
      }
    },
  );
});
nativeDescribe("PHP path-fallback native graph parity", () => {
  for (const mapping of PHP_PATH_MAPPINGS) {
    it.each(PHP_PATH_IMPORT_FORMS.filter((form) => form.name === form.role))(
      `agrees on ${mapping} $name targets after disk reload and rename`,
      async (form) => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-path-native-"));
        tempDirs.push(root);
        const fixture = phpPathFallbackFixture(mapping, form);
        const files = await writeFixtureFiles(root, fixture.files);
        const owner = files[fixture.owner]!;
        const consumer = files["Use.php"]!;
        const definition = {
          file: owner,
          localName: "Gadget",
          range: { start: { index: fixture.ownerSource.indexOf("Gadget") } },
        };
        for (const [source, present] of [
          [fixture.ownerSource, true],
          [fixture.missingSource, false],
          [fixture.ownerSource, true],
        ] as const) {
          await fsp.writeFile(owner, source, "utf8");
          const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
          const persisted = await buildProjectIndex(root, { cache: "disk", threads: 1 });
          clearMemoryCache();
          const reopened = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
          const expectedDetailed = await buildSymbolGraphDetailed(cold);
          for (const index of [persisted, reopened]) {
            expect(index.graph.edges).toEqual(cold.graph.edges);
            expect(index.byFile.get(fileIdentityKey(owner))?.nativeOutcome).toBe("used");
            const detailed = await buildSymbolGraphDetailed(index);
            expect(detailed.edges).toEqual(expectedDetailed.edges);
            const importEdges = detailed.edges.filter((edge) => {
              const from = detailed.nodes.get(edge.from);
              return from?.kind === "import" && fileIdentityKey(from.file) === fileIdentityKey(consumer);
            });
            expect(importEdges.map((edge) => edge.to)).toEqual(present ? [defNodeId(definition)] : []);
            for (const graph of [await buildSymbolGraph(index), detailed]) {
              expect(
                graph.edges.some((edge) => {
                  const from = graph.nodes.get(edge.from);
                  const to = graph.nodes.get(edge.to);
                  return from?.file === consumer && to?.file === files["Decoy.php"];
                }),
              ).toBe(false);
            }
          }
        }
      },
    );
  }
});

nativeDescribe("Type-parameter receiver native parity", () => {
  it.each(TYPE_PARAMETER_RECEIVER_ROWS.map((row, position) => ({ row, position })))(
    "keeps goto, references, and graph edges on the class for $row.language row $position",
    async ({ row }) => {
      await expectTypeParameterReceiverRow(row, "off");
    },
  );
});
