import { describe, expect, it } from "vitest";
import {
  computeFileSymbolHashes,
  computeSymbolHash,
  detectSymbolChanges,
  symbolIdentifier,
  type SymbolHash,
} from "../src/util/symbolHash.js";
import { getIOSemaphore, mapLimitSemaphore, resetIOSemaphore, Semaphore } from "../src/util/concurrency.js";
import { sliceText, stringifyUnknown, toRange, unquote } from "../src/util/ast.js";
import { graphToTriples, type SymbolGraph, type SymbolNode } from "../src/index.js";
import { SymbolKind, type ExportEntry, type SymbolDef } from "../src/indexer.js";
import type { Graph } from "../src/types.js";
import runNativeExtraction, { createNativeExtractor } from "../src/worker/nativeExtractWorker.js";
import { compareEdges, edgeKey, parseGoImportAlias, toRelativeEdge } from "../src/indexer/shared.js";
import { collectImportsForFile } from "../src/indexer.js";
import { TS_SUPPORT } from "../src/languages.js";
import type { NativeCapture, NativeQueryResults } from "../src/native/treeSitterNative.js";

const makeRange = (start: number, end: number) => ({
  start: { line: 1, column: start + 1, index: start },
  end: { line: 1, column: end + 1, index: end },
});

const makeSymbol = (localName: string, kind: SymbolKind, start: number, end: number): SymbolDef => ({
  file: "src/example.ts",
  localName,
  kind,
  range: makeRange(start, end),
});

const makeHash = (id: string, hash: string): SymbolHash => ({
  id,
  hash,
  kind: "function",
  exported: false,
});

const capture = (name: string, text: string): NativeCapture => ({
  name,
  text,
  nodeType: "identifier",
  start: { row: 0, column: 0, index: 0 },
  end: { row: 0, column: text.length, index: text.length },
});

describe("targeted coverage for small utilities", () => {
  it("computes stable symbol hashes and exported markers from source ranges", () => {
    const source = "export function alpha() { return 1; }\nconst beta = 2;\n";
    const alpha = makeSymbol("alpha", SymbolKind.Function, 7, 37);
    const beta = makeSymbol("beta", SymbolKind.Variable, 38, 53);
    const exports: ExportEntry[] = [{ type: "local", exportedAs: "alpha", target: alpha }];

    const alphaHash = computeSymbolHash(alpha, source);
    const fileHashes = computeFileSymbolHashes([alpha, beta], exports, source);

    expect(symbolIdentifier(alpha)).toBe("alpha::function::7");
    expect(alphaHash).toMatchObject({
      id: "alpha::function::7",
      kind: SymbolKind.Function,
      exported: false,
    });
    expect(alphaHash.hash).toHaveLength(16);
    expect(fileHashes.map((entry) => [entry.id, entry.exported])).toEqual([
      ["alpha::function::7", true],
      ["beta::variable::38", false],
    ]);
  });

  it("classifies added removed modified and unchanged symbol hashes", () => {
    const oldAlpha = makeHash("alpha::function::0", "old");
    const oldBeta = makeHash("beta::function::10", "same");
    const oldRemoved = makeHash("removed::function::20", "gone");
    const newAlpha = makeHash("alpha::function::0", "new");
    const newBeta = makeHash("beta::function::10", "same");
    const newGamma = makeHash("gamma::function::30", "fresh");

    const changes = detectSymbolChanges([oldAlpha, oldBeta, oldRemoved], [newAlpha, newBeta, newGamma]);

    expect(changes.added).toEqual([newGamma]);
    expect(changes.removed).toEqual([oldRemoved]);
    expect(changes.modified).toEqual([newAlpha]);
    expect(changes.unchanged).toEqual([newBeta]);
  });

  it("bounds concurrent work and releases permits after failures", async () => {
    const semaphore = new Semaphore(1);

    await semaphore.acquire();
    expect(semaphore.available()).toBe(0);
    const queued = semaphore.acquire().then(() => "queued");
    expect(semaphore.waiting()).toBe(1);
    semaphore.release();
    await expect(queued).resolves.toBe("queued");
    expect(semaphore.available()).toBe(0);
    semaphore.release();

    await expect(
      semaphore.withPermit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(semaphore.available()).toBe(1);
  });
  it("preserves FIFO order through a large semaphore queue and compaction", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const order: number[] = [];
    const waiters = Array.from({ length: 2048 }, (_, index) =>
      semaphore.acquire().then(() => {
        order.push(index);
        semaphore.release();
      }),
    );
    semaphore.release();
    await Promise.all(waiters);
    expect(order).toEqual(Array.from({ length: 2048 }, (_, index) => index));
    expect(semaphore.waiting()).toBe(0);
  });

  it("maps with bounded concurrency and caches the global I/O semaphore", async () => {
    await expect(() => new Semaphore(0)).toThrow("positive number");

    let active = 0;
    let maxActive = 0;
    const results = await mapLimitSemaphore([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    resetIOSemaphore();
    const first = getIOSemaphore(3);
    const second = getIOSemaphore(1);
    resetIOSemaphore();
    const third = getIOSemaphore(1);

    expect(results).toEqual([2, 4, 6, 8]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(third.available()).toBe(1);
  });

  it("normalizes AST node text ranges and unknown values", () => {
    const node = {
      startIndex: 1,
      endIndex: 4,
      startPosition: { row: 2, column: 3 },
      endPosition: { row: 2, column: 6 },
    };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    function namedHelper() {
      return "value";
    }

    expect(sliceText(node, "abcdef")).toBe("bcd");
    expect(sliceText(undefined, "abcdef")).toBe("");
    expect(sliceText(node, "")).toBe("");
    expect(unquote("  `value`  ")).toBe("value");
    expect(unquote("plain")).toBe("plain");
    expect(toRange(node)).toEqual({
      start: { line: 3, column: 4, index: 1 },
      end: { line: 3, column: 7, index: 4 },
    });
    expect(toRange(null)).toEqual({
      start: { line: 0, column: 0, index: 0 },
      end: { line: 0, column: 0, index: 0 },
    });
    expect(stringifyUnknown(new Error("failure"))).toBe("failure");
    expect(stringifyUnknown(3n)).toBe("3");
    expect(stringifyUnknown(null)).toBe("null");
    expect(stringifyUnknown(circular)).toBe("[Object]");
    expect(stringifyUnknown(Symbol.for("codegraph"))).toBe("Symbol(codegraph)");
    expect(stringifyUnknown(namedHelper)).toBe("[Function: namedHelper]");
  });
});

describe("targeted coverage for graph triples and native worker fallback", () => {
  it("collects default namespace and named imports from native import binding captures", async () => {
    const source = [
      'import alpha from "pkg-alpha";',
      'import * as beta from "pkg-beta";',
      'import { gamma as localGamma } from "pkg-gamma";',
    ].join("\n");
    const nativeQueries: NativeQueryResults = {
      imports: [],
      exports: [],
      locals: [],
      importBindings: [
        {
          patternIndex: 0,
          captures: [
            capture("stmt", 'import alpha from "pkg-alpha";'),
            capture("def", "alpha"),
            capture("from", '"pkg-alpha"'),
          ],
        },
        {
          patternIndex: 1,
          captures: [
            capture("stmt", 'import * as beta from "pkg-beta";'),
            capture("ns", "beta"),
            capture("from", '"pkg-beta"'),
          ],
        },
        {
          patternIndex: 2,
          captures: [
            capture("stmt", 'import { gamma as localGamma } from "pkg-gamma";'),
            capture("iname", "gamma"),
            capture("alias", "localGamma"),
            capture("from", '"pkg-gamma"'),
          ],
        },
      ],
    };

    const imports = await collectImportsForFile("C:/repo/src/main.ts", "C:/repo", {
      source,
      sup: TS_SUPPORT,
      nativeQueries,
    });

    expect(imports.map((entry) => ({ kind: entry.kind, from: entry.from }))).toEqual([
      { kind: "default", from: "pkg-alpha" },
      { kind: "namespace", from: "pkg-beta" },
      { kind: "named", from: "pkg-gamma" },
    ]);
    expect(imports[0]).toMatchObject({ local: "alpha", resolved: { external: "pkg-alpha" } });
    expect(imports[1]).toMatchObject({ localNS: "beta", resolved: { external: "pkg-beta" } });
    expect(imports[2]).toMatchObject({
      local: "localGamma",
      imported: "gamma",
      resolved: { external: "pkg-gamma" },
    });
  });

  it("formats and sorts shared indexer edge helpers", () => {
    const externalEdge = {
      from: "C:/repo/src/main.ts",
      to: { type: "external" as const, name: "react" },
      raw: "react",
      typeOnly: true,
    };
    const fileEdge = {
      from: "C:/repo/src/main.ts",
      to: { type: "file" as const, path: "C:/repo/src/util.ts" },
      raw: "./util",
    };
    const laterFileEdge = {
      from: "C:/repo/src/main.ts",
      to: { type: "file" as const, path: "C:/repo/src/z.ts" },
      raw: "./z",
    };

    expect(parseGoImportAlias('import alias "github.com/acme/pkg"')).toBe("alias");
    expect(parseGoImportAlias('import\talias "github.com/acme/pkg"')).toBe("alias");
    expect(parseGoImportAlias('import   alias "github.com/acme/pkg"')).toBe("alias");
    expect(parseGoImportAlias('import . "github.com/acme/pkg"')).toBe(".");
    expect(parseGoImportAlias('import _ "github.com/acme/pkg"')).toBe("_");
    expect(parseGoImportAlias('import "fmt"')).toBeNull();
    // The dot-import token is standalone; ".alias" is not valid Go syntax and must not be
    // captured as an identifier.
    expect(parseGoImportAlias('import .alias "github.com/acme/pkg"')).toBeNull();
    // Go's unicode_digit is Nd only; a non-decimal number character (No, e.g. "½") is not a
    // valid identifier continuation.
    expect(parseGoImportAlias('import a\u00bd "github.com/acme/pkg"')).toBeNull();
    expect(edgeKey(externalEdge)).toBe("C:/repo/src/main.ts|external:react|react|1");
    expect(compareEdges(fileEdge, externalEdge)).toBeLessThan(0);
    expect(compareEdges(fileEdge, laterFileEdge)).toBeLessThan(0);
    expect(toRelativeEdge("C:/repo", fileEdge)).toEqual({
      from: "src/main.ts",
      to: { type: "file", path: "src/util.ts" },
      raw: "./util",
    });
    expect(toRelativeEdge("C:/repo", externalEdge)).toEqual({
      from: "src/main.ts",
      to: { type: "external", name: "react" },
      raw: "react",
      typeOnly: true,
    });
  });

  it("exports external import triples and skips symbol edges with missing endpoints", () => {
    const fileGraph: Graph = {
      nodes: new Set(["src/main.ts"]),
      edges: [
        {
          from: "src/main.ts",
          to: { type: "external", name: "react" },
          raw: "react",
        },
      ],
    };
    const symbolNode: SymbolNode = {
      id: "src/main.ts#main",
      name: "main",
      kind: "function",
      file: "src/main.ts",
      range: makeRange(0, 4),
      docstring: "Entrypoint",
      lineSpan: 3,
      complexity: 2,
    };
    const symbolGraph: SymbolGraph = {
      nodes: new Map([[symbolNode.id, symbolNode]]),
      edges: [{ from: symbolNode.id, to: "missing", label: "calls" }],
    };

    const triples = graphToTriples(fileGraph, symbolGraph);

    expect(triples).toEqual([
      {
        subject: { type: "file", id: "src/main.ts", path: "src/main.ts" },
        predicate: "imports",
        object: { type: "external", id: "external:react", name: "react" },
      },
    ]);
  });

  it("returns source and fallback details from the production native extractor fallback", async () => {
    const result = await runNativeExtraction({
      filePath: "virtual.ts",
      languageId: "definitely-not-a-supported-language",
      source: "export const value = 1;\n",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(result.filePath).toBe("virtual.ts");
    expect(result.languageId).toBe("definitely-not-a-supported-language");
    expect(result.source).toBe("export const value = 1;\n");
    expect(result.nativeResults).toBeNull();
    expect(result.compactResults).toBeNull();
    expect(["unavailable", "unsupportedLanguage"]).toContain(result.fallbackReason);
  });

  it("distinguishes deterministic unavailable and unsupported native extraction fallbacks", async () => {
    const unavailableExtractor = createNativeExtractor({
      loadBinding: () => ({ binding: null, error: new Error("native missing") }),
      readFile: async () => "from disk",
    });
    const unsupportedExtractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => {
            throw new Error("unexpected query");
          },
          extractLanguage: () => {
            throw new Error("unexpected query");
          },
        },
      }),
      readFile: async () => "from disk",
    });

    const unavailable = await unavailableExtractor({
      filePath: "virtual.ts",
      languageId: "ts",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });
    const unsupported = await unsupportedExtractor({
      filePath: "virtual.go",
      languageId: "go",
      source: "package main\n",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(unavailable).toMatchObject({
      source: "from disk",
      fallbackReason: "unavailable",
      nativeResults: null,
      compactResults: null,
    });
    expect(unavailable.error).toContain("native missing");
    expect(unsupported).toMatchObject({
      source: "package main\n",
      fallbackReason: "unsupportedLanguage",
      nativeResults: null,
      compactResults: null,
    });
  });

  it("creates injectable native extractors for success compact and failure paths", async () => {
    let loadCount = 0;
    const extractor = createNativeExtractor({
      loadBinding: () => {
        loadCount += 1;
        return {
          binding: {
            supportedLanguageIds: () => ["ts"],
            runLanguageQueries: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => ({
              imports: [{ patternIndex: 0, captures: [capture("source", source), capture("language", languageId)] }],
              exports: [{ patternIndex: 0, captures: [capture("query", exportsQuery)] }],
              locals: [{ patternIndex: 0, captures: [capture("query", localsQuery)] }],
              importBindings: [{ patternIndex: 0, captures: [capture("query", importBindingsQuery)] }],
            }),
            extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => ({
              results: {
                imports: [{ patternIndex: 0, captures: [capture("source", source), capture("language", languageId)] }],
                exports: [{ patternIndex: 0, captures: [capture("query", exportsQuery)] }],
                locals: [{ patternIndex: 0, captures: [capture("query", localsQuery)] }],
                importBindings: [{ patternIndex: 0, captures: [capture("query", importBindingsQuery)] }],
              },
              syntaxTree: null,
            }),
            runImportsQueryCompact: (source, languageId, importsQuery) => ({
              imports: [{ patternIndex: 0, captures: [{ name: languageId, text: `${importsQuery}:${source}` }] }],
            }),
          },
        };
      },
      readFile: async () => "from disk",
    });

    const full = await extractor({
      filePath: "virtual.ts",
      languageId: "ts",
      importsQuery: "imports",
      exportsQuery: "exports",
      localsQuery: "locals",
      importBindingsQuery: "bindings",
    });
    const compact = await extractor({
      filePath: "virtual.ts",
      languageId: "ts",
      source: "provided",
      importsQuery: "imports",
      exportsQuery: "exports",
      localsQuery: "locals",
      importBindingsQuery: "bindings",
      compact: true,
    });

    expect(loadCount).toBe(1);
    expect(full.source).toBe("from disk");
    expect(full.nativeResults?.imports[0]?.captures[0]?.text).toBe("from disk");
    expect(compact.nativeResults).toBeNull();
    expect(compact.compactResults?.imports[0]?.captures[0]).toEqual({ name: "ts", text: "imports:provided" });

    const failingExtractor = createNativeExtractor({
      loadBinding: () => ({
        binding: {
          supportedLanguageIds: () => ["ts"],
          runLanguageQueries: () => {
            throw new Error("query failed");
          },
          extractLanguage: () => {
            throw new Error("query failed");
          },
        },
      }),
      readFile: async () => {
        throw new Error("unexpected read");
      },
    });

    const failed = await failingExtractor({
      filePath: "virtual.ts",
      languageId: "ts",
      source: "provided",
      importsQuery: "",
      exportsQuery: "",
      localsQuery: "",
      importBindingsQuery: "",
    });

    expect(failed).toMatchObject({
      fallbackReason: "queryFailure",
      error: "query failed",
      nativeResults: null,
      compactResults: null,
    });
  });
});
