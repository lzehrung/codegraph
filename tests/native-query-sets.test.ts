import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { CPP_SUPPORT, supportForFile, TS_SUPPORT } from "../src/languages.js";
import type { NativeBinding, NativeQueryResults } from "../src/native/contracts.js";
import { getCachedNormalizedQuery, getNativeQuerySetId, NATIVE_QUERY_KINDS } from "../src/native/queries.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
  getCompactImportsExecution,
  getNativeExtractionExecution,
  getNativeQueryExecution,
  isNativeTreeSitterAvailable,
} from "../src/native/tree-sitter-native.js";
import { loadBinding } from "../src/native/runtime.js";
import { createNativeWorkerPool } from "../src/worker/native-worker-pool.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

const SAMPLES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "samples");
const SAMPLE_DIRECTORIES = [
  "c",
  "cpp",
  "csharp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "kotlin",
  "less",
  "php",
  "python",
  "ruby",
  "rust",
  "scss",
  "sql",
  "swift",
  "terraform",
  "tsx",
  "typescript",
];
const SAMPLE_FILES_PER_DIRECTORY = 3;
const SAMPLE_MAX_BYTES = 100 * 1024;

function realBinding(): { binding: NativeBinding; loadedPath: string } {
  const state = loadBinding();
  if (!state.loaded) throw new Error("The native addon is required for query set tests.");
  const { loadedPath } = state.origin;
  if (!loadedPath) throw new Error("Expected the addon to report the path it loaded from.");
  return { binding: state.binding, loadedPath };
}

function compileCount(binding: NativeBinding, querySetId: number): number {
  if (!binding.querySetCompileCount) throw new Error("The addon does not expose querySetCompileCount.");
  return binding.querySetCompileCount(querySetId);
}

afterEach(() => {
  __resetNativeTreeSitterBindingForTests();
});

type PoolBatch = { results: Array<{ fallbackReason?: string; nativeResults: unknown }> };

/**
 * Extracts one-line files of `languageId` through a fresh three-thread worker pool, several batches at once so the pool
 * starts every thread, and returns how many threads it started. Every file must extract with native results.
 */
async function extractOnWorkerPool(
  languageId: string,
  extension: string,
  line: (name: string) => string,
): Promise<number> {
  const pool = createNativeWorkerPool({ threads: 3 });
  try {
    const batches: PoolBatch[] = await Promise.all(
      Array.from({ length: 6 }, (_, batch) =>
        pool.run({
          tasks: [0, 1, 2, 3].map((file) => ({
            filePath: path.resolve(`pool-${batch}-${file}.${extension}`),
            languageId,
            source: line(`value${batch}${file}`),
            includeSourceInResult: false,
          })),
        }),
      ),
    );
    for (const batch of batches) {
      for (const result of batch.results) {
        expect(result.fallbackReason).toBeUndefined();
        expect(result.nativeResults).not.toBeNull();
      }
    }
    return pool.threads.length;
  } finally {
    await pool.destroy();
  }
}

nativeDescribe("native query sets", () => {
  it("returns one id for equal texts and a different id for different texts or languages", () => {
    const { binding } = realBinding();
    const imports = "(import_statement (string) @mod) @stmt";
    const locals = "(variable_declarator name: (identifier) @name)";

    const id = binding.registerQuerySet("ts", imports, "", locals, "");

    expect(binding.registerQuerySet("ts", imports, "", locals, "")).toBe(id);
    expect(binding.registerQuerySet("ts", imports, "", `${locals} `, "")).not.toBe(id);
    expect(binding.registerQuerySet("ts", "", imports, locals, "")).not.toBe(id);
    expect(binding.registerQuerySet("tsx", imports, "", locals, "")).not.toBe(id);
  });

  it("rejects an unsupported language and an id that was never registered", () => {
    const { binding } = realBinding();

    expect(() => binding.registerQuerySet("klingon", "", "", "", "")).toThrow(/Unsupported language/);
    for (const call of [
      () => binding.runLanguageQueries("export const value = 1;", 0),
      () => binding.extractLanguage("export const value = 1;", 2 ** 31),
      () => binding.runImportsQueryCompact?.("export const value = 1;", 0),
    ]) {
      expect(call).toThrow(/Unknown query set id/);
    }
  });

  it("reports a query that does not compile on every call without compiling it again", () => {
    const { binding } = realBinding();
    const id = binding.registerQuerySet("ts", `; ${randomUUID()}\n(`, "", "", "");

    for (let call = 0; call < 3; call += 1) {
      expect(() => binding.runLanguageQueries("export const value = 1;", id)).toThrow(/Failed to compile query/);
    }

    expect(compileCount(binding, id)).toBe(1);
  });

  it("runs each sample file's registered set to the same matches as every kind run alone", () => {
    const { binding } = realBinding();
    const runQuery = binding.runQuery;
    if (!runQuery) throw new Error("The addon does not expose runQuery.");
    const comparedKinds = new Set<string>();
    let comparedFiles = 0;

    for (const directory of SAMPLE_DIRECTORIES) {
      const files = fs
        .readdirSync(path.join(SAMPLES_ROOT, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(SAMPLES_ROOT, directory, entry.name))
        .sort();
      let used = 0;
      for (const file of files) {
        if (used === SAMPLE_FILES_PER_DIRECTORY) break;
        const support = supportForFile(file);
        if (!support || fs.statSync(file).size > SAMPLE_MAX_BYTES) continue;
        used += 1;
        const source = fs.readFileSync(file, "utf8");

        // The first kind with text gets a comment nothing else has, so this set is private to this test and its
        // compile count is its own.
        const texts = NATIVE_QUERY_KINDS.map((kind) => getCachedNormalizedQuery(support, kind));
        const firstActive = texts.findIndex((text) => text.trim());
        const registered = texts.map((text, index) => (index === firstActive ? `; ${randomUUID()}\n${text}` : text));
        const [imports = "", exports = "", locals = "", importBindings = ""] = registered;
        const id = binding.registerQuerySet(support.id, imports, exports, locals, importBindings);

        const merged = binding.runLanguageQueries(source, id);
        for (const [index, kind] of NATIVE_QUERY_KINDS.entries()) {
          const text = texts[index] ?? "";
          const alone = text.trim() ? runQuery(source, support.id, text).matches : [];
          expect(merged[kind], `${path.relative(SAMPLES_ROOT, file)} ${kind}`).toEqual(alone);
          if (alone.length) comparedKinds.add(`${support.id}:${kind}`);
        }

        const activeKinds = texts.filter((text) => text.trim()).length;
        expect(compileCount(binding, id), `${support.id} compiles`).toBe(activeKinds >= 2 ? 1 : activeKinds);
        comparedFiles += 1;
      }
    }

    // The comparison must have matched something in every kind, or it proved nothing about routing.
    expect(comparedFiles).toBeGreaterThan(20);
    for (const kind of NATIVE_QUERY_KINDS) {
      expect([...comparedKinds].filter((entry) => entry.endsWith(`:${kind}`)).length, kind).toBeGreaterThan(3);
    }
  }, 60_000);

  it("passes only the source and the id on every extraction call", () => {
    const { binding } = realBinding();
    const argumentCounts: Record<string, number[]> = { extractLanguage: [], runLanguageQueries: [], compact: [] };
    const { extractLanguage, runLanguageQueries, runImportsQueryCompact } = binding;
    if (!runImportsQueryCompact) throw new Error("The addon does not expose runImportsQueryCompact.");
    const state = loadBinding();
    if (!state.loaded) throw new Error("The native addon is required.");
    __setNativeTreeSitterBindingForTests({
      ...state,
      binding: {
        ...binding,
        extractLanguage: (...args: Parameters<NativeBinding["extractLanguage"]>) => {
          argumentCounts.extractLanguage?.push(args.length);
          return extractLanguage(...args);
        },
        runLanguageQueries: (...args: Parameters<NativeBinding["runLanguageQueries"]>) => {
          argumentCounts.runLanguageQueries?.push(args.length);
          return runLanguageQueries(...args);
        },
        runImportsQueryCompact: (...args: Parameters<NonNullable<NativeBinding["runImportsQueryCompact"]>>) => {
          argumentCounts.compact?.push(args.length);
          return runImportsQueryCompact(...args);
        },
      },
    });
    const source = "import { a } from './a';\nexport const b = a;\n";

    expect(getNativeExtractionExecution(source, TS_SUPPORT).results?.imports).toHaveLength(1);
    expect(getNativeQueryExecution(source, TS_SUPPORT, "full").results?.exports).not.toHaveLength(0);
    expect(getNativeQueryExecution(source, TS_SUPPORT, "imports").results?.imports).toHaveLength(1);
    expect(getCompactImportsExecution(source, TS_SUPPORT).results?.imports).toHaveLength(1);

    expect(argumentCounts).toEqual({ extractLanguage: [2], runLanguageQueries: [2, 2], compact: [2] });
  });

  it("gives every thread of the process the same id and one compile of the set", async () => {
    const { binding, loadedPath } = realBinding();
    const threadCount = 4;
    // A private set: the comment makes its text unlike any other test's, so its compile count is its own.
    const texts: [string, string, string, string] = [
      `; ${randomUUID()}\n${getCachedNormalizedQuery(TS_SUPPORT, "imports")}`,
      getCachedNormalizedQuery(TS_SUPPORT, "exports"),
      getCachedNormalizedQuery(TS_SUPPORT, "locals"),
      getCachedNormalizedQuery(TS_SUPPORT, "importBindings"),
    ];
    const source = "import { a } from './a';\nexport const b = a;\nexport function c() {}\n";
    // Every thread tells the main thread it has loaded the addon, then parks on `gate` until all have, so they ask
    // for the set at the same moment. The main thread learns that from their messages, not from a timer.
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const binding = require(workerData.addonPath);
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage({ type: "ready" });
      Atomics.wait(gate, 0, 0);
      const id = binding.registerQuerySet(workerData.language, ...workerData.texts);
      parentPort.postMessage({ type: "done", id, results: binding.runLanguageQueries(workerData.source, id) });
    `;
    const threads = Array.from({ length: threadCount }, () => {
      const ready = Promise.withResolvers<void>();
      const done = Promise.withResolvers<{ id: number; results: NativeQueryResults }>();
      let arrived = false;
      const worker = new Worker(workerSource, {
        eval: true,
        execArgv: [],
        workerData: { addonPath: path.resolve(loadedPath), gate: gate.buffer, language: "ts", texts, source },
      });
      worker.on("message", (message: { type: "ready" } | { type: "done"; id: number; results: NativeQueryResults }) => {
        if (message.type === "ready") {
          arrived = true;
          ready.resolve();
        } else {
          done.resolve(message);
        }
      });
      worker.once("error", (error) => (arrived ? done : ready).reject(error));
      return { ready: ready.promise, done: done.promise };
    });
    await Promise.all(threads.map((thread) => thread.ready));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const results = await Promise.all(threads.map((thread) => thread.done));

    const [first, ...rest] = results;
    if (!first) throw new Error("Expected a reply from every thread.");
    for (const reply of rest) {
      expect(reply.id).toBe(first.id);
      expect(reply.results).toEqual(first.results);
    }
    expect(first.results.imports).toHaveLength(1);
    expect(first.results.exports.length).toBeGreaterThan(0);
    expect(binding.registerQuerySet("ts", ...texts)).toBe(first.id);
    expect(binding.runLanguageQueries(source, first.id)).toEqual(first.results);
    expect(compileCount(binding, first.id)).toBe(1);
  }, 60_000);

  it("lets worker pool threads use the set the main thread already compiled", async () => {
    const { binding } = realBinding();
    // The main thread compiles the language's real set first, as the first main-thread extraction of a build does.
    const source = "export const fromMain = 1;\n";
    expect(getNativeExtractionExecution(source, TS_SUPPORT).results).not.toBeNull();
    const querySetId = getNativeQuerySetId(binding, TS_SUPPORT, "full");
    const compiledBefore = compileCount(binding, querySetId);

    await extractOnWorkerPool("ts", "ts", (name) => `export const ${name} = 1;\n`);

    expect(compileCount(binding, querySetId)).toBe(compiledBefore);
  }, 60_000);

  it("compiles a language's set once for every thread of a worker pool", async () => {
    const { binding } = realBinding();

    // Nothing in this file runs the real C++ set on the main thread, so a count above zero shows the pool's threads
    // compiled into the registry the main thread reads, and a count of one shows they shared that compile.
    const threadsUsed = await extractOnWorkerPool("cpp", "cpp", (name) => `int ${name}() { return 1; }\n`);

    expect(threadsUsed).toBeGreaterThan(1);
    expect(compileCount(binding, getNativeQuerySetId(binding, CPP_SUPPORT, "full"))).toBe(1);
  }, 60_000);
});
