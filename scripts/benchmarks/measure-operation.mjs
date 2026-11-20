// One operation per fresh process; preparation, imports, and optional profiling setup are not timed.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";

const [checkout, root, op, cacheDir, planPath, profilePath] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const load = (relative) => import(pathToFileURL(path.join(checkout, "dist", relative)).href);
const api = await load("index.js");
const quiet = { ...plan.buildOptions, logLevel: "silent" };
const disk = { ...quiet, cache: "disk", cacheDir };

async function timed(fn) {
  let profiler;
  if (profilePath) {
    profiler = new Session();
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 1000 });
    await profiler.post("Profiler.start");
  }
  try {
    const start = performance.now();
    const value = await fn();
    return { ms: performance.now() - start, value };
  } finally {
    if (profiler) {
      const { profile } = await profiler.post("Profiler.stop");
      profiler.disconnect();
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      fs.writeFileSync(profilePath, JSON.stringify(profile));
    }
  }
}

// Toggle an entire added line, preserving even a source file without a final newline.
function touchOneFile() {
  const file = path.join(root, plan.touch.file);
  const text = fs.readFileSync(file, "utf8");
  const marker = `\n${plan.touch.comment} codegraph-bench\n`;
  const next = text.endsWith(marker) ? text.slice(0, -marker.length) : `${text}${marker}`;
  fs.writeFileSync(file, next);
}

function relativeSite(file, start, name) {
  return { file: path.relative(root, file), line: start.line, column: start.column, name };
}

async function prepare() {
  const index = await api.buildProjectIndex(root, { ...quiet, cache: "off" });
  const modules = [...index.byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
  const declarations = [];
  for (const module of modules) {
    for (const local of module.locals) {
      if (["function", "method", "class"].includes(String(local.kind).toLowerCase())) {
        declarations.push(relativeSite(module.file, local.range.start, local.localName));
      }
    }
  }
  if (!declarations.length) throw new Error("Corpus has no callable or class declarations to query.");
  const step = Math.max(1, Math.floor(declarations.length / 25));
  const sites = declarations.filter((_, index) => index % step === 0).slice(0, 25);
  const gotoSites = [];
  for (const site of sites) {
    const answer = await api.findReferences(index, { ...site, file: path.join(root, site.file) });
    if (answer.status !== "ok") continue;
    const use = answer.references.find((reference) => {
      if (reference.file !== answer.definition.file) return true;
      const start = reference.range.start;
      const declaration = answer.definition.range.start;
      return start.line !== declaration.line || start.column !== declaration.column;
    });
    if (use) gotoSites.push(relativeSite(use.file, use.range.start, site.name));
  }
  if (!gotoSites.length) throw new Error("Corpus declaration sample has no reference use-sites for goto.");
  const touch = modules.find((module) => module.file.endsWith(plan.touchExtension));
  if (!touch) throw new Error(`Corpus has no indexed ${plan.touchExtension} file to edit.`);
  return {
    files: modules.length,
    touch: { file: path.relative(root, touch.file), comment: plan.comment },
    sites,
    gotoSites,
    queries: [...new Set(sites.map((site) => site.name))],
  };
}

let result;
let report;
if (op === "prepare") {
  result = await prepare();
} else if (op === "init") {
  const { initCodegraphLifecycle } = await load("lifecycle/manifest.js");
  fs.rmSync(path.join(root, ".codegraph"), { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const { ms, value } = await timed(() => initCodegraphLifecycle(root, { buildOptions: disk }));
  result = { ms, files: value.manifest.fileCount };
} else if (op === "cold" || op === "nochange" || op === "onefile") {
  if (op === "onefile") touchOneFile();
  report = { timings: {} };
  const options = { ...disk, report };
  if (op === "cold") options.cache = "off";
  const { ms, value } = await timed(() => api.buildProjectIndexIncremental(root, options));
  result = { ms, files: value.byFile.size };
} else if (op === "graph") {
  const index = await api.buildProjectIndex(root, disk);
  const { ms, value } = await timed(() => api.buildSymbolGraphDetailed(index));
  result = { ms, nodes: value.nodes.size, edges: value.edges.length };
} else if (op === "refs" || op === "goto") {
  const index = await api.buildProjectIndex(root, disk);
  const sites = op === "refs" ? plan.sites : plan.gotoSites;
  const { ms, value } = await timed(async () => {
    let found = 0;
    let references = 0;
    for (const site of sites) {
      const request = { file: path.join(root, site.file), line: site.line, column: site.column };
      const answer =
        op === "refs" ? await api.findReferences(index, request) : await api.goToDefinition(index, request);
      if (answer.status !== "ok") continue;
      found += 1;
      if (op === "refs") references += answer.references.length;
    }
    return { found, references };
  });
  result = { ms, sites: sites.length, ...value };
} else if (op === "search") {
  const { createAgentSession } = await load("agent/session.js");
  const { searchCodegraphWithSession } = await load("agent/search.js");
  const { ensureSessionQueryIndex } = await load("agent/query-index/session-store.js");
  const session = createAgentSession({ root, useConfig: false, buildOptions: disk });
  try {
    const snapshot = await session.loadProject({ symbolGraph: "basic" });
    await ensureSessionQueryIndex(session, snapshot);
    const { ms, value } = await timed(async () => {
      let matches = 0;
      for (const query of plan.queries) {
        const answer = await searchCodegraphWithSession(session, { root, query, mode: "hybrid", limit: 20 });
        matches += answer.results.length;
      }
      return matches;
    });
    result = { ms, queries: plan.queries.length, matches: value };
  } finally {
    session.invalidate();
  }
} else {
  throw new Error(`Unknown operation ${op}.`);
}
global.gc?.();
const memory = process.memoryUsage();
console.log(
  JSON.stringify({
    op,
    ...result,
    ...(report ? { report } : {}),
    memory: {
      heapUsedAfterGc: memory.heapUsed,
      rssAfterGc: memory.rss,
      peakRss: process.resourceUsage().maxRSS * 1024,
    },
  }),
);
