import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(rootDir, "dist", "index.js");
const baselinesDir = path.join(rootDir, ".bench-baselines");

const FIXTURE_ROOTS = {
  typescript: path.join(rootDir, "tests", "samples", "typescript"),
  python: path.join(rootDir, "tests", "samples", "python"),
  go: path.join(rootDir, "tests", "samples", "go"),
  rust: path.join(rootDir, "tests", "samples", "rust"),
  mixed: path.join(rootDir, "tests", "samples"),
  repo: rootDir,
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
    saveBaseline: "",
    compareBaseline: "",
    includeWorkers: false,
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
    if (arg === "--workers") {
      options.includeWorkers = true;
      continue;
    }
    if (arg.startsWith("--temperatures=")) {
      options.temperatures = arg
        .slice("--temperatures=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length);
      continue;
    }
    if (arg === "--temperatures") {
      options.temperatures = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length);
      index += 1;
      continue;
    }
    if (arg.startsWith("--workloads=")) {
      options.workloads = arg
        .slice("--workloads=".length)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length);
      continue;
    }
    if (arg === "--workloads") {
      options.workloads = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length);
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
        .filter((value) => value.length);
      continue;
    }
    if (arg === "--fixtures") {
      options.fixtures = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length);
      index += 1;
      continue;
    }
    if (arg.startsWith("--save-baseline=")) {
      options.saveBaseline = arg.slice("--save-baseline=".length).trim();
      continue;
    }
    if (arg === "--save-baseline") {
      options.saveBaseline = (argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--compare-baseline=")) {
      options.compareBaseline = arg.slice("--compare-baseline=".length).trim();
      continue;
    }
    if (arg === "--compare-baseline") {
      options.compareBaseline = (argv[index + 1] ?? "").trim();
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
      throw new Error(`Unknown temperature '${temperature}'. Expected one of: cold, warm`);
    }
  }

  return options;
}

function assertFixtureNames(fixtures) {
  for (const fixture of fixtures) {
    if (!(fixture in FIXTURE_ROOTS)) {
      throw new Error(`Unknown fixture '${fixture}'. Expected one of: ${Object.keys(FIXTURE_ROOTS).join(", ")}`);
    }
  }
}

/**
 * Retry-aware rmSync for Windows: sqlite WAL/SHM files and temp-cache
 * directories can briefly hold file handles after db.close().
 * Retries up to 3 times with a short delay on EBUSY/EPERM/EACCES.
 */
function robustRmSync(dir, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      const isRetryable = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (!isRetryable || attempt === retries) {
        throw error;
      }
      // Synchronous delay — acceptable here since bench is not latency-critical
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // spin
      }
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
          CODEGRAPH_USE_WORKERS: mode === "workers" ? "1" : "0",
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
    graphNodeCount: sample.graphNodeCount,
    filesPerSecond: averageElapsedMs > 0 ? (sample.filesIndexed / averageElapsedMs) * 1000 : 0,
    measurementKind: sample.measurementKind,
    backend: sample.backend,
    warmupBackend: sample.warmupBackend,
  };
}

function formatSpeedup(nativeMs, jsMs) {
  if (jsMs <= 0 || nativeMs <= 0) return "n/a";
  const ratio = nativeMs / jsMs;
  if (ratio < 1) {
    return `${(1 / ratio).toFixed(2)}x faster`;
  }
  return `${ratio.toFixed(2)}x slower`;
}

function formatSummary(results, { includeWorkers = false } = {}) {
  const modes = includeWorkers ? ["native", "js", "workers"] : ["native", "js"];
  const header = includeWorkers
    ? "Fixture      Workload Temp  Mode    Measure Avg ms  Fastest  Slowest  Files  Nodes   Files/s  Native used/fb  vs JS          vs Native"
    : "Fixture      Workload Temp  Mode    Measure Avg ms  Fastest  Slowest  Files  Nodes   Files/s  Native used/fb  vs JS";
  const lines = ["", header, "-".repeat(header.length)];
  for (const result of results) {
    for (const workload of Object.keys(result.workloads)) {
      const workloadResult = result.workloads[workload];
      if (!workloadResult) continue;
      for (const temperature of Object.keys(workloadResult)) {
        const temperatureResult = workloadResult[temperature];
        if (!temperatureResult) continue;
        const jsSummary = temperatureResult.js;
        const nativeSummary = temperatureResult.native;
        for (const mode of modes) {
          const summary = temperatureResult[mode];
          if (!summary) continue;
          const backend = summary.backend;
          const backendSummary = backend ? `${backend.filesUsed}/${backend.filesFellBack}` : "n/a";
          const vsJs =
            mode !== "js" && jsSummary ? formatSpeedup(summary.averageElapsedMs, jsSummary.averageElapsedMs) : "";
          const cols = [
            result.fixture.padEnd(12),
            workload.padEnd(8),
            temperature.padEnd(5),
            mode.padEnd(7),
            summary.measurementKind.padEnd(7),
            String(Math.round(summary.averageElapsedMs)).padStart(6),
            String(Math.round(summary.fastestElapsedMs)).padStart(8),
            String(Math.round(summary.slowestElapsedMs)).padStart(8),
            String(summary.filesIndexed).padStart(6),
            String(summary.graphNodeCount ?? summary.filesIndexed).padStart(6),
            String(summary.filesPerSecond.toFixed(1)).padStart(8),
            backendSummary.padStart(15),
            vsJs.padStart(14),
          ];
          if (includeWorkers) {
            const vsNative =
              mode === "workers" && nativeSummary
                ? formatSpeedup(summary.averageElapsedMs, nativeSummary.averageElapsedMs)
                : "";
            cols.push(vsNative.padStart(14));
          }
          lines.push(cols.join(" "));
        }
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatBaselineComparison(current, baseline) {
  const lines = [
    "",
    `Comparing against baseline: ${baseline._meta?.name ?? "unknown"}`,
    `  Baseline date: ${baseline._meta?.date ?? "unknown"}`,
    `  Baseline runs: ${baseline._meta?.runs ?? "?"}`,
    "",
    "Fixture      Workload Temp  Mode      Current    Baseline     Delta",
    "-".repeat(80),
  ];

  const baselineByKey = new Map();
  for (const result of baseline.results ?? []) {
    for (const workload of Object.keys(result.workloads ?? {})) {
      for (const temperature of Object.keys(result.workloads[workload] ?? {})) {
        for (const mode of ["native", "js", "workers"]) {
          const summary = result.workloads[workload]?.[temperature]?.[mode];
          if (!summary) continue;
          baselineByKey.set(`${result.fixture}/${workload}/${temperature}/${mode}`, summary);
        }
      }
    }
  }

  for (const result of current) {
    for (const workload of Object.keys(result.workloads)) {
      for (const temperature of Object.keys(result.workloads[workload] ?? {})) {
        for (const mode of ["native", "js", "workers"]) {
          const summary = result.workloads[workload]?.[temperature]?.[mode];
          if (!summary) continue;
          const key = `${result.fixture}/${workload}/${temperature}/${mode}`;
          const base = baselineByKey.get(key);
          const currentMs = Math.round(summary.averageElapsedMs);
          if (!base) {
            lines.push(
              [
                result.fixture.padEnd(12),
                workload.padEnd(8),
                temperature.padEnd(5),
                mode.padEnd(7),
                `${currentMs}ms`.padStart(10),
                "---".padStart(11),
                "(no baseline)".padStart(12),
              ].join(" "),
            );
            continue;
          }
          const baseMs = Math.round(base.averageElapsedMs);
          const deltaMs = currentMs - baseMs;
          const deltaPct = baseMs > 0 ? ((deltaMs / baseMs) * 100).toFixed(1) : "n/a";
          const sign = deltaMs > 0 ? "+" : "";
          const indicator = deltaMs < 0 ? " (improved)" : deltaMs > 0 ? " (regressed)" : "";
          lines.push(
            [
              result.fixture.padEnd(12),
              workload.padEnd(8),
              temperature.padEnd(5),
              mode.padEnd(7),
              `${currentMs}ms`.padStart(10),
              `${baseMs}ms`.padStart(11),
              `${sign}${deltaMs}ms (${sign}${deltaPct}%)${indicator}`.padStart(12),
            ].join(" "),
          );
        }
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function saveBaseline(name, runs, results) {
  fs.mkdirSync(baselinesDir, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(baselinesDir, `${safeName}.json`);
  const payload = {
    _meta: {
      name,
      date: new Date().toISOString(),
      runs,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    results,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

function loadBaseline(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(baselinesDir, `${safeName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Baseline '${name}' not found at ${filePath}. Save one first with --save-baseline=${name}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Build a process-isolated cache directory. Uses a short random suffix
 * so concurrent benchmark runs on the same machine never collide.
 */
function benchmarkCacheDir(fixture, workload, temperature, mode) {
  return path.join(os.tmpdir(), `codegraph-bench-${process.pid}`, fixture, workload, temperature, mode);
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
        const modes = options.includeWorkers ? ["native", "js", "workers"] : ["native", "js"];
        for (const mode of modes) {
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

  if (options.saveBaseline) {
    const filePath = saveBaseline(options.saveBaseline, options.runs, results);
    process.stderr.write(`Baseline saved: ${filePath}\n`);
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          runs: options.runs,
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          results,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${formatSummary(results, { includeWorkers: options.includeWorkers })}\n`);

  if (options.compareBaseline) {
    const baseline = loadBaseline(options.compareBaseline);
    process.stdout.write(`${formatBaselineComparison(results, baseline)}\n`);
  }
}

async function runSingleBenchmarkChild(options) {
  const fixtureRoot = FIXTURE_ROOTS[options.fixture];
  if (!fixtureRoot) {
    throw new Error(`Unknown fixture '${options.fixture}'`);
  }
  if (!fs.existsSync(distEntry)) {
    throw new Error("dist/index.js not found. Run 'npm run build' before benchmarking.");
  }

  const { buildProjectIndex, collectGraph, listProjectFiles } = await import(pathToFileURL(distEntry).href);
  const report = { timings: {} };
  let warmupBackend = null;
  const workload = options.workloads[0];
  const temperature = options.temperatures[0];
  const cacheDir = benchmarkCacheDir(options.fixture, workload, temperature, options.mode);
  if (temperature === "cold") {
    robustRmSync(cacheDir);
  } else {
    robustRmSync(cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const useWorkers = process.env.CODEGRAPH_USE_WORKERS === "1";
  const workerOpts = useWorkers ? { useNativeWorkers: true } : {};
  const start = performance.now();
  let filesIndexed = 0;
  let graphNodeCount = 0;
  if (workload === "graph") {
    const files = await listProjectFiles(fixtureRoot);
    const graph = await collectGraph(fixtureRoot, files, { report });
    filesIndexed = files.length;
    graphNodeCount = graph.nodes.size;
  } else {
    if (temperature === "warm") {
      const warmupReport = { timings: {} };
      await buildProjectIndex(fixtureRoot, {
        cache: "disk",
        cacheDir,
        report: warmupReport,
        ...workerOpts,
      });
      warmupBackend = warmupReport.backend?.native ?? null;
    }
    const index = await buildProjectIndex(fixtureRoot, {
      cache: "disk",
      cacheDir,
      report,
      ...workerOpts,
    });
    filesIndexed = index.byFile.size;
    graphNodeCount = index.graph.nodes.size;
  }
  const elapsedMs = performance.now() - start;
  const payload = {
    fixture: options.fixture,
    workload,
    temperature,
    mode: options.mode,
    elapsedMs,
    filesIndexed,
    graphNodeCount,
    measurementKind: workload === "full" && temperature === "warm" ? "cached" : "direct",
    backend: report.backend?.native ?? null,
    warmupBackend,
  };
  process.stdout.write(JSON.stringify(payload));
}

const options = parseArgs(process.argv.slice(2));
if (options.child) {
  runSingleBenchmarkChild(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  runParentBenchmark(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
