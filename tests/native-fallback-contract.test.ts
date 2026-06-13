import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  collectImportsForFile,
  collectLocalsAndExportsFromSource,
  SymbolKind,
  type BuildReport,
  type ModuleIndex,
  type ProjectIndex,
} from "../src/index.js";
import { prepareParserInput } from "../src/languages/filePrep.js";
import { parsePreparedFileContext } from "../src/indexer/parse-context.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";
import { supportForFile } from "../src/languages.js";
import type { NativeCapture, NativeQueryResults } from "../src/native/treeSitterNative.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;

function normalizeFile(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

const REQUIRED_NATIVE_UNAVAILABLE = "native tree-sitter required by explicit option but unavailable";

const nativeCapture = (name: string, text: string): NativeCapture => ({
  name,
  text,
  nodeType: "identifier",
  start: { row: 0, column: 0, index: 0 },
  end: { row: 0, column: text.length, index: text.length },
});

function simplifyModule(index: ModuleIndex): unknown {
  return {
    imports: index.imports.map((entry) => ({
      ...entry,
      resolved: typeof entry.resolved === "string" ? normalizeFile(entry.resolved) : entry.resolved,
    })),
    locals: index.locals.map((local) => ({
      localName: local.localName,
      kind: local.kind,
    })),
    exports: index.exports.map((entry) => {
      if (entry.type === "local") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          localName: entry.target.localName,
          kind: entry.target.kind,
        };
      }
      if (entry.type === "reexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeFile(entry.fromModule),
          sourceSpecifier: entry.sourceSpecifier,
          typeOnly: entry.typeOnly ?? false,
        };
      }
      if (entry.type === "namespaceReexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeFile(entry.fromModule),
          typeOnly: entry.typeOnly ?? false,
        };
      }
      return {
        type: entry.type,
        fromModule: normalizeFile(entry.fromModule),
        sourceSpecifier: entry.sourceSpecifier,
        typeOnly: entry.typeOnly ?? false,
      };
    }),
  };
}

async function makeTempProject(): Promise<{
  root: string;
  alphaFile: string;
  betaFile: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-fallback-"));
  const alphaFile = path.join(root, "alpha.ts");
  const betaFile = path.join(root, "beta.ts");

  await fsp.writeFile(
    betaFile,
    ["export const betaValue = 1;", "export function betaHelper() {", "  return betaValue;", "}", ""].join("\n"),
    "utf8",
  );

  await fsp.writeFile(
    alphaFile,
    [
      "import { betaHelper, betaValue } from './beta';",
      "",
      "export function alphaValue() {",
      "  return betaHelper() + betaValue;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return { root, alphaFile, betaFile };
}

async function computeJsOnlyModule(file: string, projectRoot: string): Promise<unknown> {
  const prepared = await prepareParserInput(file);
  const imports = await collectImportsForFile(file, projectRoot, {
    source: prepared.source,
    sup: prepared.sup,
    lang: prepared.lang,
  });
  const moduleIndex = collectLocalsAndExportsFromSource(
    normalizeFile(file),
    prepared.source,
    prepared.sup,
    prepared.lang,
    imports,
  );
  moduleIndex.imports = imports;
  return simplifyModule(moduleIndex);
}

function mockNativeFailureForFile(file: string) {
  const normalizedFile = normalizeFile(file);
  const original = nativeRuntime.getNativeQueryExecution;
  return vi.spyOn(nativeRuntime, "getNativeQueryExecution").mockImplementation((source, support) => {
    if (support.id === "ts" && source.includes("export function alphaValue") && normalizedFile.endsWith("/alpha.ts")) {
      return {
        results: null,
        fallbackReason: "queryFailure",
        error: "forced native query failure",
      };
    }
    return original(source, support);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native required fallback boundaries", () => {
  it("does not suppress required-native failures during locals enrichment", () => {
    const file = normalizeFile(path.join(os.tmpdir(), "required-native.ts"));
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) return;

    const nativeQueries: NativeQueryResults = {
      imports: [],
      exports: [],
      locals: [
        {
          patternIndex: 0,
          captures: [nativeCapture("name", "alpha")],
        },
      ],
      importBindings: [],
    };
    vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation((mode) => {
      if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
    });
    const syntaxSpy = vi
      .spyOn(nativeRuntime, "getNativeSyntaxTreeExecution")
      .mockImplementation((_source, _support, mode) => {
        if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
        throw new Error(REQUIRED_NATIVE_UNAVAILABLE);
      });

    expect(() =>
      collectLocalsAndExportsFromSource(file, "export const alpha = 1;\n", support, undefined, [], {
        nativeMode: "on",
        nativeQueries,
      }),
    ).toThrow(REQUIRED_NATIVE_UNAVAILABLE);
    expect(syntaxSpy).toHaveBeenCalled();
  });

  it("does not require native availability for graph-only local collection", () => {
    const file = normalizeFile(path.join(os.tmpdir(), "required-native.md"));
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) return;

    const nativeRequiredSpy = vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation(() => {
      throw new Error(REQUIRED_NATIVE_UNAVAILABLE);
    });

    const moduleIndex = collectLocalsAndExportsFromSource(file, "[Guide](./guide.md)\n", support, undefined, [], {
      nativeMode: "on",
    });

    expect(moduleIndex).toEqual({ file, exports: [], imports: [], locals: [] });
    expect(nativeRequiredSpy).not.toHaveBeenCalled();
  });

  it("uses a minimal syntax tree for reduced-mode parse recovery", () => {
    const file = normalizeFile(path.join(os.tmpdir(), "reduced-mode-parse.ts"));
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) return;

    const parsed = parsePreparedFileContext({
      file,
      source: "export const alpha = 1;\n",
      sup: support,
      nativeMode: "off",
      nativeQueries: null,
    });

    expect(parsed.source).toBe("export const alpha = 1;\n");
    expect(parsed.sup.id).toBe("ts");
    expect(parsed.tree.rootNode.type).toBe("document");
    expect(parsed.tree.rootNode.namedChildren).toEqual([]);
  });

  it("preserves required-native parse failures", () => {
    const file = normalizeFile(path.join(os.tmpdir(), "required-native-parse.ts"));
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) return;

    vi.spyOn(nativeRuntime, "getNativeSyntaxTreeExecution").mockReturnValue({
      tree: null,
      fallbackReason: "unavailable",
      error: REQUIRED_NATIVE_UNAVAILABLE,
    });

    expect(() =>
      parsePreparedFileContext({
        file,
        source: "export const alpha = 1;\n",
        sup: support,
        nativeMode: "on",
        nativeQueries: null,
      }),
    ).toThrow(`Failed to reconstruct syntax tree for ${file}`);
  });

  it("validates required-native mode before using supplied non-graph-only query data", () => {
    const file = normalizeFile(path.join(os.tmpdir(), "required-native-supplied.ts"));
    const support = supportForFile(file);
    expect(support).toBeDefined();
    if (!support) return;

    const nativeQueries: NativeQueryResults = {
      imports: [],
      exports: [],
      locals: [],
      importBindings: [],
    };
    vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation((mode) => {
      if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
      throw new Error(REQUIRED_NATIVE_UNAVAILABLE);
    });

    expect(() =>
      collectLocalsAndExportsFromSource(file, "export const alpha = 1;\n", support, undefined, [], {
        nativeMode: "on",
        nativeQueries,
      }),
    ).toThrow(REQUIRED_NATIVE_UNAVAILABLE);
  });

  it("does not suppress required-native failures during detailed symbol graph building", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-required-native-detailed-"));
    const file = normalizeFile(path.join(root, "entry.ts"));
    await fsp.writeFile(file, "export function alpha() { return 1; }\n", "utf8");
    const local = {
      file,
      localName: "alpha",
      kind: SymbolKind.Function,
      range: {
        start: { line: 1, column: 16, index: 16 },
        end: { line: 1, column: 21, index: 21 },
      },
    };
    const moduleIndex: ModuleIndex = {
      file,
      exports: [{ type: "local", exportedAs: "alpha", target: local }],
      imports: [],
      locals: [local],
    };
    const index: ProjectIndex = {
      graph: { nodes: new Set([file]), edges: [] },
      modules: new Map([[file, moduleIndex]]),
      byFile: new Map([[file, moduleIndex]]),
      projectRoot: root,
      nativeMode: "on",
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation((mode) => {
      if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
    });
    const syntaxSpy = vi
      .spyOn(nativeRuntime, "getNativeSyntaxTreeExecution")
      .mockImplementation((_source, _support, mode) => {
        if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
        throw new Error(REQUIRED_NATIVE_UNAVAILABLE);
      });

    try {
      await expect(buildSymbolGraphDetailed(index)).rejects.toThrow(REQUIRED_NATIVE_UNAVAILABLE);
      expect(syntaxSpy).toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not suppress required-native failures for graph-only detailed symbol graph files", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-required-native-detailed-md-"));
    const file = normalizeFile(path.join(root, "entry.md"));
    await fsp.writeFile(file, "[Guide](./guide.md)\n", "utf8");
    const moduleIndex: ModuleIndex = {
      file,
      exports: [],
      imports: [],
      locals: [],
    };
    const index: ProjectIndex = {
      graph: { nodes: new Set([file]), edges: [] },
      modules: new Map([[file, moduleIndex]]),
      byFile: new Map([[file, moduleIndex]]),
      projectRoot: root,
      nativeMode: "on",
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    vi.spyOn(nativeRuntime, "assertNativeRequiredAvailable").mockImplementation((mode) => {
      if (mode !== "on") throw new Error(`unexpected native mode: ${String(mode)}`);
      throw new Error(REQUIRED_NATIVE_UNAVAILABLE);
    });

    try {
      await expect(buildSymbolGraphDetailed(index)).rejects.toThrow(REQUIRED_NATIVE_UNAVAILABLE);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

nativeDescribe("native fallback contract", () => {
  it("falls back cleanly for one file without mixing native and JS extraction", async () => {
    const { root, alphaFile, betaFile } = await makeTempProject();
    const alphaNormalized = normalizeFile(alphaFile);
    const betaNormalized = normalizeFile(betaFile);
    const jsOnlyAlpha = await computeJsOnlyModule(alphaFile, root);

    const spy = mockNativeFailureForFile(alphaFile);
    const report: BuildReport = { timings: {} };

    try {
      const index = await buildProjectIndexFromFiles(root, [alphaFile, betaFile], {
        report,
      });

      expect(simplifyModule(index.byFile.get(alphaNormalized)!)).toEqual(jsOnlyAlpha);
      expect(report.backend?.native.byLanguage.ts?.filesSeen).toBe(2);
      expect(report.backend?.native.byLanguage.ts?.filesUsed).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.filesFellBack).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.fallbackReasons.queryFailure).toBe(1);
      expect(report.backend?.native.errors).toContainEqual({
        file: alphaNormalized,
        languageId: "ts",
        reason: "queryFailure",
        message: "forced native query failure",
      });

      const betaModule = index.byFile.get(betaNormalized);
      expect(betaModule).toBeDefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the same per-file fallback contract in incremental builds", async () => {
    const { root, alphaFile, betaFile } = await makeTempProject();
    const alphaNormalized = normalizeFile(alphaFile);
    const jsOnlyAlpha = await computeJsOnlyModule(alphaFile, root);

    try {
      await buildProjectIndex(root, { cache: "disk" });

      const report: BuildReport = { timings: {} };
      const spy = mockNativeFailureForFile(alphaFile);
      const index = await buildProjectIndexIncremental(root, {
        cache: "disk",
        files: [alphaFile, betaFile],
        report,
      });

      expect(simplifyModule(index.byFile.get(alphaNormalized)!)).toEqual(jsOnlyAlpha);
      expect(report.backend?.native.byLanguage.ts?.filesSeen).toBe(2);
      expect(report.backend?.native.byLanguage.ts?.filesUsed).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.filesFellBack).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.fallbackReasons.queryFailure).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
