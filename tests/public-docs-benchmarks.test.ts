import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertComplete,
  collectSourceFiles,
  loadScenarioFile,
  parseArguments,
  runBenchmark,
  runScenario,
  serializeBenchmarkResult,
  validateScenarioDocument,
} from "../scripts/benchmarks/run-scenario-lib.mjs";
import { calculateScenarioDigest } from "../scripts/benchmarks/benchmark-contract-lib.mjs";
import {
  describeReviewedRelationships,
  checkGeneratedBlock,
  median,
  renderMarkdownTable,
  runCli as runSummarizerCli,
  summarizeResults,
  validateResults,
  validateScenarioFile,
} from "../scripts/benchmarks/summarize-results-lib.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const scenarioFilePath = path.join(rootDir, "docs", "benchmarks", "scenarios.json");
const resultsFilePath = path.join(rootDir, "docs", "benchmarks", "results.example.json");
const readmePath = path.join(rootDir, "docs", "benchmarks", "README.md");
const runnerPath = path.join(rootDir, "scripts", "benchmarks", "run-scenario.mjs");
const metrics = ["toolCalls", "fileReads", "wallTimeMs"];
const scenarioIds = [
  "repo-orientation-small-ts",
  "python-import-reference",
  "sql-migration-application-review",
  "mixed-docs-source-graph",
  "installer-preservation-ranking",
];

interface BaselineStep {
  type: string;
  path: string;
}

interface CodegraphStep {
  type: string;
  command: string;
  query: string;
}

interface AnchorSelector {
  file: string;
  label: string;
}

interface ReviewedRelationships {
  anchorOrder: Array<{
    before: AnchorSelector;
    after: AnchorSelector;
    beforeRank: number | null;
    afterRank: number | null;
    beforeReciprocalRank: number | null;
    afterReciprocalRank: number | null;
  }>;
  recommendedFile: {
    expected: string;
    actual: string | null;
    rank: number | null;
    reciprocalRank: number | null;
  };
  candidateTests: Array<{
    file: string;
    rank: number | null;
    reciprocalRank: number | null;
  }>;
}

interface Scenario {
  id: string;
  repo: string;
  task: string;
  expectedAnchors: string[];
  metrics: string[];
  requiredAnchorOrder?: Array<{ before: AnchorSelector; after: AnchorSelector }>;
  expectedRecommendedFile?: string;
  requiredCandidateTests?: string[];
  variants: {
    baseline: BaselineStep[];
    codegraph: CodegraphStep[];
    "warm-cli"?: CodegraphStep[];
    "warm-mcp"?: CodegraphStep[];
  };
}

interface ScenarioDocument {
  schemaVersion: number;
  scenarios: Scenario[];
}

type Variant = "baseline" | "codegraph" | "warm-cli" | "warm-mcp";

interface BenchmarkRun {
  scenarioId: string;
  variant: Variant;
  run: number;
  metrics: {
    toolCalls: number;
    fileReads: number;
    wallTimeMs: number;
  };
  checks: {
    anchorsExpected: number;
    anchorsFound: number;
    missingAnchors: string[];
    completeness: number;
    reviewedRelationships?: ReviewedRelationships | undefined;
  };
}

interface BenchmarkResults {
  schemaVersion: number;
  generatedAt: string;
  command: string[];
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
  };
  scenarioFile: string;
  scenarioDigest: string;
  scenarioIds: string[];
  runsPerVariant: number;
  runs: BenchmarkRun[];
}

interface RunInput {
  scenarioId?: string;
  variant?: Variant;
  run?: number;
  toolCalls?: number;
  fileReads?: number;
  wallTimeMs?: number;
  anchorsExpected?: number;
  anchorsFound?: number;
  missingAnchors?: string[];
  completeness?: number;
}

interface ResultsInput {
  scenarioDigest?: string;
  scenarioIds?: string[];
  runsPerVariant?: number;
}

const validScenarioDigest = `sha256:${"0".repeat(64)}`;

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-public-docs-benchmarks-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createScenarioFixture(tempRoot: string): ScenarioDocument {
  const fixtureRoot = path.join(tempRoot, "fixture", "src");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "actual.ts"), "export const actual = true;\n", "utf8");
  fs.writeFileSync(path.join(fixtureRoot, "anchor.ts"), "export const anchor = true;\n", "utf8");
  return {
    schemaVersion: 1,
    scenarios: [
      {
        id: "fixture-scenario",
        repo: "fixture",
        task: "Trace the fixture files.",
        expectedAnchors: ["src/actual.ts", "src/anchor.ts"],
        metrics: [...metrics],
        variants: {
          baseline: [
            { type: "read", path: "src/actual.ts" },
            { type: "read", path: "src/anchor.ts" },
          ],
          codegraph: [{ type: "codegraph", command: "explore", query: "Trace actual to anchor." }],
        },
      },
    ],
  };
}

function addReviewedContract(document: ScenarioDocument): ScenarioDocument {
  const scenario = document.scenarios[0];
  scenario.requiredAnchorOrder = [
    {
      before: { file: "src/actual.ts", label: "actual" },
      after: { file: "src/anchor.ts", label: "anchor" },
    },
  ];
  scenario.expectedRecommendedFile = "src/actual.ts";
  scenario.requiredCandidateTests = ["src/anchor.ts"];
  return document;
}

function addSecondaryScenario(document: ScenarioDocument): ScenarioDocument {
  document.scenarios.push({
    id: "fixture-secondary",
    repo: "fixture",
    task: "Trace the secondary fixture scenario.",
    expectedAnchors: ["src/actual.ts", "src/anchor.ts"],
    metrics: [...metrics],
    variants: {
      baseline: [{ type: "read", path: "src/actual.ts" }],
      codegraph: [
        { type: "codegraph", command: "explore", query: "Find the actual fixture file." },
        { type: "codegraph", command: "explore", query: "Find the anchor fixture file." },
      ],
    },
  });
  return document;
}

function addWarmVariants(document: ScenarioDocument): ScenarioDocument {
  for (const scenario of document.scenarios) {
    scenario.variants["warm-cli"] = structuredClone(scenario.variants.codegraph);
    scenario.variants["warm-mcp"] = structuredClone(scenario.variants.codegraph);
  }
  return document;
}

function makeRun(input: RunInput = {}): BenchmarkRun {
  const anchorsExpected = input.anchorsExpected ?? 2;
  const anchorsFound = input.anchorsFound ?? anchorsExpected;
  return {
    scenarioId: input.scenarioId ?? "alpha",
    variant: input.variant ?? "baseline",
    run: input.run ?? 1,
    metrics: {
      toolCalls: input.toolCalls ?? 1,
      fileReads: input.fileReads ?? 1,
      wallTimeMs: input.wallTimeMs ?? 1,
    },
    checks: {
      anchorsExpected,
      anchorsFound,
      missingAnchors: input.missingAnchors ?? [],
      completeness: input.completeness ?? anchorsFound / anchorsExpected,
    },
  };
}

function makeResults(runs: BenchmarkRun[], input: ResultsInput = {}): BenchmarkResults {
  const inferredScenarioIds = [...new Set(runs.map((run) => run.scenarioId))];
  const inferredRunsPerVariant = Math.max(...runs.map((run) => run.run));
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-10T12:00:00.000Z",
    command: ["node", "scripts/benchmarks/run-scenario.mjs"],
    environment: {
      nodeVersion: "v24.0.0",
      platform: "linux",
      arch: "x64",
      cpuModel: "test cpu",
      logicalCpus: 4,
      totalMemoryBytes: 1024,
    },
    scenarioFile: "docs/benchmarks/scenarios.json",
    scenarioDigest: input.scenarioDigest ?? validScenarioDigest,
    scenarioIds: input.scenarioIds ?? inferredScenarioIds,
    runsPerVariant: input.runsPerVariant ?? inferredRunsPerVariant,
    runs,
  };
}

function makeScenarioResults(
  document: ScenarioDocument,
  selectedScenarioIds = document.scenarios.map((scenario) => scenario.id),
  runsPerVariant = 2,
): BenchmarkResults {
  const selectedIds = new Set(selectedScenarioIds);
  const selectedScenarios = document.scenarios.filter((scenario) => selectedIds.has(scenario.id));
  const runs: BenchmarkRun[] = [];
  for (const scenario of selectedScenarios) {
    const variants: Variant[] = ["baseline", "codegraph"];
    if (scenario.variants["warm-cli"]) variants.push("warm-cli");
    if (scenario.variants["warm-mcp"]) variants.push("warm-mcp");
    for (const variant of variants) {
      const steps = scenario.variants[variant];
      if (!steps) throw new Error(`Missing declared steps for ${variant}.`);
      for (let run = 1; run <= runsPerVariant; run += 1) {
        runs.push(
          makeRun({
            scenarioId: scenario.id,
            variant,
            run,
            toolCalls: steps.length,
            fileReads: variant === "baseline" ? scenario.variants.baseline.length : scenario.expectedAnchors.length,
            anchorsExpected: scenario.expectedAnchors.length,
          }),
        );
      }
    }
  }
  return makeResults(runs, {
    scenarioDigest: calculateScenarioDigest(document.schemaVersion, selectedScenarios),
    scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    runsPerVariant,
  });
}

function completeVariantPair(scenarioId = "alpha"): BenchmarkResults {
  return makeResults([makeRun({ scenarioId, variant: "baseline" }), makeRun({ scenarioId, variant: "codegraph" })]);
}

function findRun(results: BenchmarkResults, scenarioId: string, variant: Variant, run: number): BenchmarkRun {
  const match = results.runs.find(
    (candidate) => candidate.scenarioId === scenarioId && candidate.variant === variant && candidate.run === run,
  );
  if (!match) throw new Error(`Missing test run ${scenarioId}/${variant}/${run}.`);
  return match;
}

describe("public documentation benchmark scenarios", () => {
  it("loads exactly the five checked local scenarios with canonical metrics, variants, steps, and existing fixtures", () => {
    const document = loadScenarioFile("docs/benchmarks/scenarios.json", { rootDir }) as ScenarioDocument;

    expect(document.schemaVersion).toBe(1);
    expect(document.scenarios.map((scenario) => scenario.id)).toEqual(scenarioIds);
    for (const scenario of document.scenarios) {
      expect(scenario.metrics).toEqual(metrics);
      expect(Object.keys(scenario.variants)).toEqual(["baseline", "codegraph", "warm-cli", "warm-mcp"]);
      expect(scenario.variants.baseline.length).toBeGreaterThan(0);
      expect(scenario.variants.codegraph.length).toBeGreaterThan(0);
      expect(scenario.variants["warm-cli"]).toEqual(scenario.variants.codegraph);
      expect(scenario.variants["warm-mcp"]).toEqual(scenario.variants.codegraph);
      expect(scenario.variants.baseline.every((step) => step.type === "read")).toBe(true);
      for (const variant of ["codegraph", "warm-cli", "warm-mcp"] as const) {
        expect(
          scenario.variants[variant]?.every((step) => step.type === "codegraph" && step.command === "explore"),
        ).toBe(true);
      }
      expect(scenario.repo).not.toMatch(/^(?:[a-z][a-z\d+.-]*:|[/\\~])/iu);
      const fixtureRoot = path.join(rootDir, ...scenario.repo.split("/"));
      expect(fs.statSync(fixtureRoot).isDirectory()).toBe(true);
      const reviewedFiles = [
        ...(scenario.requiredAnchorOrder ?? []).flatMap((pair) => [pair.before.file, pair.after.file]),
        ...(scenario.expectedRecommendedFile ? [scenario.expectedRecommendedFile] : []),
        ...(scenario.requiredCandidateTests ?? []),
      ];
      for (const relativeFile of [
        ...scenario.expectedAnchors,
        ...scenario.variants.baseline.map((step) => step.path),
        ...reviewedFiles,
      ]) {
        expect(fs.statSync(path.join(fixtureRoot, ...relativeFile.split("/"))).isFile()).toBe(true);
      }
    }
  });

  it("rejects malformed JSON, unsupported schema versions, and unknown fields at every schema layer", () => {
    const tempRoot = createTempRoot();
    fs.writeFileSync(path.join(tempRoot, "broken.json"), "{ not json", "utf8");
    expect(() => loadScenarioFile("broken.json", { rootDir: tempRoot })).toThrow(/not valid JSON/);

    const mutations: Array<{ name: string; mutate: (document: ScenarioDocument) => void }> = [
      {
        name: "unsupported schema version",
        mutate: (document) => {
          document.schemaVersion = 2;
        },
      },
      {
        name: "unknown document field",
        mutate: (document) => {
          Object.assign(document, { unexpected: true });
        },
      },
      {
        name: "unknown scenario field",
        mutate: (document) => {
          Object.assign(document.scenarios[0], { unexpected: true });
        },
      },
      {
        name: "unknown baseline step field",
        mutate: (document) => {
          Object.assign(document.scenarios[0].variants.baseline[0], { unexpected: true });
        },
      },
      {
        name: "unknown codegraph step field",
        mutate: (document) => {
          Object.assign(document.scenarios[0].variants.codegraph[0], { unexpected: true });
        },
      },
      {
        name: "unknown variant",
        mutate: (document) => {
          Object.assign(document.scenarios[0].variants, { unknown: [] });
        },
      },
    ];

    for (const testCase of mutations) {
      const document = createScenarioFixture(tempRoot);
      testCase.mutate(document);
      expect(() => validateScenarioDocument(document, { rootDir: tempRoot }), testCase.name).toThrow();
    }
  });

  it("rejects warm benchmark variants that differ from the cold query steps", () => {
    const tempRoot = createTempRoot();
    const document = addWarmVariants(createScenarioFixture(tempRoot));
    const warmCliSteps = document.scenarios[0].variants["warm-cli"];
    if (!warmCliSteps) throw new Error("fixture is missing warm-cli steps");
    warmCliSteps[0].query = "Use a different query.";

    expect(() => validateScenarioDocument(document, { rootDir: tempRoot })).toThrow(/warm-cli.*codegraph/);
    expect(() => validateScenarioFile(document)).toThrow(/warm-cli.*codegraph/);
  });

  it("strictly validates reviewed relationship fields and confines every declared path", () => {
    const tempRoot = createTempRoot();
    const valid = addReviewedContract(createScenarioFixture(tempRoot));
    expect(validateScenarioDocument(valid, { rootDir: tempRoot })).toBe(valid);

    const cases: Array<{ name: string; mutate: (scenario: Scenario) => void }> = [
      {
        name: "unknown pair field",
        mutate: (scenario) => {
          const pair = scenario.requiredAnchorOrder?.[0];
          if (!pair) throw new Error("scenario is missing the anchor pair this mutation targets");
          Object.assign(pair, { unexpected: true });
        },
      },
      {
        name: "traversing pair file",
        mutate: (scenario) => {
          if (scenario.requiredAnchorOrder) scenario.requiredAnchorOrder[0].before.file = "../outside.ts";
        },
      },
      {
        name: "absolute recommendation",
        mutate: (scenario) => {
          scenario.expectedRecommendedFile = "/outside.ts";
        },
      },
      {
        name: "network candidate test",
        mutate: (scenario) => {
          scenario.requiredCandidateTests = ["https://example.test/test.ts"];
        },
      },
      {
        name: "duplicate pair",
        mutate: (scenario) => {
          scenario.requiredAnchorOrder?.push(clone(scenario.requiredAnchorOrder[0]));
        },
      },
    ];
    for (const testCase of cases) {
      const document = addReviewedContract(createScenarioFixture(tempRoot));
      testCase.mutate(document.scenarios[0]);
      expect(() => validateScenarioDocument(document, { rootDir: tempRoot }), testCase.name).toThrow();
    }
  });

  it("rejects duplicate scenario IDs and duplicate expected anchors", () => {
    const tempRoot = createTempRoot();
    const duplicateIdDocument = createScenarioFixture(tempRoot);
    duplicateIdDocument.scenarios.push(clone(duplicateIdDocument.scenarios[0]));
    expect(() => validateScenarioDocument(duplicateIdDocument, { rootDir: tempRoot })).toThrow(/duplicated/i);

    const duplicateAnchorDocument = createScenarioFixture(tempRoot);
    duplicateAnchorDocument.scenarios[0].expectedAnchors.push("src/actual.ts");
    expect(() => validateScenarioDocument(duplicateAnchorDocument, { rootDir: tempRoot })).toThrow(/duplicate anchor/i);
  });

  it("rejects URL, absolute, and traversal paths for repos, reads, and anchors", () => {
    const tempRoot = createTempRoot();
    const cases: Array<{
      name: string;
      mutate: (scenario: Scenario) => void;
    }> = [
      {
        name: "URL repo",
        mutate: (scenario) => {
          scenario.repo = "https://example.test/repo";
        },
      },
      {
        name: "absolute repo",
        mutate: (scenario) => {
          scenario.repo = "/outside/repo";
        },
      },
      {
        name: "traversing repo",
        mutate: (scenario) => {
          scenario.repo = "../outside";
        },
      },
      {
        name: "URL read",
        mutate: (scenario) => {
          scenario.variants.baseline[0].path = "https://example.test/file.ts";
        },
      },
      {
        name: "absolute read",
        mutate: (scenario) => {
          scenario.variants.baseline[0].path = "/outside/file.ts";
        },
      },
      {
        name: "traversing read",
        mutate: (scenario) => {
          scenario.variants.baseline[0].path = "../outside.ts";
        },
      },
      {
        name: "URL anchor",
        mutate: (scenario) => {
          scenario.expectedAnchors[0] = "https://example.test/file.ts";
        },
      },
      {
        name: "absolute anchor",
        mutate: (scenario) => {
          scenario.expectedAnchors[0] = "/outside/file.ts";
        },
      },
      {
        name: "traversing anchor",
        mutate: (scenario) => {
          scenario.expectedAnchors[0] = "../outside.ts";
        },
      },
    ];

    for (const testCase of cases) {
      const document = createScenarioFixture(tempRoot);
      testCase.mutate(document.scenarios[0]);
      expect(() => validateScenarioDocument(document, { rootDir: tempRoot }), testCase.name).toThrow();
    }
  });

  it("rejects missing scenario repos, baseline reads, and expected-anchor files", () => {
    const tempRoot = createTempRoot();
    const cases: Array<{
      name: string;
      mutate: (scenario: Scenario) => void;
      expected: RegExp;
    }> = [
      {
        name: "missing repo",
        mutate: (scenario) => {
          scenario.repo = "missing-repo";
        },
        expected: /repo.*does not exist|repo.*cannot be resolved/i,
      },
      {
        name: "missing read",
        mutate: (scenario) => {
          scenario.variants.baseline[0].path = "src/missing-read.ts";
        },
        expected: /baseline.*missing-read|missing-read.*does not exist|missing-read.*cannot be resolved/i,
      },
      {
        name: "missing anchor",
        mutate: (scenario) => {
          scenario.expectedAnchors[0] = "src/missing-anchor.ts";
        },
        expected: /anchor|missing-anchor/i,
      },
    ];

    for (const testCase of cases) {
      const document = createScenarioFixture(tempRoot);
      testCase.mutate(document.scenarios[0]);
      expect(() => validateScenarioDocument(document, { rootDir: tempRoot }), testCase.name).toThrow(testCase.expected);
    }
  });
});

describe("public documentation benchmark runner contracts", () => {
  it("reports declared tool calls, unique delivered source files, elapsed time, completeness, and a portable result shape", async () => {
    const tempRoot = createTempRoot();
    const scenarioDocument = createScenarioFixture(tempRoot);
    const clock = [100, 112.3456, 200, 225.556];
    const environment = {
      nodeVersion: "v24.0.0",
      platform: "test-platform",
      arch: "test-arch",
      cpuModel: "test cpu",
      logicalCpus: 2,
      totalMemoryBytes: 4096,
    };
    const result = await runBenchmark(
      {
        scenarioIds: ["fixture-scenario"],
        runs: 1,
        scenarioFile: "scenario.json",
        requireComplete: true,
        json: true,
      },
      {
        rootDir: tempRoot,
        scenarioDocument,
        environment,
        date: () => new Date("2026-07-10T12:00:00.000Z"),
        now: () => {
          const value = clock.shift();
          if (value === undefined) throw new Error("test clock exhausted");
          return value;
        },
        executeCodegraph: async () => ({
          anchors: ["src/actual.ts", "src/anchor.ts"],
          fileView: { file: "src/actual.ts" },
          packets: [{ target: "src/actual.ts" }, { packet: { target: { file: "src/anchor.ts" } } }],
        }),
      },
    );

    expect(result).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-10T12:00:00.000Z",
      command: [
        "node",
        "scripts/benchmarks/run-scenario.mjs",
        "--scenario-file",
        "scenario.json",
        "--runs",
        "1",
        "--scenario",
        "fixture-scenario",
        "--require-complete",
        "--json",
      ],
      environment,
      scenarioFile: "scenario.json",
      scenarioDigest: calculateScenarioDigest(scenarioDocument.schemaVersion, scenarioDocument.scenarios),
      scenarioIds: ["fixture-scenario"],
      runsPerVariant: 1,
      runs: [
        {
          scenarioId: "fixture-scenario",
          variant: "baseline",
          run: 1,
          metrics: { toolCalls: 2, fileReads: 2, wallTimeMs: 12.346 },
          checks: {
            anchorsExpected: 2,
            anchorsFound: 2,
            missingAnchors: [],
            completeness: 1,
          },
        },
        {
          scenarioId: "fixture-scenario",
          variant: "codegraph",
          run: 1,
          metrics: { toolCalls: 1, fileReads: 2, wallTimeMs: 25.556 },
          checks: {
            anchorsExpected: 2,
            anchorsFound: 2,
            missingAnchors: [],
            completeness: 1,
          },
        },
      ],
    });
    const serialized = serializeBenchmarkResult(result);
    expect(JSON.parse(serialized)).toEqual(result);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).not.toContain(tempRoot);
    expect(serialized).not.toContain(JSON.stringify(tempRoot).slice(1, -1));
  });

  it("uses measured warm cache and MCP calls after separate unmeasured warmups", async () => {
    const tempRoot = createTempRoot();
    const document = addWarmVariants(createScenarioFixture(tempRoot));
    const scenario = document.scenarios[0];
    const cacheDir = path.join(tempRoot, "benchmark-cache");
    const cliCalls: Array<{ cache: string; cacheDir: string | undefined }> = [];
    const mcpOptions: Array<{ cacheDir: string | undefined }> = [];
    let mcpCalls = 0;
    let mcpDisposals = 0;
    const response = {
      anchors: ["src/actual.ts", "src/anchor.ts"],
      packets: [{ target: "src/actual.ts" }, { target: "src/anchor.ts" }],
    };

    const runs = await runScenario(scenario, {
      rootDir: tempRoot,
      runs: 2,
      cacheDir,
      now: () => 0,
      executeCodegraph: async (options: { cache: string; cacheDir?: string }) => {
        cliCalls.push({ cache: options.cache, cacheDir: options.cacheDir });
        return response;
      },
      createWarmMcp: async (options: { cacheDir?: string }) => {
        mcpOptions.push({ cacheDir: options.cacheDir });
        return {
          execute: async () => {
            mcpCalls += 1;
            return response;
          },
          dispose: () => {
            mcpDisposals += 1;
          },
        };
      },
    });

    expect(runs.map((run: BenchmarkRun) => run.variant)).toEqual([
      "baseline",
      "baseline",
      "codegraph",
      "codegraph",
      "warm-cli",
      "warm-cli",
      "warm-mcp",
      "warm-mcp",
    ]);
    expect(
      runs.filter((run: BenchmarkRun) => run.variant === "warm-cli").every((run) => run.metrics.toolCalls === 1),
    ).toBe(true);
    expect(
      runs.filter((run: BenchmarkRun) => run.variant === "warm-mcp").every((run) => run.metrics.toolCalls === 1),
    ).toBe(true);
    expect(cliCalls).toEqual([
      { cache: "off", cacheDir: undefined },
      { cache: "off", cacheDir: undefined },
      { cache: "disk", cacheDir: path.join(cacheDir, "cli") },
      { cache: "disk", cacheDir: path.join(cacheDir, "cli") },
      { cache: "disk", cacheDir: path.join(cacheDir, "cli") },
    ]);
    expect(mcpOptions).toEqual([{ cacheDir: path.join(cacheDir, "mcp") }]);
    expect(mcpCalls).toBe(3);
    expect(mcpDisposals).toBe(1);
    expect(() =>
      validateResults(
        makeResults(runs, {
          scenarioDigest: calculateScenarioDigest(document.schemaVersion, document.scenarios),
          scenarioIds: document.scenarios.map((scenario) => scenario.id),
        }),
        { scenarioFile: document },
      ),
    ).not.toThrow();
  });

  it("disposes a warm MCP session when its warmup request fails", async () => {
    const tempRoot = createTempRoot();
    const scenario = addWarmVariants(createScenarioFixture(tempRoot)).scenarios[0];
    const response = {
      anchors: ["src/actual.ts", "src/anchor.ts"],
      packets: [{ target: "src/actual.ts" }, { target: "src/anchor.ts" }],
    };
    let disposals = 0;

    await expect(
      runScenario(scenario, {
        rootDir: tempRoot,
        runs: 1,
        executeCodegraph: async () => response,
        createWarmMcp: async () => ({
          execute: async () => {
            throw new Error("MCP warmup failed");
          },
          dispose: () => {
            disposals += 1;
          },
        }),
      }),
    ).rejects.toThrow("MCP warmup failed");
    expect(disposals).toBe(1);
  });

  it("binds the scenario digest to repo, task, query, and ordered baseline steps", () => {
    const tempRoot = createTempRoot();
    const document = createScenarioFixture(tempRoot);
    const originalDigest = calculateScenarioDigest(document.schemaVersion, document.scenarios);
    const cases: Array<{ name: string; mutate: (scenario: Scenario) => void }> = [
      {
        name: "repo",
        mutate: (scenario) => {
          scenario.repo = "a-different-fixture";
        },
      },
      {
        name: "task",
        mutate: (scenario) => {
          scenario.task = "Trace the fixture in a different way.";
        },
      },
      {
        name: "codegraph query",
        mutate: (scenario) => {
          scenario.variants.codegraph[0].query = "Trace anchor to actual instead.";
        },
      },
      {
        name: "baseline step order",
        mutate: (scenario) => {
          scenario.variants.baseline.reverse();
        },
      },
    ];

    for (const testCase of cases) {
      const changed = clone(document);
      testCase.mutate(changed.scenarios[0]);
      expect(calculateScenarioDigest(changed.schemaVersion, changed.scenarios), testCase.name).not.toBe(originalDigest);
    }
  });

  it("digests and validates only the selected scenario definitions in scenario-file order", async () => {
    const tempRoot = createTempRoot();
    const document = addSecondaryScenario(createScenarioFixture(tempRoot));
    const dependencies = {
      rootDir: tempRoot,
      scenarioDocument: document,
      date: () => new Date("2026-07-10T12:00:00.000Z"),
      now: () => 0,
      executeCodegraph: async () => ({
        anchors: ["src/actual.ts", "src/anchor.ts"],
        packets: [{ target: "src/actual.ts" }, { target: "src/anchor.ts" }],
      }),
    };
    const result = await runBenchmark(
      { scenarioIds: ["fixture-secondary"], runs: 1, scenarioFile: "scenario.json" },
      dependencies,
    );
    const changedUnselected = clone(document);
    changedUnselected.scenarios[0].task = "This unselected task changed.";
    const resultAfterUnselectedChange = await runBenchmark(
      { scenarioIds: ["fixture-secondary"], runs: 1, scenarioFile: "scenario.json" },
      { ...dependencies, scenarioDocument: changedUnselected },
    );

    expect(result.scenarioIds).toEqual(["fixture-secondary"]);
    expect(result.runsPerVariant).toBe(1);
    expect(result.scenarioDigest).toBe(calculateScenarioDigest(1, [document.scenarios[1]]));
    expect(resultAfterUnselectedChange.scenarioDigest).toBe(result.scenarioDigest);
    expect(
      summarizeResults(result, { scenarioFile: document }).map((summary: { scenarioId: string; variant: Variant }) => [
        summary.scenarioId,
        summary.variant,
      ]),
    ).toEqual([
      ["fixture-secondary", "baseline"],
      ["fixture-secondary", "codegraph"],
    ]);
  });

  it("calculates completeness from captured step evidence rather than task or query metadata", async () => {
    const tempRoot = createTempRoot();
    const fixtureRoot = path.join(tempRoot, "fixture", "src");
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "actual.ts"), "export const actual = true;\n", "utf8");
    fs.writeFileSync(path.join(fixtureRoot, "metadata-only.ts"), "export const hidden = true;\n", "utf8");
    const metadataAnchor = "src/metadata-only.ts";
    const scenario: Scenario = {
      id: "metadata-is-not-evidence",
      repo: "fixture",
      task: `Find ${metadataAnchor}`,
      expectedAnchors: [metadataAnchor],
      metrics: [...metrics],
      variants: {
        baseline: [{ type: "read", path: "src/actual.ts" }],
        codegraph: [{ type: "codegraph", command: "explore", query: `Find ${metadataAnchor}` }],
      },
    };

    const runs = await runScenario(scenario, {
      rootDir: tempRoot,
      runs: 1,
      now: () => 0,
      executeCodegraph: async () => ({ anchors: [], packets: [] }),
    });

    expect(runs.map((run: BenchmarkRun) => run.checks)).toEqual([
      {
        anchorsExpected: 1,
        anchorsFound: 0,
        missingAnchors: [metadataAnchor],
        completeness: 0,
      },
      {
        anchorsExpected: 1,
        anchorsFound: 0,
        missingAnchors: [metadataAnchor],
        completeness: 0,
      },
    ]);
  });

  it("deduplicates normalized packet and file-view paths when counting delivered source files", () => {
    expect(
      collectSourceFiles([
        {
          fileView: { file: "src/shared.ts" },
          packets: [
            { target: "src/shared.ts" },
            { target: "./src/direct.ts" },
            { packet: { target: { file: "src/nested.ts" } } },
          ],
        },
        {
          fileView: { file: "src/nested.ts" },
          packets: [
            { target: "src/direct.ts" },
            { target: "../outside.ts" },
            { packet: { target: { file: "/absolute.ts" } } },
          ],
        },
      ]),
    ).toEqual(["src/direct.ts", "src/nested.ts", "src/shared.ts"]);
  });

  it("records reviewed ranks and rejects failed ordering, recommendation, and candidate-test relationships", async () => {
    const tempRoot = createTempRoot();
    const document = addReviewedContract(createScenarioFixture(tempRoot));
    const response = {
      anchors: [
        { file: "src/actual.ts", label: "actual" },
        { file: "src/anchor.ts", label: "anchor" },
      ],
      packets: [{ target: "src/actual.ts" }, { target: "src/anchor.ts" }],
      candidateTests: ["src/anchor.ts"],
      followUps: ["codegraph file src/actual.ts", "codegraph file src/anchor.ts"],
    };
    const result = await runBenchmark(
      { runs: 1, scenarioFile: "scenario.json", requireComplete: true },
      {
        rootDir: tempRoot,
        scenarioDocument: document,
        now: () => 0,
        executeCodegraph: async () => response,
        date: () => new Date("2026-07-10T12:00:00.000Z"),
        environment: {
          nodeVersion: "v24.0.0",
          platform: "linux",
          arch: "x64",
          cpuModel: "test cpu",
          logicalCpus: 4,
          totalMemoryBytes: 1024,
        },
      },
    );
    assertComplete(result);
    validateResults(result, { scenarioFile: document });
    const reviewed = result.runs[1].checks.reviewedRelationships;
    expect(reviewed).toEqual({
      anchorOrder: [
        {
          before: { file: "src/actual.ts", label: "actual" },
          after: { file: "src/anchor.ts", label: "anchor" },
          beforeRank: 1,
          afterRank: 2,
          beforeReciprocalRank: 1,
          afterReciprocalRank: 0.5,
        },
      ],
      recommendedFile: {
        expected: "src/actual.ts",
        actual: "src/actual.ts",
        rank: 1,
        reciprocalRank: 1,
      },
      candidateTests: [{ file: "src/anchor.ts", rank: 1, reciprocalRank: 1 }],
    });
    expect(describeReviewedRelationships(reviewed)).toEqual([
      "src/actual.ts#actual (rank 1, reciprocal rank 1) before src/anchor.ts#anchor (rank 2, reciprocal rank 0.5)",
      "recommended src/actual.ts (rank 1, reciprocal rank 1; actual src/actual.ts)",
      "src/anchor.ts (rank 1, reciprocal rank 1)",
    ]);
    const summaries = summarizeResults(result, { scenarioFile: document }) as Array<{
      reviewedRelationships?: string[];
    }>;
    expect(summaries[1].reviewedRelationships).toEqual(describeReviewedRelationships(reviewed));
    expect(renderMarkdownTable(summaries)).toContain("3 exact observations; ranks in results.example.json");
    const serialized = serializeBenchmarkResult(result);
    expect(serializeBenchmarkResult(clone(result))).toBe(serialized);
    expect(serialized).toContain('"beforeReciprocalRank": 1');
    expect(serialized).toContain('"afterReciprocalRank": 0.5');
    const unknownField = clone(result);
    Object.assign(unknownField.runs[1].checks.reviewedRelationships?.recommendedFile ?? {}, {
      unexpected: true,
    });
    expect(() => validateResults(unknownField, { scenarioFile: document })).toThrow(/unknown unexpected/);
    const invalidReciprocalRank = clone(result);
    const invalidReviewed = invalidReciprocalRank.runs[1].checks.reviewedRelationships;
    if (!invalidReviewed) throw new Error("Missing reviewed relationship checks.");
    invalidReviewed.anchorOrder[0].afterReciprocalRank = 0.25;
    expect(() => validateResults(invalidReciprocalRank, { scenarioFile: document })).toThrow(
      /expected reciprocal rank/,
    );

    const failures = [
      {
        name: "ordering",
        mutate: (checks: ReviewedRelationships) => {
          checks.anchorOrder[0].beforeRank = 2;
          checks.anchorOrder[0].beforeReciprocalRank = 0.5;
        },
        expected: /must rank before/,
      },
      {
        name: "recommendation",
        mutate: (checks: ReviewedRelationships) => {
          checks.recommendedFile.actual = "src/anchor.ts";
        },
        expected: /recommended.*expected/,
      },
      {
        name: "candidate test",
        mutate: (checks: ReviewedRelationships) => {
          checks.candidateTests[0].rank = null;
          checks.candidateTests[0].reciprocalRank = null;
        },
        expected: /missing candidate test/,
      },
    ];
    for (const testCase of failures) {
      const failed = clone(result);
      const failedChecks = failed.runs[1].checks.reviewedRelationships;
      if (!failedChecks) throw new Error("Missing reviewed relationship checks.");
      testCase.mutate(failedChecks);
      expect(() => assertComplete(failed), testCase.name).toThrow(testCase.expected);
    }
  });

  it("executes the checked installer-preservation scenario through the public harness", async () => {
    const document = loadScenarioFile("docs/benchmarks/scenarios.json", { rootDir }) as ScenarioDocument;
    const scenario = document.scenarios.find((candidate) => candidate.id === "installer-preservation-ranking");
    if (!scenario) throw new Error("Missing installer-preservation scenario.");
    const runs = (await runScenario(scenario, { rootDir, runs: 1, now: () => 0 })) as BenchmarkRun[];
    expect(runs).toHaveLength(4);
    expect(() => assertComplete({ runs })).not.toThrow();
    expect(
      runs.filter((run: BenchmarkRun) => run.variant !== "baseline").every((run) => run.checks.reviewedRelationships),
    ).toBe(true);
    expect(runs[1].checks.reviewedRelationships?.recommendedFile).toMatchObject({
      expected: "src/installer/registry.ts",
      actual: "src/installer/registry.ts",
      rank: 1,
      reciprocalRank: 1,
    });
  });

  it("accepts explicit runner selections and rejects ambiguous or unsafe arguments", () => {
    const parsed = parseArguments([
      "--scenario",
      "one,two",
      "--runs=2",
      "--scenario-file",
      "fixtures/scenarios.json",
      "--output=tmp/results.json",
      "--require-complete",
      "--json",
    ]);
    expect(parsed.scenarioIds).toEqual(["one", "two"]);
    expect(parsed.runs).toBe(2);
    expect(parsed.scenarioFile).toBe("fixtures/scenarios.json");
    expect(parsed.output).toBe("tmp/results.json");
    expect(parsed.requireComplete).toBe(true);
    expect(parsed.json).toBe(true);

    const invalidCases: Array<{ args: string[]; expected: RegExp }> = [
      { args: ["--runs", "0"], expected: /positive integer/ },
      { args: ["--runs", "1.5"], expected: /positive integer/ },
      { args: ["--runs", "9007199254740992"], expected: /safe positive integer/ },
      { args: ["--scenario", "one,,two"], expected: /non-empty comma-separated/ },
      { args: ["--scenario", "one", "--scenario=one"], expected: /more than once/ },
      { args: ["--scenario-file", "https://example.test/scenarios.json"], expected: /local path/ },
      { args: ["--output", "/tmp/results.json"], expected: /relative path/ },
      { args: ["--output", "../results.json"], expected: /within the repository/ },
      { args: ["--json", "--json"], expected: /only once/ },
      { args: ["--require-complete=yes"], expected: /does not take a value/ },
      { args: ["--unknown"], expected: /Unknown argument/ },
    ];
    for (const testCase of invalidCases) {
      expect(() => parseArguments(testCase.args), testCase.args.join(" ")).toThrow(testCase.expected);
    }
  });
});

describe("public documentation benchmark summarizer contracts", () => {
  it("computes odd, even, single, and zero medians without mutating input", () => {
    const values = [9, 1, 5, 3];
    const original = [...values];

    expect(median([9, 1, 5])).toBe(5);
    expect(median(values)).toBe(4);
    expect(median([7])).toBe(7);
    expect(median([0])).toBe(0);
    expect(values).toEqual(original);
  });

  it("rejects empty, nonfinite, and negative median inputs", () => {
    const cases: Array<{ values: number[]; expected: RegExp }> = [
      { values: [], expected: /must not be empty/ },
      { values: [Number.NaN], expected: /finite number/ },
      { values: [Number.POSITIVE_INFINITY], expected: /finite number/ },
      { values: [-0.001], expected: /must not be negative/ },
    ];
    for (const testCase of cases) {
      expect(() => median(testCase.values)).toThrow(testCase.expected);
    }
  });

  it("keeps fractional even-count medians isolated by scenario and variant", () => {
    const runs = [
      makeRun({ scenarioId: "alpha", variant: "codegraph", run: 2, toolCalls: 102, fileReads: 202, wallTimeMs: 302 }),
      makeRun({ scenarioId: "beta", variant: "baseline", run: 1, toolCalls: 10, fileReads: 20, wallTimeMs: 30 }),
      makeRun({ scenarioId: "alpha", variant: "baseline", run: 2, toolCalls: 2, fileReads: 12, wallTimeMs: 22 }),
      makeRun({ scenarioId: "beta", variant: "codegraph", run: 1, toolCalls: 1000, fileReads: 2000, wallTimeMs: 3000 }),
      makeRun({ scenarioId: "alpha", variant: "baseline", run: 1, toolCalls: 1, fileReads: 11, wallTimeMs: 21 }),
      makeRun({ scenarioId: "beta", variant: "codegraph", run: 2, toolCalls: 1001, fileReads: 2001, wallTimeMs: 3001 }),
      makeRun({ scenarioId: "beta", variant: "baseline", run: 2, toolCalls: 11, fileReads: 21, wallTimeMs: 31 }),
      makeRun({ scenarioId: "alpha", variant: "codegraph", run: 1, toolCalls: 101, fileReads: 201, wallTimeMs: 301 }),
    ];

    expect(summarizeResults(makeResults(runs), { scenarioOrder: ["beta", "alpha"] })).toEqual([
      {
        scenarioId: "beta",
        variant: "baseline",
        sampleCount: 2,
        medians: { toolCalls: 10.5, fileReads: 20.5, wallTimeMs: 30.5 },
        completeRunCount: 2,
        minimumCompleteness: 1,
      },
      {
        scenarioId: "beta",
        variant: "codegraph",
        sampleCount: 2,
        medians: { toolCalls: 1000.5, fileReads: 2000.5, wallTimeMs: 3000.5 },
        completeRunCount: 2,
        minimumCompleteness: 1,
      },
      {
        scenarioId: "alpha",
        variant: "baseline",
        sampleCount: 2,
        medians: { toolCalls: 1.5, fileReads: 11.5, wallTimeMs: 21.5 },
        completeRunCount: 2,
        minimumCompleteness: 1,
      },
      {
        scenarioId: "alpha",
        variant: "codegraph",
        sampleCount: 2,
        medians: { toolCalls: 101.5, fileReads: 201.5, wallTimeMs: 301.5 },
        completeRunCount: 2,
        minimumCompleteness: 1,
      },
    ]);
  });

  it("surfaces incomplete run counts and the minimum completeness in each group", () => {
    const results = makeResults([
      makeRun({ scenarioId: "alpha", variant: "baseline", run: 1 }),
      makeRun({
        scenarioId: "alpha",
        variant: "baseline",
        run: 2,
        anchorsExpected: 2,
        anchorsFound: 1,
        missingAnchors: ["src/missing.ts"],
        completeness: 0.5,
      }),
      makeRun({ scenarioId: "alpha", variant: "codegraph", run: 1 }),
      makeRun({ scenarioId: "alpha", variant: "codegraph", run: 2 }),
    ]);

    expect(summarizeResults(results)).toEqual([
      {
        scenarioId: "alpha",
        variant: "baseline",
        sampleCount: 2,
        medians: { toolCalls: 1, fileReads: 1, wallTimeMs: 1 },
        completeRunCount: 1,
        minimumCompleteness: 0.5,
      },
      {
        scenarioId: "alpha",
        variant: "codegraph",
        sampleCount: 2,
        medians: { toolCalls: 1, fileReads: 1, wallTimeMs: 1 },
        completeRunCount: 2,
        minimumCompleteness: 1,
      },
    ]);
  });

  it("rejects malformed and stale scenario digests", () => {
    const tempRoot = createTempRoot();
    const document = createScenarioFixture(tempRoot);
    const malformedDigests = ["", "sha256:abc", `sha256:${"A".repeat(64)}`, `sha512:${"0".repeat(64)}`];

    for (const digest of malformedDigests) {
      const results = makeScenarioResults(document, ["fixture-scenario"], 1);
      results.scenarioDigest = digest;
      expect(() => validateResults(results, { scenarioFile: document }), digest).toThrow(/results\.scenarioDigest/);
    }

    const stale = makeScenarioResults(document, ["fixture-scenario"], 1);
    stale.scenarioDigest = validScenarioDigest;
    expect(() => validateResults(stale, { scenarioFile: document })).toThrow(
      /scenarioDigest.*does not match the selected scenario definitions/,
    );
  });

  it("requires selected scenario IDs to be unique, known, ordered, and exactly represented", () => {
    const tempRoot = createTempRoot();
    const document = addSecondaryScenario(createScenarioFixture(tempRoot));
    const cases: Array<{ name: string; create: () => BenchmarkResults; expected: RegExp }> = [
      {
        name: "duplicate selected id",
        create: () => {
          const results = makeScenarioResults(document);
          results.scenarioIds.push("fixture-scenario");
          return results;
        },
        expected: /scenarioIds\[2\].*duplicate value/,
      },
      {
        name: "unknown selected id",
        create: () => {
          const results = makeScenarioResults(document);
          results.scenarioIds[1] = "unknown-scenario";
          return results;
        },
        expected: /scenarioIds\[1\].*unknown scenario id/,
      },
      {
        name: "selected ids out of scenario-file order",
        create: () => {
          const results = makeScenarioResults(document);
          results.scenarioIds.reverse();
          return results;
        },
        expected: /must follow scenario-file order/,
      },
      {
        name: "selected scenario has no runs",
        create: () => {
          const results = makeScenarioResults(document);
          results.runs = results.runs.filter((run) => run.scenarioId !== "fixture-secondary");
          return results;
        },
        expected: /missing required run tuple fixture-secondary\/baseline\/1/,
      },
      {
        name: "run tuple belongs to an unselected scenario",
        create: () => {
          const results = makeScenarioResults(document, ["fixture-scenario"], 1);
          results.runs.push(
            makeRun({
              scenarioId: "fixture-secondary",
              variant: "baseline",
              toolCalls: 1,
              fileReads: 1,
            }),
          );
          return results;
        },
        expected: /scenarioId.*not listed in results\.scenarioIds/,
      },
    ];

    for (const testCase of cases) {
      expect(() => validateResults(testCase.create(), { scenarioFile: document }), testCase.name).toThrow(
        testCase.expected,
      );
    }
  });

  it("rejects incomplete, noncontiguous, duplicate, extra, and input-amplified run matrices", () => {
    const tempRoot = createTempRoot();
    const document = addSecondaryScenario(createScenarioFixture(tempRoot));
    const cases: Array<{ name: string; create: () => BenchmarkResults; expected: RegExp }> = [
      {
        name: "one missing tuple",
        create: () => {
          const results = makeScenarioResults(document);
          results.runs = results.runs.filter(
            (run) => !(run.scenarioId === "fixture-scenario" && run.variant === "codegraph" && run.run === 2),
          );
          return results;
        },
        expected: /missing required run tuple fixture-scenario\/codegraph\/2/,
      },
      {
        name: "noncontiguous set mismatches the other scenario-variant sets",
        create: () => {
          const results = makeScenarioResults(
            document,
            document.scenarios.map((scenario) => scenario.id),
            3,
          );
          results.runs = results.runs.filter(
            (run) => !(run.scenarioId === "fixture-scenario" && run.variant === "baseline" && run.run === 2),
          );
          return results;
        },
        expected: /missing required run tuple fixture-scenario\/baseline\/2/,
      },
      {
        name: "extra out-of-range tuple",
        create: () => {
          const results = makeScenarioResults(document);
          const extra = clone(findRun(results, "fixture-scenario", "baseline", 1));
          extra.run = 3;
          results.runs.push(extra);
          return results;
        },
        expected: /run.*must be between 1 and results\.runsPerVariant \(2\).*received 3/,
      },
      {
        name: "deleted incomplete run",
        create: () => {
          const results = makeScenarioResults(document);
          const incomplete = findRun(results, "fixture-scenario", "baseline", 2);
          incomplete.checks.anchorsFound = 1;
          incomplete.checks.missingAnchors = ["src/anchor.ts"];
          incomplete.checks.completeness = 0.5;
          results.runs = results.runs.filter((run) => run !== incomplete);
          return results;
        },
        expected: /missing required run tuple fixture-scenario\/baseline\/2/,
      },
      {
        name: "duplicate tuple",
        create: () => {
          const results = makeScenarioResults(document);
          results.runs.push(clone(findRun(results, "fixture-secondary", "codegraph", 2)));
          return results;
        },
        expected: /duplicate scenario\+variant\+run key fixture-secondary\/codegraph\/2/,
      },
      {
        name: "absurd runsPerVariant remains input-bounded",
        create: () => {
          const results = makeScenarioResults(document);
          results.runsPerVariant = Number.MAX_SAFE_INTEGER;
          return results;
        },
        expected: /missing required run tuple fixture-scenario\/baseline\/3/,
      },
    ];

    for (const testCase of cases) {
      expect(() => validateResults(testCase.create(), { scenarioFile: document }), testCase.name).toThrow(
        testCase.expected,
      );
    }
  });

  it("requires every run for present optional variants without scenario metadata", () => {
    const runs: BenchmarkRun[] = [];
    for (const variant of ["baseline", "codegraph"] as const) {
      for (let run = 1; run <= 3; run += 1) {
        runs.push(makeRun({ variant, run }));
      }
    }
    runs.push(makeRun({ variant: "warm-cli", run: 1 }));

    const results = makeResults(runs, { runsPerVariant: 3 });
    expect(() => validateResults(results)).toThrow(/missing required run tuple alpha\/warm-cli\/2/);
  });

  it("binds declared step counts while preserving output-derived Codegraph file reads", () => {
    const tempRoot = createTempRoot();
    const document = addSecondaryScenario(createScenarioFixture(tempRoot));
    const mismatches: Array<{
      name: string;
      mutate: (results: BenchmarkResults) => void;
      expected: RegExp;
    }> = [
      {
        name: "baseline tool calls",
        mutate: (results) => {
          findRun(results, "fixture-scenario", "baseline", 1).metrics.toolCalls = 1;
        },
        expected: /toolCalls.*expected 2.*variant "baseline"/,
      },
      {
        name: "Codegraph tool calls",
        mutate: (results) => {
          findRun(results, "fixture-scenario", "codegraph", 1).metrics.toolCalls = 2;
        },
        expected: /toolCalls.*expected 1.*variant "codegraph"/,
      },
      {
        name: "baseline file reads",
        mutate: (results) => {
          findRun(results, "fixture-scenario", "baseline", 1).metrics.fileReads = 1;
        },
        expected: /fileReads.*expected 2 from the declared baseline read steps/,
      },
    ];

    for (const testCase of mismatches) {
      const results = makeScenarioResults(document, ["fixture-scenario"], 1);
      testCase.mutate(results);
      expect(() => validateResults(results, { scenarioFile: document }), testCase.name).toThrow(testCase.expected);
    }

    const outputDerived = makeScenarioResults(document, ["fixture-secondary"], 1);
    findRun(outputDerived, "fixture-secondary", "codegraph", 1).metrics.fileReads = 7;
    expect(
      summarizeResults(outputDerived, { scenarioFile: document }).map(
        (summary: { variant: Variant; medians: { fileReads: number } }) => ({
          variant: summary.variant,
          fileReads: summary.medians.fileReads,
        }),
      ),
    ).toEqual([
      { variant: "baseline", fileReads: 1 },
      { variant: "codegraph", fileReads: 7 },
    ]);
  });

  it("rejects malformed, duplicate, nonfinite, negative, inconsistent, and unsafe result data", () => {
    const cases: Array<{
      name: string;
      mutate: (results: BenchmarkResults) => void;
      expected: RegExp;
    }> = [
      {
        name: "unknown result field",
        mutate: (results) => {
          Object.assign(results, { unexpected: true });
        },
        expected: /unknown unexpected/,
      },
      {
        name: "missing metric",
        mutate: (results) => {
          Reflect.deleteProperty(results.runs[0].metrics, "fileReads");
        },
        expected: /missing fileReads/,
      },
      {
        name: "nonfinite metric",
        mutate: (results) => {
          results.runs[0].metrics.wallTimeMs = Number.NaN;
        },
        expected: /finite number/,
      },
      {
        name: "negative metric",
        mutate: (results) => {
          results.runs[0].metrics.fileReads = -1;
        },
        expected: /must not be negative/,
      },
      {
        name: "unsafe count",
        mutate: (results) => {
          results.runs[0].metrics.toolCalls = Number.MAX_SAFE_INTEGER + 1;
        },
        expected: /safe integer count/,
      },
      {
        name: "absolute command path",
        mutate: (results) => {
          results.command[0] = "/absolute/node";
        },
        expected: /absolute path or network URL/,
      },
      {
        name: "traversing scenario file",
        mutate: (results) => {
          results.scenarioFile = "../outside.json";
        },
        expected: /confined to the repository/,
      },
      {
        name: "missing-anchor arithmetic",
        mutate: (results) => {
          results.runs[0].checks.anchorsFound = 1;
          results.runs[0].checks.completeness = 0.5;
        },
        expected: /plus missingAnchors.*must equal anchorsExpected/,
      },
      {
        name: "completeness arithmetic",
        mutate: (results) => {
          results.runs[0].checks.completeness = 0.5;
        },
        expected: /expected 1 from anchorsFound \/ anchorsExpected/,
      },
      {
        name: "inconsistent expected-anchor total",
        mutate: (results) => {
          results.runs[1].checks.anchorsExpected = 3;
          results.runs[1].checks.anchorsFound = 3;
          results.runs[1].checks.completeness = 1;
        },
        expected: /inconsistent total for scenario/,
      },
    ];

    for (const testCase of cases) {
      const results = completeVariantPair();
      testCase.mutate(results);
      expect(() => validateResults(results), testCase.name).toThrow(testCase.expected);
    }
  });

  it("renders deterministic scenario and variant order with Markdown cell escaping", () => {
    const escapedId = "z|[x]\nnext";
    const plainId = "alpha";
    const runs = [
      makeRun({ scenarioId: plainId, variant: "codegraph", toolCalls: 4, fileReads: 5, wallTimeMs: 6 }),
      makeRun({ scenarioId: escapedId, variant: "codegraph", toolCalls: 7, fileReads: 8, wallTimeMs: 9 }),
      makeRun({ scenarioId: plainId, variant: "baseline", toolCalls: 1, fileReads: 2, wallTimeMs: 3 }),
      makeRun({ scenarioId: escapedId, variant: "baseline", toolCalls: 10, fileReads: 11, wallTimeMs: 12 }),
    ];
    const order = [escapedId, plainId];
    const render = (orderedRuns: BenchmarkRun[]) =>
      renderMarkdownTable(summarizeResults(makeResults(orderedRuns), { scenarioOrder: order }));
    const expected = [
      "| Scenario         | Variant   | Samples | Median tool calls | Median file reads | Median wall time (ms) | Complete runs | Minimum completeness |",
      "| ---------------- | --------- | ------: | ----------------: | ----------------: | --------------------: | ------------: | -------------------: |",
      "| z\\|\\[x\\]<br>next | baseline  |       1 |                10 |                11 |                    12 |             1 |                 100% |",
      "| z\\|\\[x\\]<br>next | codegraph |       1 |                 7 |                 8 |                     9 |             1 |                 100% |",
      "| alpha            | baseline  |       1 |                 1 |                 2 |                     3 |             1 |                 100% |",
      "| alpha            | codegraph |       1 |                 4 |                 5 |                     6 |             1 |                 100% |",
      "",
    ].join("\n");

    expect(render(runs)).toBe(expected);
    expect(render([...runs].reverse())).toBe(expected);
    const checkedScenarios: unknown = JSON.parse(fs.readFileSync(scenarioFilePath, "utf8"));
    const checkedResults: unknown = JSON.parse(fs.readFileSync(resultsFilePath, "utf8"));
    const checkedTable = renderMarkdownTable(summarizeResults(checkedResults, { scenarioFile: checkedScenarios }));
    const formatted = spawnSync(
      process.execPath,
      [path.join(rootDir, "node_modules", "prettier", "bin", "prettier.cjs"), "--parser", "markdown"],
      {
        cwd: rootDir,
        input: checkedTable,
        encoding: "utf8",
      },
    );
    expect(formatted.status, formatted.stderr).toBe(0);
    expect(formatted.stdout).toBe(checkedTable);
  });

  it("matches the README generated block to results.example.json and passes the summarizer --check flow", () => {
    const scenarioDocument: unknown = JSON.parse(fs.readFileSync(scenarioFilePath, "utf8"));
    const results: unknown = JSON.parse(fs.readFileSync(resultsFilePath, "utf8"));
    const readmeBefore = fs.readFileSync(readmePath, "utf8");
    const table = renderMarkdownTable(summarizeResults(results, { scenarioFile: scenarioDocument }));

    expect(checkGeneratedBlock(readmeBefore, table)).toBe(true);
    let stdout = "";
    runSummarizerCli(
      ["--input", resultsFilePath, "--scenario-file", scenarioFilePath, "--readme", readmePath, "--check"],
      {
        stdout: (chunk: string) => {
          stdout += chunk;
        },
      },
    );
    expect(stdout).toBe(table);
    expect(fs.readFileSync(readmePath, "utf8")).toBe(readmeBefore);
  });
});

describe("public documentation benchmark subprocess", () => {
  it("runs one complete local scenario through all variants without native or network requirements", () => {
    const result = spawnSync(
      process.execPath,
      [runnerPath, "--runs", "1", "--scenario", "repo-orientation-small-ts", "--require-complete", "--json"],
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, CODEGRAPH_DISABLE_NATIVE: "1" },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Benchmark error:");
    const output: BenchmarkResults = JSON.parse(result.stdout);
    const scenarioDocument: ScenarioDocument = JSON.parse(fs.readFileSync(scenarioFilePath, "utf8"));
    expect(() => validateResults(output, { scenarioFile: scenarioDocument })).not.toThrow();
    expect(output.runs.map((run) => run.variant)).toEqual(["baseline", "codegraph", "warm-cli", "warm-mcp"]);
    for (const run of output.runs) {
      expect(run.scenarioId).toBe("repo-orientation-small-ts");
      expect(Object.keys(run.metrics)).toEqual(metrics);
      expect(run.checks).toEqual({
        anchorsExpected: 3,
        anchorsFound: 3,
        missingAnchors: [],
        completeness: 1,
      });
    }
    const serializedRoot = JSON.stringify(rootDir).slice(1, -1);
    expect(result.stdout).not.toContain(rootDir);
    expect(result.stdout).not.toContain(serializedRoot);
  }, 60_000);
});
