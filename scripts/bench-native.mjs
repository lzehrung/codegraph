import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(rootDir, "dist", "index.js");

const FIXTURE_ROOTS = {
  typescript: path.join(rootDir, "tests", "samples", "typescript"),
  python: path.join(rootDir, "tests", "samples", "python"),
  go: path.join(rootDir, "tests", "samples", "go"),
  rust: path.join(rootDir, "tests", "samples", "rust"),
  mixed: path.join(rootDir, "tests", "samples"),
};

const DEFAULT_FIXTURES = ["typescript", "python", "go", "rust", "mixed"];
const DEFAULT_RUNS = 3;
const DEFAULT_WORKLOADS = ["full", "graph"];
const DEFAULT_TEMPERATURES = ["cold", "warm"];

function parseArgs(argv) {
  const options = {
    child: false,
    fixture: "",
    mode: "native",
    runs: DEFAULT_RUNS,
    fixtures: [...DEFAULT_FIXTURES],
    workloads: [...DEFAULT_WORKLOADS],
    temperatures: [...DEFAULT_TEMPERATURES],
    json: false,
    maxSlowdown: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--child") {
      options.child = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--temperatures=")) {
      options.temperatures = arg
        .slice("--temperatures=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      continue;
    }
    if (arg === "--temperatures") {
      options.temperatures = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }
    if (arg.startsWith("--workloads=")) {
      options.workloads = arg
        .slice("--workloads=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      continue;
    }
    if (arg === "--workloads") {
      options.workloads = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-slowdown=")) {
      options.maxSlowdown = Number(arg.slice("--max-slowdown=".length));
      continue;
    }
    if (arg === "--max-slowdown") {
      options.maxSlowdown = Number(argv[index + 1] ?? options.maxSlowdown);
      index += 1;
      continue;
    }
    if (arg.startsWith("--fixture=")) {
      options.fixture = arg.slice("--fixture=".length);
      continue;
    }
    if (arg === "--fixture") {
      options.fixture = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--mode") {
      options.mode = argv[index + 1] ?? options.mode;
      index += 1;
      continue;
    }
    if (arg.startsWith("--runs=")) {
      options.runs = Number(arg.slice("--runs=".length));
      continue;
    }
    if (arg === "--runs") {
      options.runs = Number(argv[index + 1] ?? options.runs);
      index += 1;
      continue;
    }
    if (arg.startsWith("--fixtures=")) {
      options.fixtures = arg
        .slice("--fixtures=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      continue;
    }
    if (arg === "--fixtures") {
      options.fixtures = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error(`Invalid --runs value: ${String(options.runs)}`);
  }
  if (!Number.isFinite(options.maxSlowdown) || options.maxSlowdown < 0) {
    throw new Error(`Invalid --max-slowdown value: ${String(options.maxSlowdown)}`);
  }
  for (const workload of options.workloads) {
    if (workload !== "full" && workload !== "graph") {
      throw new Error(`Unknown workload '${workload}'. Expected one of: full, graph`);
    }
  }
  for (const temperature of options.temperatures) {
    if (temperature !== "cold" && temperature !== "warm") {
      throw new Error(
        `Unknown temperature '${temperature}'. Expected one of: cold, warm`,
      );
    }
  }

  return options;
}

function assertFixtureNames(fixtures) {
  for (const fixture of fixtures) {
    if (!(fixture in FIXTURE_ROOTS)) {
      throw new Error(
        `Unknown fixture '${fixture}'. Expected one of: ${Object.keys(FIXTURE_ROOTS).join(", ")}`,
      );
    }
  }
}

async function runChildBenchmark(fixture, workload, temperature, mode) {
  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--child",
        `--fixture=${fixture}`,
        `--workloads=${workload}`,
        `--temperatures=${temperature}`,
        `--mode=${mode}`,
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          CODEGRAPH_DISABLE_NATIVE: mode === "js" ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Benchmark child failed for ${fixture}/${workload}/${temperature}/${mode}: ${stderrChunks.join("").trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdoutChunks.join("")));
      } catch (error) {
        reject(
          new Error(
            `Failed to parse benchmark output for ${fixture}/${workload}/${temperature}/${mode}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

function summarizeRuns(runs) {
  const elapsedValues = runs.map((entry) => entry.elapsedMs);
  const totalElapsed = elapsedValues.reduce((sum, value) => sum + value, 0);
  const averageElapsedMs = totalElapsed / runs.length;
  const fastestElapsedMs = Math.min(...elapsedValues);
  const slowestElapsedMs = Math.max(...elapsedValues);
  const sample = runs[0];
  if (!sample) {
    throw new Error("Cannot summarize empty benchmark run set");
  }
  return {
    averageElapsedMs,
    fastestElapsedMs,
    slowestElapsedMs,
    filesIndexed: sample.filesIndexed,
    filesPerSecond:
      averageElapsedMs > 0 ? (sample.filesIndexed / averageElapsedMs) * 1000 : 0,
    measurementKind: sample.measurementKind,
    backend: sample.backend,
    warmupBackend: sample.warmupBackend,
  };
}

function formatSummary(results) {
  const lines = [
    "Fixture      Workload Temp  Mode    Measure Avg ms  Fastest  Slowest  Files  Files/s  Native used/fallback",
  ];
  for (const result of results) {
    for (const workload of Object.keys(result.workloads)) {
      const workloadResult = result.workloads[workload];
      if (!workloadResult) continue;
      for (const temperature of Object.keys(workloadResult)) {
        const temperatureResult = workloadResult[temperature];
        if (!temperatureResult) continue;
        for (const mode of ["native", "js"]) {
          const summary = temperatureResult[mode];
          if (!summary) continue;
          const backend = summary.backend;
          const backendSummary = backend
            ? `${backend.filesUsed}/${backend.filesFellBack}`
            : "n/a";
          lines.push(
            [
              result.fixture.padEnd(12),
              workload.padEnd(8),
              temperature.padEnd(5),
              mode.padEnd(7),
              summary.measurementKind.padEnd(7),
              String(Math.round(summary.averageElapsedMs)).padStart(6),
              String(Math.round(summary.fastestElapsedMs)).padStart(8),
              String(Math.round(summary.slowestElapsedMs)).padStart(8),
              String(summary.filesIndexed).padStart(6),
              String(summary.filesPerSecond.toFixed(1)).padStart(8),
              backendSummary.padStart(20),
            ].join(" "),
          );
        }
      }
    }
  }
  return lines.join("\n");
}

function benchmarkCacheDir(fixture, workload, temperature, mode) {
  return path.join(
    os.tmpdir(),
    "codegraph-native-bench",
    fixture,
    workload,
    temperature,
    mode,
  );
}

async function runParentBenchmark(options) {
  if (!fs.existsSync(distEntry)) {
    throw new Error("dist/index.js not found. Run 'npm run build' before benchmarking.");
  }
  assertFixtureNames(options.fixtures);

  const results = [];
  for (const fixture of options.fixtures) {
    const fixtureResult = { fixture, workloads: {} };
    for (const workload of options.workloads) {
      fixtureResult.workloads[workload] = {};
      for (const temperature of options.temperatures) {
        fixtureResult.workloads[workload][temperature] = {};
        for (const mode of ["native", "js"]) {
          const runs = [];
          for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
            runs.push(await runChildBenchmark(fixture, workload, temperature, mode));
          }
          fixtureResult.workloads[workload][temperature][mode] = summarizeRuns(runs);
        }
      }
    }
    results.push(fixtureResult);
  }

  if (options.maxSlowdown > 0) {
    for (const result of results) {
      for (const workload of Object.keys(result.workloads)) {
        for (const temperature of Object.keys(result.workloads[workload] ?? {})) {
          const nativeSummary = result.workloads[workload]?.[temperature]?.native;
          const jsSummary = result.workloads[workload]?.[temperature]?.js;
          if (!nativeSummary || !jsSummary) continue;
          if (nativeSummary.filesIndexed !== jsSummary.filesIndexed) {
            throw new Error(
              `Benchmark mismatch for ${result.fixture}/${workload}/${temperature}: native indexed ${nativeSummary.filesIndexed} files but JS indexed ${jsSummary.filesIndexed}`,
            );
          }
          if (jsSummary.averageElapsedMs <= 0) {
            continue;
          }
          const slowdown = nativeSummary.averageElapsedMs / jsSummary.averageElapsedMs;
          if (slowdown > options.maxSlowdown) {
            throw new Error(
              `Benchmark slowdown for ${result.fixture}/${workload}/${temperature}: native ${nativeSummary.averageElapsedMs.toFixed(2)}ms vs JS ${jsSummary.averageElapsedMs.toFixed(2)}ms exceeds max slowdown ${options.maxSlowdown}x`,
            );
          }
        }
      }
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ runs: options.runs, results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatSummary(results)}\n`);
}

async function runSingleBenchmarkChild(options) {
  const fixtureRoot = FIXTURE_ROOTS[options.fixture];
  if (!fixtureRoot) {
    throw new Error(`Unknown fixture '${options.fixture}'`);
  }
  if (!fs.existsSync(distEntry)) {
    throw new Error("dist/index.js not found. Run 'npm run build' before benchmarking.");
  }

  const { buildProjectIndex, collectGraph, listProjectFiles } = await import(
    pathToFileURL(distEntry).href
  );
  const report = { timings: {} };
  let warmupBackend = null;
  const workload = options.workloads[0];
  const temperature = options.temperatures[0];
  const cacheDir = benchmarkCacheDir(
    options.fixture,
    workload,
    temperature,
    options.mode,
  );
  if (temperature === "cold") {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } else {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const start = performance.now();
  let filesIndexed = 0;
  if (workload === "graph") {
    const files = await listProjectFiles(fixtureRoot);
    const graph = await collectGraph(fixtureRoot, files, {});
    filesIndexed = graph.nodes.size;
  } else {
    if (temperature === "warm") {
      const warmupReport = { timings: {} };
      await buildProjectIndex(fixtureRoot, {
        cache: "disk",
        cacheDir,
        report: warmupReport,
      });
      warmupBackend = warmupReport.backend?.native ?? null;
    }
    const index = await buildProjectIndex(fixtureRoot, {
      cache: "disk",
      cacheDir,
      report,
    });
    filesIndexed = index.byFile.size;
  }
  const elapsedMs = performance.now() - start;
  const payload = {
    fixture: options.fixture,
    workload,
    temperature,
    mode: options.mode,
    elapsedMs,
    filesIndexed,
    measurementKind: workload === "full" && temperature === "warm" ? "cached" : "direct",
    backend: report.backend?.native ?? null,
    warmupBackend,
  };
  process.stdout.write(JSON.stringify(payload));
}

const options = parseArgs(process.argv.slice(2));
if (options.child) {
  runSingleBenchmarkChild(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  runParentBenchmark(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
