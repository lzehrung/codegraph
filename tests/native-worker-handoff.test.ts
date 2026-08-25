import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NativeExtractBatchResult } from "../src/worker/nativeExtractWorker.js";
import { loadProductionBinding, readWorkerBindingHandoff } from "../src/worker/nativeExtractWorker.js";
import { createNativeWorkerPool } from "../src/worker/nativeWorkerPool.js";
import { getCachedNormalizedQuery } from "../src/native/treeSitterNative.js";
import { getNativeWorkerBindingHandoff, loadBinding } from "../src/native/runtime.js";
import { supportForFile } from "../src/languages.js";

const SOURCE = "export const handoff = 1;\nexport function used(): number {\n  return handoff;\n}\n";

const pools: Array<{ destroy: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

function extractionTask(filePath: string): Record<string, unknown> {
  const support = supportForFile(filePath);
  if (!support) throw new Error(`no language support for ${filePath}`);
  return {
    filePath,
    languageId: support.id,
    source: SOURCE,
    includeSourceInResult: false,
    importsQuery: getCachedNormalizedQuery(support, "imports"),
    exportsQuery: getCachedNormalizedQuery(support, "exports"),
    localsQuery: getCachedNormalizedQuery(support, "locals"),
    importBindingsQuery: getCachedNormalizedQuery(support, "importBindings"),
  };
}

async function runInPool(workerData: unknown): Promise<NativeExtractBatchResult> {
  const pool = createNativeWorkerPool({ threads: 1, ...(workerData === undefined ? {} : { workerData }) });
  pools.push(pool);
  const result = await pool.run({ tasks: [extractionTask(path.resolve("handoff-fixture.ts"))] });
  return result as NativeExtractBatchResult;
}

function expectExtracted(batch: NativeExtractBatchResult): void {
  expect(batch.results).toHaveLength(1);
  const [only] = batch.results;
  if (!only) throw new Error("expected one extraction result");
  expect(only.fallbackReason).toBeUndefined();
  expect(only.error).toBeUndefined();
  expect(only.syntaxTree).not.toBeNull();
  expect(only.nativeResults?.exports.length).toBeGreaterThan(0);
}

describe("worker native binding handoff", () => {
  it("reads a well-formed handoff and rejects anything else", () => {
    const handoff = { loadedPath: "/tmp/index.node", origin: { mode: "cache" as const, packageName: "pkg" } };
    expect(readWorkerBindingHandoff({ nativeBinding: handoff })).toEqual(handoff);

    // Every rejected shape must fall through to full resolution rather than throw, which is what
    // keeps the module usable outside a worker thread.
    expect(readWorkerBindingHandoff(undefined)).toBeNull();
    expect(readWorkerBindingHandoff({})).toBeNull();
    expect(readWorkerBindingHandoff({ nativeBinding: null })).toBeNull();
    expect(readWorkerBindingHandoff({ nativeBinding: { loadedPath: "" } })).toBeNull();
    expect(readWorkerBindingHandoff({ nativeBinding: { loadedPath: "/tmp/index.node" } })).toBeNull();
    expect(readWorkerBindingHandoff({ nativeBinding: { origin: { mode: "cache", packageName: "pkg" } } })).toBeNull();
  });

  it("offers a handoff only once this process has loaded the addon", () => {
    const state = loadBinding();
    expect(state.loaded).toBe(true);
    const handoff = getNativeWorkerBindingHandoff();
    if (!handoff) throw new Error("expected a handoff after a successful load");
    expect(handoff.loadedPath).toBe(state.loaded ? state.origin.loadedPath : undefined);
    // The origin travels whole so a worker reports the same provenance as its parent, which is
    // what tests/native-worker-path.test.ts asserts across the boundary.
    expect(handoff.origin).toEqual(loadProductionBinding().origin);
  });

  it("loads from the handoff rather than resolving the addon again", () => {
    const resolved = loadProductionBinding();
    if (!resolved.binding) throw new Error("expected the workspace addon to load");
    // Same file, deliberately different origin. Normal resolution cannot produce this origin, so
    // getting it back is proof the handoff branch ran instead of the resolution path.
    const sentinel = { mode: "cache" as const, packageName: "sentinel-package", sha256: "sentinel-digest" };
    const loadedPath = resolved.origin?.loadedPath;
    if (!loadedPath) throw new Error("expected a resolved addon path");

    const viaHandoff = loadProductionBinding({ nativeBinding: { loadedPath, origin: sentinel } });
    expect(viaHandoff.origin).toEqual(sentinel);
    expect(viaHandoff.binding).not.toBeNull();

    // An unloadable handoff must not stick: the origin reverts to whatever resolution finds.
    const viaFallback = loadProductionBinding({
      nativeBinding: { loadedPath: path.resolve("missing-addon.node"), origin: sentinel },
    });
    expect(viaFallback.origin).toEqual(resolved.origin);
    expect(viaFallback.binding).not.toBeNull();
  });

  it("extracts through a real worker using the handed-over addon", async () => {
    loadBinding();
    const handoff = getNativeWorkerBindingHandoff();
    if (!handoff) throw new Error("expected a handoff after a successful load");
    expectExtracted(await runInPool({ nativeBinding: handoff }));
  });

  it("falls back to full resolution when the handoff cannot be loaded", async () => {
    loadBinding();
    const handoff = getNativeWorkerBindingHandoff();
    if (!handoff) throw new Error("expected a handoff after a successful load");
    // A path that does not exist stands in for a stale or pruned cache entry. The worker must
    // resolve the addon the long way rather than failing every file it is given.
    expectExtracted(
      await runInPool({ nativeBinding: { loadedPath: path.resolve("missing-addon.node"), origin: handoff.origin } }),
    );
  });

  it("still extracts when no handoff is supplied at all", async () => {
    expectExtracted(await runInPool(undefined));
  });
});
