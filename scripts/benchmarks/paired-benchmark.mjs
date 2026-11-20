// Adapted from the paired, interleaved accuracy-batch benchmark.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePairedSamples } from "./paired-statistics.mjs";
import {
  assertSameWorkload,
  createPairedPlan,
  DEFAULT_PAIRED_ROUNDS,
  formatCheckoutProvenance,
  pairedExitCode,
  pairedRunOrder,
  readCheckoutProvenance,
  resolveCorpusPins,
} from "./paired-benchmark-lib.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const operations = ["init", "cold", "nochange", "onefile", "graph", "search", "refs", "goto"];
const measure = path.join(directory, "measure-operation.mjs");
const args = process.argv.slice(2);
const [baseArgument, headArgument] = args.splice(0, 2);
const options = {
  rounds: DEFAULT_PAIRED_ROUNDS,
  threads: 1,
  nativeThreads: 1,
  corpusDir: "",
  corpusMap: "",
  families: "",
  output: path.resolve("paired-benchmark.json"),
  profileDir: "",
  profileOnly: false,
};
const optionKeys = {
  "--rounds": "rounds",
  "--threads": "threads",
  "--native-threads": "nativeThreads",
  "--corpus-dir": "corpusDir",
  "--corpus-map": "corpusMap",
  "--families": "families",
  "--output": "output",
  "--profile-dir": "profileDir",
};
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--profile-only") {
    options.profileOnly = true;
    continue;
  }
  const key = optionKeys[args[index]];
  if (!key || !args[index + 1]) throw new Error(`Unknown or missing option: ${args[index]}`);
  options[key] = args[++index];
}
const missingCheckouts = !baseArgument || !headArgument;
const missingCorpus = !options.corpusDir && !options.corpusMap;
if (missingCheckouts || missingCorpus) {
  throw new Error(
    "Usage: paired-benchmark.mjs <base> <head> --corpus-dir <directory> [--families <list>] [--rounds 6] [--output <json>] [--profile-dir <directory>] [--profile-only]",
  );
}
for (const key of ["rounds", "threads", "nativeThreads"]) {
  options[key] = Number(options[key]);
  if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer.`);
}
if (options.rounds < 5) throw new Error("At least five paired rounds are required.");
if (options.profileOnly && !options.profileDir) throw new Error("--profile-only requires --profile-dir.");
const versions = { base: path.resolve(baseArgument), head: path.resolve(headArgument) };
for (const checkout of Object.values(versions)) {
  for (const relative of ["dist/index.js", "dist/worker/native-extract-worker.js"]) {
    if (!fs.existsSync(path.join(checkout, relative)))
      throw new Error(`Build the checkout first: ${checkout}/${relative}`);
  }
}
const corpusManifest = JSON.parse(fs.readFileSync(path.join(directory, "corpus.json"), "utf8"));
const accuracy = JSON.parse(fs.readFileSync(path.join(directory, "..", "accuracy", "corpus.json"), "utf8"));
const manifest = resolveCorpusPins(corpusManifest, accuracy);
const corpusPaths = options.corpusMap ? JSON.parse(fs.readFileSync(options.corpusMap, "utf8")) : {};
const selectedFamilies = options.families ? options.families.split(",") : manifest.map((corpus) => corpus.family);
for (const family of selectedFamilies) {
  if (!manifest.some((corpus) => corpus.family === family)) throw new Error(`Unknown family ${family}.`);
}
const corpora = manifest.filter((corpus) => selectedFamilies.includes(corpus.family));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-paired-"));

function git(root, ...arguments_) {
  return execFileSync("git", ["-C", root, ...arguments_], { encoding: "utf8", windowsHide: true }).trim();
}

function run(checkout, root, operation, planPath, profilePath = "") {
  const corpus = path.basename(path.dirname(path.dirname(root)));
  console.error(`[benchmark] ${corpus}/${path.basename(path.dirname(root))}: ${operation}`);
  const cacheDir = path.join(path.dirname(root), "cache");
  const out = execFileSync(
    process.execPath,
    ["--expose-gc", measure, checkout, root, operation, cacheDir, planPath, profilePath],
    { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

// Local clones retain Git discovery/status behavior without copying untracked files or changing the source.
function copyCorpus(source, target, corpus) {
  const revision = git(source, "rev-parse", "HEAD");
  if (revision !== corpus.commit) throw new Error(`${corpus.id}: expected ${corpus.commit}, found ${revision}.`);
  execFileSync("git", ["-C", source, "diff", "--quiet", "HEAD", "--"], { windowsHide: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("git", ["clone", "--shared", "--quiet", source, target], { windowsHide: true });
}

const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    npm: execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
    }).trim(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.availableParallelism(),
    totalMemory: os.totalmem(),
  },
  versions: Object.fromEntries(
    Object.entries(versions).map(([name, root]) => [
      name,
      {
        root,
        ...readCheckoutProvenance(root),
      },
    ]),
  ),
  settings: {
    mode: options.profileOnly ? "profile-only" : "paired",
    rounds: options.profileOnly ? 0 : options.rounds,
    threads: options.threads,
    nativeThreads: options.nativeThreads,
  },
  corpora: {},
};
for (const [label, provenance] of Object.entries(report.versions)) {
  console.log(formatCheckoutProvenance(label, provenance));
}

try {
  for (const corpus of corpora) {
    const roots = {};
    const plans = {};
    const activeVersions = options.profileOnly ? ["base"] : Object.keys(versions);
    for (const version of activeVersions) {
      roots[version] = path.join(work, corpus.id, version, "project");
      plans[version] = path.join(work, corpus.id, version, "plan.json");
      const source =
        corpusPaths[corpus.id] ?? path.join(path.resolve(options.corpusDir), corpus.directory ?? corpus.id);
      copyCorpus(source, roots[version], corpus);
    }
    const plan = createPairedPlan(corpus, options);
    fs.writeFileSync(plans.base, JSON.stringify(plan));
    Object.assign(plan, run(versions.base, roots.base, "prepare", plans.base));
    delete plan.memory;
    delete plan.op;
    for (const version of activeVersions) {
      fs.writeFileSync(plans[version], JSON.stringify(plan));
      run(versions[version], roots[version], "nochange", plans[version]);
    }
    const samples = Object.fromEntries(operations.map((operation) => [operation, { base: [], head: [] }]));
    const measuredRounds = options.profileOnly ? 0 : options.rounds;
    for (let round = 0; round < measuredRounds; round += 1) {
      const order = pairedRunOrder(round);
      for (const operation of operations) {
        for (const version of order) {
          const result = run(versions[version], roots[version], operation, plans[version]);
          samples[operation][version].push(result);
        }
        assertSameWorkload(operation, samples[operation].base[round], samples[operation].head[round]);
      }
    }
    const rows = {};
    for (const operation of options.profileOnly ? [] : operations) {
      const pair = samples[operation];
      rows[operation] = {
        ...comparePairedSamples(
          pair.base.map((sample) => sample.ms),
          pair.head.map((sample) => sample.ms),
        ),
        samples: pair,
      };
      const row = rows[operation];
      console.log(
        `${corpus.family} ${operation}: base ${row.base.medianMs.toFixed(1)} ms, head ${row.head.medianMs.toFixed(1)} ms, paired delta ${row.slowerPercent.toFixed(1)}%, spread base/head ${row.base.spreadPercent.toFixed(1)}/${row.head.spreadPercent.toFixed(1)}%, paired noise ${row.noisePercent.toFixed(1)}%, head slower ${row.roundsHeadSlower}/${row.rounds}, ${row.verdict.toUpperCase()}`,
      );
    }
    report.corpora[corpus.id] = {
      ...corpus,
      files: plan.files,
      touch: plan.touch,
      sites: plan.sites,
      gotoSites: plan.gotoSites,
      queries: plan.queries,
      rows,
    };
    // Profiling is a separate, unpaired run and never contributes to the wall-clock verdict.
    if (options.profileDir) {
      const profiles = {};
      for (const operation of operations) {
        const profile = path.resolve(options.profileDir, corpus.id, `${operation}.cpuprofile`);
        profiles[operation] = run(versions.base, roots.base, operation, plans.base, profile);
      }
      report.corpora[corpus.id].profiles = profiles;
    }
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = pairedExitCode(report.corpora);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
