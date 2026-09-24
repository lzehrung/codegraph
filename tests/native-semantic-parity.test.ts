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
  SymbolKind,
  type ProjectIndex,
  type SqlFactKind,
} from "../src/index.js";
import { resolveExport } from "../src/indexer/navigation-resolve.js";
import * as nativeRuntime from "../src/native/tree-sitter-native.js";
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
    ];

    for (const testCase of cases) {
      await expectNativeSemantics(testCase);
    }
    // This serial fixture matrix is CPU-bound. Under parallel native CI on Windows,
    // deterministic assertions can exceed 60 seconds, so retain headroom for host variance.
  }, 120_000);

  it("keeps C++ callable redeclarations connected across files", async () => {
    const fixture = await createCppCallableRedeclarationCase();
    const index = await expectNativeSemantics(fixture);
    const consumerFile = normalizeFile(fixture.files[2]!);
    const consumerLines = (await fsp.readFile(consumerFile, "utf8")).split("\n");
    for (const line of [3, 4, 5, 8]) {
      const text = consumerLines[line - 1]!;
      const token = line === 8 ? "pick" : "run";
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
      ).toEqual([line]);
    }
  });

  it("keeps native C tag and typedef export identities distinct", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-c-tag-typedef-"));
    tempDirs.push(root);
    const header = normalizeFile(path.join(root, "api.h"));
    const consumer = normalizeFile(path.join(root, "main.c"));
    await fsp.writeFile(header, "struct Item { int value; };\ntypedef struct Item *Item;\n", "utf8");
    await fsp.writeFile(consumer, '#include "api.h"\nstruct Item item;\nItem alias;\n', "utf8");
    const index = await withNativeRuntimeModeAsync("native", () =>
      buildProjectIndexFromFiles(root, [header, consumer], { cache: "off" }),
    );
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
      "",
    ];
    await fsp.writeFile(header, headerLines.join("\n"), "utf8");
    await fsp.writeFile(consumer, consumerLines.join("\n"), "utf8");
    const index = await withNativeRuntimeModeAsync("native", () =>
      buildProjectIndexFromFiles(root, [header, consumer], { cache: "off" }),
    );

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
    await withNativeRuntimeModeAsync("native", async () => {
      const index = await buildProjectIndexFromFiles(root, [source, consumer]);
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
    });
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
      const nativeIndex = await buildSemanticIndex(testCase, "native");
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
