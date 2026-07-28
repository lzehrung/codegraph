import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSemanticRunPlan,
  latencySummary,
  loadSemanticCorpus,
  runSemanticCorpus,
  scoreSemanticCase,
  summarizeSemanticCases,
  validateSemanticCorpus,
  validateSemanticResults,
} from "../scripts/benchmarks/semantic-corpus-lib.mjs";
import { runCli as runCorpusCli } from "../scripts/benchmarks/run-semantic-corpus.mjs";
import { runCli as runSummarizerCli } from "../scripts/benchmarks/summarize-semantic-corpus.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const corpusPath = path.join(rootDir, "docs", "benchmarks", "semantic-corpus.json");
const examplePath = path.join(rootDir, "docs", "benchmarks", "semantic-results.example.json");
const tempRoots: string[] = [];

interface Position {
  line: number;
  column: number;
}

interface SemanticLocation {
  file: string;
  range: {
    start: Position;
    end: Position;
  };
}

interface DependencyTuple {
  from: string;
  to: string;
  kind: string;
}

interface CandidateTest {
  file: string;
}

type Observation = SemanticLocation | DependencyTuple | CandidateTest;

interface SemanticCase {
  id: string;
  tier: "release" | "representative";
  repository: string;
  language: string;
  operation: "definition" | "references" | "dependency" | "candidate-tests";
  request: Record<string, unknown>;
  expected: {
    required: Observation[];
    allowed?: Observation[];
    forbidden?: Observation[];
    unsupported?: string;
  };
  rationale: string;
}

interface SemanticCorpus {
  schemaVersion: number;
  corpusRevision: string;
  repositories: Array<{
    id: string;
    url: string;
    revision: string;
    license: string;
    includeRoots?: string[];
    config?: string;
  }>;
  cases: SemanticCase[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function location(file: string, line: number, column: number, endColumn = column + 1): SemanticLocation {
  return {
    file,
    range: {
      start: { line, column },
      end: { line, column: endColumn },
    },
  };
}

function makeCorpus(): SemanticCorpus {
  return {
    schemaVersion: 1,
    corpusRevision: "test-v1",
    repositories: [
      {
        id: "local-fixture",
        url: "fixtures",
        revision: "source-candidate",
        license: "MIT",
      },
    ],
    cases: [
      {
        id: "definition-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "definition",
        request: { file: "source.ts", line: 1, column: 1 },
        expected: { required: [location("target.ts", 1, 1)] },
        rationale: "Source review: the imported source name resolves to the target declaration.",
      },
    ],
  };
}

function makeScoringCase(operation: SemanticCase["operation"], expected: SemanticCase["expected"]): SemanticCase {
  return {
    id: "score-case",
    tier: "release",
    repository: "local-fixture",
    language: "typescript",
    operation,
    request: { file: "source.ts", line: 1, column: 1 },
    expected,
    rationale: "Source review: synthetic scoring golden for the focused contract test.",
  };
}

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-semantic-corpus-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("SemanticCorpusV1 manifest", () => {
  it("loads reviewed, network-free release cases and leaves the representative tier non-blocking", () => {
    const corpus = loadSemanticCorpus("docs/benchmarks/semantic-corpus.json", { rootDir }) as SemanticCorpus;

    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(corpus.cases.map((entry) => entry.operation))).toEqual(
      new Set(["definition", "references", "dependency", "candidate-tests"]),
    );
    expect(new Set(corpus.cases.map((entry) => entry.language))).toEqual(
      new Set(["go", "markdown", "python", "typescript"]),
    );
    expect(corpus.cases.every((entry) => entry.tier === "release")).toBe(true);
    expect(corpus.cases.every((entry) => /^(?:Source|Limitation) review:/u.test(entry.rationale))).toBe(true);
    expect(corpus.repositories.every((entry) => !/^[a-z][a-z\d+.-]*:/iu.test(entry.url))).toBe(true);
    expect(buildSemanticRunPlan(corpus, { tiers: ["representative"] })).toMatchObject({
      tiers: ["representative"],
      caseIds: [],
      entries: [],
    });
  });

  it("rejects absolute paths, traversal, executable fields, expansion, and unconfined repository ids", () => {
    const mutations: Array<{ name: string; mutate: (corpus: SemanticCorpus) => void; error: RegExp }> = [
      {
        name: "absolute fixture root",
        mutate: (corpus) => {
          corpus.repositories[0].url = "C:/private/fixture";
        },
        error: /relative|https/iu,
      },
      {
        name: "request traversal",
        mutate: (corpus) => {
          corpus.cases[0].request.file = "../source.ts";
        },
        error: /within|stay/iu,
      },
      {
        name: "arbitrary command",
        mutate: (corpus) => {
          corpus.cases[0].request.command = "rm -rf .";
        },
        error: /executable|invalid keys/iu,
      },
      {
        name: "environment expansion",
        mutate: (corpus) => {
          corpus.cases[0].request.file = "${HOME}/source.ts";
        },
        error: /expansion/iu,
      },
      {
        name: "repository traversal id",
        mutate: (corpus) => {
          corpus.cases[0].repository = "../local-fixture";
        },
        error: /confined repository id/iu,
      },
      {
        name: "undeclared repository id",
        mutate: (corpus) => {
          corpus.cases[0].repository = "other-fixture";
        },
        error: /undeclared repository/iu,
      },
    ];

    for (const testCase of mutations) {
      const corpus = makeCorpus();
      testCase.mutate(corpus);
      expect(() => validateSemanticCorpus(corpus, { checkFilesystem: false }), testCase.name).toThrow(testCase.error);
    }
  });

  it("accepts pinned HTTPS repository metadata for future representative cases", () => {
    const corpus = makeCorpus();
    corpus.repositories.push({
      id: "public-fixture",
      url: "https://github.com/example/public-fixture",
      revision: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      includeRoots: ["src"],
    });

    expect(validateSemanticCorpus(corpus, { checkFilesystem: false })).toBe(corpus);
  });

  it("rejects duplicate expected observations across required, allowed, and forbidden sets", () => {
    const corpus = makeCorpus();
    corpus.cases[0].expected.allowed = [clone(corpus.cases[0].expected.required[0])];
    expect(() => validateSemanticCorpus(corpus, { checkFilesystem: false })).toThrow(/duplicates/iu);
  });
});

describe("semantic scoring", () => {
  it("scores required, allowed, forbidden, unexpected, missing, and duplicate locations without inflation", () => {
    const required = location("source.ts", 1, 1);
    const missing = location("source.ts", 2, 1);
    const allowed = location("source.ts", 3, 1);
    const forbidden = location("source.ts", 4, 1);
    const unexpected = location("source.ts", 5, 1);
    const caseDefinition = makeScoringCase("references", {
      required: [required, missing],
      allowed: [allowed],
      forbidden: [forbidden],
    });

    expect(scoreSemanticCase(caseDefinition, [required, allowed, forbidden, unexpected, clone(required)])).toEqual({
      truePositives: 1,
      falseNegatives: 1,
      falsePositives: 1,
      allowed: 1,
      unexpected: 1,
      duplicates: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      support: 1,
      unsupported: 0,
      reciprocalRank: null,
    });
  });

  it("compares the complete dependency tuple including kind", () => {
    const required: DependencyTuple = { from: "source.ts", to: "target.ts", kind: "dependency" };
    const wrongKind: DependencyTuple = { from: "source.ts", to: "target.ts", kind: "type-only" };
    const caseDefinition = makeScoringCase("dependency", {
      required: [required],
      forbidden: [wrongKind],
    });

    const score = scoreSemanticCase(caseDefinition, [required, wrongKind]);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1);
    expect(score.precision).toBe(0.5);
  });

  it("reports candidate-test reciprocal rank and ignores duplicate candidates", () => {
    const first: CandidateTest = { file: "first.test.ts" };
    const required: CandidateTest = { file: "required.test.ts" };
    const caseDefinition = makeScoringCase("candidate-tests", { required: [required] });

    const score = scoreSemanticCase(caseDefinition, [first, required, clone(required)]);
    expect(score.reciprocalRank).toBe(0.5);
    expect(score.duplicates).toBe(1);
    expect(score.truePositives).toBe(1);
  });

  it("keeps unsupported cases out of accuracy denominators and uses nearest-rank latency", () => {
    const caseDefinition = makeScoringCase("definition", { required: [location("target.ts", 1, 1)] });
    expect(scoreSemanticCase(caseDefinition, [], { supported: false })).toMatchObject({
      support: 0,
      unsupported: 1,
      precision: null,
      recall: null,
      f1: null,
      truePositives: 0,
      falseNegatives: 0,
    });
    expect(latencySummary([40, 10, 30, 20])).toEqual({
      samples: 4,
      p50Ms: 20,
      p95Ms: 40,
      maxMs: 40,
    });
  });

  it("emits separate native and reduced summaries in deterministic order", () => {
    const caseDefinition = makeScoringCase("definition", { required: [location("target.ts", 1, 1)] });
    const supportedScore = scoreSemanticCase(caseDefinition, [location("target.ts", 1, 1)]);
    const unsupportedScore = scoreSemanticCase(caseDefinition, [], { supported: false });
    const summaries = summarizeSemanticCases([
      {
        caseId: "definition-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "definition",
        runtimeMode: "reduced",
        status: "unsupported",
        durationMs: 2,
        score: unsupportedScore,
      },
      {
        caseId: "definition-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "definition",
        runtimeMode: "native",
        status: "supported",
        durationMs: 1,
        score: supportedScore,
      },
    ]);
    const totals = summaries.filter((entry) => entry.groupBy === "total");

    expect(totals.map((entry) => entry.runtimeMode)).toEqual(["native", "reduced"]);
    expect(totals.map((entry) => entry.support)).toEqual([1, 0]);
  });
});

describe("semantic runner", () => {
  it("produces byte-identical dry-run ordering on repeated runs", async () => {
    let first = "";
    let second = "";
    await runCorpusCli(["--dry-run"], {
      rootDir,
      stdout: (chunk: string) => {
        first += chunk;
      },
    });
    await runCorpusCli(["--dry-run"], {
      rootDir,
      stdout: (chunk: string) => {
        second += chunk;
      },
    });

    expect(second).toBe(first);
    const plan = JSON.parse(first) as { cases: Array<{ caseId: string; runtimeMode: string }> };
    expect(plan.cases[0]).toEqual({
      caseId: "go-definition-utility-class",
      tier: "release",
      repository: "local-go",
      language: "go",
      operation: "definition",
      runtimeMode: "native",
    });
  });

  it("sorts cases and modes independently of manifest and selection order", () => {
    const corpus = makeCorpus();
    const secondCase = clone(corpus.cases[0]);
    secondCase.id = "alpha-case";
    corpus.cases.unshift(secondCase);
    const plan = buildSemanticRunPlan(corpus, { modes: ["reduced", "native"] });

    expect(plan.caseIds).toEqual(["alpha-case", "definition-case"]);
    expect(plan.entries.map((entry) => `${entry.caseDefinition.id}/${entry.runtimeMode}`)).toEqual([
      "alpha-case/native",
      "alpha-case/reduced",
      "definition-case/native",
      "definition-case/reduced",
    ]);
  });

  it("uses explicit-file public APIs without writing fixture caches", async () => {
    const tempRoot = createTempRoot();
    const fixtureRoot = path.join(tempRoot, "fixtures");
    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const file of ["source.ts", "target.ts", "source.test.ts"]) {
      fs.writeFileSync(path.join(fixtureRoot, file), `export const ${file.replace(/\W/gu, "_")} = 1;\n`, "utf8");
    }
    const corpus = makeCorpus();
    corpus.cases = [
      corpus.cases[0],
      {
        id: "dependency-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "dependency",
        request: { from: "source.ts" },
        expected: {
          required: [{ from: "source.ts", to: "target.ts", kind: "dependency" }],
        },
        rationale: "Source review: source.ts has the reviewed synthetic dependency on target.ts.",
      },
      {
        id: "references-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "references",
        request: { file: "target.ts", line: 1, column: 1 },
        expected: { required: [location("source.ts", 1, 1)] },
        rationale: "Source review: source.ts contains the reviewed reference to the target declaration.",
      },
      {
        id: "candidate-case",
        tier: "release",
        repository: "local-fixture",
        language: "typescript",
        operation: "candidate-tests",
        request: { changedFiles: ["source.ts"] },
        expected: { required: [{ file: "source.test.ts" }] },
        rationale: "Source review: source.test.ts is the reviewed focused test for source.ts.",
      },
    ];

    let listCalls = 0;
    let explicitBuildCalls = 0;
    const normalizedFixture = fixtureRoot.replace(/\\/gu, "/");
    const fakeApi = {
      listProjectFiles: async (_projectRoot: string): Promise<string[]> => {
        listCalls += 1;
        return ["source.ts", "target.ts", "source.test.ts"].map((file) => `${normalizedFixture}/${file}`);
      },
      buildProjectIndexFromFiles: async (
        _projectRoot: string,
        _files: string[],
        _options: { native: string },
      ): Promise<object> => {
        explicitBuildCalls += 1;
        return {
          graph: {
            edges: [
              {
                from: `${normalizedFixture}/source.ts`,
                to: { type: "file", path: `${normalizedFixture}/target.ts` },
              },
            ],
          },
        };
      },
      goToDefinition: async (): Promise<object> => ({
        status: "ok",
        definition: {
          file: `${normalizedFixture}/target.ts`,
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      }),
      findReferences: async (): Promise<object> => ({
        status: "ok",
        references: [
          {
            file: `${normalizedFixture}/source.ts`,
            range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          },
        ],
      }),
      listCandidateTestFiles: (): Array<{ file: string }> => [{ file: `${normalizedFixture}/source.test.ts` }],
      symbolId: (): string => "target.ts::target::0",
    };
    const result = await runSemanticCorpus(
      {
        rootDir: tempRoot,
        corpusDocument: corpus,
        modes: ["native", "reduced"],
        packageInfo: { name: "@lzehrung/codegraph", version: "test" },
        generatedAt: "2026-07-27T00:00:00.000Z",
      },
      {
        api: fakeApi,
        environment: {
          nodeVersion: "v24.0.0",
          platform: "linux",
          arch: "x64",
          cpuModel: "test",
          logicalCpus: 1,
          totalMemoryBytes: 1,
        },
      },
    );

    expect(result.cases).toHaveLength(8);
    expect(result.packageMode).toBe("checkout");
    expect(result.cases.every((entry) => entry.status === "supported")).toBe(true);
    expect(listCalls).toBe(2);
    expect(explicitBuildCalls).toBe(2);
    expect(fs.existsSync(path.join(fixtureRoot, ".codegraph-cache"))).toBe(false);
  });
});

describe("semantic result and summarizer contracts", () => {
  it("validates the checked example, canonical JSON, and no-baseline informational scaffold", () => {
    const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as SemanticCorpus;
    const exampleSource = fs.readFileSync(examplePath, "utf8");
    const example = JSON.parse(exampleSource);

    expect(validateSemanticResults(example, { corpus })).toBe(example);
    let output = "";
    const summarized = runSummarizerCli(
      ["--input", examplePath, "--corpus", "docs/benchmarks/semantic-corpus.json", "--check"],
      {
        rootDir,
        stdout: (chunk: string) => {
          output += chunk;
        },
      },
    );
    expect(output).toContain("| native | total |");
    expect(output).toContain("| reduced | total |");
    expect(summarized.summary?.baseline).toEqual({ status: "not-configured", file: null, changes: [] });
  });

  it("writes a validated canonical result to an explicit output path", () => {
    const tempRoot = createTempRoot();
    const outputPath = path.join(tempRoot, "semantic-copy.json");
    runSummarizerCli(
      ["--input", examplePath, "--corpus", "docs/benchmarks/semantic-corpus.json", "--output", outputPath],
      {
        rootDir,
        stdout: () => undefined,
      },
    );

    expect(fs.readFileSync(outputPath, "utf8")).toBe(fs.readFileSync(examplePath, "utf8"));
  });

  it("rejects duplicate case/mode rows, non-canonical ordering, and stale summaries", () => {
    const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as SemanticCorpus;
    const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));

    const duplicate = clone(example);
    duplicate.cases.splice(1, 0, clone(duplicate.cases[0]));
    expect(() => validateSemanticResults(duplicate, { corpus })).toThrow(/duplicates case\/mode/iu);

    const unordered = clone(example);
    [unordered.cases[0], unordered.cases[1]] = [unordered.cases[1], unordered.cases[0]];
    expect(() => validateSemanticResults(unordered, { corpus })).toThrow(/deterministic/iu);

    const unorderedCaseIds = clone(example);
    [unorderedCaseIds.corpus.caseIds[0], unorderedCaseIds.corpus.caseIds[1]] = [
      unorderedCaseIds.corpus.caseIds[1],
      unorderedCaseIds.corpus.caseIds[0],
    ];
    expect(() => validateSemanticResults(unorderedCaseIds, { corpus })).toThrow(/deterministic tier and case/iu);

    const stale = clone(example);
    stale.summaries[0].support = 0;
    expect(() => validateSemanticResults(stale, { corpus })).toThrow(/canonical computed value/iu);
  });
});
