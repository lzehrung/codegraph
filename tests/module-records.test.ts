import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import v8 from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  listProjectFiles,
  type BuildReport,
  type ProjectIndex,
} from "../src/index.js";
import { cacheRoot } from "../src/indexer/build-cache/location.js";
import { fileIdentityKey } from "../src/util/paths.js";
import * as nativeWorkerPool from "../src/worker/native-worker-pool.js";
import * as moduleRecords from "../src/indexer/module-record.js";
import {
  buildModuleRecord,
  decodeModuleRecord,
  encodeModuleRecord,
  finishModuleRecord,
  type ModuleRecord,
  type ModuleRecordInput,
  type ModuleRecordPayload,
} from "../src/indexer/module-record.js";
import * as parseErrors from "../src/indexer/parse-errors.js";
import {
  PendingImportResolutionError,
  PendingImportTarget,
  resolvedImportFile,
} from "../src/indexer/imports/context.js";
import type { ImportBinding, ModuleIndex } from "../src/indexer/types.js";
import { supportForFile } from "../src/languages.js";
import { ProjectedSyntaxTree } from "../src/native/projected-tree.js";
import { getNativeExtractionExecution, type NativeCapture } from "../src/native/tree-sitter-native.js";

const repoRoot = process.cwd();
const sampleRoot = path.join(repoRoot, "tests", "samples");
const corpusRoot = path.join(repoRoot, "tests", "edge-corpus", "typescript");
const spreadRoot = path.join(sampleRoot, "language-regressions", "javascript");
const jsTsRoots = [
  path.join(sampleRoot, "typescript"),
  path.join(sampleRoot, "javascript"),
  path.join(sampleRoot, "tsx"),
  spreadRoot,
  ...fs
    .readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(corpusRoot, entry.name)),
];
const JS_TS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/** Each module as JSON, which keeps key order, so equal lists also mean every module's keys come in the same order. */
function moduleTexts(index: ProjectIndex): string[] {
  return [...index.byFile.values()].map((mod) => JSON.stringify(mod)).sort();
}

function edgeTexts(index: ProjectIndex): string[] {
  return index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
}

function slash(file: string): string {
  return file.replace(/\\/g, "/");
}

/** A module record input from a file's own native extraction, as a worker would build it. */
function recordInput(file: string, source = fs.readFileSync(file, "utf8")): ModuleRecordInput {
  const support = supportForFile(file);
  if (!support) throw new Error(`No language support for ${file}`);
  const extraction = getNativeExtractionExecution(source, support);
  if (!extraction.tree || !extraction.results) throw new Error(`Native extraction failed for ${file}`);
  return {
    file: slash(file),
    source,
    support,
    nativeQueries: extraction.results,
    tree: new ProjectedSyntaxTree(source, extraction.tree),
    projectRoot: slash(path.dirname(file)),
    dynamicImportHeuristics: false,
  };
}

async function recordFor(input: ModuleRecordInput): Promise<ModuleRecord> {
  const outcome = await buildModuleRecord(input);
  if (!("record" in outcome)) throw new Error(`${input.file} fell back: ${outcome.fallback}`);
  return outcome.record;
}

/** A capture whose text cannot be read, so the extraction step that reads it fails. */
function unreadableCapture(name: string): NativeCapture {
  const point = { row: 0, column: 0, index: 0 };
  return {
    name,
    nodeType: "import_statement",
    start: point,
    end: point,
    get text(): string {
      throw new Error("unreadable capture");
    },
  };
}

/** The record's content with key order and placeholder requests, which JSON cannot show for a pending target. */
function describeValue(value: unknown): unknown {
  if (value instanceof PendingImportTarget) return { pendingRequest: value.request };
  if (Array.isArray(value)) return value.map(describeValue);
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, entry]) => [key, describeValue(entry)]);
  }
  return value;
}

/** Which objects of the record are one object: placeholders, unaliased binding ranges, and exported locals. */
function sharedObjects(record: ModuleRecord) {
  const { imports, locals, exports } = record.module;
  return {
    targets: imports.map((binding) => imports.findIndex((other) => other.resolved === binding.resolved)),
    ranges: imports.map((binding) => binding.kind === "named" && binding.importedRange === binding.localRange),
    exportTargets: exports.map((entry) => (entry.type === "local" ? locals.indexOf(entry.target) : -2)),
  };
}

function transfer(payload: ModuleRecordPayload): ModuleRecordPayload {
  const copy: ModuleRecordPayload = v8.deserialize(v8.serialize(payload));
  return copy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("module records", () => {
  for (const root of jsTsRoots) {
    it(`builds the same index and disk cache in native workers as on the main thread: ${slash(path.relative(repoRoot, root))}`, async () => {
      const files = await listProjectFiles(root);
      const cacheDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codegraph-module-record-parity-"));
      try {
        const workerCacheDir = path.join(cacheDirectory, "workers");
        const mainCacheDir = path.join(cacheDirectory, "main");
        const workerReport: BuildReport = { timings: {} };
        const inWorkers = await buildProjectIndex(root, {
          cache: "disk",
          cacheDir: workerCacheDir,
          useNativeWorkers: true,
          nativeThreads: 2,
          report: workerReport,
        });
        const onMainThread = await buildProjectIndex(root, {
          cache: "disk",
          cacheDir: mainCacheDir,
          useNativeWorkers: false,
        });

        // The compiled worker in dist ran and built the records, so this compares the worker path itself.
        expect(workerReport.workerPool?.moduleRecords).toBeGreaterThan(0);
        expect(moduleTexts(inWorkers)).toEqual(moduleTexts(onMainThread));
        expect(edgeTexts(inWorkers)).toEqual(edgeTexts(onMainThread));
        const diskContents = (cacheDir: string) => {
          const location = cacheRoot(root, { cache: "disk", cacheDir });
          const db = new DatabaseSync(path.join(location, "index-cache.sqlite"), { readOnly: true });
          try {
            const rows = db
              .prepare("SELECT file, sig, version, payload FROM module_cache ORDER BY file")
              .all() as Array<{ file: string; sig: string; version: number; payload: Uint8Array }>;
            const modules = rows.map(({ file, sig, version, payload }) => ({
              file,
              sig,
              version,
              module: JSON.parse(brotliDecompressSync(payload).toString("utf8")) as unknown,
            }));
            const manifest = JSON.parse(fs.readFileSync(path.join(location, "manifest.json"), "utf8")) as {
              files: Record<string, unknown>;
            };
            return { modules, manifestFiles: manifest.files };
          } finally {
            db.close();
          }
        };
        const workerDisk = diskContents(workerCacheDir);
        const mainDisk = diskContents(mainCacheDir);
        expect(workerDisk.modules.length).toBeGreaterThan(0);
        expect(Object.keys(workerDisk.manifestFiles)).toHaveLength(files.length);
        expect(workerDisk).toEqual(mainDisk);
      } finally {
        await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it("indexes every JavaScript and TypeScript file as it was indexed without module records", async () => {
    for (const root of jsTsRoots) {
      const files = await listProjectFiles(root);
      const recordSpy = vi.spyOn(moduleRecords, "buildModuleRecord");
      const withRecords = await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false });
      const outcomes = await Promise.all(recordSpy.mock.results.map((result) => result.value));
      expect(outcomes.filter((outcome) => "record" in outcome).length).toBeGreaterThan(0);

      recordSpy.mockResolvedValue({ fallback: "error" });
      const withoutRecords = await buildProjectIndexFromFiles(root, files, { useNativeWorkers: false });
      recordSpy.mockRestore();

      expect(moduleTexts(withRecords)).toEqual(moduleTexts(withoutRecords));
      expect(edgeTexts(withRecords)).toEqual(edgeTexts(withoutRecords));
    }
  }, 120_000);

  it("leaves a CommonJS spread of a required module to the main thread", async () => {
    const files = await listProjectFiles(spreadRoot);
    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndexFromFiles(spreadRoot, files, {
      useNativeWorkers: true,
      nativeThreads: 2,
      report,
    });

    // Every file but the spread is a worker record.
    expect(files.filter((file) => JS_TS_FILE.test(file))).toHaveLength(3);
    expect(report.workerPool?.moduleRecords).toBe(2);
    const spread = [...index.byFile.values()].find((mod) => mod.file.endsWith("/spread-exports.js"));
    expect(spread?.exports).toContainEqual({
      type: "exportStar",
      fromModule: expect.stringMatching(/\/spread-base\.js$/u),
      moduleSpecifier: "./spread-base",
      sourceSpecifier: "./spread-base",
    });
  }, 60_000);

  it("keeps the trees of a keepParsed build whose parsed files fit its parsed-file cache", async () => {
    const root = path.join(sampleRoot, "typescript");
    const files = await listProjectFiles(root);
    const parsedFiles = files.filter((file) => JS_TS_FILE.test(file));

    const fitReport: BuildReport = { timings: {} };
    const fit = await buildProjectIndexFromFiles(root, files, {
      useNativeWorkers: true,
      nativeThreads: 2,
      keepParsed: true,
      report: fitReport,
    });
    expect(fitReport.workerPool?.tasksSubmitted).toBe(parsedFiles.length);
    expect(fitReport.workerPool?.moduleRecords ?? 0).toBe(0);
    expect(fit.parsed?.size).toBe(parsedFiles.length);

    const overflowReport: BuildReport = { timings: {} };
    await buildProjectIndexFromFiles(root, files, {
      useNativeWorkers: true,
      nativeThreads: 2,
      keepParsed: true,
      parsedCacheMaxEntries: 2,
      report: overflowReport,
    });
    expect(overflowReport.workerPool?.moduleRecords).toBeGreaterThan(0);
  }, 60_000);

  it("keeps parsed trees when non-parsed files exceed the parsed cache's file limit", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codegraph-module-record-trees-"));
    try {
      const files = ["first.ts", "second.ts", "settings.json", "notes.md"].map((name) => path.join(root, name));
      await Promise.all(
        files.map((file) =>
          fs.promises.writeFile(
            file,
            file.endsWith(".ts") ? `export const ${path.basename(file, ".ts")} = 1;\n` : "{}\n",
            "utf8",
          ),
        ),
      );
      const report: BuildReport = { timings: {} };
      const index = await buildProjectIndexFromFiles(root, files, {
        useNativeWorkers: true,
        nativeThreads: 2,
        keepParsed: true,
        parsedCacheMaxEntries: 2,
        report,
      });
      expect(report.workerPool?.tasksSubmitted).toBe(2);
      expect(report.workerPool?.moduleRecords ?? 0).toBe(0);
      expect([...(index.parsed?.keys() ?? [])].map(fileIdentityKey).sort()).toEqual(
        files.slice(0, 2).map(fileIdentityKey).sort(),
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("counts a SQL syntax tree alongside a TypeScript tree for keepParsed", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codegraph-module-record-sql-trees-"));
    try {
      const ts = path.join(root, "main.ts");
      const sql = path.join(root, "schema.sql");
      const json = path.join(root, "settings.json");
      await Promise.all([
        fs.promises.writeFile(ts, "export const answer = 42;\n", "utf8"),
        fs.promises.writeFile(sql, "CREATE TABLE example (id INTEGER);\n", "utf8"),
        fs.promises.writeFile(json, "{}\n", "utf8"),
      ]);
      const report: BuildReport = { timings: {} };
      const index = await buildProjectIndexFromFiles(root, [ts, sql, json], {
        useNativeWorkers: true,
        nativeThreads: 2,
        keepParsed: true,
        parsedCacheMaxEntries: 1,
        report,
      });
      expect(report.workerPool?.moduleRecords).toBe(1);
      expect([...(index.parsed?.keys() ?? [])].map(fileIdentityKey)).toEqual([fileIdentityKey(sql)]);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps the automatic parse window to twice a one-thread worker pool", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codegraph-module-record-window-"));
    try {
      const files = Array.from({ length: 10 }, (_, index) => path.join(root, `file-${index}.ts`));
      await Promise.all(files.map((file) => fs.promises.writeFile(file, "export const value = 1;\n", "utf8")));
      let inFlight = 0;
      let maximumInFlight = 0;
      const bothStarted = Promise.withResolvers<void>();
      const originalCreatePool = nativeWorkerPool.createNativeWorkerPool;
      vi.spyOn(nativeWorkerPool, "createNativeWorkerPool").mockImplementation((options) => {
        const pool = originalCreatePool(options);
        const originalRun = pool.run.bind(pool);
        vi.spyOn(pool, "run").mockImplementation(async (task, runOptions) => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          if (inFlight === 2) bothStarted.resolve();
          try {
            await bothStarted.promise;
            const result = await originalRun(task, runOptions);
            return result;
          } finally {
            inFlight -= 1;
          }
        });
        return pool;
      });
      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, files, {
        useNativeWorkers: true,
        nativeThreads: 1,
        report,
      });
      expect(report.workerPool?.threads).toBe(1);
      expect(report.workerPool?.moduleRecords).toBe(files.length);
      expect(maximumInFlight).toBe(2);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  describe("buildModuleRecord", () => {
    const mainFile = path.join(sampleRoot, "typescript", "main.ts");

    it("records each distinct resolution request once, in first-use order", async () => {
      const record = await recordFor(recordInput(mainFile));

      expect(record.requests).toEqual([{ from: "./utils" }]);
      expect(record.module.imports.length).toBeGreaterThan(1);
      for (const binding of record.module.imports) {
        expect(binding.resolved).toBeInstanceOf(PendingImportTarget);
        expect(binding.resolved).toBe(record.module.imports[0]?.resolved);
      }
      expect(record.module.nativeOutcome).toBe("used");
      expect(record.module.parseErrorRanges).toEqual([]);
      // One specifier per import statement, as the edge collector reads them; edges are deduplicated later.
      expect(record.specifiers.map((specifier) => specifier.spec)).toEqual([
        "./utils",
        "./utils",
        "./utils",
        "./utils",
      ]);
    });

    it("falls back without a syntax tree or native results", async () => {
      const input = recordInput(mainFile);

      expect(await buildModuleRecord({ ...input, tree: undefined })).toEqual({ fallback: "noTree" });
      expect(await buildModuleRecord({ ...input, nativeQueries: null })).toEqual({ fallback: "noTree" });
    });

    it("falls back when the import extraction degrades", async () => {
      const input = recordInput(mainFile);
      if (!input.nativeQueries) throw new Error("expected native results");
      const nativeQueries = {
        ...input.nativeQueries,
        importBindings: [{ patternIndex: 0, captures: [unreadableCapture("stmt")] }],
      };

      expect(await buildModuleRecord({ ...input, nativeQueries })).toEqual({ fallback: "degradedImport" });
    });

    it("falls back when a step would write to the build report", async () => {
      const input = recordInput(mainFile);
      if (!input.nativeQueries) throw new Error("expected native results");
      // Only the edge specifiers read the import matches, and a failure there is recorded in the report.
      const nativeQueries = {
        ...input.nativeQueries,
        imports: [{ patternIndex: 0, captures: [unreadableCapture("stmt")] }],
      };

      expect(await buildModuleRecord({ ...input, nativeQueries })).toEqual({ fallback: "reportWrite" });
    });

    it("falls back when post-processing throws", async () => {
      vi.spyOn(parseErrors, "collectParseErrorRanges").mockImplementation(() => {
        throw new Error("synthetic post-processing failure");
      });

      expect(await buildModuleRecord(recordInput(mainFile))).toEqual({ fallback: "error" });
    });

    it("falls back for a CommonJS spread of a required module, even though export extraction catches the read", async () => {
      expect(await buildModuleRecord(recordInput(path.join(spreadRoot, "spread-exports.js")))).toEqual({
        fallback: "resolutionDependent",
      });

      // A spread of a local object reads no import target, so it stays a record.
      const localSpread = await recordFor(
        recordInput(
          path.join(spreadRoot, "local-spread.js"),
          [
            'const base = require("./spread-base");',
            "function localFunction() {",
            '  return "local";',
            "}",
            "const local = { localFunction };",
            "module.exports = { ...local };",
            "",
          ].join("\n"),
        ),
      );
      expect(localSpread.requests).toEqual([{ from: "./spread-base" }]);
      expect(localSpread.module.exports).toContainEqual(
        expect.objectContaining({ type: "local", exportedAs: "localFunction" }),
      );
    });
  });

  describe("pending import targets", () => {
    it("refuses every read as a resolved target and remembers it", () => {
      const target = new PendingImportTarget(4);
      const binding: ImportBinding = { kind: "namespace", localNS: "base", from: "./base", resolved: target };

      expect(target.read).toBe(false);
      expect(() => resolvedImportFile(binding)).toThrow(PendingImportResolutionError);
      expect(target.read).toBe(true);
      expect(() => target.external).toThrow(PendingImportResolutionError);
      expect(() => `${String(target)}`).toThrow(PendingImportResolutionError);
      expect(() => JSON.stringify({ resolved: target })).toThrow(PendingImportResolutionError);

      // A resolved binding reads as before.
      expect(resolvedImportFile({ ...binding, resolved: "/project/base.js" })).toBe("/project/base.js");
      expect(resolvedImportFile({ ...binding, resolved: { external: "base" } })).toBeUndefined();
    });

    it("rejects a record whose binding names a request the record does not have", async () => {
      const file = slash(path.join(sampleRoot, "typescript", "main.ts"));
      const support = supportForFile(file);
      if (!support) throw new Error("TypeScript support was not registered");
      const module: ModuleIndex = {
        file,
        exports: [],
        imports: [{ kind: "namespace", localNS: "utils", from: "./utils", resolved: new PendingImportTarget(2) }],
        locals: [],
      };

      await expect(
        finishModuleRecord(
          { module, requests: [], specifiers: [] },
          {
            file,
            support,
            projectRoot: slash(path.dirname(file)),
            graphOptions: {},
            jsonDependencies: new Map(),
          },
        ),
      ).rejects.toThrow(/has no resolution request 2/u);
    });

    it("resolves a record's requests into its placeholders, keeping each binding's key order", async () => {
      const record = await recordFor(recordInput(path.join(sampleRoot, "typescript", "main.ts")));
      const keyOrder = record.module.imports.map((binding) => Object.keys(binding));
      const support = supportForFile(record.module.file);
      if (!support) throw new Error("TypeScript support was not registered");

      const finished = await finishModuleRecord(record, {
        file: record.module.file,
        support,
        projectRoot: slash(path.join(sampleRoot, "typescript")),
        graphOptions: {},
        jsonDependencies: new Map(),
        cacheSignature: async () => "signature",
      });

      expect(finished.module.imports.map((binding) => Object.keys(binding))).toEqual(keyOrder);
      for (const binding of finished.module.imports) {
        expect(binding.resolved).toBe(slash(path.join(sampleRoot, "typescript", "utils.ts")));
      }
      expect(finished.cacheWrite).toEqual({ file: record.module.file, sig: "signature", mod: finished.module });
      expect(finished.edgeSource.specifiers).toBe(record.specifiers);
    });
  });

  describe("encoding", () => {
    it("restores every record exactly after a transfer between threads", async () => {
      let checked = 0;
      for (const root of jsTsRoots) {
        for (const file of await listProjectFiles(root)) {
          if (!JS_TS_FILE.test(file)) continue;
          const outcome = await buildModuleRecord(recordInput(file));
          if (!("record" in outcome)) continue;
          const expected = describeValue(outcome.record);
          const sharing = sharedObjects(outcome.record);

          const decoded = decodeModuleRecord(transfer(encodeModuleRecord(outcome.record)));

          expect(describeValue(decoded)).toEqual(expected);
          expect(sharedObjects(decoded)).toEqual(sharing);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(20);
    }, 60_000);

    it("names the module's file once and packs every range into one Int32Array", async () => {
      const record = await recordFor(recordInput(path.join(sampleRoot, "typescript", "helpers.ts")));
      const file = record.module.file;
      const occurrences = (text: string) => text.split(file).length - 1;
      expect(record.module.locals.length).toBeGreaterThan(1);
      expect(occurrences(v8.serialize(record).toString("latin1"))).toBeGreaterThan(record.module.locals.length);

      const payload = encodeModuleRecord(record);

      expect(occurrences(v8.serialize(payload).toString("latin1"))).toBe(1);
      expect(payload.data).toBeInstanceOf(Int32Array);
      for (const def of payload.defs) expect(def.range).toBe(payload.packedRange);
    });

    it("keeps ranges it cannot pack exactly, and paths of other files, as they are", async () => {
      const record = await recordFor(recordInput(path.join(sampleRoot, "typescript", "helpers.ts")));
      const [first, second] = record.module.locals;
      if (!first || !second) throw new Error("expected two locals");
      // One position object at both ends of a range cannot be told apart from two equal positions once packed.
      const position = { line: 1, column: 1 };
      first.range = { start: position, end: position };
      second.file = "/elsewhere/other.ts";
      const expected = describeValue(record);
      const sharing = sharedObjects(record);

      const payload = encodeModuleRecord(record);
      const decoded = decodeModuleRecord(transfer(payload));

      expect(payload.defs[0]?.range).toBe(first.range);
      expect(describeValue(decoded)).toEqual(expected);
      expect(sharedObjects(decoded)).toEqual(sharing);
      const [decodedFirst, decodedSecond] = decoded.module.locals;
      expect(decodedFirst?.range.start).toBe(decodedFirst?.range.end);
      expect(decodedSecond?.file).toBe("/elsewhere/other.ts");
    });
  });
});
