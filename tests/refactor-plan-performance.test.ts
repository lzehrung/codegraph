import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { findCalleesWithSession, findCallersWithSession } from "../src/agent/callHierarchy.js";
import { buildRefactorPlanWithSession } from "../src/agent/refactorPlan.js";
import { previewRenameWithSession } from "../src/agent/renamePreview.js";
import { createAgentSession } from "../src/agent/session.js";
import { findImplementationsWithSession, findSubtypesWithSession } from "../src/agent/typeHierarchy.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import type { SymbolEdge } from "../src/graphs/symbol-graph.js";
import { isPlainRecord } from "../src/util/guards.js";
import { countingSession } from "./helpers/agent.js";

const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "refactor-plan-performance");
const contractFile = path.join(fixtureRoot, "benchmark-contract.json");

type OperationSample = {
  name: string;
  durationMs: number;
  resultCount: number;
};

type BenchmarkContract = {
  referenceCount: number;
  warmIterations: number;
  operationNames: string[];
  environmentFields: string[];
  operationCeilingMs: number;
  totalCeilingMs: number;
  hierarchyPeakRssDeltaBytes: number;
};

async function loadBenchmarkContract(): Promise<BenchmarkContract> {
  const parsed: unknown = JSON.parse(await fs.readFile(contractFile, "utf8"));
  if (
    !isPlainRecord(parsed) ||
    !Array.isArray(parsed.environmentFields) ||
    !Array.isArray(parsed.operationNames) ||
    !isPlainRecord(parsed.ceilings)
  ) {
    throw new Error("Refactor performance benchmark contract is invalid");
  }
  const operationNames = parsed.operationNames.filter((value): value is string => typeof value === "string");
  const environmentFields = parsed.environmentFields.filter((value): value is string => typeof value === "string");
  const { referenceCount, warmIterations } = parsed;
  const operationCeilingMs = parsed.ceilings.operationMs;
  const totalCeilingMs = parsed.ceilings.totalMs;
  const hierarchyPeakRssDeltaBytes = parsed.ceilings.hierarchyPeakRssDeltaBytes;
  if (
    typeof referenceCount !== "number" ||
    typeof warmIterations !== "number" ||
    typeof operationCeilingMs !== "number" ||
    typeof totalCeilingMs !== "number" ||
    typeof hierarchyPeakRssDeltaBytes !== "number"
  ) {
    throw new Error("Refactor performance benchmark contract has invalid numeric fields");
  }
  return {
    referenceCount,
    warmIterations,
    operationNames,
    environmentFields,
    operationCeilingMs,
    totalCeilingMs,
    hierarchyPeakRssDeltaBytes,
  };
}

describe("refactor plan deterministic performance regression", () => {
  it("samples required operations with structural cache and generous environment-scoped ceilings", async () => {
    const contract = await loadBenchmarkContract();
    const samples: OperationSample[] = [];
    const sample = async <T>(name: string, action: () => Promise<T>, count: (value: T) => number): Promise<T> => {
      const started = performance.now();
      const value = await action();
      samples.push({ name, durationMs: performance.now() - started, resultCount: count(value) });
      return value;
    };

    const baseSession = createAgentSession({
      root: fixtureRoot,
      buildOptions: { cache: "off" },
      freshness: { policy: "manual" },
    });
    const counted = countingSession(baseSession);
    const snapshot = await counted.session.loadProject();

    const targetLookup = await sample(
      "workspace-symbol-exact",
      async () => await workspaceSymbolsInSnapshot(snapshot, { query: "target", limit: 1 }),
      (response) => response.symbols.length,
    );
    const targetHandle = targetLookup.symbols[0]?.handle;
    if (!targetHandle || targetLookup.symbols[0]?.name !== "target") {
      throw new Error("Exact target lookup did not resolve the benchmark symbol");
    }
    const [callRootLookup, baseLookup, contractLookup] = await Promise.all([
      workspaceSymbolsInSnapshot(snapshot, { query: "callRoot", limit: 1 }),
      workspaceSymbolsInSnapshot(snapshot, { query: "Base", limit: 1 }),
      workspaceSymbolsInSnapshot(snapshot, { query: "Contract", limit: 1 }),
    ]);
    const callRootHandle = callRootLookup.symbols[0]?.handle;
    const baseHandle = baseLookup.symbols[0]?.handle;
    const contractHandle = contractLookup.symbols[0]?.handle;
    if (!callRootHandle || !baseHandle || !contractHandle) {
      throw new Error("Call or hierarchy benchmark symbols were not indexed");
    }

    const edges = snapshot.symbolGraph.edges;
    const edgeStorage = [...edges];
    let edgeIterations = 0;
    Object.defineProperty(edges, Symbol.iterator, {
      configurable: true,
      value: function* iterateEdges(): IterableIterator<SymbolEdge> {
        edgeIterations += 1;
        yield* edgeStorage;
      },
    });

    const directCallers = await sample(
      "direct-callers",
      async () => await findCallersWithSession(counted.session, { root: fixtureRoot, handle: targetHandle, depth: 1 }),
      (response) => response.entries.length,
    );
    const directCallees = await sample(
      "direct-callees",
      async () =>
        await findCalleesWithSession(counted.session, { root: fixtureRoot, handle: callRootHandle, depth: 1 }),
      (response) => response.entries.length,
    );
    const depthCallers = await sample(
      "depth-3-callers",
      async () => await findCallersWithSession(counted.session, { root: fixtureRoot, handle: targetHandle, depth: 3 }),
      (response) => response.entries.length,
    );
    const depthCallees = await sample(
      "depth-3-callees",
      async () =>
        await findCalleesWithSession(counted.session, { root: fixtureRoot, handle: callRootHandle, depth: 3 }),
      (response) => response.entries.length,
    );

    const rssBeforeHierarchy = process.memoryUsage().rss;
    const subtypes = await sample(
      "subtypes",
      async () => await findSubtypesWithSession(counted.session, { root: fixtureRoot, handle: baseHandle, depth: 3 }),
      (response) => response.relations.length,
    );
    const rssAfterSubtypes = process.memoryUsage().rss;
    const implementations = await sample(
      "implementations",
      async () => await findImplementationsWithSession(counted.session, { root: fixtureRoot, handle: contractHandle }),
      (response) => response.implementations.length,
    );
    const hierarchyPeakRssBytes = Math.max(rssBeforeHierarchy, rssAfterSubtypes, process.memoryUsage().rss);
    const hierarchyPeakRssDeltaBytes = Math.max(0, hierarchyPeakRssBytes - rssBeforeHierarchy);

    for (const limit of [10, 100, 1000]) {
      const rename = await sample(
        `rename-${limit}`,
        async () =>
          await previewRenameWithSession(counted.session, {
            root: fixtureRoot,
            handle: targetHandle,
            newName: "renamedTarget",
            maxEdits: limit,
          }),
        (response) => response.edits.length,
      );
      expect(rename.edits).toHaveLength(limit - 1);
      expect(rename.safe).toBe(false);
      expect(rename.omittedCounts.edits).toBeGreaterThan(0);
    }

    const warmStarted = performance.now();
    let warmResultCount = 0;
    for (let iteration = 0; iteration < contract.warmIterations; iteration += 1) {
      const response = await buildRefactorPlanWithSession(counted.session, {
        root: fixtureRoot,
        handle: targetHandle,
        maxReferences: 10,
        maxCallers: 10,
        maxHierarchy: 10,
      });
      warmResultCount += response.references.length + response.callers.length + response.callees.length;
    }
    samples.push({
      name: "warm-refactor-plan",
      durationMs: performance.now() - warmStarted,
      resultCount: warmResultCount,
    });

    expect(directCallers.entries.map((entry) => entry.symbol.name)).toEqual(["directCaller", "run", "allReferences"]);
    expect(directCallees.entries.map((entry) => entry.symbol.name)).toEqual(["levelOne"]);
    expect(depthCallers.entries.map((entry) => entry.symbol.name)).toEqual([
      "directCaller",
      "run",
      "allReferences",
      "levelTwo",
      "levelOne",
    ]);
    expect(depthCallees.entries.map((entry) => entry.symbol.name)).toEqual(["levelOne", "levelTwo", "directCaller"]);
    expect(subtypes.relations.map((relation) => relation.type.name)).toEqual(["Mid", "Leaf"]);
    expect(implementations.implementations.map((entry) => entry.symbol.name)).toEqual(["Leaf"]);
    expect(targetLookup.totalCandidates).toBe(1);
    expect(contract.referenceCount).toBe(1000);
    expect(counted.loads()).toBe(1);
    expect(edgeIterations).toBeLessThanOrEqual(2);

    const totalDurationMs = samples.reduce((total, entry) => total + entry.durationMs, 0);
    expect(samples.map((entry) => entry.name)).toEqual(contract.operationNames);
    expect(samples.every((entry) => entry.durationMs < contract.operationCeilingMs)).toBe(true);
    expect(totalDurationMs).toBeLessThan(contract.totalCeilingMs);
    expect(hierarchyPeakRssDeltaBytes).toBeLessThan(contract.hierarchyPeakRssDeltaBytes);

    const cpus = os.cpus();
    const report = {
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuModel: cpus[0]?.model ?? "unknown",
        cpuCount: cpus.length,
        totalMemoryBytes: os.totalmem(),
      },
      fixture: {
        referenceCount: contract.referenceCount,
        warmIterations: contract.warmIterations,
      },
      hierarchyIndex: {
        peakRssBytes: hierarchyPeakRssBytes,
        peakRssDeltaBytes: hierarchyPeakRssDeltaBytes,
        edgeIterations,
      },
      samples,
      totalDurationMs,
      interpretation: "Environment-scoped regression guard only; not a universal latency claim.",
    };
    expect(Object.keys(report.environment)).toEqual(contract.environmentFields);
    console.info("refactor-plan-performance", JSON.stringify(report));
  });
});
