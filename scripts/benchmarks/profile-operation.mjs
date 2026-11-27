// Profile one Codegraph operation in a fresh process. Records process CPU time (all threads), wall time, filesystem and
// child-process call counts, memory, and optionally a main-isolate V8 CPU profile, precise call counts, or a sampling
// heap profile. Setup outside the measured phases (imports, warm loads, plan preparation) is not measured.
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const USAGE = `Usage: node scripts/benchmarks/profile-operation.mjs --checkout <codegraph checkout> --root <project>
  --op <operation> --out <output prefix> [--plan <plan.json>] [--cache-dir <dir>] [--workers on|off|auto]
  [--threads N] [--native-threads N] [--profile none|cpu|coverage|heap|retained] [--interval-us N]
  [--profile-phase <phase>] [--rss-sampler] [--per-call]

Edit operations toggle a comment line in the plan's touch file, and init writes <root>/.codegraph: run them on a
disposable local clone. --threads defaults to 2; --threads 0 leaves build concurrency at its default, which an
explicit value caps (files in flight = threads, whatever the native pool size).

Operations:
  prepare            build with the disk cache (warming it) and write the query plan to --plan
  cold               buildProjectIndex with cache "off"
  init               initCodegraphLifecycle with an empty lifecycle directory and cache
  load               the disk-backed session index load that one-shot CLI queries perform first
  nochange-disk      buildProjectIndexIncremental with a warm disk cache (fresh process)
  onefile-disk       the same after toggling one comment line in the plan's touch file
  nochange-memory    a second buildProjectIndexIncremental with cache "memory" in the same process
  onefile-memory     the same after toggling the touch file between the two builds
  sync-nochange      syncCodegraphLifecycle after init, no edit
  sync-onefile       syncCodegraphLifecycle after toggling the touch file
  freshness          agent session freshness scans with no edit (the per-call check of an MCP session)
  refresh            MCP warm refresh: loaded session, one edit, then refresh and the first tool calls after it
  graph-basic        buildSymbolGraph on a disk-backed index
  graph-detailed     buildSymbolGraphDetailed on a disk-backed index
  query-index        cold search sidecar build, then a warm open
  query-index-split  the sidecar build's worker preparation and insert transaction measured apart
  goto refs families rename search wsymbols explore orient filedeps
                     query batches from the plan on a warm session
  session            long-lived session: detailed graph, query index, every query batch, then retained memory

Worker threads: add --import scripts/benchmarks/worker-cpu-profile.mjs with WORKER_PROFILE_DIR set to profile them.`;

const COMMENT_BY_EXTENSION = new Map([
  ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".cs", ".java", ".kt", ".go", ".rs", ".swift"].map(
    (extension) => [extension, "//"],
  ),
  ...[".c", ".cc", ".cpp", ".h", ".hpp", ".php", ".scss", ".zig", ".dart"].map((extension) => [extension, "//"]),
  ...[".py", ".rb"].map((extension) => [extension, "#"]),
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.\n${USAGE}`);
    const equals = arg.indexOf("=");
    if (equals > 0) {
      args[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[arg.slice(2)] = true;
    } else {
      args[arg.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.checkout || !args.root || !args.op || !args.out) {
  console.error(USAGE);
  process.exit(args.help ? 0 : 2);
}
const profileMode = args.profile ?? "none";

// Precise call counts need unoptimized code: optimized and inlined functions stop counting invocations.
const requiredFlags = ["--expose-gc", ...(profileMode === "coverage" ? ["--no-opt", "--no-maglev"] : [])];
const missingFlags = requiredFlags.filter((flag) => !process.execArgv.includes(flag));
if (missingFlags.length) {
  const child = childProcess.spawnSync(
    process.execPath,
    [...process.execArgv, ...missingFlags, ...process.argv.slice(1)],
    { stdio: "inherit", windowsHide: true },
  );
  process.exit(child.status ?? 1);
}

// Filesystem and child-process counters, installed before the library loads so named imports see the wrappers.
const fsCounts = new Map();
const childCounts = new Map();
let counting = false;
const bump = (counts, key) => {
  if (counting) counts.set(key, (counts.get(key) ?? 0) + 1);
};

function wrap(owner, name, counts, keyOf) {
  const original = owner[name];
  if (typeof original !== "function") return;
  const wrapped = function (...callArgs) {
    bump(counts, keyOf(callArgs));
    return Reflect.apply(original, this, callArgs);
  };
  for (const key of Object.keys(original)) wrapped[key] = original[key];
  const custom = original[promisify.custom];
  if (typeof custom === "function") {
    wrapped[promisify.custom] = function (...callArgs) {
      bump(counts, keyOf(callArgs));
      return Reflect.apply(custom, this, callArgs);
    };
  }
  owner[name] = wrapped;
}

const FS_SYNC = ["readFileSync", "statSync", "lstatSync", "realpathSync", "readdirSync", "existsSync", "accessSync"];
const FS_SYNC_WRITE = ["openSync", "writeFileSync", "renameSync", "mkdirSync", "rmSync", "opendirSync"];
const FS_CALLBACK = ["readFile", "stat", "lstat", "realpath", "readdir", "access", "open", "writeFile", "rename"];
const FS_PROMISES = ["readFile", "stat", "lstat", "realpath", "readdir", "access", "open", "writeFile", "rename"];
for (const name of [...FS_SYNC, ...FS_SYNC_WRITE, ...FS_CALLBACK]) wrap(fs, name, fsCounts, () => name);
wrap(fs.realpathSync, "native", fsCounts, () => "realpathSync.native");
wrap(fs.realpath, "native", fsCounts, () => "realpath.native");
for (const name of [...FS_PROMISES, "opendir", "mkdir", "rm"]) wrap(fsp, name, fsCounts, () => `promises.${name}`);

function childKey(callArgs) {
  const [command, commandArgs] = callArgs;
  const tokens = Array.isArray(commandArgs) ? commandArgs : String(command).split(/\s+/).slice(1);
  const base = path.basename(String(command).split(/\s+/)[0]).replace(/\.exe$/i, "");
  let subcommand = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    if (token === "-C" || token === "-c") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    subcommand = token;
    break;
  }
  return subcommand ? `${base} ${subcommand}` : base;
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  wrap(childProcess, name, childCounts, childKey);
}
syncBuiltinESMExports();

const checkout = path.resolve(args.checkout);
const root = path.resolve(args.root);
const out = path.resolve(args.out);
const planPath = args.plan ? path.resolve(args.plan) : `${out}.plan.json`;
const cacheDir = path.resolve(args["cache-dir"] ?? path.join(path.dirname(out), "cache"));
const load = (relative) => import(pathToFileURL(path.join(checkout, "dist", relative)).href);
const api = await load("index.js");

const buildOptions = { logLevel: "silent", threads: Number(args.threads ?? 2) };
if (args.workers === "on") buildOptions.useNativeWorkers = true;
if (args.workers === "off") buildOptions.useNativeWorkers = false;
if (args["native-threads"]) buildOptions.nativeThreads = Number(args["native-threads"]);
const disk = { ...buildOptions, cache: "disk", cacheDir };

// With --rss-sampler, a worker thread samples process RSS every 50 ms, including while the main thread is blocked in
// synchronous native work, so each phase reports the RSS peak inside its own window.
const RSS_SAMPLE_CAPACITY = 200_000;
const rssSamples = args["rss-sampler"] ? new Float64Array(new SharedArrayBuffer(16 * RSS_SAMPLE_CAPACITY)) : undefined;
if (rssSamples) {
  const sampler = new Worker(
    `const { workerData } = require("node:worker_threads");
    const samples = new Float64Array(workerData.buffer);
    let next = 0;
    setInterval(() => {
      if (next >= samples.length / 2) return;
      samples[2 * next] = Date.now();
      samples[2 * next + 1] = process.memoryUsage.rss();
      next += 1;
    }, 50);`,
    { eval: true, workerData: { buffer: rssSamples.buffer } },
  );
  sampler.unref();
}

function rssPeakBetween(startMs, endMs) {
  if (!rssSamples) return undefined;
  let peak = 0;
  for (let index = 0; index < rssSamples.length; index += 2) {
    const at = rssSamples[index];
    if (!at) break;
    if (at >= startMs && at <= endMs) peak = Math.max(peak, rssSamples[index + 1]);
  }
  return round(peak / 2 ** 20);
}

// Profiling spans every measured phase; phases record their own CPU, wall time, and counters.
const inspector = new Session();
inspector.connect();
let profileStarted = false;
const phases = [];

async function startProfile() {
  if (profileStarted || profileMode === "none") return;
  profileStarted = true;
  if (profileMode === "cpu") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: Number(args["interval-us"] ?? 500) });
    await inspector.post("Profiler.start");
  } else if (profileMode === "coverage") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    await inspector.post("Profiler.takePreciseCoverage");
  } else if (profileMode === "heap" || profileMode === "retained") {
    await inspector.post("HeapProfiler.enable");
    const collected = profileMode === "heap";
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: collected,
      includeObjectsCollectedByMinorGC: collected,
    });
  }
}

function summarizeCoverage(coverage) {
  const distRoot = pathToFileURL(path.join(checkout, "dist")).href;
  const functions = [];
  for (const script of coverage.result) {
    if (!script.url.startsWith(distRoot)) continue;
    const file = script.url.slice(distRoot.length + 1);
    for (const fn of script.functions) {
      const count = fn.ranges[0]?.count ?? 0;
      if (!count) continue;
      functions.push({ file, name: fn.functionName || "(anonymous)", offset: fn.ranges[0].startOffset, count });
    }
  }
  functions.sort((left, right) => right.count - left.count);
  return { totalCalls: functions.reduce((sum, fn) => sum + fn.count, 0), functions };
}

async function stopProfile() {
  if (!profileStarted) return undefined;
  profileStarted = false;
  if (profileMode === "cpu") {
    const { profile } = await inspector.post("Profiler.stop");
    fs.writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
    return `${out}.cpuprofile`;
  }
  if (profileMode === "coverage") {
    const coverage = await inspector.post("Profiler.takePreciseCoverage");
    await inspector.post("Profiler.stopPreciseCoverage");
    fs.writeFileSync(`${out}.coverage.json`, JSON.stringify(summarizeCoverage(coverage)));
    return `${out}.coverage.json`;
  }
  if (profileMode === "retained") global.gc();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  fs.writeFileSync(`${out}.heapprofile`, JSON.stringify(profile));
  return `${out}.heapprofile`;
}

function snapshotCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

// With --profile-phase, only the named phase is profiled; otherwise the profile spans every measured phase.
const profilePhase = args["profile-phase"];
let profileResult;

async function phase(name, fn) {
  const profiled = !profilePhase || profilePhase === name;
  if (profiled) await startProfile();
  fsCounts.clear();
  childCounts.clear();
  counting = true;
  const cpuStart = process.cpuUsage();
  const startedAt = Date.now();
  const start = performance.now();
  let value;
  try {
    value = await fn();
  } finally {
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    counting = false;
    phases.push({
      name,
      wallMs: round(wallMs),
      cpuMs: round((cpu.user + cpu.system) / 1000),
      userMs: round(cpu.user / 1000),
      systemMs: round(cpu.system / 1000),
      fs: snapshotCounts(fsCounts),
      child: snapshotCounts(childCounts),
      peakRssMiBAfter: round(process.resourceUsage().maxRSS / 1024),
      ...(rssSamples ? { windowPeakRssMiB: rssPeakBetween(startedAt, Date.now() + 60) } : {}),
    });
    if (profilePhase === name) profileResult = await stopProfile();
  }
  return value;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function readPlan() {
  return JSON.parse(fs.readFileSync(planPath, "utf8"));
}

function absoluteSite(site) {
  return { ...site, file: path.join(root, site.file) };
}

function relativeFile(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

// Toggle one whole appended comment line, so repeated runs alternate between two contents.
function touchFile(plan) {
  const file = path.join(root, plan.touch.file);
  const text = fs.readFileSync(file, "utf8");
  const marker = `\n${plan.touch.comment} codegraph-profile\n`;
  fs.writeFileSync(file, text.endsWith(marker) ? text.slice(0, -marker.length) : `${text}${marker}`);
}

function evenly(list, count) {
  if (list.length <= count) return [...list];
  const step = list.length / count;
  return Array.from({ length: count }, (_, index) => list[Math.floor(index * step)]);
}

function importerCounts(graph) {
  const counts = new Map();
  for (const edge of graph.edges) {
    if (edge.to.type !== "file" || edge.to.path === edge.from) continue;
    const importers = counts.get(edge.to.path) ?? new Set();
    importers.add(edge.from);
    counts.set(edge.to.path, importers);
  }
  return new Map([...counts.entries()].map(([file, importers]) => [file, importers.size]));
}

const DECLARATION_KINDS = new Set(["function", "method", "class"]);

async function prepare() {
  const index = await api.buildProjectIndex(root, disk);
  const modules = [...index.byFile.values()].sort((left, right) => (left.file < right.file ? -1 : 1));
  const declarationSite = (module, local) => ({
    file: relativeFile(module.file),
    line: local.range.start.line,
    column: local.range.start.column,
    name: local.localName,
  });
  const declarations = [];
  const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
  for (const module of modules) {
    for (const local of module.locals) {
      if (!DECLARATION_KINDS.has(String(local.kind).toLowerCase()) || !identifier.test(local.localName)) continue;
      declarations.push(declarationSite(module, local));
    }
  }
  if (!declarations.length) throw new Error("The project has no callable or class declarations to query.");
  const sampled = evenly(declarations, Number(args.declarations ?? 50));
  // Goto sites come from the use-sites of a wider declaration sample, so small reference families still fill them.
  const uses = [];
  for (const site of evenly(declarations, 3 * Number(args.declarations ?? 50))) {
    const answer = await api.findReferences(index, absoluteSite(site));
    if (answer.status !== "ok") continue;
    for (const reference of answer.references) {
      const start = reference.range.start;
      const declaration = answer.definition.range.start;
      const sameSite =
        reference.file === answer.definition.file &&
        start.line === declaration.line &&
        start.column === declaration.column;
      if (!sameSite) uses.push({ file: relativeFile(reference.file), line: start.line, column: start.column });
    }
  }
  if (!uses.length) throw new Error("The declaration sample has no reference use-sites for goto.");
  // Large reference families: exported declarations of the most-imported files, ranked by their reference count.
  const importers = importerCounts(index.graph);
  const hubs = [...importers.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  const familyCandidates = [];
  // Module map keys are identity keys (case-folded on Windows); graph edges keep the module's own spelling.
  const moduleByFile = new Map(modules.map((module) => [module.file, module]));
  for (const [file] of hubs.slice(0, 10)) {
    const module = moduleByFile.get(file);
    if (!module) continue;
    const siteKey = (def) => `${def.localName}:${def.range.start.line}:${def.range.start.column}`;
    const exported = new Set(
      module.exports.filter((entry) => entry.type === "local").map((entry) => siteKey(entry.target)),
    );
    const locals = module.locals.filter((local) => !local.isMember && exported.has(siteKey(local)));
    for (const local of locals.slice(0, 4)) familyCandidates.push(declarationSite(module, local));
  }
  const families = [];
  for (const site of familyCandidates.slice(0, 30)) {
    const answer = await api.findReferences(index, absoluteSite(site));
    if (answer.status === "ok") families.push({ ...site, references: answer.references.length });
  }
  families.sort((left, right) => right.references - left.references);
  const touchable = modules.filter(
    (module) => COMMENT_BY_EXTENSION.has(path.extname(module.file)) && (importers.get(module.file) ?? 0) > 0,
  );
  const byImporters = touchable.sort(
    (left, right) => importers.get(left.file) - importers.get(right.file) || (left.file < right.file ? -1 : 1),
  );
  const touch = byImporters[Math.floor(byImporters.length / 2)] ?? modules[0];
  const leaves = modules.filter(
    (module) => COMMENT_BY_EXTENSION.has(path.extname(module.file)) && !importers.get(module.file),
  );
  const plan = {
    root,
    files: modules.length,
    touch: {
      file: relativeFile(touch.file),
      comment: COMMENT_BY_EXTENSION.get(path.extname(touch.file)) ?? "//",
      importers: importers.get(touch.file) ?? 0,
    },
    declarations: sampled,
    gotoSites: evenly(uses, Number(args.gotos ?? 200)),
    families: families.slice(0, 5),
    terms: [...new Set(sampled.map((site) => site.name))].slice(0, 25),
    depFiles: [...hubs.slice(0, 5).map(([file]) => file), ...evenly(leaves, 5).map((module) => module.file)].map(
      relativeFile,
    ),
  };
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { files: plan.files, declarations: sampled.length, uses: uses.length, families: plan.families };
}

function buildSummary(report, index) {
  return {
    files: index?.byFile.size,
    workerPool: report?.workerPool,
    cache: report?.cache
      ? Object.fromEntries(Object.entries(report.cache).filter(([, value]) => typeof value !== "object"))
      : undefined,
    timings: report?.timings,
  };
}

function symbolHandle(site) {
  return ["symbol", encodeURIComponent(site.file), encodeURIComponent(site.name), site.line, site.column].join(":");
}

async function createSession(options = {}) {
  const { createAgentSession } = await load("agent/session.js");
  return createAgentSession({ root, buildOptions: disk, ...options });
}

// Per-call timings separate a batch's first, setup-paying call from its steady state.
async function batch(items, run) {
  const calls = [];
  let found = 0;
  let results = 0;
  for (const item of items) {
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const counted = await run(item);
    const cpu = process.cpuUsage(cpuStart);
    calls.push({ wallMs: round(performance.now() - start), cpuMs: round((cpu.user + cpu.system) / 1000) });
    if (counted !== undefined) {
      found += 1;
      results += counted;
    }
  }
  const sortedCpu = calls.map((call) => call.cpuMs).sort((left, right) => left - right);
  return {
    calls: calls.length,
    found,
    results,
    firstCpuMs: calls[0]?.cpuMs,
    medianCpuMs: sortedCpu[Math.floor(sortedCpu.length / 2)],
    maxCpuMs: sortedCpu.at(-1),
    perCall: calls,
  };
}

const queryRunners = {
  goto: async (context) =>
    await batch(context.plan.gotoSites, async (site) => {
      const answer = await api.goToDefinition(context.index, absoluteSite(site));
      return answer.status === "ok" ? 1 : undefined;
    }),
  refs: async (context) =>
    await batch(context.plan.declarations, async (site) => {
      const answer = await api.findReferences(context.index, absoluteSite(site));
      return answer.status === "ok" ? answer.references.length : undefined;
    }),
  families: async (context) =>
    await batch(context.plan.families, async (site) => {
      const answer = await api.findReferences(context.index, absoluteSite(site));
      return answer.status === "ok" ? answer.references.length : undefined;
    }),
  rename: async (context) => {
    const { previewRenameWithSession } = await load("agent/rename-preview.js");
    return await batch([...context.plan.families, ...context.plan.declarations.slice(0, 10)], async (site) => {
      const answer = await previewRenameWithSession(context.session, {
        root,
        handle: symbolHandle(site),
        newName: `${site.name}Renamed`,
      });
      return answer.edits?.length ?? 0;
    });
  },
  search: async (context) => {
    const { searchCodegraphWithSession } = await load("agent/search.js");
    return await batch(context.plan.terms, async (query) => {
      const answer = await searchCodegraphWithSession(context.session, { root, query, mode: "hybrid", limit: 20 });
      return answer.results.length;
    });
  },
  wsymbols: async (context) => {
    const { workspaceSymbolsWithSession } = await load("agent/workspace-symbols.js");
    return await batch(context.plan.terms, async (query) => {
      const answer = await workspaceSymbolsWithSession(context.session, { root, query, limit: 50 });
      return answer.symbols.length;
    });
  },
  explore: async (context) => {
    const { exploreCodegraphWithSession } = await load("agent/explore.js");
    return await batch(context.plan.terms.slice(0, 10), async (query) => {
      const answer = await exploreCodegraphWithSession(context.session, { root, query, includeSource: false });
      return answer.anchors.length;
    });
  },
  orient: async (context) => {
    const { orientCodegraphWithSession } = await load("agent/orient.js");
    return await batch(["small", "medium"], async (budget) => {
      const answer = await orientCodegraphWithSession(context.session, { root, budget });
      return JSON.stringify(answer).length;
    });
  },
  filedeps: async (context) => {
    const snapshot = await context.session.loadProject({ symbolGraph: "skip" });
    return await batch(context.plan.depFiles, async (file) => {
      const target = path.join(root, file);
      const forward = api.getDependencies(snapshot.fileGraph, target, { limit: 51 });
      const reverse = api.getReverseDependencies(snapshot.fileGraph, target, { limit: 51 });
      return forward.length + reverse.length;
    });
  },
};

// What each query batch loads before it is measured, as the MCP tool loads it.
async function prepareQueryContext(op, plan) {
  const context = { plan };
  if (op === "goto" || op === "refs" || op === "families") {
    context.index = await api.buildProjectIndex(root, disk);
    return context;
  }
  context.session = await createSession({ freshness: { policy: "manual" } });
  if (op === "rename") {
    await context.session.loadProject();
  } else if (op === "search") {
    const snapshot = await context.session.loadProject({ symbolGraph: "basic" });
    const { ensureSessionQueryIndex } = await load("agent/query-index/session-store.js");
    await ensureSessionQueryIndex(context.session, snapshot);
  } else {
    await context.session.loadProject({ symbolGraph: "skip" });
  }
  return context;
}

async function mcpRefresh(plan) {
  const session = await createSession({ freshness: { policy: "auto" } });
  const { createCodegraphMcpHandlers } = await load("mcp/handlers.js");
  const handlers = createCodegraphMcpHandlers({ root, session });
  const term = plan.terms[0];
  const site = plan.gotoSites[0];
  const declaration = plan.declarations[0];
  const queries = async (label) => {
    await phase(`${label}:search`, () => handlers.search({ query: term, mode: "hybrid", limit: 20 }));
    await phase(`${label}:goto`, () => handlers.goto(site));
    await phase(`${label}:refs`, () => handlers.refs(declaration));
    await phase(`${label}:explore`, () => handlers.explore({ query: term }));
    await phase(`${label}:rename_preview`, () =>
      handlers.rename_preview({ handle: symbolHandle(declaration), newName: `${declaration.name}Renamed` }),
    );
  };
  // Warm state, as after startup warmup plus one call of each tool. Not part of the refresh measurement.
  await session.loadProject({ symbolGraph: "basic" });
  const { ensureSessionQueryIndex } = await load("agent/query-index/session-store.js");
  await ensureSessionQueryIndex(session, await session.loadProject({ symbolGraph: "skip" }));
  await handlers.search({ query: term, mode: "hybrid", limit: 20 });
  await handlers.goto(site);
  await handlers.refs(declaration);
  await handlers.explore({ query: term });
  await handlers.rename_preview({ handle: symbolHandle(declaration), newName: `${declaration.name}Renamed` });
  touchFile(plan);
  // What the watcher does after the edit's burst settles: mark, check, and rebuild the index.
  session.markChanged();
  const freshness = await phase("watcher:check", () => session.checkFreshness());
  await phase("watcher:rebuild-index", () => session.loadProject({ symbolGraph: "skip" }));
  await queries("after-edit");
  // Steady state: the same calls once more within the freshness interval.
  await queries("steady");
  return { refreshState: freshness.state, changed: freshness.changedFiles?.length ?? 0 };
}

let workload;
const op = args.op;
if (op === "prepare") {
  workload = await prepare();
} else if (op === "cold") {
  const report = { timings: {} };
  const index = await phase("cold", () => api.buildProjectIndex(root, { ...buildOptions, cache: "off", report }));
  workload = buildSummary(report, index);
} else if (op === "init") {
  const { initCodegraphLifecycle } = await load("lifecycle/manifest.js");
  fs.rmSync(path.join(root, ".codegraph"), { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const result = await phase("init", () => initCodegraphLifecycle(root, { buildOptions: disk }));
  workload = { files: result.manifest.fileCount };
} else if (op === "nochange-disk" || op === "onefile-disk") {
  if (op === "onefile-disk") touchFile(readPlan());
  const report = { timings: {} };
  const index = await phase(op, () => api.buildProjectIndexIncremental(root, { ...disk, report }));
  workload = buildSummary(report, index);
} else if (op === "nochange-memory" || op === "onefile-memory") {
  await api.buildProjectIndexIncremental(root, { ...buildOptions, cache: "memory" });
  if (op === "onefile-memory") touchFile(readPlan());
  const report = { timings: {} };
  const index = await phase(op, () =>
    api.buildProjectIndexIncremental(root, { ...buildOptions, cache: "memory", report }),
  );
  workload = buildSummary(report, index);
} else if (op === "sync-nochange" || op === "sync-onefile") {
  const { syncCodegraphLifecycle } = await load("lifecycle/manifest.js");
  if (op === "sync-onefile") touchFile(readPlan());
  const result = await phase(op, () => syncCodegraphLifecycle(root, { buildOptions: disk }));
  workload = { files: result.manifest.fileCount, changedFiles: result.changedFiles };
} else if (op === "freshness") {
  const session = await createSession({ freshness: { policy: "auto" } });
  await session.loadProject({ symbolGraph: "skip" });
  const states = [];
  for (let round = 0; round < Number(args.rounds ?? 5); round += 1) {
    session.markChanged();
    states.push((await phase(`check-${round}`, () => session.checkFreshness())).state);
  }
  workload = { states };
} else if (op === "refresh") {
  workload = await mcpRefresh(readPlan());
} else if (op === "graph-basic" || op === "graph-detailed") {
  const index = await api.buildProjectIndex(root, disk);
  const build = op === "graph-basic" ? api.buildSymbolGraph : api.buildSymbolGraphDetailed;
  const graph = await phase(op, () => build(index));
  workload = { nodes: graph.nodes.size, edges: graph.edges.length };
} else if (Object.hasOwn(queryRunners, op)) {
  const context = await prepareQueryContext(op, readPlan());
  workload = await phase(op, () => queryRunners[op](context));
  if (!args["per-call"]) delete workload.perCall;
} else if (op === "query-index") {
  // A cold search sidecar build, then the warm open a second session in the same process performs.
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(cacheDir, entry.name))) {
      if (name.startsWith("search-v1")) fs.rmSync(path.join(cacheDir, entry.name, name), { force: true });
    }
  }
  const { ensureSessionQueryIndex } = await load("agent/query-index/session-store.js");
  const session = await createSession({ freshness: { policy: "manual" } });
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  await phase("build", () => ensureSessionQueryIndex(session, snapshot));
  const second = await createSession({ freshness: { policy: "manual" } });
  const secondSnapshot = await second.loadProject({ symbolGraph: "skip" });
  await phase("open", () => ensureSessionQueryIndex(second, secondSnapshot));
  workload = { files: snapshot.files.length };
} else if (op === "load") {
  // The disk-backed index load that every one-shot CLI query performs before its first answer.
  const session = await createSession({ freshness: { policy: "manual" } });
  const snapshot = await phase("load", () => session.loadProject({ symbolGraph: "skip" }));
  workload = { files: snapshot.files.length };
} else if (op === "query-index-split") {
  // The two halves of a cold sidecar build, measured apart: worker preparation of every file, then the single insert
  // transaction into a fresh store (both full-text tables are filled by its triggers).
  const { prepareQueryIndexFiles } = await load("agent/query-index/worker-pool.js");
  const { QueryIndexStore } = await load("agent/query-index/store.js");
  const { expectedQueryIndexVersionMetadata } = await load("agent/query-index/schema.js");
  const session = await createSession({ freshness: { policy: "manual" } });
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  const files = snapshot.files.map((file) => ({ relativePath: relativeFile(file), sourceIdentity: "profile" }));
  const prepared = await phase("prepare", () => prepareQueryIndexFiles(root, files));
  global.gc();
  const heapAfterPrepareMiB = round(process.memoryUsage().heapUsed / 2 ** 20);
  const temporary = path.join(path.dirname(out), `query-index-split-${process.pid}.sqlite`);
  const store = new QueryIndexStore(temporary);
  await phase("insert", () =>
    store.replaceFiles(prepared, [], {
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity: "profile",
      projectRootIdentity: "profile",
      createdByCodegraphVersion: "profile",
      updatedAt: new Date(0).toISOString(),
    }),
  );
  store.close();
  const chunks = prepared.reduce((sum, file) => sum + file.chunks.length, 0);
  const normalizedChars = prepared.reduce((sum, file) => sum + file.normalizedText.length, 0);
  const sidecarMiB = round(fs.statSync(temporary).size / 2 ** 20);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${temporary}${suffix}`, { force: true });
  workload = { files: prepared.length, chunks, normalizedChars, heapAfterPrepareMiB, sidecarMiB };
} else if (op === "session") {
  const plan = readPlan();
  const session = await createSession({ freshness: { policy: "manual" } });
  const context = { plan, session };
  workload = {};
  await phase("load-detailed", () => session.loadProject());
  await phase("query-index", async () => {
    const { ensureSessionQueryIndex } = await load("agent/query-index/session-store.js");
    await ensureSessionQueryIndex(session, await session.loadProject({ symbolGraph: "skip" }));
  });
  context.index = (await session.loadProject({ symbolGraph: "skip" })).index;
  for (const name of ["refs", "families", "goto", "search", "wsymbols", "explore", "rename", "filedeps"]) {
    const result = await phase(name, () => queryRunners[name](context));
    workload[name] = { calls: result.calls, found: result.found, results: result.results };
  }
  // Keep the session reachable through the retained-memory measurement below.
  globalThis.__profiledSession = session;
} else {
  throw new Error(`Unknown operation ${op}.\n${USAGE}`);
}

const profilePath = profileResult ?? (await stopProfile());
global.gc();
const memory = process.memoryUsage();
const total = phases.reduce(
  (sum, entry) => ({ cpuMs: round(sum.cpuMs + entry.cpuMs), wallMs: round(sum.wallMs + entry.wallMs) }),
  { cpuMs: 0, wallMs: 0 },
);
const result = {
  schema: 1,
  op,
  root,
  checkout,
  node: process.version,
  options: { ...buildOptions, profile: profileMode },
  total,
  phases,
  workload,
  memory: {
    peakRssMiB: round(process.resourceUsage().maxRSS / 1024),
    rssAfterGcMiB: round(memory.rss / 2 ** 20),
    heapUsedAfterGcMiB: round(memory.heapUsed / 2 ** 20),
    externalAfterGcMiB: round(memory.external / 2 ** 20),
    arrayBuffersAfterGcMiB: round(memory.arrayBuffers / 2 ** 20),
  },
  ...(profilePath ? { profile: profilePath } : {}),
};
fs.writeFileSync(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ op, total, memory: result.memory, phases: phases.length }));
inspector.disconnect();
process.exit(0);
