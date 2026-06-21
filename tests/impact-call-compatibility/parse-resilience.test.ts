import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../../src/indexer.js";
import { findReferences } from "../../src/indexer/navigation.js";
import { attachCallCompatibilityHints } from "../../src/impact/callCompatibility.js";
import type { ChangedSymbol, ImpactDiagnostics } from "../../src/impact/types.js";
import type { Range } from "../../src/types.js";

function rangeFor(source: string, needle: string): Range {
  const index = source.lastIndexOf(needle);
  if (index < 0) {
    throw new Error(`Expected source to contain ${needle}`);
  }
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return {
    start: { line, column, index },
    end: { line, column: column + needle.length, index: index + needle.length },
  };
}

vi.mock(
  "../../src/indexer/navigation.js",
  async (importOriginal: () => Promise<typeof import("../../src/indexer/navigation.js")>) => {
    const actual = await importOriginal();
    return {
      ...actual,
      findReferences: vi.fn(),
      goToDefinition: vi.fn(),
    };
  },
);

describe("call compatibility parse resilience", () => {
  it("skips changed symbols when the definition file cannot be parsed", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-parse-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const apiFile = path.join(root, "src", "api.ts");
    const mainFile = path.join(root, "src", "main.ts");
    await fsp.writeFile(apiFile, "export function helper(a: string) { return a; }\n", "utf8");
    await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper("x");\n', "utf8");

    const index = await buildProjectIndex(root, { cache: "memory" });
    const indexedApiFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/api.ts"));
    if (!indexedApiFile) {
      throw new Error("Expected indexed api file");
    }
    const helperDef = index.byFile.get(indexedApiFile)?.locals.find((local) => local.localName === "helper");
    if (!helperDef) {
      throw new Error("Expected helper definition");
    }

    await fsp.unlink(apiFile);

    const changedSymbol: ChangedSymbol = {
      id: `${indexedApiFile}#helper`,
      file: indexedApiFile,
      name: "helper",
      kind: helperDef.kind,
      exported: true,
      range: helperDef.range,
      signatureChanged: true,
    };
    const diagnostics: ImpactDiagnostics = {
      changedFilesTotal: 1,
      changedFilesIgnored: 0,
      changedFilesWithoutSymbols: 0,
      symbolMappingParseFailures: 0,
      refsScanned: 0,
      refsFilteredTests: 0,
      refsFilteredIgnored: 0,
      refsDroppedByMaxRefs: 0,
      fallbackSeededFiles: 0,
      fallbackSeededDependents: 0,
      callCompatibility: {
        supportedLanguages: [],
        unsupportedLanguages: [],
        skippedByReason: {},
        unknownCallsites: 0,
        emittedHints: 0,
      },
    };

    await expect(
      attachCallCompatibilityHints(index, [changedSymbol], {
        maxRefs: 5,
        diagnostics,
      }),
    ).resolves.toBeUndefined();

    expect(diagnostics.callCompatibility?.skippedByReason["parse-failed"]).toBe(1);
    expect(changedSymbol.callCompatibility).toBeUndefined();
  });

  it("skips callsites when a referenced file cannot be parsed", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-callsite-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const apiFile = path.join(root, "src", "api.ts");
    const mainFile = path.join(root, "src", "main.ts");
    const apiSource = "export function helper(a: string, b: number) { return a + b; }\n";
    const mainSource = 'import { helper } from "./api";\nexport const value = helper("x", 1);\n';
    await fsp.writeFile(apiFile, apiSource, "utf8");
    await fsp.writeFile(mainFile, mainSource, "utf8");

    const index = await buildProjectIndex(root, { cache: "memory" });
    const indexedApiFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/api.ts"));
    const indexedMainFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/main.ts"));
    if (!indexedApiFile || !indexedMainFile) {
      throw new Error("Expected indexed fixture files");
    }
    const helperDef = index.byFile.get(indexedApiFile)?.locals.find((local) => local.localName === "helper");
    if (!helperDef) {
      throw new Error("Expected helper definition");
    }

    const changedSymbol: ChangedSymbol = {
      id: `${indexedApiFile}#helper`,
      file: indexedApiFile,
      name: "helper",
      kind: helperDef.kind,
      exported: true,
      range: helperDef.range,
      signatureChanged: true,
    };

    vi.mocked(findReferences).mockResolvedValue({
      status: "ok",
      definition: helperDef,
      references: [
        {
          file: indexedMainFile,
          range: rangeFor(mainSource, "helper"),
        },
      ],
    });

    await fsp.unlink(mainFile);

    const diagnostics: ImpactDiagnostics = {
      changedFilesTotal: 1,
      changedFilesIgnored: 0,
      changedFilesWithoutSymbols: 0,
      symbolMappingParseFailures: 0,
      refsScanned: 0,
      refsFilteredTests: 0,
      refsFilteredIgnored: 0,
      refsDroppedByMaxRefs: 0,
      fallbackSeededFiles: 0,
      fallbackSeededDependents: 0,
      callCompatibility: {
        supportedLanguages: [],
        unsupportedLanguages: [],
        skippedByReason: {},
        unknownCallsites: 0,
        emittedHints: 0,
      },
    };

    await expect(
      attachCallCompatibilityHints(index, [changedSymbol], {
        maxRefs: 5,
        diagnostics,
      }),
    ).resolves.toBeUndefined();

    expect(diagnostics.callCompatibility?.skippedByReason["parse-failed"]).toBe(2);
    expect(changedSymbol.callCompatibility).toBeUndefined();
  });
  it("counts verified scan parse failures in diagnostics", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-verified-parse-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const apiFile = path.join(root, "src", "api.ts");
    const extraFile = path.join(root, "src", "extra.ts");
    await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
    await fsp.writeFile(extraFile, 'import { helper } from "./api";\nexport const value = helper("x", 1);\n', "utf8");

    const index = await buildProjectIndex(root, { cache: "memory" });
    const indexedApiFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/api.ts"));
    if (!indexedApiFile) {
      throw new Error("Expected indexed api file");
    }
    const helperDef = index.byFile.get(indexedApiFile)?.locals.find((local) => local.localName === "helper");
    if (!helperDef) {
      throw new Error("Expected helper definition");
    }

    const changedSymbol: ChangedSymbol = {
      id: `${indexedApiFile}#helper`,
      file: indexedApiFile,
      name: "helper",
      kind: helperDef.kind,
      exported: true,
      range: helperDef.range,
      signatureChanged: true,
    };

    vi.mocked(findReferences).mockResolvedValue({
      status: "ok",
      references: [],
    });

    await fsp.unlink(extraFile);

    const diagnostics: ImpactDiagnostics = {
      changedFilesTotal: 1,
      changedFilesIgnored: 0,
      changedFilesWithoutSymbols: 0,
      symbolMappingParseFailures: 0,
      refsScanned: 0,
      refsFilteredTests: 0,
      refsFilteredIgnored: 0,
      refsDroppedByMaxRefs: 0,
      fallbackSeededFiles: 0,
      fallbackSeededDependents: 0,
      callCompatibility: {
        supportedLanguages: [],
        unsupportedLanguages: [],
        skippedByReason: {},
        unknownCallsites: 0,
        emittedHints: 0,
      },
    };

    await expect(
      attachCallCompatibilityHints(index, [changedSymbol], {
        maxRefs: 5,
        diagnostics,
      }),
    ).resolves.toBeUndefined();

    expect(diagnostics.callCompatibility?.skippedByReason["parse-failed"]).toBe(1);
    vi.mocked(findReferences).mockReset();
  });
});
